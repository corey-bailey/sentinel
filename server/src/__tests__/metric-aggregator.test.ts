import { describe, it, expect } from "vitest";
import { computeSummary, type MetricSummary } from "../services/metric-aggregator.js";

describe("computeSummary", () => {
  it("computes p50, p95, p99 correctly from raw values", () => {
    // 100 values: 1-100 ms
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const result = computeSummary(values, { totalRequests: 100, failedRequests: 0 });
    expect(result.p50).toBe(50.5);
    expect(result.p95).toBe(95.05);
    expect(result.p99).toBe(99.01);
  });

  it("computes error_rate as fraction of failed requests", () => {
    const result = computeSummary([100, 200, 300], { totalRequests: 10, failedRequests: 2 });
    expect(result.errorRate).toBe(0.2);
  });

  it("handles empty raw_values array", () => {
    const result = computeSummary([], { totalRequests: 0, failedRequests: 0 });
    expect(result.p50).toBeNull();
    expect(result.p95).toBeNull();
    expect(result.p99).toBeNull();
    expect(result.errorRate).toBe(0);
  });

  it("handles single-element array", () => {
    const result = computeSummary([250], { totalRequests: 1, failedRequests: 0 });
    expect(result.p50).toBe(250);
    expect(result.p95).toBe(250);
    expect(result.p99).toBe(250);
  });

  it("handles all-zero values", () => {
    const result = computeSummary([0, 0, 0], { totalRequests: 3, failedRequests: 0 });
    expect(result.p50).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.p99).toBe(0);
    expect(result.errorRate).toBe(0);
  });

  it("rounds to 2 decimal places", () => {
    const values = [100, 200, 333];
    const result = computeSummary(values, { totalRequests: 3, failedRequests: 1 });
    expect(result.errorRate).toBe(0.33);
    // All percentile results should have at most 2 decimal places
    if (result.p50 !== null) {
      expect(Number(result.p50.toFixed(2))).toBe(result.p50);
    }
  });

  it("computes error_rate of 0 when no failures", () => {
    const result = computeSummary([100, 200], { totalRequests: 5, failedRequests: 0 });
    expect(result.errorRate).toBe(0);
  });

  it("computes error_rate of 1 when all fail", () => {
    const result = computeSummary([100, 200], { totalRequests: 5, failedRequests: 5 });
    expect(result.errorRate).toBe(1);
  });
});
