export type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string> },
) => Promise<SpawnResult>;

export type LoadProfile = {
  vus: number;
  stages: Array<{ duration: string; target: number }>;
};

export type K6RunOptions = {
  scriptPath: string;
  baseUrl: string;
  loadProfile: LoadProfile;
  spawnFn: SpawnFn;
  extraEnv?: Record<string, string>;
};

export type K6Metrics = {
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  errorRate: number;
  totalRequests: number;
  requestRate: number | null;
  peakVus: number | null;
};

export type K6RunResult = {
  exitCode: number;
  failed: boolean;
  metrics: K6Metrics;
  source: "k6";
};

type K6Summary = {
  metrics: Record<string, {
    type: string;
    values: Record<string, number>;
  }>;
};

export function parseK6Summary(summary: K6Summary): K6Metrics {
  const m = summary.metrics ?? {};

  const duration = m["http_req_duration"];
  const reqs = m["http_reqs"];
  const failed = m["http_req_failed"];
  const vusMax = m["vus_max"];

  return {
    p50Ms: duration?.values?.med ?? null,
    p95Ms: duration?.values?.p95 ?? null,
    p99Ms: duration?.values?.p99 ?? null,
    errorRate: failed?.values?.rate ?? 0,
    totalRequests: reqs?.values?.count ?? 0,
    requestRate: reqs?.values?.rate ?? null,
    peakVus: vusMax?.values?.value ?? null,
  };
}

export async function runK6(opts: K6RunOptions): Promise<K6RunResult> {
  const { scriptPath, baseUrl, loadProfile, spawnFn, extraEnv = {} } = opts;

  const args = [
    "run",
    "--out", "json=-", // write summary JSON to stdout
    "--vus", String(loadProfile.vus),
    ...loadProfile.stages.flatMap((s) => ["--stage", `${s.duration}:${s.target}`]),
    scriptPath,
  ];

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    BASE_URL: baseUrl,
    ...extraEnv,
  };

  let result: SpawnResult;
  try {
    result = await spawnFn("k6", args, { env });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(`k6 not found: install k6 and ensure it is in PATH`);
    }
    throw err;
  }

  let metrics: K6Metrics = {
    p50Ms: null, p95Ms: null, p99Ms: null,
    errorRate: 0, totalRequests: 0, requestRate: null, peakVus: null,
  };

  if (result.stdout) {
    try {
      const summary = JSON.parse(result.stdout) as K6Summary;
      metrics = parseK6Summary(summary);
    } catch {
      // stdout may contain non-JSON lines; ignore parse errors
    }
  }

  return {
    exitCode: result.exitCode,
    failed: result.exitCode !== 0,
    metrics,
    source: "k6",
  };
}
