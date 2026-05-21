import { describe, it, expect } from "vitest";
import {
  evaluateSLATarget,
  evaluateAllTargets,
  type SLATarget,
  type SLAEvaluation,
  type AllTargetsResult,
} from "../services/sla-evaluator.js";

const base: SLATarget = {
  id: "t1",
  metric: "p95_ms",
  operator: "lt",
  threshold: 500,
  source: "k6",
};

describe("evaluateSLATarget", () => {
  it("passes when metric satisfies lt operator", () => {
    const result = evaluateSLATarget(base, 400);
    expect(result.status).toBe("pass");
    expect(result.actualValue).toBe(400);
  });

  it("fails when metric exceeds lt threshold", () => {
    const result = evaluateSLATarget(base, 600);
    expect(result.status).toBe("fail");
    expect(result.actualValue).toBe(600);
    expect(result.threshold).toBe(500);
  });

  it("passes when metric satisfies gt operator", () => {
    const target: SLATarget = { ...base, operator: "gt", threshold: 90 };
    const result = evaluateSLATarget(target, 95);
    expect(result.status).toBe("pass");
  });

  it("fails when metric does not satisfy gt operator", () => {
    const target: SLATarget = { ...base, operator: "gt", threshold: 90 };
    const result = evaluateSLATarget(target, 80);
    expect(result.status).toBe("fail");
  });

  it("passes when metric satisfies lte at boundary", () => {
    const target: SLATarget = { ...base, operator: "lte", threshold: 500 };
    const result = evaluateSLATarget(target, 500);
    expect(result.status).toBe("pass");
  });

  it("passes when metric satisfies gte at boundary", () => {
    const target: SLATarget = { ...base, operator: "gte", threshold: 99 };
    const result = evaluateSLATarget(target, 99);
    expect(result.status).toBe("pass");
  });

  it("returns skipped when metric source is unavailable", () => {
    const result = evaluateSLATarget(base, undefined);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/unavailable/i);
  });

  it("returns skipped with reason when APM is unavailable", () => {
    const apmTarget: SLATarget = { ...base, source: "apm:dynatrace" };
    const result = evaluateSLATarget(apmTarget, undefined, { apmUnavailable: true });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/apm.*unavailable/i);
  });

  it("handles NaN metric value gracefully", () => {
    const result = evaluateSLATarget(base, Number.NaN);
    expect(result.status).toBe("skipped");
  });

  it("handles null metric value gracefully", () => {
    const result = evaluateSLATarget(base, null as unknown as number);
    expect(result.status).toBe("skipped");
  });
});

describe("evaluateAllTargets", () => {
  it("returns all_pass when every SLATarget passes", () => {
    const targets: SLATarget[] = [
      { id: "t1", metric: "p95_ms", operator: "lt", threshold: 500, source: "k6" },
      { id: "t2", metric: "error_rate", operator: "lt", threshold: 0.01, source: "k6" },
    ];
    const metrics: Record<string, number> = { p95_ms: 300, error_rate: 0.005 };
    const result = evaluateAllTargets(targets, metrics);
    expect(result.outcome).toBe("all_pass");
    expect(result.breaches).toHaveLength(0);
  });

  it("returns breaches[] when one or more targets fail", () => {
    const targets: SLATarget[] = [
      { id: "t1", metric: "p95_ms", operator: "lt", threshold: 500, source: "k6" },
      { id: "t2", metric: "error_rate", operator: "lt", threshold: 0.01, source: "k6" },
    ];
    const metrics: Record<string, number> = { p95_ms: 700, error_rate: 0.005 };
    const result = evaluateAllTargets(targets, metrics);
    expect(result.outcome).toBe("breach");
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0].targetId).toBe("t1");
  });

  it("includes skipped targets separately from failures", () => {
    const targets: SLATarget[] = [
      { id: "t1", metric: "p95_ms", operator: "lt", threshold: 500, source: "k6" },
      { id: "t2", metric: "apm_cpu", operator: "lt", threshold: 80, source: "apm:dynatrace" },
    ];
    const metrics: Record<string, number> = { p95_ms: 300 };
    const result = evaluateAllTargets(targets, metrics, { apmUnavailable: true });
    expect(result.outcome).toBe("all_pass");
    expect(result.breaches).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].targetId).toBe("t2");
  });

  it("APM-sourced targets do not fail run when apm_unavailable", () => {
    const targets: SLATarget[] = [
      { id: "t1", metric: "apm_p95", operator: "lt", threshold: 100, source: "apm:dynatrace" },
    ];
    const metrics: Record<string, number> = {};
    const result = evaluateAllTargets(targets, metrics, { apmUnavailable: true });
    expect(result.outcome).toBe("all_pass");
    expect(result.breaches).toHaveLength(0);
  });
});
