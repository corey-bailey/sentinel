const VALID_STAGE_TAG_PREFIXES = ["[REQ]", "[GEN]", "[RUN:", "[ANL]", "[REG]", "[RPT]"];

export function hasValidStageTag(title: string): boolean {
  return VALID_STAGE_TAG_PREFIXES.some((prefix) => title.startsWith(prefix));
}

type CreateIssueInput = {
  title: string;
  companyId: string;
  testRunId?: string;
  testPlanId?: string;
  assigneeAgentId?: string | null;
  blockedByIssueIds?: string[];
  parentId?: string | null;
  status?: string;
  [key: string]: unknown;
};

type CreateIssueFn = (data: CreateIssueInput) => Promise<{ id: string; [key: string]: unknown }>;

export type BuildExecutionChainOpts = {
  companyId: string;
  testRunId: string;
  testPlanId: string;
  engines: string[];
  hasCoverageGaps: boolean;
  createIssue: CreateIssueFn;
};

export type BuildExecutionChainResult = {
  reqIssueId: string;
  genIssueId: string | null;
  runIssueIds: Record<string, string>;
  anlIssueId: string;
  rptIssueId: string;
};

export async function buildExecutionChain(
  opts: BuildExecutionChainOpts,
): Promise<BuildExecutionChainResult> {
  const { companyId, testRunId, testPlanId, engines, hasCoverageGaps, createIssue } = opts;

  const base = { companyId, testRunId, testPlanId };

  // [REQ] — requirement analysis
  const reqIssue = await createIssue({
    ...base,
    title: "[REQ] Analyze requirements for test run",
    status: "todo",
  });

  // [GEN] — optional test generation when coverage gaps exist
  let genIssueId: string | null = null;
  if (hasCoverageGaps) {
    const genIssue = await createIssue({
      ...base,
      title: "[GEN] Generate missing test scripts",
      blockedByIssueIds: [reqIssue.id],
      status: "blocked",
    });
    genIssueId = genIssue.id;
  }

  const runBlockedBy = genIssueId ? [genIssueId] : [reqIssue.id];

  // [RUN:<engine>] — one per engine
  const runIssueIds: Record<string, string> = {};
  for (const engine of engines) {
    const runIssue = await createIssue({
      ...base,
      title: `[RUN:${engine}] Execute ${engine} tests`,
      blockedByIssueIds: runBlockedBy,
      status: "blocked",
    });
    runIssueIds[engine] = runIssue.id;
  }

  // [ANL] — analysis, blocked by all run issues
  const anlIssue = await createIssue({
    ...base,
    title: "[ANL] Analyze test results",
    blockedByIssueIds: Object.values(runIssueIds),
    status: "blocked",
  });

  // [RPT] — report, blocked by analysis
  const rptIssue = await createIssue({
    ...base,
    title: "[RPT] Publish test report",
    blockedByIssueIds: [anlIssue.id],
    status: "blocked",
  });

  return {
    reqIssueId: reqIssue.id,
    genIssueId,
    runIssueIds,
    anlIssueId: anlIssue.id,
    rptIssueId: rptIssue.id,
  };
}

export type RegressionData = {
  metric: string;
  deviationPct: number;
  testPlanName: string;
};

export type CreateRegressionIssueOpts = {
  companyId: string;
  testRunId: string;
  createIssue: CreateIssueFn;
  executionIssueId?: string;
};

export async function createRegressionIssue(
  regression: RegressionData,
  opts: CreateRegressionIssueOpts,
): Promise<{ id: string }> {
  const { companyId, testRunId, createIssue, executionIssueId } = opts;

  const deviationStr = `+${Math.round(regression.deviationPct)}%`;
  const title = `[REG] REGRESSION: ${regression.metric} ${deviationStr} vs baseline — ${regression.testPlanName}`;

  const issue = await createIssue({
    companyId,
    testRunId,
    title,
    status: "in_review",
    executionIssueId: executionIssueId ?? null,
  });

  return { id: issue.id };
}
