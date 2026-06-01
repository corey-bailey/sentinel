import { metricSeries, type Db } from '@sentinel/db';
import type { MetricPhase } from './metric-phases.js';

export type IngestSeriesEntry = {
  metric: string; // SLA-metric key: p95_ms | p99_ms | error_rate | tps | ...
  workflowName?: string | null;
  phase?: MetricPhase | null;
  value: number;
  sampleCount?: number | null;
  rawValues?: number[] | null;
  digest?: Record<string, unknown> | null;
};

export type IngestPayload = {
  testRunId: string;
  executionRunId?: string | null;
  source: string; // 'k6' | 'playwright' | 'apm:dynatrace' | ...
  series: IngestSeriesEntry[];
};

export function metricSeriesService(db: Db) {
  // Writes one metric_series row per series entry. Returns the inserted rows.
  async function ingest(companyId: string, payload: IngestPayload) {
    if (payload.series.length === 0) return [];
    const rows = payload.series.map((s) => ({
      companyId,
      testRunId: payload.testRunId,
      executionRunId: payload.executionRunId ?? null,
      metric: s.metric,
      source: payload.source,
      workflowName: s.workflowName ?? null,
      phase: s.phase ?? null,
      value: s.value,
      rawValues: s.rawValues ?? null,
      digest: s.digest ?? null,
      sampleCount: s.sampleCount ?? null,
    }));
    return db.insert(metricSeries).values(rows).returning();
  }

  return { ingest };
}
