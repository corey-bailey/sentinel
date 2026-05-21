import { describe, it, expect, vi } from "vitest";
import { parsePytestReport, runPytest, type SpawnResult } from "../services/test-adapters/pytest-adapter.js";

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  summary: { passed: 3, failed: 1, error: 0, total: 4 },
  tests: [
    { nodeid: "test_checkout.py::test_add_to_cart", outcome: "passed", duration: 0.25 },
    { nodeid: "test_checkout.py::test_checkout_flow", outcome: "passed", duration: 1.1 },
    { nodeid: "test_checkout.py::test_payment", outcome: "passed", duration: 0.8 },
    { nodeid: "test_checkout.py::test_coupon", outcome: "failed", duration: 0.3, longrepr: "AssertionError: Expected 200 got 404" },
  ],
  ...overrides,
});

describe("parsePytestReport", () => {
  it("parses JSON report into pass/fail MetricSeries data", () => {
    const result = parsePytestReport(makeReport());
    expect(result.totalTests).toBe(4);
    expect(result.passedTests).toBe(3);
    expect(result.failedTests).toBe(1);
    expect(result.passRate).toBeCloseTo(0.75, 2);
  });

  it("records error details for failed tests", () => {
    const result = parsePytestReport(makeReport());
    const failed = result.testCases.find((t) => t.passed === false);
    expect(failed).toBeDefined();
    expect(failed?.errorMessage).toContain("AssertionError");
  });

  it("writes source=pytest on returned metrics", () => {
    const result = parsePytestReport(makeReport());
    expect(result.source).toBe("pytest");
  });

  it("handles empty test result gracefully", () => {
    const result = parsePytestReport({ summary: { passed: 0, failed: 0, total: 0 }, tests: [] });
    expect(result.totalTests).toBe(0);
    expect(result.passRate).toBe(1);
  });
});

describe("runPytest", () => {
  it("runs pytest with --json-report flag", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      jsonReportPath: "/tmp/report.json",
      jsonReport: makeReport(),
    } satisfies SpawnResult);

    await runPytest({ testPath: "tests/", spawnFn });

    const [cmd, args] = spawnFn.mock.calls[0];
    const fullCmd = `${cmd} ${args.join(" ")}`;
    expect(fullCmd).toMatch(/pytest/);
    expect(args.join(" ")).toMatch(/--json-report/);
  });

  it("marks result as failed when any test fails", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "",
      jsonReportPath: "/tmp/report.json",
      jsonReport: makeReport(),
    } satisfies SpawnResult);

    const result = await runPytest({ testPath: "tests/", spawnFn });
    expect(result.failed).toBe(true);
  });

  it("handles missing pytest binary gracefully with clear error", async () => {
    const spawnFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn pytest ENOENT"), { code: "ENOENT" }),
    );
    await expect(runPytest({ testPath: "tests/", spawnFn }))
      .rejects.toThrow(/pytest.*not found|ENOENT/i);
  });
});
