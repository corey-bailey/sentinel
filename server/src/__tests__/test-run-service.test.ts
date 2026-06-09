// server/src/__tests__/test-run-service.test.ts
import { describe, expect, it } from 'vitest';
import { testRuns, testPlans } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { testRunService } from '../services/test-runs.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('testRunService', () => {
  const ctx = withPipelineSchema([testRuns, testPlans]);

  it('create persists a queued run; getById round-trips; null for unknown id', async () => {
    const svc = testRunService(ctx.db);
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const run = await svc.create(ctx.companyId, { testPlanId: plan!.id, triggerType: 'manual', triggerContext: { from: 'test' } });
    expect(run.status).toBe('queued');
    expect(run.triggerType).toBe('manual');

    expect(await svc.getById(run.id)).toMatchObject({ id: run.id, companyId: ctx.companyId });
    expect(await svc.getById('00000000-0000-0000-0000-00000000dead')).toBeNull();
  });

  it('list scopes by company and filters by testPlanId', async () => {
    const svc = testRunService(ctx.db);
    const [planA] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'a' }).returning();
    const [planB] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'b' }).returning();
    await svc.create(ctx.companyId, { testPlanId: planA!.id, triggerType: 'ci' });
    await svc.create(ctx.companyId, { testPlanId: planB!.id, triggerType: 'scheduled' });

    expect(await svc.list(ctx.companyId)).toHaveLength(2);
    const filtered = await svc.list(ctx.companyId, { testPlanId: planA!.id });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.testPlanId).toBe(planA!.id);
  });
});
