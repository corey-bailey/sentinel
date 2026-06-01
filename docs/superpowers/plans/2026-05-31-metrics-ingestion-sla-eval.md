# Metrics Ingestion & SLA Evaluation Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make test results flow *back* into Sentinel and become verdicts — a metrics-ingestion endpoint that writes `metric_series`, and a windowed/success-filtered/sample-gated SLA evaluator that turns those rows into `sla_verdicts` (`pass | fail | inconclusive`).

**Architecture:** Services are factory functions `service(db)` querying Drizzle directly (no DAO layer). Two new services — `metricSeriesService` (ingest) and `slaVerdictEngine` (evaluate) — plus one Express route. The evaluator reads the **single source of truth** SLA targets live from `requirements_documents.slaTargets[]` (never copied), and for each target joins the **windowed, workflow-scoped, success-filtered** `metric_series` row (`phase='steady'`). This builds entirely on Plan 1's tables; it adds no migrations.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Express, Drizzle ORM, Zod validation, Vitest 3 + embedded-Postgres (DB/service tests) + Supertest (route tests).

**Depends on:** Plan 1 (the `metric_series` digest columns, `sla_verdicts`, `requirements_documents`, `pipeline_runs`, `execution_runs` tables — all committed on `sentinel/data-model-foundation`).

---

## Critical Context (read before any task)

**The ingestion contract is spec-correct, not the naive `SKILL.md` aggregate.** The spec (Stage 6) makes the `{workflow, phase}`-tagged **windowed sub-metric** the authoritative SLA number; the whole-run k6 aggregate is informational only. So:

- The executor (Plan 3) extracts, from k6's `handleSummary`, the **per-`{workflow, phase}` SLA-metric values** and POSTs them. Each posted series entry is **SLA-metric-keyed** — `metric` is the SLA key (`p95_ms | p99_ms | error_rate | tps | …`), `value` is that computed number — so the evaluator joins `slaTarget.metric === metric_series.metric` directly (no percentile re-derivation in Plan 2).
- One `metric_series` row **per** `(metric, workflowName, phase)`. Never flatten.
- `sampleCount` is load-bearing — it gates `minSampleCount`.

