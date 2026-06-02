# Pipeline Orchestration — Back-Half (Execute → Report) Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **PipelineRun state machine** that drives the execution-trigger back half — `validate → execute → analysis → report` — server-side: create a `pipeline_run`, run k6 via Plan 3's `k6Executor` (no agent assignment), evaluate SLAs via Plan 2's `slaVerdictEngine`, compute the **gate** (`auto_pass | auto_fail | inconclusive | characterization`) → set `verdict` + `ciSignal`, snapshot `resolvedExecution`, and persist the HTML + summary artifacts.

**Architecture:** A `pipelineRunService(db)` factory (no DAO) owns the `pipeline_runs` row and its `StageRecordMap` lifecycle (`pending → running → complete/skipped/failed/blocked`). The **execute** stage is *mechanical and server-side* (spec Stage 5): the orchestrator resolves inputs (k6 asset, a temp workspace cwd, baseUrl, steady window), creates a `test_run` + `execution_run`, calls `k6Executor.run`, and persists the k6 HTML artifact. The **analysis** stage runs `slaVerdictEngine.evaluate`, scopes the verdict counts to **required** targets, and a pure `resolveGate(...)` maps them (with `testIntent`) to an outcome + `ciSignal`, persisted as a `gate_resolutions` row and projected onto `pipeline_runs.verdict/ciSignal`. **report** persists a thin `sentinel_summary` artifact. A thin `POST /api/companies/:companyId/pipeline-runs` route triggers a run.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle, Zod (route), `node:fs/promises`, Vitest 3 + embedded-Postgres (DB/integration tests). **No migration** — `pipeline_runs`, `gate_resolutions`, `test_run_artifacts`, `execution_runs`, `test_runs`, `metric_series`, `sla_verdicts`, `test_assets` all shipped in Plans 1-3.

---

## Critical Context (read before any task)

### What Plan 4 is (and is NOT)

**IN scope:**
- `pipelineRunService`: `create` (initializes the `StageRecordMap` for the **execution-trigger** path), the stage-lifecycle mutators, and `runExecutionTrigger` (drives validate→execute→analysis→report).
- **Server-side execute** wiring: resolve inputs → create `test_run` + `execution_run` → `k6Executor.run` → record `executionRunIds` on the stage + persist the `k6_html_summary` artifact.
- **analysis + gate:** `slaVerdictEngine.evaluate` → required-scoped counts → pure `resolveGate` → `gate_resolutions` row → `pipeline_runs.verdict` + `ciSignal`.
- `resolvedExecution` snapshot; a thin `validate` stage (reachability probe, injected) and a thin `report` stage (`sentinel_summary` artifact).
- `testRunArtifactsService` (minimal create + a `k6_html_summary` helper).
- A `POST /api/companies/:companyId/pipeline-runs` route (create + run an execution-trigger run).

**DEFERRED (not built here):**
- The **front-half** stages (`intake/discovery/plan/generate`) and their agent-driven execution + the `assigneeAgentId` deadlock fix + the 5→8-stage `pipeline-builder` rewrite → **Plan 5** (Discovery→Plan→Generate). Plan 4 marks those stages `skipped` on the execution-trigger path.
- **Infra hardening** → a later pass: swap `spawn.ts`/`runK6` to the platform `runChildProcess` (timeout/grace/onLog), graceful abort (`terminateLocalService`), and `liveMetricFeed`/SSE streaming.
- Full **Stage-4 environment validation** (auth/smoke/Dynatrace ambient) — Plan 4's `validate` is a minimal reachability probe only.
- Real **ExecutionWorkspace** provisioning (Plan 4 uses a `fs.mkdtemp` temp dir as the cwd, recorded on `execution_runs.workspaceRef`); **secrets**-resolved auth (authToken is optional/undefined for v1).
- **Baseline/regression** gate outcomes (Stage 7) and `blocked_on_human` escalation of `inconclusive` (v1 maps `inconclusive → ciSignal 'fail'`).
- External artifact **storage** (S3/GCS): `storageRef` is the on-disk cwd path for v1; `publishStatus` stays `'stored'`.

### The gate matrix (spec Stage 8 — the heart of analysis)

`resolveGate` is a **pure function** of `{ testIntent, requiredTargetCount, requiredFailCount, requiredInconclusiveCount }`. Precedence (first match wins):

| Condition | outcome | ciSignal |
|---|---|---|
| `testIntent ∈ {baseline, exploratory}` **OR** `requiredTargetCount === 0` | `characterization` | `pass` |
| `requiredFailCount > 0` | `auto_fail` | `fail` |
| `requiredInconclusiveCount > 0` | `inconclusive` | `fail` (never false-green; `blocked_on_human` escalation deferred) |
| else (all required measured & passed) | `auto_pass` | `pass` |

`ciSignal` is **total** — `pass | fail` on every path (`gate_resolutions.ciSignal` is NOT NULL). The `verdict` on `pipeline_runs` is set from the outcome: `auto_pass | characterization → 'pass'`; `auto_fail → 'fail'`; `inconclusive → 'inconclusive'`.

**Required-scoping (do not gate on raw engine counts):** `slaVerdictEngine`'s `EvaluateResult.failCount` includes *optional* breaches and `inconclusiveCount` is required-only — so the gate must NOT use those directly. After `evaluate` persists `sla_verdicts`, the analysis stage loads `requirements_documents.slaTargets`, builds the set of **required** `slaTargetId`s, queries this run's `sla_verdicts`, and counts required fails / required inconclusives. `requiredTargetCount` = number of `slaTargets` with `required === true`.

### Execution-trigger stage initialization (spec lines ~1431-1451)

`create` initializes the `StageRecordMap` for the `execution-trigger` path (`trigger.type ∈ {ci, scheduled, manual_rerun}`):

| Stage | Initial status | Reason |
|---|---|---|
| intake | `skipped` | `skippedReason: 'execution-trigger: no new request'` |
| discovery | `skipped` | `skippedReason: 'execution-trigger: RequirementsDocument exists'` |
| plan | `skipped` | `skippedReason: 'execution-trigger: TestPlan exists'` |
| generate | `skipped` | `skippedReason: 'execution-trigger: assets exist'` (v1 assumes an approved asset already exists) |
| validate | `pending` | entry point |
| execute | `pending` | |
| analysis | `pending` | |
| report | `pending` | |

(The intake-trigger path — all stages `pending` — is Plan 5; `create` accepts a `path: 'execution-trigger'` param and only that path is implemented here. Passing any other path throws `UnsupportedTriggerPathError`.)

### Key existing contracts (verbatim — do not change)

```typescript
// pipeline_runs (packages/db/src/schema/pipeline_runs.ts) — StageRecord + StageRecordMap
type StageRecord = { status: 'pending'|'running'|'complete'|'skipped'|'failed'|'blocked';
  startedAt?: string; completedAt?: string; issueId?: string; assigneeAgentId?: string;
  skippedReason?: string; idempotencyKey?: string; error?: string; executionRunIds?: string[]; };
type StageRecordMap = { intake; discovery; plan; generate; validate; execute; analysis; report: StageRecord };
type PipelineTrigger = { type: 'manual_intake'|'jira'|'ci'|'scheduled'|'manual_rerun'; source: string; ref?: string; changedFiles?: string[] };
// verdict (NOT NULL default 'pending'): pending|running|pass|fail|blocked_on_human|inconclusive|error
// ciSignal (NOT NULL default 'pending'): pending|pass|fail|not_applicable
// resolvedExecution?: { loadProfile; executor; executionModel; resolvedSteadyWindow:{startMs,endMs}; testAssetVersions[]; dataFileHashes[]; secretRef; rngSeed }

// slaVerdictEngine (server/src/services/sla-verdict-engine.ts) — Plan 2
function slaVerdictEngine(db): { evaluate(input: { companyId; pipelineRunId; executionRunId }):
  Promise<{ verdictCount; passCount; failCount; inconclusiveCount; optionalSkippedCount }> }
// runHealthy requires execution_runs.status==='completed' && (exitCode===0 || null) — so EXECUTE must
// complete the execution_run BEFORE analysis evaluates.

// k6Executor (server/src/services/k6-executor.ts) — Plan 3
function k6Executor(deps: { db; spawnFn; binary? }): { run(input: {
  companyId; executionRunId; testRunId: string|null; cwd; asset:{ scriptContent; dataFiles:{name;content}[] };
  baseUrl; window:{warmupEndS;rampUpEndS;steadyEndS}; authToken? }): Promise<{ status:'completed'|'failed'; exitCode; ingestedCount }> }

// executionRunService (server/src/services/execution-runs.ts) — Plan 3
function executionRunService(db): {
  create(companyId, { pipelineRunId; testRunId?; testAssetId?; engine; binaryProfile?; workspaceRef? }): Promise<row>;
  markRunning(id): Promise<row>; complete(id, { status; exitCode?; peakVus?; totalRequests?; totalIterations? }): Promise<row>; }

// testAssetService (server/src/services/test-assets.ts) — list returns full rows incl scriptContent, dataFiles, engine, assetType, version
function testAssetService(db): { list(companyId, { testPlanId? }): Promise<row[]>; getById(id): Promise<row|null>; ... }

// resolveSteadyWindow (server/src/services/k6-generator/window.ts) — Plan 3
function resolveSteadyWindow(lp): { warmupEndS; rampUpEndS; steadyEndS; totalDurationS };
```

