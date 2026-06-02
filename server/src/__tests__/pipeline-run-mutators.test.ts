// server/src/__tests__/pipeline-run-mutators.test.ts
import { describe, expect, it } from 'vitest';
import { pipelineRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipelineRunService stage mutators', () => {
  const ctx = withPipelineSchema([pipelineRuns, testPlans]);

  async function newRun() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    return (await pipelineRunService(ctx.db).create(ctx.companyId, {
      path: 'execution-trigger', trigger: { type: 'ci', source: 'test' }, testPlanId: plan!.id,
    })).id;
  }
  async function stages(id: string) {
    const [r] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    return r!.stages as Record<string, { status: string; startedAt?: string; completedAt?: string; error?: string; executionRunIds?: string[] }>;
  }

  it('markStageRunning sets running + startedAt and markStageComplete sets complete + completedAt', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageRunning(id, 'validate');
    expect((await stages(id)).validate.status).toBe('running');
    expect((await stages(id)).validate.startedAt).toBeTruthy();
    await svc.markStageComplete(id, 'validate');
    expect((await stages(id)).validate.status).toBe('complete');
    expect((await stages(id)).validate.completedAt).toBeTruthy();
  });

  it('markStageComplete merges a patch (e.g. executionRunIds) without clobbering other stages', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageComplete(id, 'execute', { executionRunIds: ['er-1'] });
    const s = await stages(id);
    expect(s.execute.status).toBe('complete');
    expect(s.execute.executionRunIds).toEqual(['er-1']);
    expect(s.report.status).toBe('pending'); // untouched
  });

  it('markStageFailed records the error and setVerdict/setCiSignal/markCompleted persist', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageFailed(id, 'execute', 'k6 exited 1');
    expect((await stages(id)).execute.status).toBe('failed');
    expect((await stages(id)).execute.error).toBe('k6 exited 1');
    await svc.setVerdict(id, 'fail');
    await svc.setCiSignal(id, 'fail');
    await svc.markCompleted(id);
    const [r] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    expect(r!.verdict).toBe('fail');
    expect(r!.ciSignal).toBe('fail');
    expect(r!.completedAt).toBeTruthy();
  });
});
