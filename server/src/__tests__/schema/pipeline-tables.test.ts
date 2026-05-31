import { describe, expect, it } from 'vitest';
import { pipelineRequests, requirementsDocuments } from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from '../helpers/pipeline-schema-fixture.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipeline_requests', () => {
  const ctx = withPipelineSchema([pipelineRequests]);

  it('inserts with defaults and round-trips jsonb', async () => {
    const [row] = await ctx.db
      .insert(pipelineRequests)
      .values({
        companyId: ctx.companyId,
        source: 'manual_intake',
        ownerUserId: 'user-1',
        artifacts: { openApiSpec: { paths: {} } },
        extractedContext: { appName: 'payments' },
      })
      .returning();

    expect(row.id).toBeTruthy();
    expect(row.status).toBe('pending_confirmation'); // default
    expect(row.source).toBe('manual_intake');
    expect(row.artifacts).toEqual({ openApiSpec: { paths: {} } });
    expect(row.extractedContext).toEqual({ appName: 'payments' });
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

d('requirements_documents', () => {
  const ctx = withPipelineSchema([requirementsDocuments]);

  it('defaults minSampleCount=200 and testIntent=conformance, stores sla targets', async () => {
    const targets: SlaTarget[] = [
      { id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true },
    ];
    const [row] = await ctx.db
      .insert(requirementsDocuments)
      .values({
        companyId: ctx.companyId,
        appName: 'payments',
        ownerUserId: 'user-1',
        protocol: ['http'],
        syncModel: 'sync',
        slaTargets: targets,
      })
      .returning();

    expect(row.minSampleCount).toBe(200); // p95 floor default
    expect(row.testIntent).toBe('conformance'); // default
    expect(row.status).toBe('in_progress'); // default
    expect(row.slaTargets).toEqual(targets);
  });
});
