export type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<SpawnResult>;

type PlaywrightTestResult = {
  status: "passed" | "failed" | "timedOut" | "skipped";
  duration: number;
  error?: { message: string };
};

type PlaywrightSpec = {
  title: string;
  ok: boolean;
  tests: Array<{ results: PlaywrightTestResult[] }>;
};

type PlaywrightSuite = {
  title: string;
  specs: PlaywrightSpec[];
};

type PlaywrightReport = {
  suites: PlaywrightSuite[];
};

export type TestCaseResult = {
  title: string;
  passed: boolean;
  durationMs: number;
  errorMessage?: string;
};

export type PlaywrightMetrics = {
  passRate: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  testCases: TestCaseResult[];
  source: "playwright";
};

export type PlaywrightRunResult = PlaywrightMetrics & {
  exitCode: number;
  failed: boolean;
};

export function parsePlaywrightReport(report: PlaywrightReport): PlaywrightMetrics {
  const testCases: TestCaseResult[] = [];

  for (const suite of report.suites) {
    for (const spec of suite.specs) {
      const result = spec.tests[0]?.results[0];
      testCases.push({
        title: spec.title,
        passed: spec.ok,
        durationMs: result?.duration ?? 0,
        errorMessage: result?.error?.message,
      });
    }
  }

  const total = testCases.length;
  const passed = testCases.filter((t) => t.passed).length;
  const failed = total - passed;
  const passRate = total === 0 ? 1 : passed / total;

  return { passRate, totalTests: total, passedTests: passed, failedTests: failed, testCases, source: "playwright" };
}

export type PlaywrightRunOptions = {
  specPath: string;
  spawnFn: SpawnFn;
  extraArgs?: string[];
};

export async function runPlaywright(opts: PlaywrightRunOptions): Promise<PlaywrightRunResult> {
  const { specPath, spawnFn, extraArgs = [] } = opts;

  const args = ["playwright", "test", "--reporter=json", specPath, ...extraArgs];

  let result: SpawnResult;
  try {
    result = await spawnFn("npx", args);
  } catch (err: unknown) {
    throw err;
  }

  let metrics: PlaywrightMetrics = {
    passRate: 1, totalTests: 0, passedTests: 0, failedTests: 0, testCases: [], source: "playwright",
  };

  if (result.stdout) {
    try {
      const report = JSON.parse(result.stdout) as PlaywrightReport;
      metrics = parsePlaywrightReport(report);
    } catch {
      // ignore JSON parse errors
    }
  }

  return { ...metrics, exitCode: result.exitCode, failed: result.exitCode !== 0 };
}
