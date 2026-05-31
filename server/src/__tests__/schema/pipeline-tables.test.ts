import { describe, expect, it } from 'vitest';
import { pipelineRequests, requirementsDocuments, pipelineRuns, executionRuns, slaVerdicts, gateResolutions, testRunArtifacts } from '@sentinel/db';
import type { SlaTarget, StageRecordMap, PipelineTrigger } from '@sentinel/db';
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

d('pipeline_runs', () => {
  const ctx = withPipelineSchema([pipelineRuns]);

  it('defaults verdict=pending, ciSignal=pending; stores trigger + stages jsonb', async () => {
    const trigger: PipelineTrigger = { type: 'manual_intake', source: 'ui' };
    const stages: StageRecordMap = {
      intake: { status: 'pending' },
      discovery: { status: 'pending' },
      plan: { status: 'pending' },
      generate: { status: 'pending' },
      validate: { status: 'pending' },
      execute: { status: 'pending' },
      analysis: { status: 'pending' },
      report: { status: 'pending' },
    };
    const [row] = await ctx.db
      .insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger, stages })
      .returning();

    expect(row.verdict).toBe('pending');
    expect(row.ciSignal).toBe('pending');
    expect(row.trigger).toEqual(trigger);
    expect(Object.keys(row.stages ?? {})).toHaveLength(8);
  });
});

d('execution_runs', () => {
  const ctx = withPipelineSchema([executionRuns, pipelineRuns]);

  it('requires pipelineRunId, defaults status=queued', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: pr.id, engine: 'k6', binaryProfile: 'k6' })
      .returning();
    expect(row.status).toBe('queued');
    expect(row.pipelineRunId).toBe(pr.id);
  });
});

d('sla_verdicts', () => {
  const ctx = withPipelineSchema([slaVerdicts, pipelineRuns]);

  it('stores a windowed verdict joined to a stable slaTargetId', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(slaVerdicts).values({
      companyId: ctx.companyId, pipelineRunId: pr.id, slaTargetId: 't1',
      metric: 'p95_ms', operator: 'lt', threshold: 200, actualValue: 180,
      evaluationWindow: { startMs: 120_000, endMs: 720_000 },
      source: 'k6', status: 'pass', evaluatedOnSuccessOnly: true,
    }).returning();
    expect(row.status).toBe('pass');
    expect(row.evaluationWindow).toEqual({ startMs: 120_000, endMs: 720_000 });
    expect(row.evaluatedOnSuccessOnly).toBe(true);
  });
});

d('gate_resolutions', () => {
  const ctx = withPipelineSchema([gateResolutions, pipelineRuns]);

  it('stores outcome + total ciSignal', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(gateResolutions).values({
      companyId: ctx.companyId, pipelineRunId: pr.id,
      outcome: 'characterization', ciSignal: 'pass', resolvedBy: 'auto',
    }).returning();
    expect(row.outcome).toBe('characterization');
    expect(row.ciSignal).toBe('pass');
  });
});

d('test_run_artifacts', () => {
  const ctx = withPipelineSchema([testRunArtifacts, pipelineRuns]);

  it('stores an artifact with default publishStatus=stored', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(testRunArtifacts).values({
      companyId: ctx.companyId, pipelineRunId: pr.id,
      artifactType: 'k6_html_summary', storageRef: 's3://bucket/summary.html',
    }).returning();
    expect(row.artifactType).toBe('k6_html_summary');
    expect(row.publishStatus).toBe('stored');
  });
});