### Codebase conventions (match exactly)
- **Factory services:** `export function xService(db: Db) { async function m() {…} return { m }; }`. Pure helpers are plain exported functions.
- **ESM** with `.js` specifiers on relative imports; Drizzle from `drizzle-orm`; tables/types from `@sentinel/db`.
- **Routes:** `export function xRoutes(db: Db) { const r = Router(); ... return r; }`, registered in `server/src/app.ts` (`api.use(xRoutes(db))`); `assertCompanyAccess(req, companyId)` from `server/src/routes/authz.ts`; Zod `safeParse` → 422 `{ error: parsed.error.issues[0]?.message }`; success `res.status(201).json(result)` (no envelope).
- **Tests:** DB/integration use `server/src/__tests__/helpers/pipeline-schema-fixture.ts` (`withPipelineSchema([...tables])`, `embeddedPostgresSupport`, `ctx.db`, `ctx.companyId`); guard `const d = embeddedPostgresSupport.supported ? describe : describe.skip;`; tables passed child-before-parent. Pure-unit tests need no DB. Run one: `pnpm exec vitest run <file>` (if the rtk wrapper prints a misleading PASS/FAIL summary, use `rtk proxy pnpm exec vitest run <file>` for authoritative counts).
- **Gotcha:** `server/tsconfig.json` excludes `src/__tests__` — type bugs in tests surface only at vitest runtime.
- Conventional commits. Immutable updates (spread; never mutate inputs). NEVER `git add` `server/package.json` or the `.bak` file — use the exact `git add` paths each task specifies.

### File structure

```
server/src/services/
  gate-resolver.ts        # resolveGate(counts) -> { outcome, ciSignal }  (pure)
  test-run-artifacts.ts   # testRunArtifactsService(db): create + persistK6HtmlSummary
  pipeline-run.ts         # pipelineRunService(db): create / stage mutators / runExecutionTrigger (the orchestrator)
  pipeline-resolved-execution.ts  # buildResolvedExecution(testPlan, asset, window)  (pure)
server/src/routes/
  pipeline-runs.ts        # POST /api/companies/:companyId/pipeline-runs
server/src/app.ts         # MODIFY: mount pipelineRunsRoutes
```

---

## Task 1: `resolveGate` (pure gate matrix)

**Files:**
- Create: `server/src/services/gate-resolver.ts`
- Test: `server/src/__tests__/gate-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/gate-resolver.test.ts
import { describe, expect, it } from 'vitest';
import { resolveGate } from '../services/gate-resolver.js';

describe('resolveGate', () => {
  it('all required pass → auto_pass / pass', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 2, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'auto_pass', ciSignal: 'pass' });
  });
  it('a required breach → auto_fail / fail', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 2, requiredFailCount: 1, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'auto_fail', ciSignal: 'fail' });
  });
  it('a required inconclusive (no fail) → inconclusive / fail (never false-green)', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 1, requiredFailCount: 0, requiredInconclusiveCount: 1 }))
      .toEqual({ outcome: 'inconclusive', ciSignal: 'fail' });
  });
  it('fail takes precedence over inconclusive', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 3, requiredFailCount: 1, requiredInconclusiveCount: 1 }).outcome).toBe('auto_fail');
  });
  it('baseline intent → characterization / pass regardless of counts', () => {
    expect(resolveGate({ testIntent: 'baseline', requiredTargetCount: 0, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'characterization', ciSignal: 'pass' });
  });
  it('exploratory intent → characterization / pass', () => {
    expect(resolveGate({ testIntent: 'exploratory', requiredTargetCount: 1, requiredFailCount: 1, requiredInconclusiveCount: 0 }).outcome).toBe('characterization');
  });
  it('conformance with no required targets → characterization / pass', () => {
    expect(resolveGate({ testIntent: 'conformance', requiredTargetCount: 0, requiredFailCount: 0, requiredInconclusiveCount: 0 }))
      .toEqual({ outcome: 'characterization', ciSignal: 'pass' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/gate-resolver.test.ts`
Expected: FAIL — cannot import `resolveGate`.

- [ ] **Step 3: Write the resolver**

```typescript
// server/src/services/gate-resolver.ts
// Pure Stage-8 gate matrix. Maps REQUIRED-scoped SLA verdict counts (+ testIntent) to a gate outcome
// and a total ciSignal (pass|fail on every path). Baseline/regression outcomes (Stage 7) and the
// inconclusive → blocked_on_human escalation are deferred; v1 maps inconclusive → ciSignal 'fail'.

export type GateInput = {
  testIntent: string; // 'conformance' | 'baseline' | 'exploratory'
  requiredTargetCount: number;
  requiredFailCount: number;
  requiredInconclusiveCount: number;
};
export type GateOutcome = 'auto_pass' | 'auto_fail' | 'inconclusive' | 'characterization';
export type GateResult = { outcome: GateOutcome; ciSignal: 'pass' | 'fail' };

export function resolveGate(input: GateInput): GateResult {
  if (input.testIntent === 'baseline' || input.testIntent === 'exploratory' || input.requiredTargetCount === 0) {
    return { outcome: 'characterization', ciSignal: 'pass' };
  }
  if (input.requiredFailCount > 0) return { outcome: 'auto_fail', ciSignal: 'fail' };
  if (input.requiredInconclusiveCount > 0) return { outcome: 'inconclusive', ciSignal: 'fail' };
  return { outcome: 'auto_pass', ciSignal: 'pass' };
}

// outcome → the pipeline_runs.verdict value.
export function verdictForOutcome(outcome: GateOutcome): 'pass' | 'fail' | 'inconclusive' {
  if (outcome === 'auto_fail') return 'fail';
  if (outcome === 'inconclusive') return 'inconclusive';
  return 'pass'; // auto_pass | characterization
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/gate-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gate-resolver.ts server/src/__tests__/gate-resolver.test.ts
git commit -m "feat(server): resolveGate — pure Stage-8 gate matrix (outcome + ciSignal)"
```

---

## Task 2: `testRunArtifactsService`

