import {
  requirementsDocuments, pipelineRuns, executionRuns, metricSeries, slaVerdicts,
  type Db, type SlaTarget,
} from '@sentinel/db';
import { and, eq } from 'drizzle-orm';
import { classifyVerdict } from './sla-evaluator.js';
import { SLA_EVALUATION_PHASE } from './metric-phases.js';

export type EvaluateInput = { companyId: string; pipelineRunId: string; executionRunId: string };
export type EvaluateResult = {
  verdictCount: number;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  optionalSkippedCount: number;
};

export function slaVerdictEngine(db: Db) {
  // Joins each live requirements_documents.slaTargets[] entry to its windowed, workflow-scoped,
  // source-matched, steady-phase metric_series row, classifies pass|fail|inconclusive (decision #7:
  // a REQUIRED target never false-greens), and persists one sla_verdicts row per blocking verdict.
  // OPTIONAL unmeasured targets are non-blocking — counted in optionalSkippedCount, not persisted.
  async function evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, input.pipelineRunId));
    if (!run || run.companyId !== input.companyId) throw new Error('pipeline_run not found for company');
    if (!run.requirementsDocumentId) {
      return { verdictCount: 0, passCount: 0, failCount: 0, inconclusiveCount: 0, optionalSkippedCount: 0 };
    }

    // rd and er are independent once run is loaded → fetch concurrently.
    const [[rd], [er]] = await Promise.all([
      db.select().from(requirementsDocuments).where(eq(requirementsDocuments.id, run.requirementsDocumentId)),
      db.select().from(executionRuns).where(eq(executionRuns.id, input.executionRunId)),
    ]);
    // Tenant + pipeline scoping: er is fetched by id alone, so verify it belongs to this
    // company-scoped pipeline run before computing runHealthy or joining its metric_series.
    if (!er || er.companyId !== input.companyId || er.pipelineRunId !== input.pipelineRunId) {
      throw new Error('execution_run not found for pipeline_run');
    }
    const targets = (rd?.slaTargets ?? []) as SlaTarget[];
    const minSampleCount = rd?.minSampleCount ?? 200;
    const runHealthy = er.status === 'completed' && (er.exitCode === 0 || er.exitCode === null);

    // Fetch this run's steady-phase series ONCE (tenant-scoped) and match per target in memory —
    // avoids an N+1 round-trip per SLA target. Key = metric|source|workflowName (first row wins,
    // matching the prior single-row select).
    const steadyRows = await db.select().from(metricSeries).where(and(
      eq(metricSeries.companyId, input.companyId),
      eq(metricSeries.executionRunId, input.executionRunId),
      eq(metricSeries.phase, SLA_EVALUATION_PHASE),
    ));
    const rowKey = (metric: string, source: string, workflowName: string | null) =>
      `${metric}|${source}|${workflowName ?? ''}`;
    const byKey = new Map<string, (typeof steadyRows)[number]>();
    for (const r of steadyRows) {
      const k = rowKey(r.metric, r.source, r.workflowName);
      if (!byKey.has(k)) byKey.set(k, r);
    }

    const verdictRows = [];
    let passCount = 0, failCount = 0, inconclusiveCount = 0, optionalSkippedCount = 0;
    for (const t of targets) {
      const row = byKey.get(rowKey(t.metric, t.source, t.workflowScope ?? null));
      const v = classifyVerdict(t, {
        value: row?.value ?? null,
        sampleCount: row?.sampleCount ?? null,
        minSampleCount,
        runHealthy,
      });
      // OPTIONAL unmeasured ('skipped') is NON-blocking (spec Stage 6): count it, persist no verdict row.
      // Only REQUIRED targets (and any measured pass/fail) produce a persisted verdict, so
      // inconclusiveCount is the BLOCKING (required-inconclusive) count the gate reads.
      if (v.status === 'skipped') { optionalSkippedCount++; continue; }
      if (v.status === 'pass') passCount++;
      else if (v.status === 'fail') failCount++;
      else inconclusiveCount++;
      verdictRows.push({
        companyId: input.companyId,
        pipelineRunId: input.pipelineRunId,
        executionRunId: input.executionRunId,
        slaTargetId: t.id,
        workflowName: t.workflowScope ?? null,
        phase: SLA_EVALUATION_PHASE,
        metric: t.metric,
        operator: t.operator,
        threshold: t.threshold,
        actualValue: v.actualValue ?? null,
        evaluationWindow: null, // populated from resolvedExecution.resolvedSteadyWindow in Plan 4 wiring
        source: t.source,
        status: v.status, // 'pass' | 'fail' | 'inconclusive'
        evaluatedOnSuccessOnly: true,
      });
    }
    if (verdictRows.length) await db.insert(slaVerdicts).values(verdictRows);

    return { verdictCount: verdictRows.length, passCount, failCount, inconclusiveCount, optionalSkippedCount };
  }
  return { evaluate };
}
