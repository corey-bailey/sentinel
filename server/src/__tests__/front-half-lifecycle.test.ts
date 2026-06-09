// server/src/__tests__/front-half-lifecycle.test.ts
// Stages 0-2 end-to-end at the service layer: intake → confirm → discovery document →
// complete → approve → mechanical plan derivation.
import { describe, expect, it } from 'vitest';
import { pipelineRequests, requirementsDocuments, testPlans } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRequestService, DuplicateIntakeError } from '../services/pipeline-requests.js';
import { requirementsDocumentService, RequirementsDocumentStateError } from '../services/requirements-documents.js';
import { deriveTestPlan } from '../services/test-plan-generator.js';
import { testPlanService } from '../services/test-plans.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('front-half lifecycle (Stages 0-2)', () => {
  const ctx = withPipelineSchema([testPlans, requirementsDocuments, pipelineRequests]);

  it('manual intake is confirmed immediately; jira intake needs confirmation and dedupes', async () => {
    const svc = pipelineRequestService(ctx.db);
    const manual = await svc.create(ctx.companyId, { source: 'manual_intake', rawDescription: 'test the checkout API', ownerUserId: 'u1' });
    expect(manual.status).toBe('confirmed');

    const jira = await svc.create(ctx.companyId, { source: 'jira', jiraIssueKey: 'PERF-42', ownerUserId: 'u1' });
    expect(jira.status).toBe('pending_confirmation');
    await expect(svc.create(ctx.companyId, { source: 'jira', jiraIssueKey: 'PERF-42', ownerUserId: 'u2' }))
      .rejects.toThrow(DuplicateIntakeError);

    expect((await svc.confirm(jira.id))?.status).toBe('confirmed');
    expect(await svc.confirm(jira.id)).toBeNull(); // already confirmed → no-op

    // a rejected key frees the dedup slot
    const jira2 = await svc.create(ctx.companyId, { source: 'jira', jiraIssueKey: 'PERF-43', ownerUserId: 'u1' });
    await svc.reject(jira2.id);
    const again = await svc.create(ctx.companyId, { source: 'jira', jiraIssueKey: 'PERF-43', ownerUserId: 'u1' });
    expect(again.status).toBe('pending_confirmation');
  });

  it('discovery documents gate on a confirmed request and follow in_progress→complete→approved', async () => {
    const requests = pipelineRequestService(ctx.db);
    const docs = requirementsDocumentService(ctx.db);

    const pending = await requests.create(ctx.companyId, { source: 'jira', jiraIssueKey: 'PERF-50', ownerUserId: 'u1' });
    await expect(docs.create(ctx.companyId, { pipelineRequestId: pending.id }))
      .rejects.toThrow(RequirementsDocumentStateError);
    await requests.confirm(pending.id);

    const rd = await docs.create(ctx.companyId, {
      pipelineRequestId: pending.id,
      appName: 'checkout',
      protocol: 'http',
      syncModel: 'sync',
      slaTargets: [{ source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required: true }],
      loadModel: { peakConcurrentUsers: 100 },
      targetEnvironment: { baseUrl: 'https://example.test' },
    });
    expect(rd.status).toBe('in_progress');
    expect((rd.slaTargets as { id: string }[])[0]!.id).toMatch(/^[0-9a-f-]{36}$/);

    // approve before complete → state error; complete with a gap → completeness error
    await expect(docs.approve(rd.id, 'u1')).rejects.toThrow(RequirementsDocumentStateError);
    const gappy = await docs.create(ctx.companyId, { appName: 'no-url', protocol: 'http', syncModel: 'sync', testIntent: 'baseline' });
    await expect(docs.markComplete(gappy.id)).rejects.toThrow(/targetEnvironment.baseUrl/);

    // required target lacks an approver → approval refused even when complete
    await docs.markComplete(rd.id);
    await expect(docs.approve(rd.id, 'u1')).rejects.toThrow(/required SLA target/);

    // edits are locked after completion
    await expect(docs.update(rd.id, { appName: 'renamed' })).rejects.toThrow(RequirementsDocumentStateError);
  });

  it('full flow: approved document derives a runnable test plan', async () => {
    const docs = requirementsDocumentService(ctx.db);
    const rd = await docs.create(ctx.companyId, {
      appName: 'checkout',
      protocol: 'http',
      syncModel: 'sync',
      slaTargets: [{ source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required: true, approvedByUserId: 'u1' }],
      loadModel: { peakTps: 200 },
      targetEnvironment: { baseUrl: 'https://example.test' },
    });
    await docs.markComplete(rd.id);
    const approved = await docs.approve(rd.id, 'u1');
    expect(approved!.status).toBe('approved');

    const result = deriveTestPlan({
      id: rd.id, appName: rd.appName, protocol: rd.protocol,
      slaTargets: approved!.slaTargets as never, loadModel: approved!.loadModel,
      minSampleCount: approved!.minSampleCount, testIntent: approved!.testIntent,
    });
    expect(result).toHaveProperty('plan');
    const plan = await testPlanService(ctx.db).createDerived(ctx.companyId, (result as { plan: never }).plan);
    expect(plan.requirementsDocumentId).toBe(rd.id);
    expect(plan.executionModel).toBe('weighted-loop');
    expect((plan.loadProfile as { executor: string }).executor).toBe('constant-arrival-rate');
  });
});