**Files:**
- Create: `server/src/services/test-run-artifacts.ts`
- Test: `server/src/__tests__/test-run-artifacts-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/test-run-artifacts-service.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testRunArtifacts, pipelineRuns, testRuns, executionRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { testRunArtifactsService } from '../services/test-run-artifacts.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const PR_STUB = {
  trigger: { type: 'ci' as const, source: 'test' },
  stages: { intake: { status: 'skipped' }, discovery: { status: 'skipped' }, plan: { status: 'skipped' },
    generate: { status: 'skipped' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' } },
};

d('testRunArtifactsService', () => {
  const ctx = withPipelineSchema([testRunArtifacts, executionRuns, testRuns, pipelineRuns, testPlans]);

  async function seed() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'completed' }).returning();
    return { pipelineRunId: pr!.id, testRunId: tr!.id, executionRunId: er!.id };
  }

  it('creates an artifact row', async () => {
    const { pipelineRunId, testRunId, executionRunId } = await seed();
    const svc = testRunArtifactsService(ctx.db);
    const row = await svc.create(ctx.companyId, {
      pipelineRunId, executionRunId, testRunId, artifactType: 'sentinel_summary',
      storageRef: '/tmp/x/summary.json', contentType: 'application/json', sizeBytes: 12,
    });
    expect(row.artifactType).toBe('sentinel_summary');
    expect(row.publishStatus).toBe('stored');
    const [persisted] = await ctx.db.select().from(testRunArtifacts).where(eq(testRunArtifacts.id, row.id));
    expect(persisted?.storageRef).toBe('/tmp/x/summary.json');
  });

  it('persistK6HtmlSummary records the cwd html file when present (and is a no-op when absent)', async () => {
    const { pipelineRunId, testRunId, executionRunId } = await seed();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'artf-'));
    await fs.writeFile(path.join(cwd, 'summary-tr-1.html'), '<html>report</html>');
    const svc = testRunArtifactsService(ctx.db);

    const made = await svc.persistK6HtmlSummary(ctx.companyId, { pipelineRunId, executionRunId, testRunId, cwd, testRunId2: 'tr-1' });
    expect(made?.artifactType).toBe('k6_html_summary');
    expect(made?.storageRef).toBe(path.join(cwd, 'summary-tr-1.html'));
    expect(made?.sizeBytes).toBeGreaterThan(0);

    const absent = await svc.persistK6HtmlSummary(ctx.companyId, { pipelineRunId, executionRunId, testRunId, cwd, testRunId2: 'missing' });
    expect(absent).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/test-run-artifacts-service.test.ts`
Expected: FAIL — cannot import `testRunArtifactsService`.

- [ ] **Step 3: Write the service**

```typescript
// server/src/services/test-run-artifacts.ts
import fs from "node:fs/promises";
import path from "node:path";
import { testRunArtifacts, type Db } from "@sentinel/db";

export type CreateArtifactInput = {
  pipelineRunId: string;
  executionRunId?: string | null;
  testRunId?: string | null;
  artifactType: string; // k6_html_summary | sentinel_summary | stdout_log | ...
  storageRef: string;   // v1: on-disk cwd path (no external storage yet)
  url?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
};

export function testRunArtifactsService(db: Db) {
  async function create(companyId: string, data: CreateArtifactInput) {
    const [row] = await db
      .insert(testRunArtifacts)
      .values({
        companyId,
        pipelineRunId: data.pipelineRunId,
        executionRunId: data.executionRunId ?? null,
        testRunId: data.testRunId ?? null,
        artifactType: data.artifactType,
        storageRef: data.storageRef,
        url: data.url ?? null,
        contentType: data.contentType ?? null,
        sizeBytes: data.sizeBytes ?? null,
      })
      .returning();
    return row!;
  }

  // Records the k6 handleSummary HTML (summary-<testRunId2>.html in the run cwd) as a k6_html_summary
  // artifact. v1 storage = the on-disk path; returns null if the file is absent (e.g. a failed run).
  async function persistK6HtmlSummary(
    companyId: string,
    input: { pipelineRunId: string; executionRunId: string; testRunId: string | null; cwd: string; testRunId2: string },
  ) {
    const file = path.join(input.cwd, `summary-${input.testRunId2}.html`);
    let sizeBytes: number;
    try {
      sizeBytes = (await fs.stat(file)).size;
    } catch {
      return null;
    }
    return create(companyId, {
      pipelineRunId: input.pipelineRunId,
      executionRunId: input.executionRunId,
      testRunId: input.testRunId,
      artifactType: "k6_html_summary",
      storageRef: file,
      contentType: "text/html",
      sizeBytes,
    });
  }

  return { create, persistK6HtmlSummary };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/test-run-artifacts-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/test-run-artifacts.ts server/src/__tests__/test-run-artifacts-service.test.ts
git commit -m "feat(server): testRunArtifactsService (create + k6 html summary persistence)"
```

---

## Task 3: `buildResolvedExecution` (pure snapshot)

**Files:**
- Create: `server/src/services/pipeline-resolved-execution.ts`
- Test: `server/src/__tests__/pipeline-resolved-execution.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-resolved-execution.test.ts
import { describe, expect, it } from 'vitest';
import { buildResolvedExecution } from '../services/pipeline-resolved-execution.js';

describe('buildResolvedExecution', () => {
  it('snapshots loadProfile, executor/model, steady window (ms), asset version, and data hashes', () => {
    const out = buildResolvedExecution({
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      asset: { id: 'asset-1', workflowName: 'all', engine: 'k6', version: 3, dataFiles: [{ name: 'reusable.json', content: '[]' }] },
      window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 },
    });
    expect(out.executor).toBe('ramping-vus');
    expect(out.executionModel).toBe('weighted-loop');
    expect(out.resolvedSteadyWindow).toEqual({ startMs: 120000, endMs: 720000 });
    expect(out.testAssetVersions).toEqual([{ testAssetId: 'asset-1', workflowName: 'all', engine: 'k6', version: 3 }]);
    expect(out.dataFileHashes[0]!.name).toBe('reusable.json');
    expect(out.dataFileHashes[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.loadProfile).toMatchObject({ executor: 'ramping-vus' });
  });

  it('tolerates a null loadProfile and no data files', () => {
    const out = buildResolvedExecution({
      loadProfile: null, executionModel: null,
      asset: { id: 'a', workflowName: 'all', engine: 'k6', version: 1, dataFiles: null },
      window: { warmupEndS: 30, rampUpEndS: 30, steadyEndS: 300, totalDurationS: 300 },
    });
    expect(out.executor).toBe('unknown');
    expect(out.executionModel).toBe('weighted-loop');
    expect(out.dataFileHashes).toEqual([]);
    expect(out.loadProfile).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-resolved-execution.test.ts`
Expected: FAIL — cannot import `buildResolvedExecution`.

- [ ] **Step 3: Write the builder**

```typescript
// server/src/services/pipeline-resolved-execution.ts
import { createHash } from "node:crypto";
import type { ResolvedExecution } from "@sentinel/db";
import type { SteadyWindow } from "./k6-generator/window.js";

export type BuildResolvedExecutionInput = {
  loadProfile: Record<string, unknown> | null;
  executionModel: string | null;
  asset: { id: string; workflowName?: string | null; engine: string; version?: number | null; dataFiles?: Array<{ name: string; content: string }> | null };
  window: SteadyWindow;
};

// The immutable "what was actually executed" snapshot (distinct from the mutable TestPlan).
export function buildResolvedExecution(input: BuildResolvedExecutionInput): ResolvedExecution {
  const lp = (input.loadProfile ?? {}) as Record<string, unknown>;
  const executor = (typeof lp.executor === "string" ? lp.executor : "unknown") as ResolvedExecution["executor"];
  return {
    loadProfile: lp,
    executor,
    executionModel: (input.executionModel === "per-scenario" ? "per-scenario" : "weighted-loop"),
    resolvedSteadyWindow: { startMs: input.window.rampUpEndS * 1000, endMs: input.window.steadyEndS * 1000 },
    testAssetVersions: [{
      testAssetId: input.asset.id,
      workflowName: input.asset.workflowName ?? "all",
      engine: input.asset.engine,
      version: input.asset.version ?? 1,
    }],
    dataFileHashes: (input.asset.dataFiles ?? []).map((f) => ({
      name: f.name,
      sha256: createHash("sha256").update(f.content).digest("hex"),
    })),
    secretRef: "",
    rngSeed: 0,
  };
}
```