**The three verdict rules that are net-new (the heart of this plan):**
1. **Window/scope match.** For a target, the authoritative row is `WHERE executionRunId = X AND metric = target.metric AND source = target.source AND phase = 'steady' AND (workflowName = target.workflowScope OR (target.workflowScope IS NULL AND workflowName IS NULL))`.
2. **Inconclusive, never false-green** (decision #7 / spec Stage 6). A **required** target resolves to `inconclusive` (not `skipped`, not `fail`) when: the matching row is missing; OR `sampleCount < requirementsDocument.minSampleCount`; OR the run is unhealthy (`executionRun.status ∈ {aborted, failed}` or a non-zero `exitCode`) and the target is success-gated. `fail` is reserved for *measured + breached*. An *optional* target that can't be measured is recorded but does not force inconclusive.
3. **Success-filtered.** `sla_verdicts.evaluatedOnSuccessOnly` records that latency was cut over successful responses only; the executor posts the success-filtered sub-metric as the authoritative latency row (Plan 3), so Plan 2 trusts the posted value and records the flag.

**Codebase conventions (from recon):**
- Route file: `export function xRoutes(db: Db) { const router = Router(); const svc = xService(db); router.post('/companies/:companyId/…', async (req, res) => {…}); return router; }`. Register in `server/src/app.ts` (`api.use(xRoutes(db))`).
- Auth: `assertCompanyAccess(req, companyId)` from `server/src/routes/authz.ts` (throws if the actor lacks access). After fetching any resource, **double-check `resource.companyId === companyId`**.
- Validation: Zod `schema.safeParse(req.body)` → on failure `res.status(422).json({ error: parsed.error.issues[0]?.message }); return;`.
- Errors: `throw notFound('…')` / `badRequest('…')` from `server/src/errors.ts` (caught by `errorHandler` → `{ error, details? }`), or `res.status(code).json({ error })`. Success: `res.status(201).json(result)` (raw resource, **no `{data}` envelope**).
- Service factory: `export function xService(db: Db) { async function method() {…} return { method }; }` (no classes, no DAO).
- Drizzle: `import { and, eq, isNull, inArray } from 'drizzle-orm';` `await db.select().from(table).where(and(eq(...), ...))`. Tables/types from `@sentinel/db`.
- Tests: DB/service tests use `server/src/__tests__/helpers/pipeline-schema-fixture.ts` (`withPipelineSchema`, `embeddedPostgresSupport`) created in Plan 1. Route tests use Supertest with a mocked service (pattern: `server/src/__tests__/test-run-routes.test.ts`). Run one: `pnpm exec vitest run <file> -t '<name>'`.
- **Gotcha:** `server/tsconfig.json` excludes `src/__tests__`, so `tsc --noEmit` does NOT typecheck test files — type bugs there surface at vitest runtime only. Rely on vitest, not tsc, for test correctness.

---

## File Structure

**Create (services):**
- `server/src/services/metric-series.ts` — `metricSeriesService(db)`: `ingest(companyId, payload)` → writes `metric_series` rows
- `server/src/services/sla-verdict-engine.ts` — `slaVerdictEngine(db)`: `evaluate({ companyId, pipelineRunId, executionRunId })` → writes `sla_verdicts`, returns counts

**Create (route):**
- `server/src/routes/metric-series.ts` — `metricSeriesRoutes(db)`: `POST /companies/:companyId/metric-series`

**Modify:**
- `server/src/app.ts` — register `metricSeriesRoutes(db)`
- `server/src/services/sla-evaluator.ts` — extend with a pure `classifyVerdict(...)` helper returning `pass|fail|inconclusive` (keep the existing `evaluateSLATarget` untouched for back-compat; add the new helper)

**Create (test):**
- `server/src/__tests__/metric-series-service.test.ts` — ingestion DB test
- `server/src/__tests__/sla-verdict-engine.test.ts` — evaluation DB test (the three verdict rules)
- `server/src/__tests__/metric-series-routes.test.ts` — route (Supertest) test

---

## Task 1: `metricSeriesService.ingest`

**Files:**
- Create: `server/src/services/metric-series.ts`
- Test: `server/src/__tests__/metric-series-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/metric-series-service.test.ts
import { describe, expect, it } from 'vitest';
import { metricSeries, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { metricSeriesService } from '../services/metric-series.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('metricSeriesService.ingest', () => {
  const ctx = withPipelineSchema([metricSeries, testRuns, testPlans]);

  it('writes one row per series entry with tags, sampleCount, and normalized values', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();

    const svc = metricSeriesService(ctx.db);
    const created = await svc.ingest(ctx.companyId, {
      testRunId: run.id,
      source: 'k6',
      series: [
        { metric: 'p95_ms', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1200 },
        { metric: 'error_rate', workflowName: 'checkout', phase: 'steady', value: 0.004, sampleCount: 1200 },
      ],
    });

    expect(created).toHaveLength(2);
    const rows = await ctx.db.select().from(metricSeries).where(eq(metricSeries.testRunId, run.id));
    expect(rows).toHaveLength(2);
    const p95 = rows.find((r) => r.metric === 'p95_ms');
    expect(p95?.workflowName).toBe('checkout');
    expect(p95?.phase).toBe('steady');
    expect(p95?.value).toBe(180);
    expect(p95?.sampleCount).toBe(1200);
    expect(p95?.source).toBe('k6');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/metric-series-service.test.ts`
Expected: FAIL — cannot import `metricSeriesService`.

- [ ] **Step 3: Write the service**

```typescript
// server/src/services/metric-series.ts
import { metricSeries, type Db } from '@sentinel/db';

export type IngestSeriesEntry = {
  metric: string; // SLA-metric key: p95_ms | p99_ms | error_rate | tps | ...
  workflowName?: string | null;
  phase?: 'warmup' | 'ramp_up' | 'steady' | 'ramp_down' | null;
  value: number;
  sampleCount?: number | null;
  rawValues?: number[] | null;
  digest?: Record<string, unknown> | null;
};

export type IngestPayload = {
  testRunId: string;
  executionRunId?: string | null;
  source: string; // 'k6' | 'playwright' | 'apm:dynatrace' | ...
  series: IngestSeriesEntry[];
};

export function metricSeriesService(db: Db) {
  // Writes one metric_series row per series entry. Returns the inserted rows.
  async function ingest(companyId: string, payload: IngestPayload) {
    if (payload.series.length === 0) return [];
    const rows = payload.series.map((s) => ({
      companyId,
      testRunId: payload.testRunId,
      executionRunId: payload.executionRunId ?? null,
      metric: s.metric,
      source: payload.source,
      workflowName: s.workflowName ?? null,
      phase: s.phase ?? null,
      value: s.value,
      rawValues: s.rawValues ?? null,
      digest: s.digest ?? null,
      sampleCount: s.sampleCount ?? null,
    }));
    return db.insert(metricSeries).values(rows).returning();
  }

  return { ingest };
}
```

> NOTE: open `packages/db/src/schema/metric_series.ts` and confirm the column names match (`value`, `rawValues`, `digest`, `sampleCount`, `workflowName`, `phase`, `executionRunId`). If `metric_series` requires any column this insert omits (e.g. a `capturedAt` with no default), add it (`capturedAt: new Date()`).

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/metric-series-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/metric-series.ts server/src/__tests__/metric-series-service.test.ts
git commit -m "feat(server): metricSeriesService.ingest writes tagged metric_series rows"
```

---

## Task 2: SLA classification helper (`pass | fail | inconclusive`)

**Files:**
- Modify: `server/src/services/sla-evaluator.ts`
- Test: `server/src/__tests__/sla-verdict-engine.test.ts` (start the file with the pure-helper tests)

This is the pure decision function — no DB — so it's trivially testable and reused by the engine in Task 3.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/sla-verdict-engine.test.ts
import { describe, expect, it } from 'vitest';
import { classifyVerdict } from '../services/sla-evaluator.js';

describe('classifyVerdict (pure)', () => {
  const target = { id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt' as const, threshold: 200, required: true };

  it('pass when measured and within threshold', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('pass');
  });
  it('fail when measured and breaches threshold', () => {
    expect(classifyVerdict(target, { value: 250, sampleCount: 1000, minSampleCount: 200, runHealthy: true }).status).toBe('fail');
  });
  it('inconclusive when the required metric is missing', () => {
    expect(classifyVerdict(target, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when sampleCount below the floor', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 50, minSampleCount: 200, runHealthy: true }).status).toBe('inconclusive');
  });
  it('inconclusive when the run is unhealthy', () => {
    expect(classifyVerdict(target, { value: 180, sampleCount: 1000, minSampleCount: 200, runHealthy: false }).status).toBe('inconclusive');
  });
  it('optional missing metric does NOT force inconclusive (records skipped)', () => {
    const opt = { ...target, required: false };
    expect(classifyVerdict(opt, { value: null, sampleCount: null, minSampleCount: 200, runHealthy: true }).status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `pnpm exec vitest run server/src/__tests__/sla-verdict-engine.test.ts -t 'classifyVerdict'` → FAIL (no `classifyVerdict`).

- [ ] **Step 3: Add the helper** to `server/src/services/sla-evaluator.ts` (append; leave existing exports untouched):

```typescript
// append to server/src/services/sla-evaluator.ts
export type ClassifyTarget = {
  id: string; source: string; metric: string;
  operator: 'lt' | 'lte' | 'gt' | 'gte'; threshold: number; required: boolean;
  workflowScope?: string;
};
export type ClassifyInput = {
  value: number | null | undefined;
  sampleCount: number | null | undefined;
  minSampleCount: number;
  runHealthy: boolean; // false if executionRun aborted/failed/exitCode!=0
};
export type Verdict = { status: 'pass' | 'fail' | 'inconclusive' | 'skipped'; actualValue?: number };

function breaches(op: ClassifyTarget['operator'], value: number, threshold: number): boolean {
  switch (op) {
    case 'lt': return !(value < threshold);
    case 'lte': return !(value <= threshold);
    case 'gt': return !(value > threshold);
    case 'gte': return !(value >= threshold);
  }
}

// Decision #7 / Stage 6: a REQUIRED target never false-greens — missing/under-sampled/unhealthy => inconclusive.
// fail is reserved for measured + breached. An OPTIONAL unmeasured target is 'skipped' (recorded, non-blocking).
export function classifyVerdict(t: ClassifyTarget, input: ClassifyInput): Verdict {
  const measured = input.value !== null && input.value !== undefined && !Number.isNaN(input.value);
  if (!measured) return { status: t.required ? 'inconclusive' : 'skipped' };
  if (!input.runHealthy) return { status: t.required ? 'inconclusive' : 'skipped', actualValue: input.value! };
  const n = input.sampleCount ?? 0;
  if (n < input.minSampleCount) return { status: t.required ? 'inconclusive' : 'skipped', actualValue: input.value! };
  return { status: breaches(t.operator, input.value!, t.threshold) ? 'fail' : 'pass', actualValue: input.value! };
}
```

- [ ] **Step 4: Run, verify it passes** — `pnpm exec vitest run server/src/__tests__/sla-verdict-engine.test.ts -t 'classifyVerdict'` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): classifyVerdict — required-target inconclusive rules (decision #7)"`

---

## Task 3: `slaVerdictEngine.evaluate` (windowed join + persist)

**Files:**
- Create: `server/src/services/sla-verdict-engine.ts`
- Test: `server/src/__tests__/sla-verdict-engine.test.ts` (append the DB tests)

- [ ] **Step 1: Write the failing test**

```typescript
// append to server/src/__tests__/sla-verdict-engine.test.ts
import { metricSeries, slaVerdicts, requirementsDocuments, pipelineRuns, executionRuns, testPlans, testRuns } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { slaVerdictEngine } from '../services/sla-verdict-engine.js';
import type { SlaTarget } from '@sentinel/db';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('slaVerdictEngine.evaluate', () => {
  const ctx = withPipelineSchema([slaVerdicts, metricSeries, executionRuns, pipelineRuns, testRuns, requirementsDocuments, testPlans]);

  async function seed(targets: SlaTarget[], minSampleCount = 200) {
    // metric_series.testRunId is NOT NULL (pre-existing CASCADE column) → seed a real test run.
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan.id }).returning();
    const [rd] = await ctx.db.insert(requirementsDocuments)
      .values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, requirementsDocumentId: rd.id, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [er] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: pr.id, testRunId: run.id, engine: 'k6', status: 'completed', exitCode: 0 }).returning();
    return { rd, pr, er, run };
  }

  it('passes a target whose windowed steady metric is within threshold', async () => {
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true, workflowScope: 'checkout' }]);
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1000 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res).toMatchObject({ passCount: 1, failCount: 0, inconclusiveCount: 0 });
    const [v] = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.pipelineRunId, pr.id));
    expect(v.status).toBe('pass');
    expect(v.slaTargetId).toBe('t1');
    expect(v.workflowName).toBe('checkout');
  });

  it('inconclusive when sampleCount below minSampleCount (never false-green)', async () => {
    const { pr, er, run } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }], 200);
    await ctx.db.insert(metricSeries).values({ companyId: ctx.companyId, testRunId: run.id, executionRunId: er.id, metric: 'p95_ms', source: 'k6', workflowName: null, phase: 'steady', value: 180, sampleCount: 50 });
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.inconclusiveCount).toBe(1);
  });

  it('inconclusive when the required metric row is missing', async () => {
    const { pr, er } = await seed([{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true }]);
    const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
    expect(res.inconclusiveCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `... -t 'slaVerdictEngine'` → FAIL (no module).

- [ ] **Step 3: Write the engine**

```typescript
// server/src/services/sla-verdict-engine.ts
import {
  requirementsDocuments, pipelineRuns, executionRuns, metricSeries, slaVerdicts,
  type Db, type SlaTarget,
} from '@sentinel/db';
import { and, eq, isNull } from 'drizzle-orm';
import { classifyVerdict } from './sla-evaluator.js';

export type EvaluateInput = { companyId: string; pipelineRunId: string; executionRunId: string };
export type EvaluateResult = { verdictCount: number; passCount: number; failCount: number; inconclusiveCount: number; optionalSkippedCount: number };

export function slaVerdictEngine(db: Db) {
  async function evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, input.pipelineRunId));
    if (!run || run.companyId !== input.companyId) throw new Error('pipeline_run not found for company');
    if (!run.requirementsDocumentId) return { verdictCount: 0, passCount: 0, failCount: 0, inconclusiveCount: 0 };

    const [rd] = await db.select().from(requirementsDocuments).where(eq(requirementsDocuments.id, run.requirementsDocumentId));
    const [er] = await db.select().from(executionRuns).where(eq(executionRuns.id, input.executionRunId));
    const targets = (rd?.slaTargets ?? []) as SlaTarget[];
    const minSampleCount = rd?.minSampleCount ?? 200;
    const runHealthy = !!er && er.status === 'completed' && (er.exitCode === 0 || er.exitCode === null);

    const verdictRows = [];
    let optionalSkippedCount = 0;
    for (const t of targets) {
      // windowed, workflow-scoped, source-matched, steady-phase row
      const scope = t.workflowScope
        ? eq(metricSeries.workflowName, t.workflowScope)
        : isNull(metricSeries.workflowName);
      const matches = await db.select().from(metricSeries).where(and(
        eq(metricSeries.executionRunId, input.executionRunId),
        eq(metricSeries.metric, t.metric),
        eq(metricSeries.source, t.source),
        eq(metricSeries.phase, 'steady'),
        scope,
      ));
      const row = matches[0];
      const v = classifyVerdict(t, {
        value: row?.value ?? null,
        sampleCount: row?.sampleCount ?? null,
        minSampleCount,
        runHealthy,
      });
      // OPTIONAL unmeasured ('skipped') is NON-blocking (spec Stage 6): record the count, persist NO
      // verdict row. Only REQUIRED targets (and any measured pass/fail) produce a persisted verdict,
      // so inconclusiveCount is the BLOCKING (required-inconclusive) count the gate reads.
      if (v.status === 'skipped') { optionalSkippedCount++; continue; }
      verdictRows.push({
        companyId: input.companyId,
        pipelineRunId: input.pipelineRunId,
        executionRunId: input.executionRunId,
        slaTargetId: t.id,
        workflowName: t.workflowScope ?? null,
        phase: 'steady',
        metric: t.metric,
        operator: t.operator,
        threshold: t.threshold,
        actualValue: v.actualValue ?? null,
        evaluationWindow: null, // populated from resolvedExecution.resolvedSteadyWindow in Plan 4 wiring
        source: t.source,
        status: v.status, // 'pass' | 'fail' | 'inconclusive'
        evaluatedOnSuccessOnly: true,
      });
    }
    if (verdictRows.length) await db.insert(slaVerdicts).values(verdictRows);

    const passCount = verdictRows.filter((r) => r.status === 'pass').length;
    const failCount = verdictRows.filter((r) => r.status === 'fail').length;
    const inconclusiveCount = verdictRows.filter((r) => r.status === 'inconclusive').length;
    return { verdictCount: verdictRows.length, passCount, failCount, inconclusiveCount, optionalSkippedCount };
  }
  return { evaluate };
}
```

> NOTE: confirm `slaVerdicts` column names against `packages/db/src/schema/sla_verdicts.ts` (esp. `evaluationWindow` is nullable jsonb). The `evaluationWindow` is left null in Plan 2 and populated from `pipeline_runs.resolvedExecution.resolvedSteadyWindow` when the analysis stage wires this in Plan 4 — note this is a deliberate Plan-2 boundary, not an omission.

- [ ] **Step 4: Run, verify the three tests pass** — `pnpm exec vitest run server/src/__tests__/sla-verdict-engine.test.ts` → PASS (classifyVerdict + the 3 DB cases).

- [ ] **Step 5: Commit** — `git commit -m "feat(server): slaVerdictEngine — windowed, scoped, sample-gated verdicts → sla_verdicts"`

---

## Task 4: `POST /api/companies/:companyId/metric-series` route

**Files:**
- Create: `server/src/routes/metric-series.ts`
- Test: `server/src/__tests__/metric-series-routes.test.ts`

- [ ] **Step 1: Write the failing test** (Supertest, mocked service — copy the structure of `server/src/__tests__/test-run-routes.test.ts` for the app + mock-actor harness)

```typescript
// server/src/__tests__/metric-series-routes.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/error-handler.js';

