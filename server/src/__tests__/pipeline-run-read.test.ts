// server/src/__tests__/pipeline-run-read.test.ts
import { describe, expect, it } from 'vitest';
import {
  pipelineRuns, testPlans, requirementsDocuments, testRuns, executionRuns,
  slaVerdicts, gateResolutions, testRunArtifacts, companies,
} from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipelineRunService read helpers', () => {
  const ctx = withPipelineSchema([
    testRunArtifacts, gateResolutions, slaVerdicts, executionRuns, testRuns, pipelineRuns, testPlans, requirementsDocuments,
  ]);

  async function seedRun(companyId: string, opts: { testPlanId?: string | null; requirementsDocumentId?: string | null } = {}) {
    const svc = pipelineRunService(ctx.db);
    return svc.create(companyId, {
      path: 'execution-trigger',
      trigger: { type: 'manual_rerun', source: 'test' },
      testPlanId: opts.testPlanId ?? null,
      requirementsDocumentId: opts.requirementsDocumentId ?? null,
    });
  }

  it('list scopes to the company and orders newest-first', async () => {
    const svc = pipelineRunService(ctx.db);
    const [other] = await ctx.db.insert(companies).values({ name: 'Other Co', status: 'active', issuePrefix: 'OTH' }).returning();
    const first = await seedRun(ctx.companyId);
    const second = await seedRun(ctx.companyId);
    await seedRun(other!.id);

    const rows = await svc.list(ctx.companyId);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('list filters by testPlanId', async () => {
    const svc = pipelineRunService(ctx.db);
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p1' }).returning();
    const inPlan = await seedRun(ctx.companyId, { testPlanId: plan!.id });
    await seedRun(ctx.companyId);

    const rows = await svc.list(ctx.companyId, { testPlanId: plan!.id });
    expect(rows.map((r) => r.id)).toEqual([inPlan.id]);
  });

  it('getDetail assembles verdicts (joined to targets), gate, execution runs, and artifacts without storageRef', async () => {
    const svc = pipelineRunService(ctx.db);
    const targets = [
      { id: 't-req', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required: true },
      { id: 't-opt', source: 'k6', metric: 'error_rate', operator: 'lt', threshold: 0.01, required: false },
    ];
    const [rd] = await ctx.db.insert(requirementsDocuments)
      .values({ companyId: ctx.companyId, slaTargets: targets as never, minSampleCount: 200, appName: 'demo' }).returning();
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const run = await seedRun(ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id });

    const [testRun] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: run.id }).returning();
    const [er] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: run.id, testRunId: testRun!.id, engine: 'k6', status: 'completed' }).returning();
    await ctx.db.insert(slaVerdicts).values({
      companyId: ctx.companyId, pipelineRunId: run.id, executionRunId: er!.id, slaTargetId: 't-req',
      status: 'pass', actualValue: 420, thresholdValue: 500, operator: 'lt', metric: 'p95_ms', source: 'k6',
    } as never);
    await ctx.db.insert(gateResolutions).values({
      companyId: ctx.companyId, pipelineRunId: run.id, testRunId: testRun!.id, outcome: 'auto_pass', ciSignal: 'pass', resolvedBy: 'auto', resolvedAt: new Date(),
    } as never);
    await ctx.db.insert(testRunArtifacts).values({
      companyId: ctx.companyId, pipelineRunId: run.id, executionRunId: er!.id, testRunId: testRun!.id,
      artifactType: 'k6_html_summary', storageRef: '/tmp/secret-internal-path.html', contentType: 'text/html',
    });

    const detail = await svc.getDetail(run.id);
    expect(detail).not.toBeNull();
    expect(detail!.requirementsDocument).toMatchObject({ id: rd!.id, appName: 'demo' });
    expect(detail!.executionRuns.map((e) => e.id)).toEqual([er!.id]);
    expect(detail!.gateResolutions[0]).toMatchObject({ outcome: 'auto_pass', ciSignal: 'pass' });

    expect(detail!.slaVerdicts).toHaveLength(1);
    expect(detail!.slaVerdicts[0]!.target).toMatchObject({ id: 't-req', metric: 'p95_ms', required: true });

    expect(detail!.artifacts).toHaveLength(1);
    expect(detail!.artifacts[0]).toMatchObject({ artifactType: 'k6_html_summary' });
    expect(Object.keys(detail!.artifacts[0]!)).not.toContain('storageRef');
  });

  it('getDetail returns null for an unknown id and tolerates a run with no requirements document', async () => {
    const svc = pipelineRunService(ctx.db);
    expect(await svc.getDetail('00000000-0000-0000-0000-00000000dead')).toBeNull();

    const bare = await seedRun(ctx.companyId);
    const detail = await svc.getDetail(bare.id);
    expect(detail!.requirementsDocument).toBeNull();
    expect(detail!.slaVerdicts).toEqual([]);
    expect(detail!.artifacts).toEqual([]);
  });
});
