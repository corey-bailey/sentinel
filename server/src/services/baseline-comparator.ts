// server/src/services/baseline-comparator.ts
// Pure Stage-7 comparator: distribution-model baselines (median + stddev over K clean runs),
// dual-threshold flagging (tolerance% AND z-score), direction-aware comparison, cold-start
// fallback. The DB orchestration lives in baseline-comparator-runner.ts.

export const BASELINE_SET_SIZE = 5; // K: clean runs behind a high-confidence baseline
export const Z_SCORE_GATE = 2;

export type WorseningDirection = "up" | "down";
export type Confidence = "high" | "low";

// Single metric identity shared with sla-verdict-engine (metric|source|workflowName) — baselines
// store this key in `metric` so the join back to metric_series is unambiguous.
export function metricKey(metric: string, source: string, workflowName: string | null | undefined): string {
  return `${metric}|${source}|${workflowName ?? ""}`;
}

export function parseMetricKey(key: string): { metric: string; source: string; workflowName: string | null } {
  const [metric = "", source = "", workflowName = ""] = key.split("|");
  return { metric, source, workflowName: workflowName || null };
}

// For an SLA operator, which way does the metric WORSEN? lt/lte targets cap a
// bad-when-high metric (latency, error rate); gt/gte floor a bad-when-low one (throughput).
export function worseningDirection(operator: "lt" | "lte" | "gt" | "gte"): WorseningDirection {
  return operator === "lt" || operator === "lte" ? "up" : "down";
}

// Fallback when a metric has no SLA target: infer worsening direction from the metric family.
export function directionForMetric(metric: string): WorseningDirection {
  const m = metric.toLowerCase();
  if (m.includes("tps") || m.includes("throughput") || m.includes("rps") || m.includes("rate_per")) return "down";
  return "up"; // latency percentiles, error rates, durations
}

export function regressionTypeForMetric(metric: string): string {
  const m = metric.toLowerCase();
  if (m.includes("p95")) return "latency_p95";
  if (m.includes("p99")) return "latency_p99";
  if (m.includes("error")) return "error_rate";
  if (m.includes("tps") || m.includes("throughput") || m.includes("rps")) return "throughput";
  if (m.includes("saga") || m.includes("completion")) return "saga_completion";
  return "regression";
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export type BaselineStats = { median: number; stddev: number; sampleN: number };

// Aggregates the distribution model for each metric over its clean-run values (most recent K).
export function aggregateBaselineSet(
  cleanRunValues: Record<string, number[]>,
  k: number = BASELINE_SET_SIZE,
): Record<string, BaselineStats> {
  const out: Record<string, BaselineStats> = {};
  for (const [key, values] of Object.entries(cleanRunValues)) {
    if (values.length === 0) continue;
    const window = values.slice(-k);
    out[key] = { median: median(window), stddev: stddev(window), sampleN: window.length };
  }
  return out;
}

export type CompareInput = {
  median: number;
  stddev: number;
  sampleN: number;
  tolerancePct: number;
};

export type CompareResult = {
  deltaPct: number;
  zScore: number | null;
  flagged: boolean;
  confidence: Confidence;
  isWorsening: boolean;
};

// Dual-threshold worsening check. High confidence (sampleN >= K): flag only when the delta
// breaches tolerance AND the z-score gate — one noisy run against a tight distribution
// doesn't fire, nor does a consistent-but-tiny drift. Cold start (sampleN < K): tolerance-only,
// confidence 'low', zScore null (a stddev from <K runs would gate on noise).
export function compareMetric(
  baseline: CompareInput,
  actual: number,
  direction: WorseningDirection,
  zGate: number = Z_SCORE_GATE,
): CompareResult {
  const deltaPct = baseline.median === 0 ? 0 : ((actual - baseline.median) / Math.abs(baseline.median)) * 100;
  const isWorsening = direction === "up" ? actual > baseline.median : actual < baseline.median;
  const highConfidence = baseline.sampleN >= BASELINE_SET_SIZE;

  const zScore = highConfidence && baseline.stddev > 0 ? (actual - baseline.median) / baseline.stddev : null;
  const breachesTolerance = Math.abs(deltaPct) > baseline.tolerancePct;
  const breachesZ = zScore === null ? true : Math.abs(zScore) > zGate;

  return {
    deltaPct: Math.round(deltaPct * 100) / 100,
    zScore: zScore === null ? null : Math.round(zScore * 100) / 100,
    flagged: isWorsening && breachesTolerance && (highConfidence ? breachesZ : true),
    confidence: highConfidence ? "high" : "low",
    isWorsening,
  };
}

export type BaselineProfile = {
  executor?: string | null;
  peak?: number | null; // peak VUs or rate the baseline set was characterized at
};

// A baseline is stale when the load shape changed underneath it: different executor branch
// or a materially different peak (>20%). Stale baselines must be re-characterized, not compared.
export function isBaselineStale(baselineProfile: BaselineProfile, currentProfile: BaselineProfile): boolean {
  if ((baselineProfile.executor ?? null) !== (currentProfile.executor ?? null)) return true;
  const a = baselineProfile.peak ?? null;
  const b = currentProfile.peak ?? null;
  if (a === null || b === null) return a !== b;
  if (a === 0) return b !== 0;
  return Math.abs((b - a) / a) > 0.2;
}

// v1 clean-run proxy; the deliberate seam where Dynatrace ambient-pollution
// detection plugs in later (spec Stage 4/7) without touching the comparator.
export function isCleanRun(run: { status: string; exitCode: number | null }): boolean {
  return run.status === "completed" && (run.exitCode === 0 || run.exitCode === null);
}
