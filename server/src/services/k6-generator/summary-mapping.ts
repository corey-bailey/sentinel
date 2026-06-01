// server/src/services/k6-generator/summary-mapping.ts
// Harness-side transform: RAW k6 end-of-test summary (data) -> Sentinel metric_series rows.
// The windowed percentiles are computed IN-RUNNER by k6 over the {workflow,phase}-tagged threshold
// sub-metrics (Task 4); this only re-keys them to the SLA vocabulary — it does NOT recompute anything.

export type K6MetricValues = Record<string, number>;
export type K6RawSummary = { metrics?: Record<string, { type?: string; values?: K6MetricValues }> };

export type MappedSeriesEntry = {
  metric: string;
  workflowName: string | null;
  phase: 'steady';
  value: number;
  sampleCount: number | null;
};
export type MappedSummary = {
  series: MappedSeriesEntry[];
  run: { peakVus: number | null; totalRequests: number | null; totalIterations: number | null };
};

// SLA-vocab latency metric → the k6 Trend values stat key.
const LATENCY_STATS: Array<{ metric: string; stat: string }> = [
  { metric: 'p50_ms', stat: 'med' },
  { metric: 'p95_ms', stat: 'p(95)' },
  { metric: 'p99_ms', stat: 'p(99)' },
];

// Parse a tagged sub-metric key like 'http_req_duration{workflow:checkout,phase:steady,expected_response:true}'.
function parseTags(key: string): { base: string; tags: Record<string, string> } | null {
  const m = /^([^{]+)\{(.*)\}$/.exec(key);
  if (!m) return null; // untagged base metric (no braces) → not a sub-metric we ingest
  const tags: Record<string, string> = {};
  for (const pair of m[2]!.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    tags[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return { base: m[1]!.trim(), tags };
}

export function mapK6Summary(data: K6RawSummary): MappedSummary {
  const metrics = data.metrics ?? {};
  const series: MappedSeriesEntry[] = [];

  for (const [key, m] of Object.entries(metrics)) {
    const parsed = parseTags(key);
    if (!parsed || !m?.values) continue;
    const { base, tags } = parsed;
    if (tags.phase !== 'steady') continue; // only the authoritative window is ingested for verdicts
    const workflowName = tags.workflow ?? null;

    if (base === 'http_req_duration' && tags.expected_response === 'true') {
      const count = typeof m.values.count === 'number' ? m.values.count : null;
      for (const { metric, stat } of LATENCY_STATS) {
        const value = m.values[stat];
        if (typeof value === 'number') series.push({ metric, workflowName, phase: 'steady', value, sampleCount: count });
      }
    } else if (base === 'http_req_failed') {
      const value = m.values.rate;
      if (typeof value === 'number') {
        // NOTE: k6 reverses the passes/fails semantics on http_req_failed; we only SUM them for
        // sampleCount, so the swap is irrelevant. Never read passes/fails individually for a verdict.
        const passes = typeof m.values.passes === 'number' ? m.values.passes : 0;
        const fails = typeof m.values.fails === 'number' ? m.values.fails : 0;
        const sampleCount = passes + fails > 0 ? passes + fails : null;
        series.push({ metric: 'error_rate', workflowName, phase: 'steady', value, sampleCount });
      }
    }
  }

  const num = (k: string, f: string): number | null => {
    const v = metrics[k]?.values?.[f];
    return typeof v === 'number' ? v : null;
  };
  return {
    series,
    run: {
      peakVus: num('vus_max', 'max') ?? num('vus_max', 'value'),
      totalRequests: num('http_reqs', 'count'),
      totalIterations: num('iterations', 'count'),
    },
  };
}
