// server/src/__tests__/pipeline-run-resolve-inputs.test.ts
import { describe, expect, it } from 'vitest';
import { testAssets, testPlans, requirementsDocuments } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { resolveExecuteInputs, ExecutePrerequisiteError } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('resolveExecuteInputs', () => {
  const ctx = withPipelineSchema([testAssets, testPlans, requirementsDocuments]);

  it('resolves the k6 asset, baseUrl, and steady window', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({
      companyId: ctx.companyId, slaTargets: [], minSampleCount: 200,
      targetEnvironment: { baseUrl: 'https://staging.example.com' },
    }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({
      companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, executionModel: 'weighted-loop',
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
    }).returning();
    await ctx.db.insert(testAssets).values({
      companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6-script', engine: 'k6', assetType: 'generated',
      scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }],
    }).returning();

    const out = await resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    expect(out.baseUrl).toBe('https://staging.example.com');
    expect(out.asset.scriptContent).toContain('export default');
    expect(out.asset.dataFiles).toHaveLength(1);
    expect(out.window).toEqual({ warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 });
    expect(out.testPlan.executionModel).toBe('weighted-loop');
  });

  it('throws ExecutePrerequisiteError when no k6 asset exists', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200, targetEnvironment: { baseUrl: 'http://x' } }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' } }).returning();
    await expect(resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id }))
      .rejects.toThrow(ExecutePrerequisiteError);
  });

  it('throws ExecutePrerequisiteError when baseUrl is missing', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200, targetEnvironment: {} }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' } }).returning();
    await ctx.db.insert(testAssets).values({ companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6', engine: 'k6', assetType: 'generated', scriptContent: 'x' });
    await expect(resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id }))
      .rejects.toThrow(/baseUrl/);
  });
});
