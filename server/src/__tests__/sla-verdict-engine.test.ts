import { describe, expect, it } from 'vitest';
import { classifyVerdict } from '../services/sla-evaluator.js';

describe('classifyVerdict (pure)', () => {
  const target = { id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt' as const, threshold: 200, required: true };

  it('pass when measured and within threshold', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('pass');
  });
  it('fail when measured and breaches threshold', () => {
    expect(classifyVerdict(target, { value: 250, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('fail');
  });
  it('inconclusive when the required metric is missing', () => {
    expect(classifyVerdict(target, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when sampleCount below the floor', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 50, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when the run is unhealthy', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: false }).status).toBe('inconclusive');
  });
  it('optional missing metric does NOT force inconclusive (records skipped)', () => {
    const opt = { ...target, required: false };
    expect(classifyVerdict(opt, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('skipped');
  });
});

import { metricSeries, slaVerdicts, requirementsDocuments, pipelineRuns, executionRuns, testPlans, testRuns } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { metricSeriesService } from '../services/metric-series.js';
import { slaVerdictEngine } from '../services/sla-verdict-engine.js';
import type { SlaTarget } from '@sentinel/db';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('slaVerdictEngine.evaluate', () => {
  const ctx = withPipelineSchema([slaVerdicts, metricSeries, executionRuns, pipelineRuns, testRuns, requirementsDocuments, testPlans]);

  async function seed(targets: SlaTarget[], minSampleCount = 200) {
    // metric_series.testRunId is NOT NULL (pre-existing CASCADE column) → seed a real test run.
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();
    const [rd] = await ctx.db.insert(requirementsDocuments)
      .values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, requirementsDocumentId: rd.id, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [er] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: pr.id, testRunId: run.id, engine: 'k6', status: 'completed', exitCode: 0 }).returning();
    return { rd, pr, er, run };
  }

  it('passes a target whose windowed steady metric is within threshold', async () => {
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true, workflowScope: 'checkout' }]);
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1000 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res).toMatchObject({ passCount: 1, failCount: 0, inconclusiveCount: 0 });
    const [v] = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, pr.id));
    expect(v.status).toBe('pass');
    expect(v.slaTargetId).toBe('t1');
    expect(v.workflowName).toBe('checkout');
  });

  it('inconclusive when sampleCount below minSampleCount (never false-green)', async () => {
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }], 200);
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: null, phase: 'steady', value: 180, sampleCount: 50 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.inconclusiveCount).toBe(1);
  });

  it('inconclusive when the required metric row is missing', async () => {
    const { pr, er } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.inconclusiveCount).toBe(1);
  });
});
