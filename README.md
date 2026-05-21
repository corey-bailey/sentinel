# Sentinel

**Autonomous agentic performance and functional testing platform**

Sentinel orchestrates a team of AI agents to run your entire test pipeline — from requirement intake through load testing, functional coverage, SLA analysis, regression detection, and report publishing — without human intervention in the happy path.

Built on the Paperclip agent execution infrastructure. Fork it, self-host it, and point your CI/CD at it.

<br/>

## What is Sentinel?

Most testing platforms tell you _what_ to test. Sentinel _runs_ the tests, _analyzes_ the results, _detects_ regressions, and _routes_ decisions to the right people — automatically.

| Step | Agent | What happens |
|---|---|---|
| **01** | TestOrchestrator | CI webhook fires → matching test plans selected → execution chain created |
| **02** | TestGenerationAgent | Coverage gaps detected → k6/Playwright/pytest/Mocha scripts generated |
| **03** | LoadTestAgent + FunctionalTestAgent | Tests run in parallel across all engines |
| **04** | AnalysisAgent | MetricSeries loaded, SLA targets evaluated, baselines compared, Dynatrace APM correlated |
| **05** | Human (you) | Regression or baseline proposal reviewed and approved/rejected in the UI |
| **06** | ReportPublisher | Confluence page written, Jira updated, GitHub PR status set, Slack notification sent |

<br/>

## User journeys

**UJ-1 — CI-triggered run:** Your pipeline POSTs a deploy webhook. Sentinel selects the matching test plans, runs all engines in parallel, and posts a pass/fail status back to the PR. Zero human action required on a green run.

**UJ-2 — Human creates a requirement:** A QA engineer fills in a requirement form with SLA targets. Sentinel audits existing test assets for coverage gaps, generates missing scripts, and queues a run automatically.

**UJ-3 — Jira-sourced requirement:** A PM agent POSTs a Jira issue ID. Sentinel reads the ticket, maps acceptance criteria to SLA targets, and kicks off the pipeline.

**UJ-4 — Regression detection:** A run breaches a baseline SLA. A regression card appears in the UI with deviation %, APM trace context, and approve/reject buttons. Your decision either promotes a new baseline or fails the deploy.

**UJ-5 — First run / baseline proposal:** No baseline exists yet. AnalysisAgent proposes the current results as v1. You review and approve. All subsequent runs compare against it.

**UJ-6 — Scheduled endurance run:** A nightly cron fires the full performance suite. AnalysisAgent compares to baseline. ReportPublisher posts a Confluence page. No human required.

**UJ-7 — Upstream agent POSTs requirements:** A release orchestration agent POSTs a structured requirement directly to the API. Sentinel treats it identically to a human-created requirement.

<br/>

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SENTINEL SERVER                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Requirements │  │  Test Plans  │  │  Test Assets │          │
│  │  + SLA targets│  │  + engines   │  │  + coverage  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Test Runs   │  │ MetricSeries │  │  Baselines   │          │
│  │  + triggers  │  │  + APM data  │  │  + tolerance │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────────────────────────┐     │
│  │ Regressions  │  │   Pipeline Builder (issue chain)     │     │
│  │  + decisions │  │  [REQ]→[GEN]→[RUN:*]→[ANL]→[RPT]   │     │
│  └──────────────┘  └──────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
   ┌─────┴──────┐ ┌─────┴──────┐ ┌────┴──────┐ ┌────┴──────┐
   │    k6      │ │ Playwright │ │  pytest   │ │   Mocha   │
   │ load tests │ │ UI tests   │ │ API tests │ │  JS tests │
   └────────────┘ └────────────┘ └───────────┘ └───────────┘
