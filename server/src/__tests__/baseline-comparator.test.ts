import { describe, it, expect } from "vitest";
import {
  detectRegressions,
  type BaselineRecord,
  type RunMetrics,
  type RegressionResult,
} from "../services/baseline-comparator.js";

const makeBaseline = (overrides: Partial<BaselineRecord> = {}): BaselineRecord => ({
  id: "b1",
  testPlanId: "plan1",
  metric: "p95_ms",
  baselineValue: 400,
  tolerancePct: 10,
  isActive: true,
  ...overrides,
});

describe("detectRegressions", () => {
  it("returns empty when all metrics within baseline thresholds", () => {
    const baselines = [makeBaseline({ metric: "p95_ms", baselineValue: 400, tolerancePct: 10 })];
    const metrics: RunMetrics = { p95_ms: 430 }; // +7.5%, within 10%
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(0);
    expect(result.baselineProposal).toBeNull();
  });

  it("creates Regression when p95 exceeds baseline by >10%", () => {
    const baselines = [makeBaseline({ metric: "p95_ms", baselineValue: 400, tolerancePct: 10 })];
    const metrics: RunMetrics = { p95_ms: 500 }; // +25%
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].metric).toBe("p95_ms");
    expect(result.regressions[0].deviationPct).toBeCloseTo(25, 0);
  });

  it("creates Regression when error_rate exceeds baseline", () => {
    const baselines = [makeBaseline({ metric: "error_rate", baselineValue: 0.01, tolerancePct: 0 })];
    const metrics: RunMetrics = { error_rate: 0.05 };
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].metric).toBe("error_rate");
  });

  it("creates baseline_proposal when no active baseline exists", () => {
    const baselines: BaselineRecord[] = []; // no baselines at all
    const metrics: RunMetrics = { p95_ms: 300, error_rate: 0.005 };
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(0);
    expect(result.baselineProposal).not.toBeNull();
    expect(result.baselineProposal?.proposedValues).toMatchObject({ p95_ms: 300 });
  });

  it("uses only is_active=true baselines", () => {
    const baselines = [
      makeBaseline({ metric: "p95_ms", baselineValue: 400, tolerancePct: 10, isActive: false }),
    ];
    const metrics: RunMetrics = { p95_ms: 600 }; // would be regression against inactive baseline
    const result = detectRegressions(baselines, metrics);
    // inactive baselines are ignored → treated as no baseline → proposal
    expect(result.regressions).toHaveLength(0);
    expect(result.baselineProposal).not.toBeNull();
  });

  it("returns one Regression per breached SLATarget", () => {
    const baselines = [
      makeBaseline({ id: "b1", metric: "p95_ms", baselineValue: 400, tolerancePct: 10 }),
      makeBaseline({ id: "b2", metric: "error_rate", baselineValue: 0.01, tolerancePct: 0 }),
    ];
    const metrics: RunMetrics = { p95_ms: 500, error_rate: 0.05 };
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(2);
  });

  it("includes deviation_pct on each Regression", () => {
    const baselines = [makeBaseline({ metric: "p95_ms", baselineValue: 400, tolerancePct: 10 })];
    const metrics: RunMetrics = { p95_ms: 480 }; // +20%
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].deviationPct).toBeCloseTo(20, 0);
  });

  it("does not create regression when metric exactly at tolerance boundary", () => {
    // +10% is exactly the boundary — should NOT be a regression
    const baselines = [makeBaseline({ metric: "p95_ms", baselineValue: 400, tolerancePct: 10 })];
    const metrics: RunMetrics = { p95_ms: 440 }; // exactly +10%
    const result = detectRegressions(baselines, metrics);
    expect(result.regressions).toHaveLength(0);
  });
});
