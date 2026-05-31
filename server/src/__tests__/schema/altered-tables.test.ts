import { describe, expect, it } from 'vitest';
import { testRuns, pipelineRuns, testPlans } from '@sentinel/db';
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
