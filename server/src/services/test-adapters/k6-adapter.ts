import fs from "node:fs/promises";
import path from "node:path";
import type { K6RawSummary } from "../k6-generator/summary-mapping.js"; // type-only: the raw k6 summary shape

export type SpawnResult = { exitCode: number; stdout: string; stderr: string };
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
) => Promise<SpawnResult>;

export type K6Window = { warmupEndS: number; rampUpEndS: number; steadyEndS: number };

export type K6RunOptions = {
  scriptPath: string;            // path RELATIVE to cwd (k6 reads ./reusable.json etc. from cwd)
  cwd: string;                   // the per-run ExecutionWorkspace working directory
  testRunId: string;             // -> TEST_RUN_ID env, names summary-<id>.json
  baseUrl: string;
  window: K6Window;
  executionRunId?: string;
  authToken?: string;
  spawnFn: SpawnFn;
  extraEnv?: Record<string, string>;
  binary?: string;               // default 'k6'
};

export type K6RunResult = {
  exitCode: number;
  failed: boolean;               // true when k6 exits non-zero (e.g. threshold breach or script error)
  summaryFileName: string;       // summary-<testRunId>.json — read via readK6Summary
  stdout: string;
  stderr: string;
};

export async function runK6(opts: K6RunOptions): Promise<K6RunResult> {
  const { scriptPath, cwd, testRunId, baseUrl, window, executionRunId, authToken, spawnFn, extraEnv = {}, binary = "k6" } = opts;

  // Scenarios come from the script's options block (locked decision), NOT --vus/--stage CLI flags.
  const args = ["run", scriptPath];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BASE_URL: baseUrl,
    TEST_RUN_ID: testRunId,
    WARMUP_END_S: String(window.warmupEndS),
    RAMP_UP_END_S: String(window.rampUpEndS),
    STEADY_END_S: String(window.steadyEndS),
    ...(executionRunId ? { EXECUTION_RUN_ID: executionRunId } : {}),
    ...(authToken ? { AUTH_TOKEN: authToken } : {}),
    ...extraEnv,
  };

  let result: SpawnResult;
  try {
    result = await spawnFn(binary, args, { env, cwd });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Error(`k6 not found: install k6 and ensure it is in PATH`);
    throw err;
  }

  return {
    exitCode: result.exitCode,
    failed: result.exitCode !== 0,
    summaryFileName: `summary-${testRunId}.json`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Reads the RAW k6 end-of-test summary (what the generated handleSummary wrote via JSON.stringify(data)).
// The harness/executor applies mapK6Summary to turn this into metric_series rows — the adapter stays generic.
export async function readK6Summary(cwd: string, testRunId: string): Promise<K6RawSummary> {
  const file = path.join(cwd, `summary-${testRunId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`k6 summary not found: expected summary-${testRunId}.json in ${cwd} (did handleSummary run?)`);
  }
  return JSON.parse(raw) as K6RawSummary;
}
