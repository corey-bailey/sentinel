export type RequestStats = {
  totalRequests: number;
  failedRequests: number;
};

export type MetricSummary = {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errorRate: number;
};

function percentile(sorted: number[], p: number): number {
  // R-7 method: linear interpolation on sorted positions
  const h = (sorted.length - 1) * (p / 100);
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  if (lower === upper) return sorted[lower];
  const value = sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
  return round2(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeSummary(rawValues: number[], stats: RequestStats): MetricSummary {
  const { totalRequests, failedRequests } = stats;

  const errorRate = totalRequests === 0
    ? 0
    : round2(failedRequests / totalRequests);

  if (rawValues.length === 0) {
    return { p50: null, p95: null, p99: null, errorRate };
  }

  const sorted = [...rawValues].sort((a, b) => a - b);

  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    errorRate,
  };
}