```

### Domain entities

| Entity | Purpose |
|---|---|
| **Requirement** | SLA targets (metric / operator / threshold / source), optional Jira link, coverage status |
| **TestPlan** | Engine list, file patterns for CI matching, load profile, APM provider, cron schedule |
| **TestAsset** | Script content per engine — human-authored, AI-generated, or approved-generated |
| **TestRun** | Triggered execution — CI, manual, or scheduled — with status and result signal |
| **MetricSeries** | Time-series metric data from each engine and APM adapter |
| **Baseline** | Approved reference value per metric with tolerance percentage |
| **Regression** | Deviation from baseline or baseline proposal awaiting human approval |

### Execution pipeline (issue stage tags)

| Tag | Stage | Agent |
|---|---|---|
| `[REQ]` | Requirement analysis + coverage audit | RequirementsAgent |
| `[GEN]` | Test script generation (when gaps exist) | TestGenerationAgent |
| `[RUN:k6]` | Load test execution | LoadTestAgent |
| `[RUN:playwright]` | UI functional test | FunctionalTestAgent |
| `[RUN:pytest]` | API contract test | FunctionalTestAgent |
| `[RUN:mocha]` | JS unit/integration test | FunctionalTestAgent |
| `[ANL]` | SLA evaluation, baseline comparison, regression creation | AnalysisAgent |
| `[REG]` | Regression or baseline proposal — requires human decision | (human) |
| `[RPT]` | Confluence + Jira + GitHub status + Slack | ReportPublisher |

Each stage is a first-class issue with atomic checkout, blocker dependencies, and full audit trail. `[RUN:*]` stages run in parallel; `[ANL]` waits for all of them.

<br/>

## Test engines

| Engine | Adapter | Metrics captured |
|---|---|---|
| **k6** | `packages/adapters/k6-local` | p50 / p95 / p99 / error\_rate\_pct / throughput |
| **Playwright** | `packages/adapters/playwright-local` | pass\_rate\_pct / per-test pass/fail / screenshots on failure |
| **pytest** | `packages/adapters/pytest-local` | pass\_rate\_pct / per-test pass/fail / error details |
| **Mocha** | `packages/adapters/mocha-local` | pass / fail counts |
| **Dynatrace APM** | `packages/adapters/apm-dynatrace` | p50 / p95 / p99 / error\_rate\_pct / DB call count |

APM data is optional and correlates infrastructure metrics with load test windows. If Dynatrace is unavailable, APM-sourced SLA targets become `skipped` — they don't fail the run.

<br/>

## API

### Trigger a CI deploy

```bash
POST /api/companies/:companyId/triggers/deploy
{
  "repo": "my-org/my-repo",
  "commit": "abc1234",
  "changedFiles": ["src/checkout/processor.ts"]
}
# → { "runIds": ["run-uuid-1", "run-uuid-2"] }
```

Sentinel selects all active TestPlans whose `filePatterns` match any changed file and creates a TestRun for each.

### Create a requirement

```bash
POST /api/companies/:companyId/requirements
{
  "name": "Checkout flow SLA",
  "slaTargets": [
    { "metric": "p95", "operator": "lt", "threshold": 300, "source": "k6" },
    { "metric": "error_rate_pct", "operator": "lt", "threshold": 1, "source": "k6" }
  ],
  "jiraIssueId": "PROJ-123"
}
```

### Approve or reject a regression

```bash
PATCH /api/regressions/:id
{ "action": "approve" }   # accepts deviation → promotes new baseline
{ "action": "reject" }    # rejects deviation → sets FAIL signal on TestRun
```

### Approve a baseline proposal

```bash
POST /api/baselines/:id/approve
# Deactivates previous active baseline for same plan+metric, activates this one
```

<br/>

## UI

Eight pages under `/:companyPrefix/sentinel/*`, reachable from the **Sentinel** sidebar section:

| Page | Path | Purpose |
|---|---|---|
| Overview | `/sentinel/dashboard` | Live stat cards, open regression banner, recent runs |
| Test Runs | `/sentinel/test-runs` | Full run history with status badges |
| Run detail | `/sentinel/test-runs/:id` | Metadata, result signal, live refresh when running |
| Regressions | `/sentinel/regressions` | Approve/reject queue + resolved history |
| Baselines | `/sentinel/baselines` | Active baselines + pending approval section |
| Requirements | `/sentinel/requirements` | List + create form |
| Test Plans | `/sentinel/test-plans` | Plans with engine badges and file patterns |
| Test Assets | `/sentinel/test-assets` | Scripts with coverage status and inline preview |

The Regressions sidebar item shows a live red badge with the open regression count, polling every 30 seconds.

<br/>

## Quickstart

```bash
git clone https://github.com/corey-bailey/sentinel.git
cd sentinel
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

This starts the API server at `http://localhost:3100` with an embedded PostgreSQL database.

> **Requirements:** Node.js 20+, pnpm 9.15+

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:server       # Server only
pnpm dev:ui           # UI only
pnpm build            # Build all packages
pnpm typecheck        # Type check all packages
pnpm test             # Vitest unit + integration suite
pnpm test:watch       # Vitest watch mode
pnpm db:generate      # Generate DB migration from schema changes
pnpm db:migrate       # Apply pending migrations
```

### E2E tests

```bash
cd tests/e2e
pnpm playwright test sentinel.spec.ts
```

Requires a running Sentinel instance. The E2E suite seeds all test data via the REST API — no LLM execution required.

### Test coverage

149 Sentinel-specific unit and integration tests across:
- `server/src/__tests__/requirements-routes.test.ts`
- `server/src/__tests__/trigger-routes.test.ts`
- `server/src/__tests__/test-run-routes.test.ts`
- `server/src/__tests__/baseline-routes.test.ts`
- `server/src/__tests__/regression-routes.test.ts`
- `server/src/__tests__/test-asset-routes.test.ts`
- `server/src/__tests__/pipeline-builder.test.ts`

<br/>

## Multi-company workspace design

One company = one service team's testing workspace. Do not split performance from functional via company boundaries — the unified TestRun model requires both engines in the same execution context.

```
ORD company  →  Orders service tests
PAY company  →  Payments service tests
API company  →  Core API tests
INT company  →  Cross-service integration tests
```

Each company gets its own agent pool, budget envelope, baseline history, issue sequence, and routine schedules.

<br/>

## License

MIT

<br/>

---

<p align="center">
  <sub>Built for teams who want tests to run themselves.</sub>
</p>
