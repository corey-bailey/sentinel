// server/src/__tests__/test-assets-generated.test.ts
import { describe, expect, it } from 'vitest';
import { testAssets, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { testAssetService } from '../services/test-assets.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('testAssetService.create (generated asset fields)', () => {
  const ctx = withPipelineSchema([testAssets, testPlans]);

  it('persists scriptContent, dataFiles, setupScript, generatedFrom, protocol for a generated asset', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const svc = testAssetService(ctx.db);
    const row = await svc.create(ctx.companyId, {
      testPlanId: plan!.id,
      engine: 'k6',
      assetType: 'generated',
      protocol: 'http',
      generatedFrom: 'scratch',
      scriptContent: 'export default function () {}',
      dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }],
      setupScript: null,
    });
    const [persisted] = await ctx.db.select().from(testAssets).where(eq(testAssets.id, row.id));
    expect(persisted?.assetType).toBe('generated');
    expect(persisted?.protocol).toBe('http');
    expect(persisted?.generatedFrom).toBe('scratch');
    expect(persisted?.scriptContent).toBe('export default function () {}');
    expect(persisted?.dataFiles).toEqual([{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }]);
  });
});
