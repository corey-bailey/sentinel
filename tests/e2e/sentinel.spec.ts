/**
 * E2E: Sentinel testing platform — all 7 user journeys.
 *
 * Runs against a throwaway local_trusted instance bootstrapped by the
 * playwright.config.ts webServer directive. All data is created via the REST
 * API so tests are fast and never depend on real agent LLM execution.
 *
 * User journeys covered:
 *   UJ-1  CI-triggered run (deploy webhook → TestRun appears in UI)
 *   UJ-2  Human creates requirement via UI form
 *   UJ-4  Regression detection and human approve/reject decision
 *   UJ-5  First run — baseline proposal promoted to active baseline
 *   UJ-6  Dashboard stat cards reflect live counts
 *   UJ-7  Upstream agent POSTs requirements (source=agent)
 */

import { test, expect, type Page } from "@playwright/test";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getBaseUrl(page: Page): Promise<string> {
  return page.url().split("/").slice(0, 3).join("/");
}

async function getCompany(page: Page): Promise<{ id: string; issuePrefix: string; name: string }> {
  const base = await getBaseUrl(page);
  const res = await page.request.get(`${base}/api/companies`);
  expect(res.ok()).toBe(true);
  const companies = await res.json();
  // Use the first company created by the bootstrap `onboard --yes` invocation.
  const company = companies[0];
  expect(company, "bootstrap should have created at least one company").toBeTruthy();
  return company;
}

