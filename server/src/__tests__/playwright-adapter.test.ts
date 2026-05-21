import { describe, it, expect, vi } from "vitest";
import { parsePlaywrightReport, runPlaywright, type SpawnResult } from "../services/test-adapters/playwright-adapter.js";

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  suites: [
    {
      title: "checkout.spec.ts",
      specs: [
        { title: "adds item to cart", ok: true, tests: [{ results: [{ status: "passed", duration: 120 }] }] },
        { title: "completes checkout", ok: true, tests: [{ results: [{ status: "passed", duration: 250 }] }] },
      ],
    },
  ],
  ...overrides,
});

describe("parsePlaywrightReport", () => {
  it("extracts pass_rate_pct as primary metric", () => {
    const result = parsePlaywrightReport(makeReport());
    expect(result.passRate).toBe(1);
    expect(result.totalTests).toBe(2);
    expect(result.passedTests).toBe(2);
    expect(result.failedTests).toBe(0);
  });

  it("computes pass_rate_pct with failures", () => {
    const report = makeReport({
      suites: [
        {
          title: "checkout.spec.ts",
          specs: [
            { title: "passes", ok: true, tests: [{ results: [{ status: "passed", duration: 100 }] }] },
            { title: "fails", ok: false, tests: [{ results: [{ status: "failed", duration: 50, error: { message: "Expected 1, got 2" } }] }] },
          ],
        },
      ],
    });
    const result = parsePlaywrightReport(report);
    expect(result.passRate).toBe(0.5);
    expect(result.failedTests).toBe(1);
  });

  it("returns individual test case pass/fail data", () => {
    const result = parsePlaywrightReport(makeReport());
    expect(result.testCases).toHaveLength(2);
    expect(result.testCases[0].title).toBe("adds item to cart");
    expect(result.testCases[0].passed).toBe(true);
    expect(result.testCases[0].durationMs).toBe(120);
  });

  it("captures error details for failed tests", () => {
    const report = makeReport({
      suites: [
        {
          title: "test.spec.ts",
          specs: [
            {
              title: "broken test",
              ok: false,
              tests: [{ results: [{ status: "failed", duration: 30, error: { message: "Expected 'foo' to equal 'bar'" } }] }],
            },
          ],
        },
      ],
    });
    const result = parsePlaywrightReport(report);
    expect(result.testCases[0].errorMessage).toContain("Expected 'foo'");
  });

  it("handles empty report gracefully", () => {
    const result = parsePlaywrightReport({ suites: [] });
    expect(result.passRate).toBe(1); // vacuously true — no failures
    expect(result.totalTests).toBe(0);
  });
});

describe("runPlaywright", () => {
  it("runs npx playwright test with correct spec file path", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(makeReport()),
      stderr: "",
    } satisfies SpawnResult);

    await runPlaywright({
      specPath: "tests/checkout.spec.ts",
      spawnFn,
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(`${cmd} ${args.join(" ")}`).toMatch(/npx.*playwright.*test|playwright.*test/);
    expect(args).toContain("tests/checkout.spec.ts");
  });

  it("marks result as failed when any spec fails", async () => {
    const failReport = makeReport({
      suites: [{
        title: "t.spec.ts",
        specs: [{ title: "fails", ok: false, tests: [{ results: [{ status: "failed", duration: 10 }] }] }],
      }],
    });
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify(failReport),
      stderr: "",
    } satisfies SpawnResult);

    const result = await runPlaywright({ specPath: "t.spec.ts", spawnFn });
    expect(result.failed).toBe(true);
  });

  it("handles missing spec file gracefully", async () => {
    const spawnFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("No tests found"), { code: "ERR_NOT_FOUND" }),
    );
    await expect(runPlaywright({ specPath: "missing.spec.ts", spawnFn }))
      .rejects.toThrow();
  });

  it("writes source=playwright on returned metric data", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(makeReport()),
      stderr: "",
    } satisfies SpawnResult);

    const result = await runPlaywright({ specPath: "t.spec.ts", spawnFn });
    expect(result.source).toBe("playwright");
  });
});
