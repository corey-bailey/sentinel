import { computeSummary } from "../metric-aggregator.js";

export class APMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APMUnavailableError";
  }
}

export type DynatraceConfig = {
  apiUrl: string;
  apiToken: string;
  serviceId: string;
};

export type TimeWindow = {
  startedAt: Date;
  completedAt: Date;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type DynatraceMetrics = {
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  errorRatePct: number | null;
  dbCallCount: number | null;
  source: "apm:dynatrace";
};

type DynatraceMetricResult = {
  metricId: string;
  data: Array<{ values: (number | null)[] }>;
};

type DynatraceMetricResponse = {
  resolution: string;
  result: DynatraceMetricResult[];
};

async function fetchMetric(
  config: DynatraceConfig,
  window: TimeWindow,
  metricSelector: string,
  fetchFn: FetchFn,
): Promise<(number | null)[]> {
  const from = window.startedAt.getTime();
  const to = window.completedAt.getTime();
  const entitySelector = `type(SERVICE),entityId(${config.serviceId})`;
  const url = `${config.apiUrl}/api/v2/metrics/query?metricSelector=${encodeURIComponent(metricSelector)}&from=${from}&to=${to}&entitySelector=${encodeURIComponent(entitySelector)}`;

  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await fetchFn(url, {
      headers: {
        Authorization: `Api-Token ${config.apiToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    throw new APMUnavailableError(`Dynatrace network error: ${(err as Error).message}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new APMUnavailableError(`Dynatrace authentication failed (HTTP ${response.status})`);
    }
    // 404 and other non-auth errors → return empty (service not instrumented etc.)
    return [];
  }

  const data = await response.json() as DynatraceMetricResponse;
  return data.result?.[0]?.data?.[0]?.values ?? [];
}

export async function queryDynatraceMetrics(
  config: DynatraceConfig,
  window: TimeWindow,
  opts: { fetchFn: FetchFn },
): Promise<DynatraceMetrics> {
  const { fetchFn } = opts;

  // Response time is in microseconds — convert to ms
  const responseTimeValues = await fetchMetric(
    config, window,
    "builtin:service.response.time",
    fetchFn,
  );

  const responseTimeMs = responseTimeValues
    .filter((v): v is number => v !== null)
    .map((v) => v / 1000);

  const summary = computeSummary(responseTimeMs, { totalRequests: responseTimeMs.length, failedRequests: 0 });

  // Error rate
  let errorRatePct: number | null = null;
  try {
    const errValues = await fetchMetric(config, window, "builtin:service.errors.total.rate", fetchFn);
    const validErr = errValues.filter((v): v is number => v !== null);
    if (validErr.length > 0) {
      errorRatePct = validErr.reduce((a, b) => a + b, 0) / validErr.length;
    }
  } catch {
    // ignore secondary metric failures
  }

  return {
    p50Ms: summary.p50,
    p95Ms: summary.p95,
    p99Ms: summary.p99,
    errorRatePct,
    dbCallCount: null,
    source: "apm:dynatrace",
  };
}
