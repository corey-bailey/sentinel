import { describe, it, expect, vi } from "vitest";
import {
  queryDynatraceMetrics,
  APMUnavailableError,
  type DynatraceConfig,
  type TimeWindow,
} from "../services/test-adapters/dynatrace-adapter.js";

const config: DynatraceConfig = {
  apiUrl: "https://abc.live.dynatrace.com",
  apiToken: "dt0c01.test.token",
  serviceId: "SERVICE-ABC123",
};

const window: TimeWindow = {
  startedAt: new Date("2026-05-01T10:00:00Z"),
  completedAt: new Date("2026-05-01T10:10:00Z"),
};

describe("queryDynatraceMetrics", () => {
  it("queries Dynatrace API with correct time window", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resolution: "1m", result: [{ metricId: "builtin:service.response.time", data: [{ values: [120000, 150000, 130000] }] }] }),
    });

    await queryDynatraceMetrics(config, window, { fetchFn });

    expect(fetchFn).toHaveBeenCalled();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain(config.apiUrl);
    // Time window should be encoded in the query
    expect(url).toMatch(/from=|startTimestamp/i);
  });

  it("returns service response time as p50/p95/p99 MetricSeries", async () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000); // 1000-100000 microseconds
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolution: "1m",
        result: [{ metricId: "builtin:service.response.time", data: [{ values }] }],
      }),
    });

    const result = await queryDynatraceMetrics(config, window, { fetchFn });
    expect(result.p50Ms).not.toBeNull();
    expect(result.p95Ms).not.toBeNull();
    expect(result.p99Ms).not.toBeNull();
    expect(result.source).toBe("apm:dynatrace");
  });

  it("returns error_rate_pct as MetricSeries", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("failure.rate")) {
        return { ok: true, json: async () => ({ resolution: "1m", result: [{ metricId: "builtin:service.errors.total.rate", data: [{ values: [0.03, 0.02, 0.04] }] }] }) };
      }
      return { ok: true, json: async () => ({ resolution: "1m", result: [{ metricId: "builtin:service.response.time", data: [{ values: [100000] }] }] }) };
    });

    const result = await queryDynatraceMetrics(config, window, { fetchFn });
    expect(result.errorRatePct).not.toBeNull();
  });

  it("writes source=apm:dynatrace on all MetricSeries entries", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resolution: "1m", result: [] }),
    });

    const result = await queryDynatraceMetrics(config, window, { fetchFn });
    expect(result.source).toBe("apm:dynatrace");
  });

  it("returns empty metrics (not error) when Dynatrace returns 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "Service not found" } }),
    });

    const result = await queryDynatraceMetrics(config, window, { fetchFn });
    expect(result.p95Ms).toBeNull();
    expect(result.source).toBe("apm:dynatrace");
  });

  it("throws APMUnavailableError on authentication failure (401)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid token" } }),
    });

    await expect(queryDynatraceMetrics(config, window, { fetchFn }))
      .rejects.toThrow(APMUnavailableError);
  });

  it("throws APMUnavailableError on network timeout", async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("network timeout"), { name: "AbortError" }),
    );

    await expect(queryDynatraceMetrics(config, window, { fetchFn }))
      .rejects.toThrow(APMUnavailableError);
  });

  it("respects DYNATRACE_API_TOKEN from config", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resolution: "1m", result: [] }),
    });

    await queryDynatraceMetrics(config, window, { fetchFn });

    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers?.Authorization || headers?.authorization).toContain(config.apiToken);
  });
});