const ingest = vi.fn();
vi.mock('../services/metric-series.js', () => ({ metricSeriesService: () => ({ ingest }) }));
// import the route AFTER vi.mock so it binds to the mocked service (vi.mock is hoisted)
const { metricSeriesRoutes } = await import('../routes/metric-series.js');

// Build the app inline, mirroring server/src/__tests__/test-run-routes.test.ts's createApp():
// mock actor middleware → mount route under /api → errorHandler last (so thrown forbidden() ⇒ 403).
// IMPORTANT: copy the EXACT actor shape that test-run-routes.test.ts uses (the field assertCompanyAccess
// reads for a 'board' actor — companyIds/allowedCompanies). Adjust if the real harness differs.
function buildApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  const api = express.Router();
  api.use(metricSeriesRoutes({} as never)); // db unused — service is mocked
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
const board = (companyIds: string[]) => ({ type: 'board', userId: 'u1', companyIds, memberships: [] });

describe.sequential('POST /api/companies/:companyId/metric-series', () => {
  afterEach(() => ingest.mockReset());

  it('returns 201 and the created rows', async () => {
    ingest.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/metric-series')
      .send({ testRunId: '00000000-0000-0000-0000-000000000001', source: 'k6', series: [{ metric: 'p95_ms', phase: 'steady', value: 180, sampleCount: 1000 }] });
    expect(res.status).toBe(201);
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('returns 422 on an invalid body (missing series)', async () => {
    const res = await request(buildApp(board(['company-1'])))
      .post('/api/companies/company-1/metric-series')
      .send({ testRunId: '00000000-0000-0000-0000-000000000001', source: 'k6' });
    expect(res.status).toBe(422);
  });

  it('returns 403 when the actor lacks company access', async () => {
    const res = await request(buildApp(board(['other'])))
      .post('/api/companies/company-1/metric-series')
      .send({ testRunId: '00000000-0000-0000-0000-000000000001', source: 'k6', series: [{ metric: 'p95_ms', phase: 'steady', value: 1, sampleCount: 1 }] });
    expect(res.status).toBe(403);
  });
});
```

> NOTE: open `server/src/__tests__/test-run-routes.test.ts` FIRST and copy its `createApp()` actor shape + `errorHandler` import path **exactly** into `buildApp` above — the 403 case depends on `assertCompanyAccess` reading the right actor field for a `board` actor (recon: it checks the board's allowed-company list). Do NOT create a shared `build-test-app.ts` helper (that's a cross-cutting refactor out of Plan 2's scope); inline it here as shown.

- [ ] **Step 2: Run, verify it fails** — FAIL (no route module / helper).

- [ ] **Step 3: Write the route + validation**

```typescript
// server/src/routes/metric-series.ts
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '@sentinel/db';
import { assertCompanyAccess } from './authz.js';
import { metricSeriesService } from '../services/metric-series.js';

const seriesEntry = z.object({
  metric: z.string().min(1),
  workflowName: z.string().nullish(),
  phase: z.enum(['warmup', 'ramp_up', 'steady', 'ramp_down']).nullish(),
  value: z.number(),
  sampleCount: z.number().int().nonnegative().nullish(),
  rawValues: z.array(z.number()).nullish(),
  digest: z.record(z.unknown()).nullish(),
});
const ingestSchema = z.object({
  testRunId: z.string().uuid(),
  executionRunId: z.string().uuid().nullish(),
  source: z.string().min(1),
  series: z.array(seriesEntry).min(1),
});

export function metricSeriesRoutes(db: Db) {
  const router = Router();
  const svc = metricSeriesService(db);

  router.post('/companies/:companyId/metric-series', async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? 'invalid body' });
      return;
    }
    const created = await svc.ingest(companyId, parsed.data);
    res.status(201).json(created);
  });

  return router;
}
```

- [ ] **Step 4: Run, verify it passes** — `pnpm exec vitest run server/src/__tests__/metric-series-routes.test.ts` → PASS (201, 422, 403).

- [ ] **Step 5: Commit** — `git commit -m "feat(server): POST /metric-series ingestion route (zod + company-scoped)"`

---

## Task 5: Register the route in `app.ts`

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Add the import + mount.** In `server/src/app.ts`, add near the other route imports: `import { metricSeriesRoutes } from './routes/metric-series.js';` and, where the `/api` router is assembled (the `api.use(...)` block ~line 214), add: `api.use(metricSeriesRoutes(db));`

- [ ] **Step 2: Verify it builds + the route is reachable** — `pnpm -C server exec tsc --noEmit` (server source typechecks; PASS), then re-run the route test (already green) to confirm no regression: `pnpm exec vitest run server/src/__tests__/metric-series-routes.test.ts`.

- [ ] **Step 3: Commit** — `git commit -m "feat(server): mount metric-series route under /api"`

---

## Task 6: Integration — ingest → evaluate → verdicts, and full verify

**Files:**
- Test: `server/src/__tests__/sla-verdict-engine.test.ts` (append one end-to-end case)

- [ ] **Step 1: Write the end-to-end test** — seed a requirementsDocument + pipelineRun + executionRun, `metricSeriesService.ingest(...)` two tagged steady rows (one passing latency, one passing error_rate), then `slaVerdictEngine.evaluate(...)`, and assert `passCount === 2`, `failCount === 0`, and that two `sla_verdicts` rows exist with `status='pass'`. (Compose the helpers already imported in this file.)

```typescript
it('end-to-end: ingest tagged steady rows then evaluate to passing verdicts', async () => {
  const targets = [
    { id: 'lat', source: 'k6', metric: 'p95_ms', operator: 'lt' as const, threshold: 200, required: true, workflowScope: 'checkout' },
    { id: 'err', source: 'k6', metric: 'error_rate', operator: 'lt' as const, threshold: 0.01, required: true, workflowScope: 'checkout' },
  ];
  const { pr, er, run } = await seed(targets);
  await metricSeriesService(ctx.db).ingest(ctx.companyId, {
    testRunId: run.id, executionRunId: er.id, source: 'k6',
    series: [
      { metric: 'p95_ms', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1000 },
      { metric: 'error_rate', workflowName: 'checkout', phase: 'steady', value: 0.004, sampleCount: 1000 },
    ],
  });
  const res = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId: pr.id, executionRunId: er.id });
  expect(res).toMatchObject({ passCount: 2, failCount: 0, inconclusiveCount: 0 });
});
```

> NOTE: import `metricSeriesService` at the top of this test file alongside `slaVerdictEngine`. `metric_series.testRunId` is **NOT NULL** (pre-existing CASCADE column), so the `seed()` helper creates `testPlans`+`testRuns` and every `metric_series` insert / `ingest` passes `run.id`.

- [ ] **Step 2: Run the full Plan-2 test suite, verify green**

Run: `pnpm exec vitest run server/src/__tests__/metric-series-service.test.ts server/src/__tests__/sla-verdict-engine.test.ts server/src/__tests__/metric-series-routes.test.ts`
Expected: all PASS.

- [ ] **Step 3: Workspace typecheck + no regressions**

Run: `pnpm -C server exec tsc --noEmit` (PASS), then the Plan-1 schema suite to confirm nothing regressed: `pnpm exec vitest run server/src/__tests__/schema/` (12/12 PASS).

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/sla-verdict-engine.test.ts
git commit -m "test(server): end-to-end ingest→evaluate→sla_verdicts integration"
```

