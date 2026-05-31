import { describe, expect, it } from 'vitest';
import { testRuns, pipelineRuns, testPlans, metricSeries } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from '../helpers/pipeline-schema-fixture.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('test_runs.pipelineRunId', () => {
  const ctx = withPipelineSchema([testRuns, pipelineRuns, testPlans]);
  it('accepts a nullable pipelineRunId linking to a pipeline_runs row', async () => {
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [run] = await ctx.db.insert(testRuns)
      .values({ companyId: ctx.companyId, testPlanId: plan.id, pipelineRunId: pr.id }).returning();
    expect(run.pipelineRunId).toBe(pr.id);
  });
});

d('metric_series digest columns', () => {
  // metric_series.testRunId CASCADE-deletes from test_runs; clean child first.
  const ctx = withPipelineSchema([metricSeries, testRuns, testPlans]);
  it('stores per-workflow phase-tagged digest series', async () => {
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns)
      .values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();
    const [row] = await ctx.db.insert(metricSeries).values({
      companyId: ctx.companyId,
      testRunId: run.id,
      metric: 'http_req_duration',
      source: 'k6',
      workflowName: 'checkout',
      phase: 'steady',
      digest: { centroids: [] },
      sampleCount: 1234,
    }).returning();
    expect(row.workflowName).toBe('checkout');
    expect(row.phase).toBe('steady');
    expect(row.sampleCount).toBe(1234);
    expect(row.digest).toEqual({ centroids: [] });
  });
});