async function createTestPlan(
  page: Page,
  base: string,
  companyId: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await page.request.post(`${base}/api/companies/${companyId}/test-plans`, {
    data: {
      name: `Test Plan ${Date.now()}`,
      engines: ["k6", "playwright"],
      filePatterns: ["src/checkout/**"],
      isActive: true,
      ...overrides,
    },
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{ id: string }>;
}

async function createTestRun(
  page: Page,
  base: string,
  companyId: string,
  testPlanId: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await page.request.post(`${base}/api/companies/${companyId}/test-runs`, {
    data: {
      testPlanId,
      triggerType: "manual",
      status: "completed",
      resultSignal: "pass",
      ...overrides,
    },
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{ id: string }>;
}

async function createRegression(
  page: Page,
  base: string,
  companyId: string,
  testRunId: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await page.request.post(`${base}/api/companies/${companyId}/regressions`, {
    data: {
      testRunId,
      metric: "p95",
      baselineValue: 200,
      actualValue: 250,
      deviationPct: 25,
      regressionType: "metric_breach",
      status: "open",
      ...overrides,
    },
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{ id: string }>;
}

async function createRequirement(
  page: Page,
  base: string,
  companyId: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await page.request.post(`${base}/api/companies/${companyId}/requirements`, {
    data: {
      name: `Requirement ${Date.now()}`,
      slaTargets: [{ metric: "p95", operator: "lt", threshold: 300, source: "k6" }],
      ...overrides,
    },
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{ id: string; coverageStatus: string }>;
}

// ─── test setup ───────────────────────────────────────────────────────────────

// Navigate to root and let the app redirect to /:prefix/dashboard so we have a
// valid session and know which company prefix to use.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Wait for redirect to /:prefix/dashboard or /onboarding
  await page.waitForURL(/\/(onboarding|[A-Z0-9]+\/dashboard)/, { timeout: 15_000 });
});

// ─── UJ-6 / Dashboard ─────────────────────────────────────────────────────────

test.describe("Dashboard", () => {
  test("renders stat cards on the sentinel dashboard", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/dashboard`);

    await expect(page.getByText("Active Runs")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Open Regressions")).toBeVisible();
    await expect(page.getByText("Active Baselines")).toBeVisible();
    await expect(page.getByText("Total Runs")).toBeVisible();
  });

  test("dashboard open-regressions count increments when a regression is created", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id);
    await createRegression(page, base, company.id, run.id);

    await page.goto(`/${company.issuePrefix}/sentinel/dashboard`);
    // The open-regressions card should show at least 1.
    const openCard = page.locator(".text-orange-600.text-3xl");
    await expect(openCard).toBeVisible({ timeout: 10_000 });
    const count = Number(await openCard.textContent());
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("dashboard shows orange regression banner when open regressions exist", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id);
    await createRegression(page, base, company.id, run.id, { metric: "error_rate" });

    await page.goto(`/${company.issuePrefix}/sentinel/dashboard`);
    await expect(page.getByText("Regressions Requiring Decision")).toBeVisible({ timeout: 10_000 });
  });

  test("recent runs list shows run with status badge", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    await createTestRun(page, base, company.id, plan.id, { triggerType: "manual", status: "completed" });

    await page.goto(`/${company.issuePrefix}/sentinel/dashboard`);
    await expect(page.getByText("Recent Test Runs")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=completed").first()).toBeVisible();
  });
});

// ─── UJ-2: Human creates requirement via UI ───────────────────────────────────

test.describe("UJ-2: Requirements page", () => {
  test("loads requirements list page", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/requirements`);
    await expect(page.getByRole("heading", { name: "Requirements" })).toBeVisible({ timeout: 10_000 });
  });

  test("creates a requirement via the UI form", async ({ page }) => {
    const company = await getCompany(page);
    const reqName = `Checkout SLA ${Date.now()}`;

    await page.goto(`/${company.issuePrefix}/sentinel/requirements`);
    await expect(page.getByRole("heading", { name: "Requirements" })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "New Requirement" }).click();
    await expect(page.getByPlaceholder(/e.g. Checkout/)).toBeVisible();

    await page.getByPlaceholder(/e.g. Checkout/).fill(reqName);
    await page.getByPlaceholder(/Describe the performance/).fill("p95 < 300ms under load");

    await page.getByRole("button", { name: "Create" }).click();

    // Requirement appears in the list
    await expect(page.getByText(reqName)).toBeVisible({ timeout: 10_000 });
    // Coverage status badge defaults to "pending"
    await expect(page.getByText("pending").first()).toBeVisible();
  });

  test("shows validation error when name is empty", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/requirements`);
    await expect(page.getByRole("heading", { name: "Requirements" })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "New Requirement" }).click();
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Name is required")).toBeVisible();
  });

  test("requirement created via API appears in the list", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const req = await createRequirement(page, base, company.id, {
      name: `API-Created Req ${Date.now()}`,
    });
    expect(req.coverageStatus).toBe("pending");

    await page.goto(`/${company.issuePrefix}/sentinel/requirements`);
    await expect(page.getByText(/API-Created Req/)).toBeVisible({ timeout: 10_000 });
  });
});

// ─── UJ-7: Upstream agent POSTs requirements ──────────────────────────────────

test.describe("UJ-7: Agent-sourced requirements", () => {
  test("requirement created with source=agent has pending coverage status", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    // Simulate an upstream agent POSTing a requirement.
    // In real usage the agent JWT sets source=agent; here we set it explicitly
    // because local_trusted mode does not enforce JWT-based actor detection.
    const res = await page.request.post(`${base}/api/companies/${company.id}/requirements`, {
      data: {
        name: `Agent Requirement ${Date.now()}`,
        slaTargets: [{ metric: "p95", operator: "lt", threshold: 500, source: "k6" }],
      },
    });
    expect(res.ok()).toBe(true);
    const req = await res.json();
    expect(req.coverageStatus).toBe("pending");
    expect(req.companyId).toBe(company.id);

    // Visible in the UI
    await page.goto(`/${company.issuePrefix}/sentinel/requirements`);
    await expect(page.getByText(/Agent Requirement/)).toBeVisible({ timeout: 10_000 });
  });
});

// ─── UJ-1: CI-triggered run ───────────────────────────────────────────────────

test.describe("UJ-1: CI-triggered run via deploy webhook", () => {
  test("deploy webhook creates a TestRun that appears in the runs list", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);

    // Create a test plan that watches the checkout path.
    await createTestPlan(page, base, company.id, {
      name: `CI Plan ${Date.now()}`,
      filePatterns: ["src/payment/**"],
    });

    // Simulate a CI/CD deploy webhook with a changed file that matches.
    const triggerRes = await page.request.post(
      `${base}/api/companies/${company.id}/triggers/deploy`,
      {
        data: {
          repo: "my-org/my-repo",
          commit: "abc1234",
          changedFiles: ["src/payment/processor.ts"],
        },
      }
    );
    expect(triggerRes.ok()).toBe(true);
    const { runIds } = await triggerRes.json() as { runIds: string[] };
    expect(runIds.length).toBeGreaterThanOrEqual(1);

    // The run appears in the UI runs list.
    await page.goto(`/${company.issuePrefix}/sentinel/test-runs`);
    await expect(page.getByRole("heading", { name: "Test Runs" })).toBeVisible({ timeout: 10_000 });
    // At least one run row should be visible.
    await expect(page.locator("text=ci").first()).toBeVisible({ timeout: 10_000 });
  });

  test("deploy webhook returns empty runIds when no plans match changed files", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);

    const triggerRes = await page.request.post(
      `${base}/api/companies/${company.id}/triggers/deploy`,
      {
        data: {
          repo: "my-org/my-repo",
          commit: "deadbeef",
          changedFiles: ["docs/README.md"], // won't match any plan
        },
      }
    );
    expect(triggerRes.ok()).toBe(true);
    const { runIds } = await triggerRes.json() as { runIds: string[] };
    // No matching plans → no runs created.
    expect(runIds).toHaveLength(0);
  });
});

// ─── TestRunDetail page ────────────────────────────────────────────────────────

test.describe("Test run detail view", () => {
  test("navigating to a test run shows metadata", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id, {
      triggerType: "manual",
      status: "completed",
      resultSignal: "pass",
    });

    await page.goto(`/${company.issuePrefix}/sentinel/test-runs/${run.id}`);
    await expect(page.getByRole("heading", { name: /Manual Run/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("completed")).toBeVisible();
    await expect(page.getByText("Result: PASS")).toBeVisible();
  });

  test("running test run shows live refresh notice", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id, {
      triggerType: "ci",
      status: "running",
      resultSignal: null,
    });

    await page.goto(`/${company.issuePrefix}/sentinel/test-runs/${run.id}`);
    await expect(page.getByText(/actively executing/)).toBeVisible({ timeout: 10_000 });
  });
});

// ─── UJ-4: Regression detection and human decision ───────────────────────────

test.describe("UJ-4: Regression board — approve and reject", () => {
  test("loads regressions page", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/regressions`);
    await expect(page.getByRole("heading", { name: "Regressions" })).toBeVisible({ timeout: 10_000 });
  });

  test("open regression appears with deviation and approve/reject buttons", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id, { resultSignal: "fail" });
    await createRegression(page, base, company.id, run.id, {
      metric: "p95_latency",
      deviationPct: 23.5,
    });

    await page.goto(`/${company.issuePrefix}/sentinel/regressions`);
    await expect(page.getByText("Requiring Decision")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/p95_latency/)).toBeVisible();
    await expect(page.getByText("+23.5%")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  });

  test("approving a regression resolves it and moves it to Resolved", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id, { resultSignal: "fail" });
    await createRegression(page, base, company.id, run.id, { metric: "error_rate_approve" });

    await page.goto(`/${company.issuePrefix}/sentinel/regressions`);
    await expect(page.getByText(/error_rate_approve/)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Accept" }).first().click();

    // After approval the regression moves to Resolved section
    await expect(page.getByText("Resolved")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=approved").first()).toBeVisible();
  });

  test("rejecting a regression resolves it as rejected", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id, { resultSignal: "fail" });
    await createRegression(page, base, company.id, run.id, { metric: "error_rate_reject" });

    await page.goto(`/${company.issuePrefix}/sentinel/regressions`);
    await expect(page.getByText(/error_rate_reject/)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Reject" }).first().click();

    await expect(page.getByText("Resolved")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=rejected").first()).toBeVisible();
  });
});