---

## Self-Review

**1. Spec coverage (Stage 6):** windowed authoritative sub-metric (engine joins `phase='steady'` + `workflowScope` + `source`) ✅; success-filtered flag recorded (`evaluatedOnSuccessOnly`) ✅; `minSampleCount` guard → inconclusive ✅; missing-required → inconclusive, never false-green ✅; `pass|fail|inconclusive` (no `skipped` persisted for required) ✅; one `metric_series` row per `(metric, workflow, phase)` ✅; SLA targets read live from `requirements_documents.slaTargets[]`, never copied ✅. The DT/async source-of-record path and the `evaluationWindow` population from `resolvedSteadyWindow` are deliberately deferred to Plan 4 wiring (noted in Task 3) — Plan 2 evaluates the posted value and leaves `evaluationWindow` null. The gate's final `ciSignal` is Plan 6.

**2. Placeholder scan:** The `_required` field carried then stripped in Task 3 is intentional (local rollup signal, never a column). The `buildTestApp` helper / inline-app note in Task 4 is a concrete instruction to match the existing route-test harness (read `test-run-routes.test.ts`), not a TODO. No `TBD`.

**3. Type consistency:** `IngestPayload`/`IngestSeriesEntry` (Task 1) are consumed by the route's Zod schema (Task 4) and the engine's ingest in Task 6. `ClassifyTarget`/`Verdict` (Task 2) are consumed by `slaVerdictEngine` (Task 3). `SlaTarget` is imported from `@sentinel/db` (Plan 1's `requirements_documents.ts`) and its shape (`id, source, metric, operator, threshold, required, workflowScope?`) matches both the classifier and the engine join. `evaluate(...)` returns the same `EvaluateResult` shape asserted in every engine test.
