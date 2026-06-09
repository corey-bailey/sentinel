// server/src/__tests__/baseline-comparator.test.ts
import { describe, expect, it } from "vitest";
import {
  BASELINE_SET_SIZE,
  aggregateBaselineSet,
  compareMetric,
  directionForMetric,
  isBaselineStale,
  isCleanRun,
  median,
  metricKey,
  parseMetricKey,
  regressionTypeForMetric,
  stddev,
  worseningDirection,
} from "../services/baseline-comparator.js";

describe("metricKey", () => {
  it("round-trips metric|source|workflowName and matches sla-verdict-engine keying", () => {
    expect(metricKey("p95_ms", "k6", "checkout")).toBe("p95_ms|k6|checkout");
    expect(metricKey("p95_ms", "k6", null)).toBe("p95_ms|k6|");
    expect(parseMetricKey("p95_ms|k6|checkout")).toEqual({ metric: "p95_ms", source: "k6", workflowName: "checkout" });
    expect(parseMetricKey("p95_ms|k6|")).toEqual({ metric: "p95_ms", source: "k6", workflowName: null });
  });
});

describe("direction resolution", () => {
  it("lt/lte targets worsen upward (latency caps); gt/gte worsen downward (throughput floors)", () => {
    expect(worseningDirection("lt")).toBe("up");
    expect(worseningDirection("lte")).toBe("up");
    expect(worseningDirection("gt")).toBe("down");
    expect(worseningDirection("gte")).toBe("down");
  });

  it("infers direction from the metric family when no SLA target exists", () => {
    expect(directionForMetric("p95_ms")).toBe("up");
    expect(directionForMetric("error_rate")).toBe("up");
    expect(directionForMetric("tps")).toBe("down");
    expect(directionForMetric("throughput_rps")).toBe("down");
  });
});

describe("regressionTypeForMetric", () => {
  it("maps metric families deterministically (no free-text default for known families)", () => {
    expect(regressionTypeForMetric("p95_ms")).toBe("latency_p95");
    expect(regressionTypeForMetric("p99_ms")).toBe("latency_p99");
    expect(regressionTypeForMetric("error_rate")).toBe("error_rate");
    expect(regressionTypeForMetric("tps")).toBe("throughput");
    expect(regressionTypeForMetric("saga_completion_ms")).toBe("saga_completion");
    expect(regressionTypeForMetric("something_else")).toBe("regression");
  });
});

describe("median / stddev / aggregateBaselineSet", () => {
  it("computes median for odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("computes sample stddev; 0 for fewer than two values", () => {
    expect(stddev([10])).toBe(0);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  it("aggregates the most recent K values per metric", () => {
    const out = aggregateBaselineSet({ "p95_ms|k6|": [100, 110, 105, 120, 115, 108, 112] }, 5);
    // last 5 values: [105, 120, 115, 108, 112] → median 112
    expect(out["p95_ms|k6|"]!.sampleN).toBe(5);
    expect(out["p95_ms|k6|"]!.median).toBe(112);
  });

  it("skips metrics with no values", () => {
    expect(aggregateBaselineSet({ empty: [] })).toEqual({});
  });
});

describe("compareMetric — dual-threshold truth table (high confidence)", () => {
  const baseline = { median: 100, stddev: 5, sampleN: BASELINE_SET_SIZE, tolerancePct: 10 };

  it("worsening + breaches tolerance + breaches z → flagged", () => {
    const r = compareMetric(baseline, 120, "up");
    expect(r).toMatchObject({ flagged: true, confidence: "high", isWorsening: true });
    expect(r.deltaPct).toBe(20);
    expect(r.zScore).toBe(4);
  });

  it("worsening + breaches tolerance but NOT z (wide distribution) → not flagged", () => {
    const noisy = { ...baseline, stddev: 50 }; // z = 20/50 = 0.4
    expect(compareMetric(noisy, 120, "up").flagged).toBe(false);
  });

  it("worsening + breaches z but NOT tolerance (tiny drift, tight distribution) → not flagged", () => {
    const tight = { ...baseline, stddev: 1 }; // 5% delta, z = 5
    expect(compareMetric(tight, 105, "up").flagged).toBe(false);
  });

  it("improving direction is never flagged, regardless of magnitude", () => {
    expect(compareMetric(baseline, 50, "up").flagged).toBe(false); // latency halved = better
    expect(compareMetric(baseline, 200, "down").flagged).toBe(false); // throughput doubled = better
  });

  it("direction-aware: throughput drop flags on 'down'", () => {
    const r = compareMetric(baseline, 70, "down");
    expect(r.flagged).toBe(true);
    expect(r.deltaPct).toBe(-30);
  });
});

describe("compareMetric — cold start (sampleN < K)", () => {
  const coldBaseline = { median: 100, stddev: 0, sampleN: 1, tolerancePct: 10 };

  it("tolerance-only, confidence low, zScore null", () => {
    const r = compareMetric(coldBaseline, 120, "up");
    expect(r).toMatchObject({ flagged: true, confidence: "low", zScore: null });
  });

  it("within tolerance → not flagged", () => {
    expect(compareMetric(coldBaseline, 105, "up").flagged).toBe(false);
  });

  it("zero median never divides by zero", () => {
    const r = compareMetric({ median: 0, stddev: 0, sampleN: 1, tolerancePct: 10 }, 50, "up");
    expect(r.deltaPct).toBe(0);
    expect(r.flagged).toBe(false);
  });
});

describe("isBaselineStale", () => {
  it("stale when the executor branch changed", () => {
    expect(isBaselineStale({ executor: "ramping-vus", peak: 100 }, { executor: "constant-arrival-rate", peak: 100 })).toBe(true);
  });

  it("stale when peak moved more than 20%", () => {
    expect(isBaselineStale({ executor: "ramping-vus", peak: 100 }, { executor: "ramping-vus", peak: 130 })).toBe(true);
    expect(isBaselineStale({ executor: "ramping-vus", peak: 100 }, { executor: "ramping-vus", peak: 110 })).toBe(false);
  });
});

describe("isCleanRun", () => {
  it("completed with exit 0 (or null) is clean; failures and aborts are not", () => {
    expect(isCleanRun({ status: "completed", exitCode: 0 })).toBe(true);
    expect(isCleanRun({ status: "completed", exitCode: null })).toBe(true);
    expect(isCleanRun({ status: "completed", exitCode: 1 })).toBe(false);
    expect(isCleanRun({ status: "aborted", exitCode: 0 })).toBe(false);
    expect(isCleanRun({ status: "failed", exitCode: 0 })).toBe(false);
  });
});
