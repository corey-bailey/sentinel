// server/src/__tests__/pipeline-run-orchestrator.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  pipelineRuns, gateResolutions, testRunArtifacts, slaVerdicts, metricSeries,
  executionRuns, testRuns, testPlans, requirementsDocuments, testAssets,
  baselines, regressions,
} from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService } from '../services/pipeline-run.js';
import { baselineService } from '../services/baselines.js';
import type { SpawnFn } from '../services/test-adapters/k6-adapter.js';
import { createStorageService } from '../storage/service.js';
import { createLocalDiskStorageProvider } from '../storage/local-disk-provider.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const t = (id: string, threshold: number): SlaTarget => ({ id, source: 'k6', metric: 'p95_ms', operator: 'lt', threshold, required: true });

// Fake k6: writes BOTH a raw summary json (for ingestion) and an html file (for the artifact), exits 0.
function fakeK6(p95: number, sampleCount: number): SpawnFn {
  return async (_cmd, _args, opts) => {
    const id = opts.env.TEST_RUN_ID;
    const data = { metrics: {
      'http_req_duration{expected_response:true,phase:steady}': { type: 'trend', values: { med: p95 - 20, 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount } },
      vus_max: { type: 'gauge', values: { max: 500 } }, http_reqs: { type: 'counter', values: { count: sampleCount } }, iterations: { type: 'counter', values: { count: sampleCount } },
    } };
    await fs.writeFile(path.join(opts.cwd!, `summary-${id}.json`), JSON.stringify(data));
    await fs.writeFile(path.join(opts.cwd!, `summary-${id}.html`), '<html>k6 report</html>');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

d('pipelineRunService.runExecutionTrigger', () => {
  const ctx = withPipelineSchema([regressions, baselines, gateResolutions, testRunArtifacts, slaVerdicts, metricSeries, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testAssets, testPlans]);

  async function seed(targets: SlaTarget[], testIntent = 'conformance') {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200, testIntent, targetEnvironment: { baseUrl: 'http://localhost:9' } }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, executionModel: 'weighted-loop', loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '1m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }] } }).returning();
    await ctx.db.insert(testAssets).values({ companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6', engine: 'k6', assetType: 'generated', version: 2, scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }] });
    const run = await pipelineRunService(ctx.db).create(ctx.companyId, { path: 'execution-trigger', trigger: { type: 'manual_rerun', source: 'test' }, testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    return { runId: run.id, requirementsDocumentId: rd!.id };
  }

  it('happy path: p95 under threshold → auto_pass, ciSignal pass, all back-half stages complete', async () => {
    const { runId } = await seed([t('req-1', 500)]);
    const svc = pipelineRunService(ctx.db);
    const result = await svc.runExecutionTrigger(runId, { spawnFn: fakeK6(180, 1200) });

    expect(result.verdict).toBe('pass');
    expect(result.ciSignal).toBe('pass');

    const [pr] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const stages = pr!.stages as Record<string, { status: string; executionRunIds?: string[] }>;
    expect(stages.validate.status).toBe('complete');
    expect(stages.execute.status).toBe('complete');
    expect(stages.analysis.status).toBe('complete');
    expect(stages.report.status).toBe('complete');
    expect(stages.execute.executionRunIds?.length).toBe(1);
    expect(pr!.resolvedExecution).toBeTruthy();

    // a gate_resolutions row + the artifacts were persisted
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('auto_pass');
    expect(gates[0]?.ciSignal).toBe('pass');
    const artifacts = await ctx.db.select().from(testRunArtifacts).where(eq(testRunArtifacts.pipelineRunId, runId));
    expect(artifacts.map((a) => a.artifactType).sort()).toEqual(['k6_html_summary', 'sentinel_summary']);
    // metric_series ingested by k6Executor + sla_verdicts produced by the engine
    expect((await ctx.db.select().from(metricSeries).where(eq(metricSeries.executionRunId, stages.execute.executionRunIds![0]!))).length).toBeGreaterThan(0);
    expect((await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, runId))).length).toBeGreaterThan(0);
  });

  it('with a storage service: artifacts land as objectKeys, content is readable, temp cwd removed', async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-storage-test-'));
    const storage = createStorageService(createLocalDiskStorageProvider(storageDir));
    const { runId } = await seed([t('req-1', 500)]);
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: fakeK6(180, 1200), storage });
    expect(result.verdict).toBe('pass');

    const artifacts = await ctx.db.select().from(testRunArtifacts).where(eq(testRunArtifacts.pipelineRunId, runId));
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact.storageRef.startsWith('/')).toBe(false); // objectKey, not a path
      expect(artifact.storageRef.startsWith(`${ctx.companyId}/pipeline-runs/${runId}/`)).toBe(true);
      const obj = await storage.getObject(ctx.companyId, artifact.storageRef);
      const chunks: Buffer[] = [];
      for await (const chunk of obj.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    }

    // the temp workspace was cleaned after report
    const [er] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.pipelineRunId, runId));
    await expect(fs.access(er!.workspaceRef!)).rejects.toThrow();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it('breach: p95 over threshold → auto_fail, ciSignal fail', async () => {
    const { runId } = await seed([t('req-1', 200)]);
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: fakeK6(480, 1200) });
    expect(result.verdict).toBe('fail');
    expect(result.ciSignal).toBe('fail');
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('auto_fail');
  });

  it('baseline intent → characterization, ciSignal pass', async () => {
    const { runId } = await seed([], 'baseline');
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: fakeK6(50, 1200) });
    expect(result.verdict).toBe('pass');
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('characterization');
  });

  it('Stage 7: first run proposes a baseline set; after approval a worse run blocks on human; rejection fails it', async () => {
    // shared plan + rd across both runs
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [t('req-1', 500)], minSampleCount: 200, testIntent: 'conformance', targetEnvironment: { baseUrl: 'http://localhost:9' } }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, executionModel: 'weighted-loop', loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '1m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }] } }).returning();
    await ctx.db.insert(testAssets).values({ companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6', engine: 'k6', assetType: 'generated', version: 2, scriptContent: 'export default function(){}', dataFiles: [] });
    const svc = pipelineRunService(ctx.db);
    const trigger = { type: 'manual_rerun', source: 'test' } as const;

    // RUN 1 (fast): no active baseline → comparator proposes a pending set, gate auto_passes
    const run1 = await svc.create(ctx.companyId, { path: 'execution-trigger', trigger, testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    const result1 = await svc.runExecutionTrigger(run1.id, { spawnFn: fakeK6(180, 1200) });
    expect(result1.verdict).toBe('pass');
    const proposed = await ctx.db.select().from(baselines).where(eq(baselines.testPlanId, plan!.id));
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.every((b) => !b.isActive && b.baselineSetId === proposed[0]!.baselineSetId)).toBe(true);
    const p95Baseline = proposed.find((b) => b.metric.startsWith('p95_ms|'));
    expect(p95Baseline?.direction).toBe('higher_is_worse');

    // approve one row → whole set activates atomically
    await baselineService(ctx.db).approve(proposed[0]!.id, 'user-1');
    const activated = await ctx.db.select().from(baselines).where(eq(baselines.testPlanId, plan!.id));
    expect(activated.every((b) => b.isActive && b.validFrom !== null)).toBe(true);

    // RUN 2 (much worse p95, still under the 500ms SLA): SLA passes but the comparator flags
    const run2 = await svc.create(ctx.companyId, { path: 'execution-trigger', trigger, testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    const result2 = await svc.runExecutionTrigger(run2.id, { spawnFn: fakeK6(480, 1200) });
    expect(result2).toEqual({ verdict: 'blocked_on_human', ciSignal: 'fail' });

    const [pr2] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run2.id));
    expect(pr2!.verdict).toBe('blocked_on_human');
    expect(pr2!.completedAt).toBeNull(); // stays open until the human decides
    const flaggedRows = await ctx.db.select().from(regressions).where(eq(regressions.pipelineRunId, run2.id));
    expect(flaggedRows.length).toBeGreaterThan(0);
    expect(flaggedRows[0]).toMatchObject({ flagged: true, status: 'open', baselineSetId: proposed[0]!.baselineSetId });
    // no auto gate row for a blocked run — the human resolution writes it
    expect(await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, run2.id))).toHaveLength(0);

    // human confirms the regression → run terminalizes as fail with a regression_rejected gate row
    const resolution = await svc.applyHumanResolution(run2.id, 'regression_rejected', 'user-1');
    expect(resolution).toMatchObject({ ciSignal: 'fail', verdict: 'fail' });
    const [pr2After] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run2.id));
    expect(pr2After!.verdict).toBe('fail');
    expect(pr2After!.ciSignal).toBe('fail');
    expect(pr2After!.completedAt).not.toBeNull();
    const gateRows = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, run2.id));
    expect(gateRows).toHaveLength(1);
    expect(gateRows[0]).toMatchObject({ outcome: 'regression_rejected', ciSignal: 'fail', resolvedBy: 'user-1' });
  });

  it('k6 non-zero exit → execute stage failed, verdict error', async () => {
    const { runId } = await seed([t('req-1', 500)]);
    const failSpawn: SpawnFn = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: failSpawn });
    expect(result.verdict).toBe('error');
    const [pr] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const stages = pr!.stages as Record<string, { status: string }>;
    expect(stages.execute.status).toBe('failed');
    expect(stages.analysis.status).toBe('pending'); // never reached
  });
});
