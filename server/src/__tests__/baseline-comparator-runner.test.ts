// server/src/__tests__/baseline-comparator-runner.test.ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  baselines, regressions, metricSeries, executionRuns, testRuns, testPlans, pipelineRuns, requirementsDocuments,
} from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { baselineComparatorRunner } from '../services/baseline-comparator-runner.js';
import { pipelineRunService } from '../services/pipeline-run.js';
import { SLA_EVALUATION_PHASE } from '../services/metric-phases.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('baselineComparatorRunner', () => {
  const ctx = withPipelineSchema([
    regressions, baselines, metricSeries, executionRuns, testRuns, pipelineRuns, testPlans, requirementsDocuments,
  ]);

  async function seed() {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const run = await pipelineRunService(ctx.db).create(ctx.companyId, { path: 'execution-trigger', trigger: { type: 'manual_rerun', source: 't' }, testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    const [testRun] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: run.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: run.id, testRunId: testRun!.id, engine: 'k6', status: 'completed', exitCode: 0 }).returning();
    return { planId: plan!.id, pipelineRunId: run.id, testRunId: testRun!.id, executionRunId: er!.id };
  }

  function input(s: Awaited<ReturnType<typeof seed>>, slaTargets: SlaTarget[] = []) {
    return { companyId: ctx.companyId, pipelineRunId: s.pipelineRunId, executionRunId: s.executionRunId, testRunId: s.testRunId, testPlanId: s.planId, slaTargets };
  }

  it('skips when the run produced no steady-phase metrics', async () => {
    const s = await seed();
    const result = await baselineComparatorRunner(ctx.db).run(input(s));
    expect(result).toEqual({ mode: 'skipped', reason: 'no steady-phase metrics for this run' });
    expect(await ctx.db.select().from(baselines)).toHaveLength(0);
  });

  it('only flags metrics that exist in the active set; unmatched metrics are ignored', async () => {
    const s = await seed();
    // active baseline for p95 only
    await ctx.db.insert(baselines).values({
      companyId: ctx.companyId, testPlanId: s.planId, sourceRunId: s.testRunId,
      baselineSetId: '00000000-0000-0000-0000-000000000abc', metric: 'p95_ms|k6|',
      baselineValue: 100, median: 100, stddev: 0, sampleN: 1, direction: 'higher_is_worse',
      tolerancePct: 10, isActive: true,
    });
    // this run measured p95 (worse) and an unmatched metric
    await ctx.db.insert(metricSeries).values([
      { companyId: ctx.companyId, testRunId: s.testRunId, executionRunId: s.executionRunId, metric: 'p95_ms', source: 'k6', phase: SLA_EVALUATION_PHASE, value: 150, sampleCount: 1000 },
      { companyId: ctx.companyId, testRunId: s.testRunId, executionRunId: s.executionRunId, metric: 'brand_new_metric', source: 'k6', phase: SLA_EVALUATION_PHASE, value: 1, sampleCount: 1000 },
    ]);

    const result = await baselineComparatorRunner(ctx.db).run(input(s));
    expect(result).toMatchObject({ mode: 'compared', comparedCount: 1, flaggedCount: 1 });
    const rows = await ctx.db.select().from(regressions).where(eq(regressions.pipelineRunId, s.pipelineRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: 'p95_ms|k6|', regressionType: 'latency_p95', confidence: 'low', deltaPct: 50 });
  });

  it('within-tolerance comparison persists no regression rows', async () => {
    const s = await seed();
    await ctx.db.insert(baselines).values({
      companyId: ctx.companyId, testPlanId: s.planId, sourceRunId: s.testRunId,
      baselineSetId: '00000000-0000-0000-0000-000000000abc', metric: 'p95_ms|k6|',
      baselineValue: 100, median: 100, stddev: 0, sampleN: 1, direction: 'higher_is_worse',
      tolerancePct: 10, isActive: true,
    });
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: s.testRunId, executionRunId: s.executionRunId, metric: 'p95_ms', source: 'k6', phase: SLA_EVALUATION_PHASE, value: 104, sampleCount: 1000 });

    const result = await baselineComparatorRunner(ctx.db).run(input(s));
    expect(result).toMatchObject({ mode: 'compared', comparedCount: 1, flaggedCount: 0 });
    expect(await ctx.db.select().from(regressions)).toHaveLength(0);
  });

  it('proposal direction comes from the SLA operator when a target matches', async () => {
    const s = await seed();
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: s.testRunId, executionRunId: s.executionRunId, metric: 'tps', source: 'k6', phase: SLA_EVALUATION_PHASE, value: 500, sampleCount: 1000 });
    const target: SlaTarget = { id: 't1', source: 'k6', metric: 'tps', operator: 'gte', threshold: 400, required: true };

    const result = await baselineComparatorRunner(ctx.db).run(input(s, [target]));
    expect(result).toMatchObject({ mode: 'proposed', proposedCount: 1 });
    const [proposal] = await ctx.db.select().from(baselines);
    expect(proposal).toMatchObject({ metric: 'tps|k6|', direction: 'lower_is_worse', isActive: false });
  });
});
