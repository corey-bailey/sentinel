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

import { companies, metricSeries, slaVerdicts, requirementsDocuments, pipelineRuns, executionRuns, testPlans, testRuns } from '@sentinel/db';
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

  // --- Task 3: optional-unmeasured is non-blocking; fail-path; run-unhealthy (engine-level) ---

  it('OPTIONAL unmeasured target is non-blocking — counts in optionalSkippedCount, persists no verdict', async () => {
    // required:false target with no matching metric_series row → classifyVerdict returns 'skipped'.
    const { pr, er } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: false }]);
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.optionalSkippedCount).toBe(1);
    expect(res.verdictCount).toBe(0);
    const rows = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, pr.id));
    expect(rows).toHaveLength(0);
  });

  it('fail-path — a measured steady value that breaches the threshold persists status=fail with actualValue', async () => {
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: null, phase: 'steady', value: 250, sampleCount: 1000 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.failCount).toBe(1);
    const [v] = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, pr.id));
    expect(v.status).toBe('fail');
    expect(v.actualValue).toBe(250);
  });

  it('run-unhealthy — an aborted execution_run with an in-threshold metric is inconclusive (never false-greens)', async () => {
    // Seed an aborted run (runHealthy=false) but with a metric that would otherwise PASS.
    const [rd] = await ctx.db.insert(requirementsDocuments)
      .values({ companyId: ctx.companyId, slaTargets: [{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }] as SlaTarget[], minSampleCount: 200 }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, requirementsDocumentId: rd.id, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();
    const [er] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: pr.id, testRunId: run.id, engine: 'k6', status: 'aborted', exitCode: 1 }).returning();
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: null, phase: 'steady', value: 180, sampleCount: 1000 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.inconclusiveCount).toBe(1);
    expect(res.passCount).toBe(0);
  });

  // --- Tenant-scoping security guard (commit 10263f6f) — cross-tenant isolation ---

  it('throws when the executionRun belongs to a different pipeline_run (execution_run scoping guard)', async () => {
    // Two pipeline runs in the same company; pass run A's pipelineRunId but run B's executionRunId.
    const a = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    const b = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    await expect(
      slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: a.pr.id, executionRunId: b.er.id }),
    ).rejects.toThrow('execution_run not found for pipeline_run');
  });

  it('filters out a foreign-company metric_series row via the companyId join (required target → inconclusive, not pass)', async () => {
    // Seed our company's required target + run, but the only matching metric row belongs to a DIFFERENT company.
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    // issuePrefix has a UNIQUE index and defaults to 'PAP' (already taken by the fixture's company) → set a distinct prefix.
    const [foreign] = await ctx.db.insert(companies).values({ name: 'Foreign Co', status: 'active', issuePrefix: 'FGN' }).returning();
    // metric_series.testRunId is NOT NULL; seed a real test run for the foreign company to satisfy the FK.
    const [foreignPlan] = await ctx.db.insert(testPlans).values({ companyId: foreign.id, name: 'fp' }).returning();
    const [foreignRun] = await ctx.db.insert(testRuns).values({ companyId: foreign.id, testPlanId: foreignPlan.id }).returning();
    // Same executionRunId + metric + source + steady phase as our target, but companyId is the foreign tenant's.
    await ctx.db.insert(metricSeries).values({ companyId: foreign.id, testRunId: foreignRun.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: null, phase: 'steady', value: 180, sampleCount: 1000 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    // The foreign row is excluded by eq(metricSeries.companyId, input.companyId); the required target sees no row → inconclusive.
    expect(res.inconclusiveCount).toBe(1);
    expect(res.passCount).toBe(0);
  });
});
