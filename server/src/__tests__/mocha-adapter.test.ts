import { describe, it, expect, vi } from "vitest";
import { parseMochaReport, runMocha, type SpawnResult } from "../services/test-adapters/mocha-adapter.js";

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  stats: { passes: 3, failures: 1, pending: 0, tests: 4, duration: 1500 },
  tests: [
    { fullTitle: "Checkout adds item to cart", duration: 200, currentRetry: 0 },
    { fullTitle: "Checkout processes payment", duration: 500, currentRetry: 0 },
    { fullTitle: "Checkout applies coupon", duration: 300, currentRetry: 0 },
  ],
  failures: [
    { fullTitle: "Checkout validates address", err: { message: "Expected 200 got 400" }, duration: 150, currentRetry: 0 },
  ],
  pending: [],
  ...overrides,
});

describe("parseMochaReport", () => {
  it("parses mocha JSON output into pass/fail counts", () => {
    const result = parseMochaReport(makeReport());
    expect(result.totalTests).toBe(4);
    expect(result.passedTests).toBe(3);
    expect(result.failedTests).toBe(1);
    expect(result.passRate).toBe(0.75);
  });

  it("records pass/fail counts as metrics", () => {
    const result = parseMochaReport(makeReport());
    expect(result.passedTests).toBe(3);
    expect(result.failedTests).toBe(1);
  });

  it("writes source=mocha on returned metrics", () => {
    const result = parseMochaReport(makeReport());
    expect(result.source).toBe("mocha");
  });

  it("captures error message for failed tests", () => {
    const result = parseMochaReport(makeReport());
    const failed = result.testCases.find((t) => !t.passed);
    expect(failed?.errorMessage).toContain("Expected 200");
  });

  it("handles empty mocha report", () => {
    const result = parseMochaReport({ stats: { passes: 0, failures: 0, tests: 0, duration: 0 }, tests: [], failures: [], pending: [] });
    expect(result.totalTests).toBe(0);
    expect(result.passRate).toBe(1);
  });
});

describe("runMocha", () => {
  it("runs mocha with --reporter json flag", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(makeReport()),
      stderr: "",
    } satisfies SpawnResult);

    await runMocha({ testPattern: "test/**/*.test.js", spawnFn });

    const [cmd, args] = spawnFn.mock.calls[0];
    const fullCmd = `${cmd} ${args.join(" ")}`;
    expect(fullCmd).toMatch(/mocha/);
    expect(args).toContain("--reporter");
    expect(args).toContain("json");
  });

  it("marks result as failed when any test fails", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify(makeReport()),
      stderr: "",
    } satisfies SpawnResult);

    const result = await runMocha({ testPattern: "test/**/*.test.js", spawnFn });
    expect(result.failed).toBe(true);
  });

  it("handles mocha not in PATH gracefully", async () => {
    const spawnFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn mocha ENOENT"), { code: "ENOENT" }),
    );
    await expect(runMocha({ testPattern: "test/**/*.test.js", spawnFn }))
      .rejects.toThrow(/mocha.*not found|ENOENT/i);
  });
});
