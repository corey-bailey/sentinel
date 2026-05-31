import { describe, expect, it } from 'vitest';
import { testRuns, pipelineRuns, testPlans, metricSeries, testAssets, requirementsDocuments, baselines, regressions } from '@sentinel/db';
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

d('test_assets provenance columns', () => {
  const ctx = withPipelineSchema([testAssets, testPlans]);
  it('stores sourceRef provenance + generatedFrom', async () => {
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [row] = await ctx.db.insert(testAssets).values({
      companyId: ctx.companyId,
      testPlanId: plan.id,
      name: 'checkout-load',
      engine: 'k6',
      protocol: 'http',
      generatedFrom: 'existing_k6',
      sourceRef: { repoUrl: 'git@x', path: 'a.js', ref: 'main', importedSha: 'abc' },
      dataFiles: [],
      setupScript: null,
      teardownScript: null,
    }).returning();
    expect(row.generatedFrom).toBe('existing_k6');
    expect(row.protocol).toBe('http');
    expect((row.sourceRef as { path?: string })?.path).toBe('a.js');
  });
});

d('test_plans references requirements + executionModel', () => {
  const ctx = withPipelineSchema([testPlans, requirementsDocuments]);
  it('links requirementsDocumentId and stores executionModel', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId }).returning();
    const [row] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd.id, executionModel: 'per-scenario' }).returning();
    expect(row.requirementsDocumentId).toBe(rd.id);
    expect(row.executionModel).toBe('per-scenario');
  });
});

d('baselines.baselineSetId + regressions direction', () => {
  // regressions.testRunId → test_runs; baselines.testPlanId → test_plans.
  const ctx = withPipelineSchema([regressions, baselines, testRuns, pipelineRuns, testPlans]);
  it('groups baseline rows and stores regression direction', async () => {
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p' }).returning();
    const setId = '00000000-0000-0000-0000-000000000001';
    const [b] = await ctx.db.insert(baselines).values({
      companyId: ctx.companyId,
      testPlanId: plan.id,
      metric: 'p95_ms',
      baselineValue: 180,
      baselineSetId: setId,
    }).returning();
    expect(b.baselineSetId).toBe(setId);

    const [run] = await ctx.db.insert(testRuns)
      .values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [r] = await ctx.db.insert(regressions).values({
      companyId: ctx.companyId,
      testRunId: run.id,
      metric: 'p95_ms',
      actualValue: 240,
      pipelineRunId: pr.id,
      direction: 'higher_is_worse',
    }).returning();
    expect(r.direction).toBe('higher_is_worse');
    expect(r.pipelineRunId).toBe(pr.id);
  });
});
