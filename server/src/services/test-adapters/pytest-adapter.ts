export type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  jsonReportPath?: string;
  jsonReport?: PytestReport;
};

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<SpawnResult>;

type PytestTestItem = {
  nodeid: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  duration: number;
  longrepr?: string;
};

type PytestSummary = {
  passed: number;
  failed: number;
  error?: number;
  total: number;
};

type PytestReport = {
  summary: PytestSummary;
  tests: PytestTestItem[];
};

export type TestCaseResult = {
  nodeid: string;
  passed: boolean;
  durationMs: number;
  errorMessage?: string;
};

export type PytestMetrics = {
  passRate: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  testCases: TestCaseResult[];
  source: "pytest";
};

export type PytestRunResult = PytestMetrics & {
  exitCode: number;
  failed: boolean;
};

export function parsePytestReport(report: PytestReport): PytestMetrics {
  const tests = report.tests ?? [];
  const testCases: TestCaseResult[] = tests.map((t) => ({
    nodeid: t.nodeid,
    passed: t.outcome === "passed",
    durationMs: Math.round((t.duration ?? 0) * 1000),
    errorMessage: t.longrepr,
  }));

  const total = report.summary.total ?? tests.length;
  const passed = report.summary.passed ?? 0;
  const failed = report.summary.failed ?? 0;
  const passRate = total === 0 ? 1 : passed / total;

  return { passRate, totalTests: total, passedTests: passed, failedTests: failed, testCases, source: "pytest" };
}

export type PytestRunOptions = {
  testPath: string;
  spawnFn: SpawnFn;
  extraArgs?: string[];
};

export async function runPytest(opts: PytestRunOptions): Promise<PytestRunResult> {
  const { testPath, spawnFn, extraArgs = [] } = opts;

  const reportPath = `/tmp/pytest-report-${Date.now()}.json`;
  const args = [
    testPath,
    "--json-report",
    `--json-report-file=${reportPath}`,
    ...extraArgs,
  ];

  let result: SpawnResult;
  try {
    result = await spawnFn("pytest", args);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(`pytest not found: install pytest and ensure it is in PATH`);
    }
    throw err;
  }

  const report = result.jsonReport ?? { summary: { passed: 0, failed: 0, total: 0 }, tests: [] };
  const metrics = parsePytestReport(report);

  return { ...metrics, exitCode: result.exitCode, failed: result.exitCode !== 0 };
}
