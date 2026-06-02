// server/src/__tests__/pipeline-run-create.test.ts
import { describe, expect, it } from 'vitest';
import { pipelineRuns, testPlans, requirementsDocuments } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService, UnsupportedTriggerPathError } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipelineRunService.create', () => {
  const ctx = withPipelineSchema([pipelineRuns, testPlans, requirementsDocuments]);

  it('initializes the execution-trigger stage map (front-half skipped, validate→report pending)', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const svc = pipelineRunService(ctx.db);
    const run = await svc.create(ctx.companyId, {
      path: 'execution-trigger',
      trigger: { type: 'manual_rerun', source: 'test' },
      testPlanId: plan!.id,
      requirementsDocumentId: rd!.id,
    });

    expect(run.verdict).toBe('pending');
    expect(run.ciSignal).toBe('pending');
    const [persisted] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    const stages = persisted!.stages as Record<string, { status: string; skippedReason?: string }>;
    expect(stages.intake.status).toBe('skipped');
    expect(stages.discovery.status).toBe('skipped');
    expect(stages.plan.status).toBe('skipped');
    expect(stages.generate.status).toBe('skipped');
    expect(stages.validate.status).toBe('pending');
    expect(stages.execute.status).toBe('pending');
    expect(stages.analysis.status).toBe('pending');
    expect(stages.report.status).toBe('pending');
    expect(stages.intake.skippedReason).toMatch(/execution-trigger/);
  });

  it('throws for an unimplemented trigger path', async () => {
    const svc = pipelineRunService(ctx.db);
    await expect(svc.create(ctx.companyId, { path: 'intake-trigger' as never, trigger: { type: 'manual_intake', source: 't' } }))
      .rejects.toThrow(UnsupportedTriggerPathError);
  });
});
