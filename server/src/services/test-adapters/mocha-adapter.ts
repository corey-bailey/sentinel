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

type MochaTestItem = {
  fullTitle: string;
  duration: number;
  currentRetry: number;
  err?: { message: string };
};

type MochaFailure = MochaTestItem & {
  err: { message: string };
};

type MochaReport = {
  stats: {
    passes: number;
    failures: number;
    tests: number;
    duration: number;
    pending?: number;
  };
  tests: MochaTestItem[];
  failures: MochaFailure[];
  pending: MochaTestItem[];
};

export type TestCaseResult = {
  title: string;
  passed: boolean;
  durationMs: number;
  errorMessage?: string;
};

export type MochaMetrics = {
  passRate: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  testCases: TestCaseResult[];
  source: "mocha";
};

export type MochaRunResult = MochaMetrics & {
  exitCode: number;
  failed: boolean;
};

export function parseMochaReport(report: MochaReport): MochaMetrics {
  const passed = report.stats.passes;
  const failed = report.stats.failures;
  const total = report.stats.tests;
  const passRate = total === 0 ? 1 : passed / total;

  const passedCases: TestCaseResult[] = report.tests.map((t) => ({
    title: t.fullTitle,
    passed: true,
    durationMs: t.duration ?? 0,
  }));

  const failedCases: TestCaseResult[] = report.failures.map((t) => ({
    title: t.fullTitle,
    passed: false,
    durationMs: t.duration ?? 0,
    errorMessage: t.err?.message,
  }));

  return {
    passRate,
    totalTests: total,
    passedTests: passed,
    failedTests: failed,
    testCases: [...passedCases, ...failedCases],
    source: "mocha",
  };
}

export type MochaRunOptions = {
  testPattern: string;
  spawnFn: SpawnFn;
  extraArgs?: string[];
};

export async function runMocha(opts: MochaRunOptions): Promise<MochaRunResult> {
  const { testPattern, spawnFn, extraArgs = [] } = opts;

  const args = ["--reporter", "json", testPattern, ...extraArgs];

  let result: SpawnResult;
  try {
    result = await spawnFn("mocha", args);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(`mocha not found: install mocha and ensure it is in PATH`);
    }
    throw err;
  }

  let metrics: MochaMetrics = {
    passRate: 1, totalTests: 0, passedTests: 0, failedTests: 0, testCases: [], source: "mocha",
  };

  if (result.stdout) {
    try {
      const report = JSON.parse(result.stdout) as MochaReport;
      metrics = parseMochaReport(report);
    } catch {
      // ignore JSON parse errors
    }
  }

  return { ...metrics, exitCode: result.exitCode, failed: result.exitCode !== 0 };
}
