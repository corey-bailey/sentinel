// server/src/__tests__/pipeline-run-required-counts.test.ts
import { describe, expect, it } from 'vitest';
import { slaVerdicts, pipelineRuns, executionRuns, testRuns, testPlans, requirementsDocuments } from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { countRequiredVerdicts } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const PR_STUB = { trigger: { type: 'ci' as const, source: 't' }, stages: { intake: { status: 'skipped' }, discovery: { status: 'skipped' }, plan: { status: 'skipped' }, generate: { status: 'skipped' }, validate: { status: 'pending' }, execute: { status: 'pending' }, analysis: { status: 'pending' }, report: { status: 'pending' } } };
const t = (id: string, required: boolean): SlaTarget => ({ id, source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required });

d('countRequiredVerdicts', () => {
  const ctx = withPipelineSchema([slaVerdicts, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testPlans]);

  it('counts only required fails/inconclusives; reports requiredTargetCount', async () => {
    const targets = [t('req-1', true), t('req-2', true), t('opt-1', false)];
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, requirementsDocumentId: rd!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'completed' }).returning();

    const mkVerdict = (slaTargetId: string, status: string) => ({ companyId: ctx.companyId, pipelineRunId: pr!.id, executionRunId: er!.id, slaTargetId, metric: 'p95_ms', operator: 'lt', threshold: 500, source: 'k6', phase: 'steady', status, evaluatedOnSuccessOnly: true });
    await ctx.db.insert(slaVerdicts).values([
      mkVerdict('req-1', 'fail'),
      mkVerdict('req-2', 'inconclusive'),
      mkVerdict('opt-1', 'fail'), // optional fail — must NOT count toward the gate
    ]);

    const counts = await countRequiredVerdicts(ctx.db, ctx.companyId, { pipelineRunId: pr!.id, executionRunId: er!.id, requirementsDocumentId: rd!.id });
    expect(counts).toEqual({ requiredTargetCount: 2, requiredFailCount: 1, requiredInconclusiveCount: 1 });
  });
});