> Note: `ResolvedExecution.executor` is a union that does not include `'unknown'`; the cast documents that v1 tolerates a missing/legacy loadProfile. If `tsc` rejects the literal `'unknown'` cast, widen via `as ResolvedExecution['executor']` (already applied) — it compiles because the cast is explicit.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-resolved-execution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-resolved-execution.ts server/src/__tests__/pipeline-resolved-execution.test.ts
git commit -m "feat(server): buildResolvedExecution snapshot for pipeline_runs"
```

---

## Task 4: `pipelineRunService.create` (execution-trigger stage init)

**Files:**
- Create: `server/src/services/pipeline-run.ts`
- Test: `server/src/__tests__/pipeline-run-create.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-run-create.test.ts
import { describe, expect, it } from 'vitest';
import { pipelineRuns, testPlans, requirementsDocuments } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService, UnsupportedTriggerPathError } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipelineRunService.create', () => {
  const ctx = withPipelineSchema([pipelineRuns, testPlans, requirementsDocuments]);

  it('initializes the execution-trigger stage map (front-half skipped, validate→report pending)', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const svc = pipelineRunService(ctx.db);
    const run = await svc.create(ctx.companyId, {
      path: 'execution-trigger',
      trigger: { type: 'manual_rerun', source: 'test' },
      testPlanId: plan!.id,
      requirementsDocumentId: rd!.id,
    });

    expect(run.verdict).toBe('pending');
    expect(run.ciSignal).toBe('pending');
    const [persisted] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id));
    const stages = persisted!.stages as Record<string, { status: string; skippedReason?: string }>;
    expect(stages.intake.status).toBe('skipped');
    expect(stages.discovery.status).toBe('skipped');
    expect(stages.plan.status).toBe('skipped');
    expect(stages.generate.status).toBe('skipped');
    expect(stages.validate.status).toBe('pending');
    expect(stages.execute.status).toBe('pending');
    expect(stages.analysis.status).toBe('pending');
    expect(stages.report.status).toBe('pending');
    expect(stages.intake.skippedReason).toMatch(/execution-trigger/);
  });

  it('throws for an unimplemented trigger path', async () => {
    const svc = pipelineRunService(ctx.db);
    await expect(svc.create(ctx.companyId, { path: 'intake-trigger' as never, trigger: { type: 'manual_intake', source: 't' } }))
      .rejects.toThrow(UnsupportedTriggerPathError);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-create.test.ts`
Expected: FAIL — cannot import `pipelineRunService`.

- [ ] **Step 3: Write `create` + the stage-map initializer (start of `pipeline-run.ts`)**

```typescript
// server/src/services/pipeline-run.ts
import { pipelineRuns, type Db, type PipelineTrigger, type StageRecordMap, type StageRecord } from "@sentinel/db";
import { eq } from "drizzle-orm";

export class UnsupportedTriggerPathError extends Error {
  constructor(path: string) { super(`Unsupported pipeline trigger path (v1 = execution-trigger only): ${path}`); this.name = "UnsupportedTriggerPathError"; }
}

const STAGE_ORDER = ["intake", "discovery", "plan", "generate", "validate", "execute", "analysis", "report"] as const;
export type StageName = (typeof STAGE_ORDER)[number];

function executionTriggerStages(): StageRecordMap {
  const skipped = (reason: string): StageRecord => ({ status: "skipped", skippedReason: reason });
  const pending = (): StageRecord => ({ status: "pending" });
  return {
    intake: skipped("execution-trigger: no new request"),
    discovery: skipped("execution-trigger: RequirementsDocument exists"),
    plan: skipped("execution-trigger: TestPlan exists"),
    generate: skipped("execution-trigger: assets exist"),
    validate: pending(),
    execute: pending(),
    analysis: pending(),
    report: pending(),
  };
}

export type CreatePipelineRunInput = {
  path: "execution-trigger";
  trigger: PipelineTrigger;
  testPlanId?: string | null;
  requirementsDocumentId?: string | null;
  pipelineRequestId?: string | null;
};

export function pipelineRunService(db: Db) {
  async function create(companyId: string, input: CreatePipelineRunInput) {
    if (input.path !== "execution-trigger") throw new UnsupportedTriggerPathError(String(input.path));
    const [row] = await db
      .insert(pipelineRuns)
      .values({
        companyId,
        testPlanId: input.testPlanId ?? null,
        requirementsDocumentId: input.requirementsDocumentId ?? null,
        pipelineRequestId: input.pipelineRequestId ?? null,
        trigger: input.trigger,
        stages: executionTriggerStages(),
      })
      .returning();
    return row!;
  }

  return { create };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-create.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-run.ts server/src/__tests__/pipeline-run-create.test.ts
git commit -m "feat(server): pipelineRunService.create — execution-trigger stage map"
```

---

## Task 5: pipeline-run stage mutators + field setters

**Files:**
- Modify: `server/src/services/pipeline-run.ts`
- Test: `server/src/__tests__/pipeline-run-mutators.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-run-mutators.test.ts
import { describe, expect, it } from 'vitest';
import { pipelineRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipelineRunService stage mutators', () => {
  const ctx = withPipelineSchema([pipelineRuns, testPlans]);

  async function newRun() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    return (await pipelineRunService(ctx.db).create(ctx.companyId, {
      path: 'execution-trigger', trigger: { type: 'ci', source: 'test' }, testPlanId: plan!.id,
    })).id;
  }
  async function stages(id: string) {
    const [r] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    return r!.stages as Record<string, { status: string; startedAt?: string; completedAt?: string; error?: string; executionRunIds?: string[] }>;
  }

  it('markStageRunning sets running + startedAt and markStageComplete sets complete + completedAt', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageRunning(id, 'validate');
    expect((await stages(id)).validate.status).toBe('running');
    expect((await stages(id)).validate.startedAt).toBeTruthy();
    await svc.markStageComplete(id, 'validate');
    expect((await stages(id)).validate.status).toBe('complete');
    expect((await stages(id)).validate.completedAt).toBeTruthy();
  });

  it('markStageComplete merges a patch (e.g. executionRunIds) without clobbering other stages', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageComplete(id, 'execute', { executionRunIds: ['er-1'] });
    const s = await stages(id);
    expect(s.execute.status).toBe('complete');
    expect(s.execute.executionRunIds).toEqual(['er-1']);
    expect(s.report.status).toBe('pending'); // untouched
  });

  it('markStageFailed records the error and setVerdict/setCiSignal/markCompleted persist', async () => {
    const id = await newRun();
    const svc = pipelineRunService(ctx.db);
    await svc.markStageFailed(id, 'execute', 'k6 exited 1');
    expect((await stages(id)).execute.status).toBe('failed');
    expect((await stages(id)).execute.error).toBe('k6 exited 1');
    await svc.setVerdict(id, 'fail');
    await svc.setCiSignal(id, 'fail');
    await svc.markCompleted(id);
    const [r] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    expect(r!.verdict).toBe('fail');
    expect(r!.ciSignal).toBe('fail');
    expect(r!.completedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-mutators.test.ts`
Expected: FAIL — `markStageRunning` is not a function.

- [ ] **Step 3: Add the mutators to `pipelineRunService` (in `pipeline-run.ts`)**

Add these helpers inside the `pipelineRunService(db)` factory, before `return`, and extend the returned object. The stage mutators read-modify-write the `stages` jsonb immutably (spread), so concurrent stages are never clobbered.

```typescript
  // --- internal: immutable read-modify-write of one stage's record ---
  async function patchStage(id: string, stage: StageName, patch: Partial<StageRecord>) {
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    if (!row) throw new Error(`pipeline_run not found: ${id}`);
    const stages = row.stages as StageRecordMap;
    const next: StageRecordMap = { ...stages, [stage]: { ...stages[stage], ...patch } };
    const [updated] = await db.update(pipelineRuns).set({ stages: next, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return updated!;
  }

  async function markStageRunning(id: string, stage: StageName) {
    return patchStage(id, stage, { status: "running", startedAt: new Date().toISOString() });
  }
  async function markStageComplete(id: string, stage: StageName, patch: Partial<StageRecord> = {}) {
    return patchStage(id, stage, { status: "complete", completedAt: new Date().toISOString(), ...patch });
  }
  async function markStageSkipped(id: string, stage: StageName, skippedReason: string) {
    return patchStage(id, stage, { status: "skipped", skippedReason });
  }
  async function markStageFailed(id: string, stage: StageName, error: string) {
    return patchStage(id, stage, { status: "failed", completedAt: new Date().toISOString(), error });
  }
  async function setVerdict(id: string, verdict: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setCiSignal(id: string, ciSignal: string) {
    const [r] = await db.update(pipelineRuns).set({ ciSignal, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setResolvedExecution(id: string, resolvedExecution: unknown) {
    const [r] = await db.update(pipelineRuns).set({ resolvedExecution: resolvedExecution as never, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markStarted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markCompleted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ completedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
```

Then change `return { create };` to:

```typescript
  return { create, markStageRunning, markStageComplete, markStageSkipped, markStageFailed, setVerdict, setCiSignal, setResolvedExecution, markStarted, markCompleted };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-mutators.test.ts`
Expected: PASS. Also re-run Task 4's test (`pnpm exec vitest run server/src/__tests__/pipeline-run-create.test.ts`) — still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-run.ts server/src/__tests__/pipeline-run-mutators.test.ts
git commit -m "feat(server): pipelineRunService stage mutators + verdict/ciSignal/resolvedExecution setters"
```

---

## Task 6: Execute-stage input resolution (`resolveExecuteInputs`)

**Files:**
- Modify: `server/src/services/pipeline-run.ts`
- Test: `server/src/__tests__/pipeline-run-resolve-inputs.test.ts`

Resolves the inputs the EXECUTE stage needs from the DB: the approved k6 asset, the baseUrl, and the steady window. Pure-ish (DB reads only); throws a typed error when a prerequisite is missing so the orchestrator can fail the stage cleanly.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-run-resolve-inputs.test.ts
import { describe, expect, it } from 'vitest';
import { testAssets, testPlans, requirementsDocuments } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { resolveExecuteInputs, ExecutePrerequisiteError } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('resolveExecuteInputs', () => {
  const ctx = withPipelineSchema([testAssets, testPlans, requirementsDocuments]);

  it('resolves the k6 asset, baseUrl, and steady window', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({
      companyId: ctx.companyId, slaTargets: [], minSampleCount: 200,
      targetEnvironment: { baseUrl: 'https://staging.example.com' },
    }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({
      companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, executionModel: 'weighted-loop',
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
    }).returning();
    await ctx.db.insert(testAssets).values({
      companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6-script', engine: 'k6', assetType: 'generated',
      scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }],
    }).returning();

    const out = await resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    expect(out.baseUrl).toBe('https://staging.example.com');
    expect(out.asset.scriptContent).toContain('export default');
    expect(out.asset.dataFiles).toHaveLength(1);
    expect(out.window).toEqual({ warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 });
    expect(out.testPlan.executionModel).toBe('weighted-loop');
  });

  it('throws ExecutePrerequisiteError when no k6 asset exists', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200, targetEnvironment: { baseUrl: 'http://x' } }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' } }).returning();
    await expect(resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id }))
      .rejects.toThrow(ExecutePrerequisiteError);
  });

  it('throws ExecutePrerequisiteError when baseUrl is missing', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: [], minSampleCount: 200, targetEnvironment: {} }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' } }).returning();
    await ctx.db.insert(testAssets).values({ companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6', engine: 'k6', assetType: 'generated', scriptContent: 'x' });
    await expect(resolveExecuteInputs(ctx.db, ctx.companyId, { testPlanId: plan!.id, requirementsDocumentId: rd!.id }))
      .rejects.toThrow(/baseUrl/);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-resolve-inputs.test.ts`
Expected: FAIL — cannot import `resolveExecuteInputs`.

- [ ] **Step 3: Add `resolveExecuteInputs` (top-level export in `pipeline-run.ts`)**

Add these imports at the top of `pipeline-run.ts`:

```typescript
import { testAssets, testPlans, requirementsDocuments } from "@sentinel/db";
import { and, eq } from "drizzle-orm";
import { resolveSteadyWindow, type SteadyWindow } from "./k6-generator/window.js";
```

(Replace the existing `import { eq } from "drizzle-orm";` with the `{ and, eq }` form.)

Add this exported error + function (top-level, not inside the factory):

```typescript
export class ExecutePrerequisiteError extends Error {
  constructor(detail: string) { super(`Cannot execute: ${detail}`); this.name = "ExecutePrerequisiteError"; }
}

export type ExecuteInputs = {
  testPlan: typeof testPlans.$inferSelect;
  asset: typeof testAssets.$inferSelect;
  baseUrl: string;
  window: SteadyWindow;
};

// Resolves what the mechanical EXECUTE stage needs. v1: the first k6 asset for the plan, the baseUrl
// from requirements_documents.targetEnvironment, and the steady window derived from the plan's
// loadProfile (same derivation the generated script baked in — see Plan 3 window.ts).
export async function resolveExecuteInputs(
  db: Db, companyId: string, input: { testPlanId: string; requirementsDocumentId: string },
): Promise<ExecuteInputs> {
  const [testPlan] = await db.select().from(testPlans).where(and(eq(testPlans.id, input.testPlanId), eq(testPlans.companyId, companyId)));
  if (!testPlan) throw new ExecutePrerequisiteError(`test_plan ${input.testPlanId} not found`);

  const assets = await db.select().from(testAssets).where(and(eq(testAssets.companyId, companyId), eq(testAssets.testPlanId, input.testPlanId), eq(testAssets.engine, "k6")));
  const asset = assets.find((a) => a.scriptContent && a.scriptContent.length > 0);
  if (!asset) throw new ExecutePrerequisiteError(`no k6 asset with scriptContent for test_plan ${input.testPlanId}`);

  const [rd] = await db.select().from(requirementsDocuments).where(and(eq(requirementsDocuments.id, input.requirementsDocumentId), eq(requirementsDocuments.companyId, companyId)));
  const targetEnv = (rd?.targetEnvironment ?? {}) as { baseUrl?: unknown };
  const baseUrl = typeof targetEnv.baseUrl === "string" ? targetEnv.baseUrl : "";
  if (!baseUrl) throw new ExecutePrerequisiteError(`requirements_documents.targetEnvironment.baseUrl is missing`);

  // resolveSteadyWindow reads only executor/stages/evaluationWindow/duration/warmupGuard — the test_plans
  // LoadProfile is structurally compatible for those fields (the startVus/startVUs casing difference is
  // not read). Cast across the two LoadProfile types.
  const window = resolveSteadyWindow(testPlan.loadProfile as never);
  return { testPlan, asset, baseUrl, window };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-resolve-inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-run.ts server/src/__tests__/pipeline-run-resolve-inputs.test.ts
git commit -m "feat(server): resolveExecuteInputs (k6 asset + baseUrl + steady window)"
```

---

## Task 7: Required-scoped verdict counts (`countRequiredVerdicts`)

**Files:**
- Modify: `server/src/services/pipeline-run.ts`
- Test: `server/src/__tests__/pipeline-run-required-counts.test.ts`

The gate must count **required** fails/inconclusives only (see Critical Context). This reads `requirements_documents.slaTargets` + the persisted `sla_verdicts` for the run.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-run-required-counts.test.ts
import { describe, expect, it } from 'vitest';
import { slaVerdicts, pipelineRuns, executionRuns, testRuns, testPlans, requirementsDocuments } from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { countRequiredVerdicts } from '../services/pipeline-run.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const PR_STUB = { trigger: { type: 'ci' as const, source: 't' }, stages: { intake: { status: 'skipped' }, discovery: { status: 'skipped' }, plan: { status: 'skipped' }, generate: { status: 'skipped' }, validate: { status: 'pending' }, execute: { status: 'pending' }, analysis: { status: 'pending' }, report: { status: 'pending' } } };
const t = (id: string, required: boolean): SlaTarget => ({ id, source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 500, required });

d('countRequiredVerdicts', () => {
  const ctx = withPipelineSchema([slaVerdicts, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testPlans]);

  it('counts only required fails/inconclusives; reports requiredTargetCount', async () => {
    const targets = [t('req-1', true), t('req-2', true), t('opt-1', false)];
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, requirementsDocumentId: rd!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'completed' }).returning();

    const mkVerdict = (slaTargetId: string, status: string) => ({ companyId: ctx.companyId, pipelineRunId: pr!.id, executionRunId: er!.id, slaTargetId, metric: 'p95_ms', operator: 'lt', threshold: 500, source: 'k6', phase: 'steady', status, evaluatedOnSuccessOnly: true });
    await ctx.db.insert(slaVerdicts).values([
      mkVerdict('req-1', 'fail'),
      mkVerdict('req-2', 'inconclusive'),
      mkVerdict('opt-1', 'fail'), // optional fail — must NOT count toward the gate
    ]);

    const counts = await countRequiredVerdicts(ctx.db, ctx.companyId, { pipelineRunId: pr!.id, executionRunId: er!.id, requirementsDocumentId: rd!.id });
    expect(counts).toEqual({ requiredTargetCount: 2, requiredFailCount: 1, requiredInconclusiveCount: 1 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-required-counts.test.ts`
Expected: FAIL — cannot import `countRequiredVerdicts`.

- [ ] **Step 3: Add `countRequiredVerdicts` (top-level export in `pipeline-run.ts`)**

Add to the `@sentinel/db` import: `slaVerdicts` and the type `SlaTarget`. Add:

```typescript
export type RequiredVerdictCounts = { requiredTargetCount: number; requiredFailCount: number; requiredInconclusiveCount: number };

// Scopes the gate to REQUIRED SLA targets (the engine's aggregate counts mix in optional breaches).
export async function countRequiredVerdicts(
  db: Db, companyId: string, input: { pipelineRunId: string; executionRunId: string; requirementsDocumentId: string },
): Promise<RequiredVerdictCounts> {
  const [rd] = await db.select().from(requirementsDocuments).where(and(eq(requirementsDocuments.id, input.requirementsDocumentId), eq(requirementsDocuments.companyId, companyId)));
  const targets = (rd?.slaTargets ?? []) as SlaTarget[];
  const requiredIds = new Set(targets.filter((t) => t.required).map((t) => t.id));

  const rows = await db.select().from(slaVerdicts).where(and(eq(slaVerdicts.companyId, companyId), eq(slaVerdicts.pipelineRunId, input.pipelineRunId), eq(slaVerdicts.executionRunId, input.executionRunId)));
  let requiredFailCount = 0;
  let requiredInconclusiveCount = 0;
  for (const r of rows) {
    if (!requiredIds.has(r.slaTargetId)) continue;
    if (r.status === "fail") requiredFailCount++;
    else if (r.status === "inconclusive") requiredInconclusiveCount++;
  }
  return { requiredTargetCount: requiredIds.size, requiredFailCount, requiredInconclusiveCount };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-required-counts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-run.ts server/src/__tests__/pipeline-run-required-counts.test.ts
git commit -m "feat(server): countRequiredVerdicts scopes the gate to required SLA targets"
```

---

## Task 8: The orchestrator — `runExecutionTrigger`

**Files:**
- Modify: `server/src/services/pipeline-run.ts`
- Test: `server/src/__tests__/pipeline-run-orchestrator.test.ts`

Drives `validate → execute → analysis → report` for an existing `pipeline_run`. Dependencies (`spawnFn`, and optionally an injected `reachabilityProbe`) are injected for testability. The EXECUTE stage is server-side: create `test_run` + `execution_run`, `k6Executor.run`, persist the HTML artifact. ANALYSIS runs `slaVerdictEngine.evaluate`, scopes counts, resolves the gate, persists `gate_resolutions`, and sets `verdict`/`ciSignal`.

- [ ] **Step 1: Write the failing test** (full back-half, fake k6 writing a raw summary + an HTML file)

```typescript
// server/src/__tests__/pipeline-run-orchestrator.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  pipelineRuns, gateResolutions, testRunArtifacts, slaVerdicts, metricSeries,
  executionRuns, testRuns, testPlans, requirementsDocuments, testAssets,
} from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { pipelineRunService } from '../services/pipeline-run.js';
import type { SpawnFn } from '../services/test-adapters/k6-adapter.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;
const t = (id: string, threshold: number): SlaTarget => ({ id, source: 'k6', metric: 'p95_ms', operator: 'lt', threshold, required: true });

// Fake k6: writes BOTH a raw summary json (for ingestion) and an html file (for the artifact), exits 0.
function fakeK6(p95: number, sampleCount: number): SpawnFn {
  return async (_cmd, _args, opts) => {
    const id = opts.env.TEST_RUN_ID;
    const data = { metrics: {
      'http_req_duration{expected_response:true,phase:steady}': { type: 'trend', values: { med: p95 - 20, 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount } },
      vus_max: { type: 'gauge', values: { max: 500 } }, http_reqs: { type: 'counter', values: { count: sampleCount } }, iterations: { type: 'counter', values: { count: sampleCount } },
    } };
    await fs.writeFile(path.join(opts.cwd!, `summary-${id}.json`), JSON.stringify(data));
    await fs.writeFile(path.join(opts.cwd!, `summary-${id}.html`), '<html>k6 report</html>');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

d('pipelineRunService.runExecutionTrigger', () => {
  const ctx = withPipelineSchema([gateResolutions, testRunArtifacts, slaVerdicts, metricSeries, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testAssets, testPlans]);

  async function seed(targets: SlaTarget[], testIntent = 'conformance') {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200, testIntent, targetEnvironment: { baseUrl: 'http://localhost:9' } }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id, executionModel: 'weighted-loop', loadProfile: { protocol: 'http', executor: 'ramping-vus', startVus: 0, stages: [{ duration: '1m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }] } }).returning();
    await ctx.db.insert(testAssets).values({ companyId: ctx.companyId, testPlanId: plan!.id, name: 'k6', engine: 'k6', assetType: 'generated', version: 2, scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }] });
    const run = await pipelineRunService(ctx.db).create(ctx.companyId, { path: 'execution-trigger', trigger: { type: 'manual_rerun', source: 'test' }, testPlanId: plan!.id, requirementsDocumentId: rd!.id });
    return { runId: run.id, requirementsDocumentId: rd!.id };
  }

  it('happy path: p95 under threshold → auto_pass, ciSignal pass, all back-half stages complete', async () => {
    const { runId } = await seed([t('req-1', 500)]);
    const svc = pipelineRunService(ctx.db);
    const result = await svc.runExecutionTrigger(runId, { spawnFn: fakeK6(180, 1200) });

    expect(result.verdict).toBe('pass');
    expect(result.ciSignal).toBe('pass');

    const [pr] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const stages = pr!.stages as Record<string, { status: string; executionRunIds?: string[] }>;
    expect(stages.validate.status).toBe('complete');
    expect(stages.execute.status).toBe('complete');
    expect(stages.analysis.status).toBe('complete');
    expect(stages.report.status).toBe('complete');
    expect(stages.execute.executionRunIds?.length).toBe(1);
    expect(pr!.resolvedExecution).toBeTruthy();

    // a gate_resolutions row + the artifacts were persisted
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('auto_pass');
    expect(gates[0]?.ciSignal).toBe('pass');
    const artifacts = await ctx.db.select().from(testRunArtifacts).where(eq(testRunArtifacts.pipelineRunId, runId));
    expect(artifacts.map((a) => a.artifactType).sort()).toEqual(['k6_html_summary', 'sentinel_summary']);
    // metric_series ingested by k6Executor + sla_verdicts produced by the engine
    expect((await ctx.db.select().from(metricSeries).where(eq(metricSeries.executionRunId, stages.execute.executionRunIds![0]!))).length).toBeGreaterThan(0);
    expect((await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, runId))).length).toBeGreaterThan(0);
  });

  it('breach: p95 over threshold → auto_fail, ciSignal fail', async () => {
    const { runId } = await seed([t('req-1', 200)]);
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: fakeK6(480, 1200) });
    expect(result.verdict).toBe('fail');
    expect(result.ciSignal).toBe('fail');
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('auto_fail');
  });

  it('baseline intent → characterization, ciSignal pass', async () => {
    const { runId } = await seed([], 'baseline');
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: fakeK6(50, 1200) });
    expect(result.verdict).toBe('pass');
    const gates = await ctx.db.select().from(gateResolutions).where(eq(gateResolutions.pipelineRunId, runId));
    expect(gates[0]?.outcome).toBe('characterization');
  });

  it('k6 non-zero exit → execute stage failed, verdict error', async () => {
    const { runId } = await seed([t('req-1', 500)]);
    const failSpawn: SpawnFn = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    const result = await pipelineRunService(ctx.db).runExecutionTrigger(runId, { spawnFn: failSpawn });
    expect(result.verdict).toBe('error');
    const [pr] = await ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    const stages = pr!.stages as Record<string, { status: string }>;
    expect(stages.execute.status).toBe('failed');
    expect(stages.analysis.status).toBe('pending'); // never reached
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-orchestrator.test.ts`
Expected: FAIL — `runExecutionTrigger` is not a function.

- [ ] **Step 3: Implement `runExecutionTrigger`**

Add imports to `pipeline-run.ts`:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gateResolutions, testRuns, executionRuns } from "@sentinel/db";
import { k6Executor } from "./k6-executor.js";
import { executionRunService } from "./execution-runs.js";
import { slaVerdictEngine } from "./sla-verdict-engine.js";
import { testRunArtifactsService } from "./test-run-artifacts.js";
import { buildResolvedExecution } from "./pipeline-resolved-execution.js";
import { resolveGate, verdictForOutcome } from "./gate-resolver.js";
import type { SpawnFn } from "./test-adapters/k6-adapter.js";
```

Add this `run` orchestration inside `pipelineRunService(db)` (before `return`), and add `runExecutionTrigger` to the returned object:

```typescript
  async function runExecutionTrigger(
    pipelineRunId: string,
    deps: { spawnFn: SpawnFn; reachabilityProbe?: (baseUrl: string) => Promise<boolean> },
  ): Promise<{ verdict: string; ciSignal: string }> {
    await markStarted(pipelineRunId); // verdict='running'
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pipelineRunId));
    if (!run) throw new Error(`pipeline_run not found: ${pipelineRunId}`);
    if (!run.testPlanId || !run.requirementsDocumentId) {
      await markStageFailed(pipelineRunId, "execute", "pipeline_run missing testPlanId/requirementsDocumentId");
      await setVerdict(pipelineRunId, "error");
      await setCiSignal(pipelineRunId, "fail");
      await markCompleted(pipelineRunId);
      return { verdict: "error", ciSignal: "fail" };
    }
    const companyId = run.companyId;
    const testPlanId = run.testPlanId;
    const requirementsDocumentId = run.requirementsDocumentId;

    try {
      // ---- VALIDATE (thin: reachability probe; full Stage-4 validation deferred) ----
      await markStageRunning(pipelineRunId, "validate");
      const inputs = await resolveExecuteInputs(db, companyId, { testPlanId, requirementsDocumentId });
      const reachable = deps.reachabilityProbe ? await deps.reachabilityProbe(inputs.baseUrl) : true;
      if (!reachable) {
        await markStageFailed(pipelineRunId, "validate", `target not reachable: ${inputs.baseUrl}`);
        await setVerdict(pipelineRunId, "error"); await setCiSignal(pipelineRunId, "fail"); await markCompleted(pipelineRunId);
        return { verdict: "error", ciSignal: "fail" };
      }
      await markStageComplete(pipelineRunId, "validate");

      // ---- EXECUTE (server-side, mechanical) ----
      await markStageRunning(pipelineRunId, "execute");
      const [testRun] = await db.insert(testRuns).values({ companyId, testPlanId, pipelineRunId }).returning();
      const runs = executionRunService(db);
      const er = await runs.create(companyId, { pipelineRunId, testRunId: testRun!.id, testAssetId: inputs.asset.id, engine: "k6", binaryProfile: "k6" });
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-run-"));
      await db.update(executionRuns).set({ workspaceRef: cwd }).where(eq(executionRuns.id, er.id));

      const execResult = await k6Executor({ db, spawnFn: deps.spawnFn }).run({
        companyId,
        executionRunId: er.id,
        testRunId: testRun!.id,
        cwd,
        asset: { scriptContent: inputs.asset.scriptContent ?? "", dataFiles: (inputs.asset.dataFiles ?? []).map((f) => ({ name: f.name, content: f.content })) },
        baseUrl: inputs.baseUrl,
        window: inputs.window,
      });

      // snapshot what actually executed
      await setResolvedExecution(pipelineRunId, buildResolvedExecution({
        loadProfile: (inputs.testPlan.loadProfile ?? null) as Record<string, unknown> | null,
        executionModel: inputs.testPlan.executionModel ?? null,
        asset: { id: inputs.asset.id, workflowName: "all", engine: "k6", version: inputs.asset.version, dataFiles: (inputs.asset.dataFiles ?? []).map((f) => ({ name: f.name, content: f.content })) },
        window: inputs.window,
      }));

      if (execResult.status === "failed") {
        await markStageFailed(pipelineRunId, "execute", `k6 exited ${execResult.exitCode}`);
        await setVerdict(pipelineRunId, "error"); await setCiSignal(pipelineRunId, "fail"); await markCompleted(pipelineRunId);
        return { verdict: "error", ciSignal: "fail" };
      }
      // persist the k6 HTML artifact (no-op if absent)
      await testRunArtifactsService(db).persistK6HtmlSummary(companyId, { pipelineRunId, executionRunId: er.id, testRunId: testRun!.id, cwd, testRunId2: testRun!.id });
      await markStageComplete(pipelineRunId, "execute", { executionRunIds: [er.id] });

      // ---- ANALYSIS (metrics already ingested by k6Executor) → SLA → gate ----
      await markStageRunning(pipelineRunId, "analysis");
      await slaVerdictEngine(db).evaluate({ companyId, pipelineRunId, executionRunId: er.id });
      const [rd] = await db.select().from(requirementsDocuments).where(eq(requirementsDocuments.id, requirementsDocumentId));
      const counts = await countRequiredVerdicts(db, companyId, { pipelineRunId, executionRunId: er.id, requirementsDocumentId });
      const gate = resolveGate({ testIntent: rd?.testIntent ?? "conformance", ...counts });
      await db.insert(gateResolutions).values({ companyId, pipelineRunId, testRunId: testRun!.id, outcome: gate.outcome, ciSignal: gate.ciSignal, resolvedBy: "auto", resolvedAt: new Date() });
      const verdict = verdictForOutcome(gate.outcome);
      await setVerdict(pipelineRunId, verdict);
      await setCiSignal(pipelineRunId, gate.ciSignal);
      await markStageComplete(pipelineRunId, "analysis");

      // ---- REPORT (thin: sentinel_summary artifact) ----
      await markStageRunning(pipelineRunId, "report");
      const summary = { pipelineRunId, verdict, ciSignal: gate.ciSignal, outcome: gate.outcome, requiredVerdicts: counts };
      const summaryPath = path.join(cwd, "sentinel-summary.json");
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      await testRunArtifactsService(db).create(companyId, { pipelineRunId, executionRunId: er.id, testRunId: testRun!.id, artifactType: "sentinel_summary", storageRef: summaryPath, contentType: "application/json", sizeBytes: Buffer.byteLength(JSON.stringify(summary)) });
      await markStageComplete(pipelineRunId, "report");

      await markCompleted(pipelineRunId);
      return { verdict, ciSignal: gate.ciSignal };
    } catch (err) {
      // any unexpected error → mark the running stage failed where possible, verdict error
      await setVerdict(pipelineRunId, "error");
      await setCiSignal(pipelineRunId, "fail");
      await markCompleted(pipelineRunId);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
```

Add `runExecutionTrigger` to the returned object.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-run-orchestrator.test.ts`
Expected: PASS (4 cases). Re-run Tasks 4-7 tests to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pipeline-run.ts server/src/__tests__/pipeline-run-orchestrator.test.ts
git commit -m "feat(server): runExecutionTrigger orchestrates validate→execute→analysis→report"
```

---

## Task 9: `POST /api/companies/:companyId/pipeline-runs` route

**Files:**
- Create: `server/src/routes/pipeline-runs.ts`
- Modify: `server/src/app.ts` (mount the route)
- Test: `server/src/__tests__/pipeline-runs-routes.test.ts`

Creates an execution-trigger run and runs it with the real `execFile` spawn. (Mirror the Supertest harness from `server/src/__tests__/metric-series-routes.test.ts` — mock the service so the route test is fast and k6-free.)

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/pipeline-runs-routes.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/index.js';

const create = vi.fn();
const runExecutionTrigger = vi.fn();
vi.mock('../services/pipeline-run.js', () => ({ pipelineRunService: () => ({ create, runExecutionTrigger }) }));
const { pipelineRunsRoutes } = await import('../routes/pipeline-runs.js');

function buildApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  const api = express.Router();
  api.use(pipelineRunsRoutes({} as never));
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
const board = (companyIds: string[]) => ({ type: 'board', userId: 'u1', companyIds, memberships: [] });

describe.sequential('POST /api/companies/:companyId/pipeline-runs', () => {
  afterEach(() => { create.mockReset(); runExecutionTrigger.mockReset(); });

  it('creates + runs an execution-trigger run and returns 201 with the verdict', async () => {
    create.mockResolvedValue({ id: 'pr-1' });
    runExecutionTrigger.mockResolvedValue({ verdict: 'pass', ciSignal: 'pass' });
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/pipeline-runs')
      .send({ testPlanId: '00000000-0000-0000-0000-000000000001', requirementsDocumentId: '00000000-0000-0000-0000-000000000002', trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pipelineRunId: 'pr-1', verdict: 'pass', ciSignal: 'pass' });
    expect(create).toHaveBeenCalledOnce();
    expect(runExecutionTrigger).toHaveBeenCalledWith('pr-1', expect.anything());
  });

  it('422 on invalid body', async () => {
    const res = await request(buildApp(board(['company-1']))).post('/api/companies/company-1/pipeline-runs').send({ trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(422);
  });

  it('403 when actor lacks company access', async () => {
    const res = await request(buildApp(board(['other']))).post('/api/companies/company-1/pipeline-runs').send({ testPlanId: '00000000-0000-0000-0000-000000000001', requirementsDocumentId: '00000000-0000-0000-0000-000000000002', trigger: { type: 'manual_rerun', source: 'api' } });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-runs-routes.test.ts`
Expected: FAIL — cannot import `pipelineRunsRoutes`.

- [ ] **Step 3: Write the route + mount it**

```typescript
// server/src/routes/pipeline-runs.ts
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@sentinel/db";
import { assertCompanyAccess } from "./authz.js";
import { pipelineRunService } from "../services/pipeline-run.js";
import { createExecFileSpawn } from "../services/test-adapters/spawn.js";

const triggerSchema = z.object({
  type: z.enum(["manual_intake", "jira", "ci", "scheduled", "manual_rerun"]),
  source: z.string().min(1),
  ref: z.string().nullish(),
});
const bodySchema = z.object({
  testPlanId: z.string().uuid(),
  requirementsDocumentId: z.string().uuid(),
  trigger: triggerSchema,
});

export function pipelineRunsRoutes(db: Db) {
  const router = Router();
  const svc = pipelineRunService(db);

  router.post("/companies/:companyId/pipeline-runs", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(422).json({ error: parsed.error.issues[0]?.message }); return; }

    const run = await svc.create(companyId, {
      path: "execution-trigger",
      trigger: parsed.data.trigger,
      testPlanId: parsed.data.testPlanId,
      requirementsDocumentId: parsed.data.requirementsDocumentId,
    });
    const result = await svc.runExecutionTrigger(run.id, { spawnFn: createExecFileSpawn() });
    res.status(201).json({ pipelineRunId: run.id, verdict: result.verdict, ciSignal: result.ciSignal });
  });

  return router;
}
```

In `server/src/app.ts`, import `pipelineRunsRoutes` alongside the other route imports and register it where the other `api.use(...)` lines are (mirror `metricSeriesRoutes`):

```typescript
import { pipelineRunsRoutes } from "./routes/pipeline-runs.js";
// ... near the other api.use(...) registrations:
api.use(pipelineRunsRoutes(db));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/pipeline-runs-routes.test.ts`
Expected: PASS. Confirm the app still boots: `pnpm -C server exec tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pipeline-runs.ts server/src/app.ts server/src/__tests__/pipeline-runs-routes.test.ts
git commit -m "feat(server): POST /api/companies/:companyId/pipeline-runs (create + run execution-trigger)"
```

---

## Final verification (after all tasks)

- [ ] **Full server suite:** `rtk proxy pnpm -C server exec vitest run` — all new suites green; no regression in Plan-1/2/3 suites (k6-generator, k6-executor, sla-verdict-engine, metric-series). (Pre-existing platform-test failures unrelated to this branch — `workspace-runtime`, `*-local-execute`, `ui-branding`, etc. — are environmental, not regressions.)
- [ ] **DB drift:** `rtk proxy pnpm -C packages/db run check:drift` — no drift (Plan 4 adds no migration).
- [ ] **Typecheck:** `rtk proxy pnpm -C server exec tsc --noEmit` — clean.

---

## Self-Review

**1. Spec coverage (back-half execution-trigger, per the chosen scope):**
- Execution-trigger stage init (front-half skipped, validate→report pending) — Task 4 ✅
- PipelineRun state machine (stage lifecycle + verdict/ciSignal/resolvedExecution setters) — Tasks 4-5 ✅
- Server-side mechanical execute (test_run + execution_run + k6Executor + HTML artifact) — Tasks 6, 8 ✅
- Analysis: slaVerdictEngine + required-scoped counts + gate matrix → gate_resolutions + verdict/ciSignal — Tasks 1, 7, 8 ✅
- `inconclusive` never false-green (→ ciSignal 'fail'); characterization for baseline/exploratory/no-required — Task 1 ✅
- resolvedExecution snapshot — Tasks 3, 8 ✅
- report: sentinel_summary artifact — Task 8 ✅
- Trigger route — Task 9 ✅
- **Deliberately deferred** (stated in Critical Context): front-half stages + assigneeAgentId deadlock + 5→8-stage pipeline-builder rewrite (Plan 5); spawn→runChildProcess + graceful abort + liveMetricFeed; full Stage-4 validation; ExecutionWorkspace provisioning (uses fs.mkdtemp); secrets-resolved auth; baseline/regression outcomes + blocked_on_human escalation; external artifact storage. **No migration.**

**2. Placeholder scan:** No TBD. Task 3 notes the explicit `'unknown'` executor cast (intentional v1 tolerance). The `validate` stage is intentionally thin (reachability probe injected; full env-validation deferred). No "implement later".

**3. Type consistency:** `StageName`/`StageRecord`/`StageRecordMap` from `@sentinel/db` are used consistently across the mutators (Task 5) and orchestrator (Task 8). `resolveGate`'s `GateInput` (Task 1) is fed by `countRequiredVerdicts`'s `RequiredVerdictCounts` (Task 7) — field names (`requiredTargetCount/requiredFailCount/requiredInconclusiveCount`) match exactly. `ExecuteInputs` (Task 6) feeds the orchestrator's `k6Executor.run` call with the Plan-3 input shape (`{companyId, executionRunId, testRunId, cwd, asset:{scriptContent,dataFiles}, baseUrl, window}`). `buildResolvedExecution` (Task 3) output matches `pipeline_runs.resolvedExecution`. `executionRunService.create/markRunning/complete` and `slaVerdictEngine.evaluate({companyId, pipelineRunId, executionRunId})` and `testRunArtifactsService.create/persistK6HtmlSummary` are called with their defined signatures. The route (Task 9) calls `pipelineRunService.create({path, trigger, testPlanId, requirementsDocumentId})` + `runExecutionTrigger(id, {spawnFn})` matching Tasks 4 + 8.
