// server/src/__tests__/execution-runs-service.test.ts
import { describe, expect, it } from 'vitest';
import { executionRuns, pipelineRuns, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { executionRunService } from '../services/execution-runs.js';

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

d('executionRunService', () => {
  const ctx = withPipelineSchema([executionRuns, testRuns, pipelineRuns, testPlans]);

  async function seed() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: run!.id }).returning();
    return { pipelineRunId: run!.id, testRunId: tr!.id };
  }

  it('creates a queued execution run, marks it running, then completes it with metrics', async () => {
    const { pipelineRunId, testRunId } = await seed();
    const svc = executionRunService(ctx.db);

    const created = await svc.create(ctx.companyId, { pipelineRunId, testRunId, engine: 'k6', binaryProfile: 'k6', workspaceRef: '/tmp/run-1' });
    expect(created.status).toBe('queued');

    await svc.markRunning(created.id);
    const completed = await svc.complete(created.id, { status: 'completed', exitCode: 0, peakVus: 500, totalRequests: 1500, totalIterations: 1500 });
    expect(completed.status).toBe('completed');
    expect(completed.exitCode).toBe(0);
    expect(completed.peakVus).toBe(500);

    const [row] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, created.id));
    expect(row?.completedAt).toBeTruthy();
    expect(row?.startedAt).toBeTruthy();
  });
});
