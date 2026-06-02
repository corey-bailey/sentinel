// server/src/__tests__/test-run-artifacts-service.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testRunArtifacts, pipelineRuns, testRuns, executionRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { testRunArtifactsService } from '../services/test-run-artifacts.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const PR_STUB = {
  trigger: { type: 'ci' as const, source: 'test' },
  stages: { intake: { status: 'skipped' }, discovery: { status: 'skipped' }, plan: { status: 'skipped' },
    generate: { status: 'skipped' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' } },
};

d('testRunArtifactsService', () => {
  const ctx = withPipelineSchema([testRunArtifacts, executionRuns, testRuns, pipelineRuns, testPlans]);

  async function seed() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'completed' }).returning();
    return { pipelineRunId: pr!.id, testRunId: tr!.id, executionRunId: er!.id };
  }

  it('creates an artifact row', async () => {
    const { pipelineRunId, testRunId, executionRunId } = await seed();
    const svc = testRunArtifactsService(ctx.db);
    const row = await svc.create(ctx.companyId, {
      pipelineRunId, executionRunId, testRunId, artifactType: 'sentinel_summary',
      storageRef: '/tmp/x/summary.json', contentType: 'application/json', sizeBytes: 12,
    });
    expect(row.artifactType).toBe('sentinel_summary');
    expect(row.publishStatus).toBe('stored');
    const [persisted] = await ctx.db.select().from(testRunArtifacts).where(eq(testRunArtifacts.id, row.id));
    expect(persisted?.storageRef).toBe('/tmp/x/summary.json');
  });

  it('persistK6HtmlSummary records the cwd html file when present (and is a no-op when absent)', async () => {
    const { pipelineRunId, testRunId, executionRunId } = await seed();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'artf-'));
    await fs.writeFile(path.join(cwd, 'summary-tr-1.html'), '<html>report</html>');
    const svc = testRunArtifactsService(ctx.db);

    const made = await svc.persistK6HtmlSummary(ctx.companyId, { pipelineRunId, executionRunId, testRunId, cwd, testRunId2: 'tr-1' });
    expect(made?.artifactType).toBe('k6_html_summary');
    expect(made?.storageRef).toBe(path.join(cwd, 'summary-tr-1.html'));
    expect(made?.sizeBytes).toBeGreaterThan(0);

    const absent = await svc.persistK6HtmlSummary(ctx.companyId, { pipelineRunId, executionRunId, testRunId, cwd, testRunId2: 'missing' });
    expect(absent).toBeNull();
  });
});