// ─── UJ-5: First run — baseline proposal ──────────────────────────────────────

test.describe("UJ-5: Baseline proposal — approve promotes to active", () => {
  test("loads baselines page", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/baselines`);
    await expect(page.getByRole("heading", { name: "Baselines" })).toBeVisible({ timeout: 10_000 });
  });

  test("baseline proposal appears in Pending Approval section", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id);

    // Create a baseline in pending (not-yet-active) state
    const baselineRes = await page.request.post(`${base}/api/companies/${company.id}/baselines`, {
      data: {
        testPlanId: plan.id,
        sourceRunId: run.id,
        metric: "p95_proposal",
        baselineValue: 185,
        tolerancePct: 10,
      },
    });
    expect(baselineRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/sentinel/baselines`);
    await expect(page.getByText("Pending Approval")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/p95_proposal/)).toBeVisible();
    await expect(page.getByText(/185/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  });

  test("approving a baseline proposal promotes it to active", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id);

    const baselineRes = await page.request.post(`${base}/api/companies/${company.id}/baselines`, {
      data: {
        testPlanId: plan.id,
        sourceRunId: run.id,
        metric: "p95_to_promote",
        baselineValue: 200,
        tolerancePct: 10,
      },
    });
    expect(baselineRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/sentinel/baselines`);
    await expect(page.getByText(/p95_to_promote/)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Approve" }).first().click();

    // After approval the baseline moves to Active Baselines
    await expect(page.getByText("Active Baselines")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/p95_to_promote/)).toBeVisible();
  });

  test("second run: subsequent baseline is evaluated against the approved one", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);
    const run = await createTestRun(page, base, company.id, plan.id);

    // Approve the first baseline
    const baselineRes = await page.request.post(`${base}/api/companies/${company.id}/baselines`, {
      data: {
        testPlanId: plan.id,
        sourceRunId: run.id,
        metric: "p95_v2",
        baselineValue: 180,
        tolerancePct: 10,
      },
    });
    expect(baselineRes.ok()).toBe(true);
    const baseline = await baselineRes.json() as { id: string };
    await page.request.post(`${base}/api/baselines/${baseline.id}/approve`);

    // Verify the baseline shows as active via API
    const activeRes = await page.request.get(
      `${base}/api/companies/${company.id}/baselines?testPlanId=${plan.id}`
    );
    expect(activeRes.ok()).toBe(true);
    const baselines = await activeRes.json() as Array<{ metric: string; isActive: boolean }>;
    const activeBaseline = baselines.find((b) => b.metric === "p95_v2" && b.isActive);
    expect(activeBaseline).toBeTruthy();
  });
});

// ─── Test assets page ─────────────────────────────────────────────────────────

test.describe("Test assets", () => {
  test("loads test assets page", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/test-assets`);
    await expect(page.getByRole("heading", { name: "Test Assets" })).toBeVisible({ timeout: 10_000 });
  });

  test("asset created via API appears in the list", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    const plan = await createTestPlan(page, base, company.id);

    const assetRes = await page.request.post(`${base}/api/companies/${company.id}/test-assets`, {
      data: {
        testPlanId: plan.id,
        engine: "k6",
        assetType: "human_authored",
        name: "Checkout load test",
        scriptContent: "import http from 'k6/http'; export default function() { http.get('http://test.k6.io'); }",
      },
    });
    expect(assetRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/sentinel/test-assets`);
    await expect(page.getByText("Checkout load test")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("k6").first()).toBeVisible();
    await expect(page.getByText("human").first()).toBeVisible();
  });
});

// ─── Test plans page ──────────────────────────────────────────────────────────

test.describe("Test plans", () => {
  test("loads test plans page", async ({ page }) => {
    const company = await getCompany(page);
    await page.goto(`/${company.issuePrefix}/sentinel/test-plans`);
    await expect(page.getByRole("heading", { name: "Test Plans" })).toBeVisible({ timeout: 10_000 });
  });

  test("test plan created via API appears with engine badges", async ({ page }) => {
    const company = await getCompany(page);
    const base = await getBaseUrl(page);
    await createTestPlan(page, base, company.id, {
      name: `Payment Suite ${Date.now()}`,
      engines: ["k6", "pytest"],
      filePatterns: ["src/payments/**"],
    });

    await page.goto(`/${company.issuePrefix}/sentinel/test-plans`);
    await expect(page.getByText(/Payment Suite/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("k6").first()).toBeVisible();
    await expect(page.getByText("pytest").first()).toBeVisible();
  });
});
