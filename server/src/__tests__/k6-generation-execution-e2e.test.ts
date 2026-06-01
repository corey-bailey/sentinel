// server/src/__tests__/k6-generation-execution-e2e.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  executionRuns, metricSeries, pipelineRuns, requirementsDocuments, slaVerdicts, testRuns, testPlans,
} from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { generateK6Script } from '../services/k6-generator/generate.js';
import { buildThresholds } from '../services/k6-generator/thresholds.js';
import { k6Executor } from '../services/k6-executor.js';
import { slaVerdictEngine } from '../services/sla-verdict-engine.js';
import type { GenerateK6Input } from '../services/k6-generator/types.js';
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

// Fake k6 that synthesizes a RAW k6 data.metrics tree from the SAME thresholds the generator declared,
// so the summary it writes is exactly what real k6 would emit for those materialized sub-metrics. The
// executor's mapK6Summary then transforms it — so this exercises the real transform end-to-end.
// `values` sets the metric values (and thus pass/fail); sampleCount drives the min-sample guard.
function fakeK6FromThresholds(targets: SlaTarget[], values: { p95_ms?: number; error_rate?: number }, sampleCount: number): SpawnFn {
  const thresholds = buildThresholds(targets);
  return async (_cmd, _args, opts) => {
    const testRunId = opts.env.TEST_RUN_ID;
    const metrics: Record<string, { type: string; values: Record<string, number> }> = {
      vus_max: { type: 'gauge', values: { max: 500 } },
      http_reqs: { type: 'counter', values: { count: sampleCount } },
      iterations: { type: 'counter', values: { count: sampleCount } },
    };
    for (const key of Object.keys(thresholds)) {
      if (key.startsWith('http_req_duration')) {
        const p95 = values.p95_ms ?? 0;
        metrics[key] = { type: 'trend', values: { med: Math.max(p95 - 20, 0), 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount } };
      } else if (key.startsWith('http_req_failed')) {
        metrics[key] = { type: 'rate', values: { rate: values.error_rate ?? 0, passes: sampleCount, fails: 0 } };
      }
    }
    await fs.writeFile(path.join(opts.cwd!, `summary-${testRunId}.json`), JSON.stringify({ metrics }));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const sla = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: 'k6', required: o.required ?? true, workflowScope: o.workflowScope, ...o,
});

d('k6 generation → execution → SLA verdict (local path)', () => {
  const ctx = withPipelineSchema([slaVerdicts, metricSeries, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testPlans]);

  async function seed(targets: SlaTarget[]) {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, requirementsDocumentId: rd!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'queued' }).returning();
    return { pipelineRunId: pr!.id, testRunId: tr!.id, executionRunId: er!.id };
  }

  it('aggregate p95 under threshold + healthy run → pass verdict', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.01 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);

    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'search', weight: 1, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' }],
      slaTargets: targets,
      data: { reusable: [{ term: 'x' }] },
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 180, error_rate: 0.004 }, 1200);

    const exec = k6Executor({ db: ctx.db, spawnFn });
    const r = await exec.run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720 } });
    expect(r.status).toBe('completed');

    const verdicts = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(verdicts.passCount).toBe(2);
    expect(verdicts.failCount).toBe(0);
    expect(verdicts.inconclusiveCount).toBe(0);

    const rows = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.executionRunId, executionRunId));
    expect(rows.every((v) => v.status === 'pass')).toBe(true);
  });

  it('p95 over threshold → fail verdict', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 200 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'search', weight: 1, request: { method: 'GET', path: '/search' }, dataStrategy: 'none' }],
      slaTargets: targets,
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 480 }, 1200);
    await k6Executor({ db: ctx.db, spawnFn }).run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 60, steadyEndS: 360 } });

    const v = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(v.failCount).toBe(1);
  });

  it('under-sampled required metric → inconclusive (never false-green)', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/health' }, dataStrategy: 'none' }],
      slaTargets: targets,
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 50 }, 12); // 12 < minSampleCount 200
    await k6Executor({ db: ctx.db, spawnFn }).run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 30, rampUpEndS: 30, steadyEndS: 120 } });

    const v = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(v.inconclusiveCount).toBe(1);
    expect(v.passCount).toBe(0);
  });
});
