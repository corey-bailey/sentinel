import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type SpawnResult, runK6, parseK6Summary } from "../services/test-adapters/k6-adapter.js";

describe("parseK6Summary", () => {
  it("extracts p95 response time from k6 JSON summary", () => {
    const summary = {
      metrics: {
        http_req_duration: {
          type: "trend",
          values: { p90: 210.5, p95: 350.2, p99: 480.1, med: 150.3 },
        },
        http_reqs: { type: "counter", values: { count: 500, rate: 16.6 } },
        http_req_failed: { type: "rate", values: { rate: 0.012 } },
        vus: { type: "gauge", values: { value: 10 } },
        vus_max: { type: "gauge", values: { value: 10 } },
      },
    };
    const result = parseK6Summary(summary);
    expect(result.p95Ms).toBeCloseTo(350.2, 1);
    expect(result.p99Ms).toBeCloseTo(480.1, 1);
    expect(result.p50Ms).toBeCloseTo(150.3, 1);
    expect(result.errorRate).toBeCloseTo(0.012, 3);
    expect(result.totalRequests).toBe(500);
    expect(result.requestRate).toBeCloseTo(16.6, 1);
  });

  it("handles missing http_req_failed metric gracefully", () => {
    const summary = {
      metrics: {
        http_req_duration: {
          type: "trend",
          values: { p90: 100, p95: 200, p99: 300, med: 80 },
        },
        http_reqs: { type: "counter", values: { count: 100, rate: 10 } },
      },
    };
    const result = parseK6Summary(summary);
    expect(result.errorRate).toBe(0);
  });

  it("returns zero values when metrics are empty", () => {
    const result = parseK6Summary({ metrics: {} });
    expect(result.p95Ms).toBeNull();
    expect(result.totalRequests).toBe(0);
    expect(result.errorRate).toBe(0);
  });

  it("extracts VU count from vus_max metric", () => {
    const summary = {
      metrics: {
        vus_max: { type: "gauge", values: { value: 25 } },
      },
    };
    const result = parseK6Summary(summary);
    expect(result.peakVus).toBe(25);
  });
});

describe("runK6", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns k6 with correct script path and env vars", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ metrics: {} }),
      stderr: "",
    } satisfies SpawnResult);

    await runK6({
      scriptPath: "/scripts/load-test.js",
      baseUrl: "http://localhost:3000",
      loadProfile: { vus: 10, stages: [{ duration: "30s", target: 10 }] },
      spawnFn,
    });

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe("k6");
    expect(args).toContain("run");
    expect(args).toContain("/scripts/load-test.js");
    expect(opts.env).toMatchObject({ BASE_URL: "http://localhost:3000" });
  });

  it("passes VUs and stages from load_profile", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ metrics: {} }),
      stderr: "",
    } satisfies SpawnResult);

    await runK6({
      scriptPath: "/scripts/test.js",
      baseUrl: "http://localhost:3000",
      loadProfile: { vus: 50, stages: [{ duration: "1m", target: 50 }, { duration: "30s", target: 0 }] },
      spawnFn,
    });

    const [_cmd, args] = spawnFn.mock.calls[0];
    // Should pass stage config to k6 via --stage flag or env var
    const argsStr = args.join(" ");
    expect(argsStr).toMatch(/50|stage/i);
  });

  it("marks result as failed when k6 exits with non-zero code", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 99,
      stdout: "",
      stderr: "ERRO[0000] script error",
    } satisfies SpawnResult);

    const result = await runK6({
      scriptPath: "/scripts/test.js",
      baseUrl: "http://localhost:3000",
      loadProfile: { vus: 1, stages: [{ duration: "10s", target: 1 }] },
      spawnFn,
    });

    expect(result.exitCode).toBe(99);
    expect(result.failed).toBe(true);
  });

  it("handles k6 binary not found gracefully", async () => {
    const spawnFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn k6 ENOENT"), { code: "ENOENT" }),
    );

    await expect(runK6({
      scriptPath: "/scripts/test.js",
      baseUrl: "http://localhost:3000",
      loadProfile: { vus: 1, stages: [] },
      spawnFn,
    })).rejects.toThrow(/k6.*not found|ENOENT/i);
  });

  it("passes BASE_URL env var to k6 process", async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ metrics: {} }),
      stderr: "",
    } satisfies SpawnResult);

    await runK6({
      scriptPath: "/test.js",
      baseUrl: "https://api.example.com",
      loadProfile: { vus: 5, stages: [{ duration: "10s", target: 5 }] },
      spawnFn,
    });

    const [_cmd, _args, opts] = spawnFn.mock.calls[0];
    expect(opts.env.BASE_URL).toBe("https://api.example.com");
  });
});
