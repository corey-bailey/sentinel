import { describe, expect, it, vi, beforeEach } from "vitest";

// The pipeline builder creates execution issue chains for test runs.
// It doesn't interact with the DB directly in these unit tests —
// it accepts a mock issueCreator so we can inspect calls without real DB.

type IssueStub = {
  id: string;
  title: string;
  assigneeAgentId?: string | null;
  blockedByIssueIds?: string[];
  parentId?: string | null;
  companyId: string;
};

const mockCreateIssue = vi.fn();

vi.mock("../services/pipeline-builder.js", async () => {
  const actual = await vi.importActual<typeof import("../services/pipeline-builder.js")>(
    "../services/pipeline-builder.js",
  );
  return actual;
});

// Deterministic id counter for stubs
let idCounter = 0;
function nextId() {
  return `issue-${++idCounter}`;
}

async function callBuildExecutionChain(opts: {
  engines: string[];
  hasCoverageGaps?: boolean;
  companyId?: string;
  testRunId?: string;
  testPlanId?: string;
}) {
  const { buildExecutionChain } = await import("../services/pipeline-builder.js");
  return buildExecutionChain({
    companyId: opts.companyId ?? "company-1",
    testRunId: opts.testRunId ?? "run-1",
    testPlanId: opts.testPlanId ?? "plan-1",
    engines: opts.engines,
    hasCoverageGaps: opts.hasCoverageGaps ?? false,
    createIssue: mockCreateIssue,
  });
}

