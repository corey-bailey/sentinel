import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executionRuns, metricSeries, pipelineRuns, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { k6Executor } from '../services/k6-executor.js';
import type { SpawnFn } from '../services/test-adapters/k6-adapter.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

// pipeline_runs.trigger and .stages are NOT NULL — minimal stubs for tests.
const PR_STUB = {
  trigger: { type: 'manual_intake' as const, source: 'test' },
  stages: {
    intake: { status: 'pending' }, discovery: { status: 'pending' }, plan: { status: 'pending' },
    generate: { status: 'pending' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' },
  },
};

// Fake k6: writes a RAW k6 end-of-test summary (data.metrics) into the cwd, then exits 0.
function fakeK6(p95: number, sampleCount: number, run: { peakVus: number; totalRequests: number; totalIterations: number }): SpawnFn {
  return async (_cmd, _args, opts) => {
    const testRunId = opts.env.TEST_RUN_ID;
    const data = {
      metrics: {
        'http_req_duration{workflow:checkout,phase:steady,expected_response:true}': {
          type: 'trend', values: { med: p95 - 20, 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount },
        },
        vus_max: { type: 'gauge', values: { max: run.peakVus } },
        http_reqs: { type: 'counter', values: { count: run.totalRequests } },
        iterations: { type: 'counter', values: { count: run.totalIterations } },
      },
    };
    await fs.writeFile(path.join(opts.cwd!, `summary-${testRunId}.json`), JSON.stringify(data));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

d('k6Executor.run', () => {
  const ctx = withPipelineSchema([metricSeries, executionRuns, testRuns, pipelineRuns, testPlans]);

  it('writes script+data, runs, transforms the raw summary, ingests rows, completes the run', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'queued' }).returning();

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6exec-'));
    const spawnFn = fakeK6(180, 1200, { peakVus: 500, totalRequests: 1500, totalIterations: 1500 });

    const executor = k6Executor({ db: ctx.db, spawnFn });
    const result = await executor.run({
      companyId: ctx.companyId,
      executionRunId: er!.id,
      testRunId: tr!.id,
      cwd,
      asset: { scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]' }] },
      baseUrl: 'http://localhost:9999',
      window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 },
    });

    expect(result.status).toBe('completed');
    expect(result.ingestedCount).toBe(3); // p50_ms, p95_ms, p99_ms from one steady latency sub-metric

    // script + data written to cwd
    expect(await fs.readFile(path.join(cwd, 'script.js'), 'utf8')).toContain('export default');
    expect(await fs.readFile(path.join(cwd, 'reusable.json'), 'utf8')).toBe('[]');

    // metric_series rows ingested with k6 source + steady phase
    const rows = await ctx.db.select().from(metricSeries).where(eq(metricSeries.executionRunId, er!.id));
    expect(rows).toHaveLength(3);
    const p95 = rows.find((r) => r.metric === 'p95_ms');
    expect(p95).toMatchObject({ workflowName: 'checkout', phase: 'steady', source: 'k6', value: 180, sampleCount: 1200 });

    // execution run completed with run metrics
    const [erRow] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, er!.id));
    expect(erRow).toMatchObject({ status: 'completed', exitCode: 0, peakVus: 500, totalRequests: 1500 });
  });

  it('marks the execution run failed when k6 exits non-zero (no summary written)', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p2' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, engine: 'k6', status: 'queued' }).returning();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6exec-'));
    const spawnFn: SpawnFn = async () => ({ exitCode: 1, stdout: '', stderr: 'script error' });

    const executor = k6Executor({ db: ctx.db, spawnFn });
    const result = await executor.run({
      companyId: ctx.companyId, executionRunId: er!.id, testRunId: null, cwd,
      asset: { scriptContent: 'boom', dataFiles: [] }, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 },
    });
    expect(result.status).toBe('failed');
    expect(result.ingestedCount).toBe(0);
    const [erRow] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, er!.id));
    expect(erRow?.status).toBe('failed');
  });
});