describe.sequential("buildExecutionChain", () => {
  beforeEach(() => {
    idCounter = 0;
    mockCreateIssue.mockReset();
    mockCreateIssue.mockImplementation(async (data: Partial<IssueStub>) => ({
      id: nextId(),
      ...data,
    }));
  });

  it("creates RequirementAnalysisIssue as first issue", async () => {
    await callBuildExecutionChain({ engines: ["k6"] });

    const firstCall = mockCreateIssue.mock.calls[0]![0];
    expect(firstCall.title).toMatch(/^\[REQ\]/);
  });

  it("creates one TestRunIssue per engine, all blocked by RequirementAnalysisIssue", async () => {
    const result = await callBuildExecutionChain({ engines: ["k6", "playwright"] });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const runK6 = calls.find((c) => c.title.startsWith("[RUN:k6]"))!;
    const runPw = calls.find((c) => c.title.startsWith("[RUN:playwright]"))!;

    expect(runK6).toBeDefined();
    expect(runPw).toBeDefined();
    expect(runK6.blockedByIssueIds).toContain(result.reqIssueId);
    expect(runPw.blockedByIssueIds).toContain(result.reqIssueId);
  });

  it("creates AnalysisIssue blocked by ALL engine TestRunIssues", async () => {
    const result = await callBuildExecutionChain({ engines: ["k6", "pytest"] });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const anlIssue = calls.find((c) => c.title.startsWith("[ANL]"))!;

    expect(anlIssue).toBeDefined();
    expect(anlIssue.blockedByIssueIds).toContain(result.runIssueIds["k6"]);
    expect(anlIssue.blockedByIssueIds).toContain(result.runIssueIds["pytest"]);
  });

  it("creates ReportIssue blocked by AnalysisIssue", async () => {
    const result = await callBuildExecutionChain({ engines: ["k6"] });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const rptIssue = calls.find((c) => c.title.startsWith("[RPT]"))!;

    expect(rptIssue).toBeDefined();
    expect(rptIssue.blockedByIssueIds).toContain(result.anlIssueId);
  });

  it("creates TestGenerationIssue between RequirementAnalysis and TestRun when gaps exist", async () => {
    const result = await callBuildExecutionChain({ engines: ["k6"], hasCoverageGaps: true });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const genIssue = calls.find((c) => c.title.startsWith("[GEN]"))!;
    const runIssue = calls.find((c) => c.title.startsWith("[RUN:k6]"))!;

    expect(genIssue).toBeDefined();
    expect(genIssue.blockedByIssueIds).toContain(result.reqIssueId);
    expect(runIssue.blockedByIssueIds).toContain(result.genIssueId);
  });

  it("skips TestGenerationIssue when TestAsset coverage is complete", async () => {
    await callBuildExecutionChain({ engines: ["k6"], hasCoverageGaps: false });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const genIssue = calls.find((c) => c.title.startsWith("[GEN]"));
    expect(genIssue).toBeUndefined();
  });

  it("all issues belong to the same companyId", async () => {
    await callBuildExecutionChain({ engines: ["k6", "playwright"], companyId: "ord-company" });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    for (const issue of calls) {
      expect(issue.companyId).toBe("ord-company");
    }
  });

  it("rejects issue creation if title does not start with a recognized stage tag", async () => {
    const { buildExecutionChain } = await import("../services/pipeline-builder.js");

    await expect(
      buildExecutionChain({
        companyId: "company-1",
        testRunId: "run-1",
        testPlanId: "plan-1",
        engines: [],
        hasCoverageGaps: false,
        createIssue: async (data: { title: string }) => {
          if (!data.title.match(/^\[(REQ|GEN|RUN:|ANL|REG|RPT)/)) {
            throw new Error(`Invalid stage tag in title: ${data.title}`);
          }
          return { id: "x", ...data };
        },
      }),
    ).resolves.toBeDefined();
  });
});

describe.sequential("issue title stage tags", () => {
  beforeEach(() => {
    idCounter = 0;
    mockCreateIssue.mockReset();
    mockCreateIssue.mockImplementation(async (data: Partial<IssueStub>) => ({
      id: nextId(),
      ...data,
    }));
  });

  it("prefixes RequirementAnalysisIssue title with [REQ]", async () => {
    await callBuildExecutionChain({ engines: ["k6"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[REQ]"))).toBe(true);
  });

  it("prefixes TestGenerationIssue title with [GEN]", async () => {
    await callBuildExecutionChain({ engines: ["k6"], hasCoverageGaps: true });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[GEN]"))).toBe(true);
  });

  it("prefixes k6 TestRunIssue title with [RUN:k6]", async () => {
    await callBuildExecutionChain({ engines: ["k6"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[RUN:k6]"))).toBe(true);
  });

  it("prefixes playwright TestRunIssue title with [RUN:playwright]", async () => {
    await callBuildExecutionChain({ engines: ["playwright"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[RUN:playwright]"))).toBe(true);
  });

  it("prefixes pytest TestRunIssue title with [RUN:pytest]", async () => {
    await callBuildExecutionChain({ engines: ["pytest"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[RUN:pytest]"))).toBe(true);
  });

  it("prefixes mocha TestRunIssue title with [RUN:mocha]", async () => {
    await callBuildExecutionChain({ engines: ["mocha"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[RUN:mocha]"))).toBe(true);
  });

  it("prefixes AnalysisIssue title with [ANL]", async () => {
    await callBuildExecutionChain({ engines: ["k6"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[ANL]"))).toBe(true);
  });

  it("prefixes ReportIssue title with [RPT]", async () => {
    await callBuildExecutionChain({ engines: ["k6"] });
    const titles = mockCreateIssue.mock.calls.map((c) => c[0].title as string);
    expect(titles.some((t) => t.startsWith("[RPT]"))).toBe(true);
  });
});

describe.sequential("createRegressionIssue", () => {
  beforeEach(() => {
    idCounter = 0;
    mockCreateIssue.mockReset();
    mockCreateIssue.mockImplementation(async (data: Partial<IssueStub>) => ({
      id: nextId(),
      ...data,
    }));
  });

  it("creates one RegressionIssue per Regression object", async () => {
    const { createRegressionIssue } = await import("../services/pipeline-builder.js");

    await createRegressionIssue(
      {
        metric: "p95Ms",
        deviationPct: 23,
        testPlanName: "checkout flow",
      },
      {
        companyId: "company-1",
        testRunId: "run-1",
        createIssue: mockCreateIssue,
      },
    );

    expect(mockCreateIssue).toHaveBeenCalledOnce();
  });

  it("sets issue title to [REG] REGRESSION: {metric} +{deviation_pct}% vs baseline — {plan name}", async () => {
    const { createRegressionIssue } = await import("../services/pipeline-builder.js");

    await createRegressionIssue(
      {
        metric: "p95Ms",
        deviationPct: 23,
        testPlanName: "checkout flow",
      },
      {
        companyId: "company-1",
        testRunId: "run-1",
        createIssue: mockCreateIssue,
      },
    );

    const title = mockCreateIssue.mock.calls[0]![0].title as string;
    expect(title).toBe("[REG] REGRESSION: p95Ms +23% vs baseline — checkout flow");
  });
});

describe.sequential("company workspace isolation", () => {
  beforeEach(() => {
    idCounter = 0;
    mockCreateIssue.mockReset();
    mockCreateIssue.mockImplementation(async (data: Partial<IssueStub>) => ({
      id: nextId(),
      ...data,
    }));
  });

  it("all execution issues for a TestRun are created in the same company_id", async () => {
    await callBuildExecutionChain({ engines: ["k6", "playwright"], companyId: "ord-co" });

    const calls = mockCreateIssue.mock.calls.map((c) => c[0] as IssueStub);
    const uniqueCompanyIds = new Set(calls.map((c) => c.companyId));
    expect(uniqueCompanyIds.size).toBe(1);
    expect(uniqueCompanyIds.has("ord-co")).toBe(true);
  });

  it("issues from ORD company never mix with PAY company (separate invocations stay isolated)", async () => {
    let ordMock = vi.fn();
    let payMock = vi.fn();
    let ordCounter = 0;
    let payCounter = 0;
    ordMock.mockImplementation(async (d: any) => ({ id: `ord-${++ordCounter}`, ...d }));
    payMock.mockImplementation(async (d: any) => ({ id: `pay-${++payCounter}`, ...d }));

    const { buildExecutionChain } = await import("../services/pipeline-builder.js");

    await Promise.all([
      buildExecutionChain({ companyId: "ord", testRunId: "r1", testPlanId: "p1", engines: ["k6"], hasCoverageGaps: false, createIssue: ordMock }),
      buildExecutionChain({ companyId: "pay", testRunId: "r2", testPlanId: "p2", engines: ["k6"], hasCoverageGaps: false, createIssue: payMock }),
    ]);

    const ordCalls = ordMock.mock.calls.map((c) => c[0] as IssueStub);
    const payCalls = payMock.mock.calls.map((c) => c[0] as IssueStub);

    expect(ordCalls.every((c) => c.companyId === "ord")).toBe(true);
    expect(payCalls.every((c) => c.companyId === "pay")).toBe(true);
  });
});
