# Data Model Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema foundation for the performance-test pipeline — the six net-new tables, the additive column changes to six existing tables, their domain types, and migrations `0091–0094` — all additively, with embedded-Postgres tests proving every table's columns, defaults, FKs, and cascade behavior.

**Architecture:** Sentinel domain types live as Drizzle schemas in `@sentinel/db` (`packages/db/src/schema/<table>.ts`), re-exported through the barrel `schema/index.ts`. There is **no repository/DAO layer** — services query Drizzle directly — so this plan adds *only* tables, types, and migrations. Migrations are **drizzle-kit-generated** (never hand-written) and gated by `.next-scope.txt` + three guard scripts. Everything here is **purely additive** (decision #4): `pipeline_runs` is a new parent table; `test_runs` is untouched except a new nullable FK; the `metric_series` `ON DELETE CASCADE` is left as-is. The only constraint-tightening change (`test_assets` NOT NULL/UNIQUE, `regressions` enum) is deferred to migration `0095` behind a backfill and is **out of this plan's scope** (documented in Task 15).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (`drizzle-orm/pg-core`), drizzle-kit (migration generation), PostgreSQL, Vitest 3 with `embedded-postgres`, pnpm workspaces.

---

## Critical Context: The Migration Workflow (read before any task)

Migrations in this repo are **generated from the schema `.ts` files**, never hand-edited. Each migration that touches a table requires declaring scope first. The exact loop, run from `packages/db/`:

1. **Declare scope** — create `packages/db/src/migrations/.next-scope.txt`, one table name per line, including **every table the migration touches *and* every FK reference target** (the guard rejects undeclared FK targets, e.g. `companies` when a new table references it). `#` lines are comments.
2. **Edit schema** — add/modify the `.ts` file(s) in `packages/db/src/schema/` and the barrel export in `schema/index.ts`.
3. **Generate** — `pnpm -C packages/db run generate`. This runs `check:migrations` → `tsc` (compiles `src/schema/*.ts` → `dist/schema/*.js`, which drizzle reads) → `drizzle-kit generate` (writes the next-numbered `NNNN_slug.sql` to `src/migrations/`) → `check-migration-scope.ts` (validates touched tables against `.next-scope.txt`, then deletes it on success).
4. **Review** the generated `packages/db/src/migrations/NNNN_*.sql` — confirm it is the additive DDL you intended (no unexpected `DROP`, no `NOT NULL` on a populated table).
5. **Drift check** — `pnpm -C packages/db run check:drift` re-runs generate and confirms it produces **no** new migration (schema matches migrations).
6. **Apply** — `pnpm -C packages/db run migrate` applies pending migrations.

**Gotchas (from recon):**
- Drizzle reads `dist/schema/*.js`, so `tsc` must run before generate — `pnpm generate` does this for you; don't call `drizzle-kit generate` directly.
- DB column names are `snake_case` (`pipeline_run_id`); TS property names are `camelCase` (`pipelineRunId`).
- `timestamp(...)` MUST include `{ withTimezone: true }`.
- `jsonb(...)` MUST specify `.$type<T>()` for type safety.
- Text-enum columns use `text(...)` (no DB constraint) — the app validates allowed values; never use pg `enum()`.
- Primary keys are `uuid('id').primaryKey().defaultRandom()`; FK columns never get a default.
- `onDelete: 'set null'` only works on a **nullable** column.

**Migration numbering note:** Spec §5 says `0089–0093`, but its grounding note assumed HEAD at `0088`; the repo on disk is actually at `0090_smart_peter_quill.sql`. This plan uses **`0091–0094` (+ deferred `0095`)** — the **same ordering and additive intent as spec §5, integers shifted forward by 2**. Do NOT "correct" these to the spec's numbers — that collides with existing migrations.

**Pattern to copy:** `packages/db/src/schema/test_runs.ts` (uuid PK, FK with references, jsonb columns, text status, timezone timestamps, exports).

---

## File Structure

**Create (schema):**
- `packages/db/src/schema/pipeline_requests.ts` — Stage-0 intake artifact
- `packages/db/src/schema/requirements_documents.ts` — Stage-1 signed-off requirements (single source of truth for SLA targets)
- `packages/db/src/schema/pipeline_runs.ts` — the pipeline state-machine parent
- `packages/db/src/schema/execution_runs.ts` — per-harness-invocation record
- `packages/db/src/schema/sla_verdicts.ts` — per-target verdict
- `packages/db/src/schema/gate_resolutions.ts` — Stage-8 gate outcome → CI signal
- `packages/db/src/schema/test_run_artifacts.ts` — stored artifacts (k6 HTML, summary, logs)

**Modify (schema):**
- `packages/db/src/schema/index.ts` — barrel exports for all new tables/types
- `packages/db/src/schema/test_runs.ts` — `+ pipelineRunId`
- `packages/db/src/schema/metric_series.ts` — `+ executionRunId, workflowName, phase, digest, sampleCount`
- `packages/db/src/schema/test_assets.ts` — `+ protocol, dataFiles, setupScript, teardownScript, generatedFrom, sourceRef` (+ widen `assetType` values — text, no DDL constraint)
- `packages/db/src/schema/test_plans.ts` — `+ requirementsDocumentId, executionModel`; widen `LoadProfile` type (jsonb — type-only)
- `packages/db/src/schema/baselines.ts` — `+ baselineSetId`
- `packages/db/src/schema/regressions.ts` — `+ pipelineRunId, direction`

**Create (test):**
- `server/src/__tests__/helpers/pipeline-schema-fixture.ts` — shared embedded-Postgres + seed-company helper
- `server/src/__tests__/schema/pipeline-tables.test.ts` — new-table tests
- `server/src/__tests__/schema/altered-tables.test.ts` — additive-alter tests

**Migrations (generated, do not hand-write):** `0091`, `0092`, `0093`, `0094` under `packages/db/src/migrations/`.

---

## Task 0: Shared test fixture

**Files:**
- Create: `server/src/__tests__/helpers/pipeline-schema-fixture.ts`

This DRYs the embedded-Postgres boilerplate and the `companies` seed (every new table has a `companyId NOT NULL` FK).

- [ ] **Step 1: Write the fixture helper**

```typescript
// server/src/__tests__/helpers/pipeline-schema-fixture.ts
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from '@sentinel/db';
import { companies } from '@sentinel/db';

export type Db = ReturnType<typeof createDb>;

export interface SchemaTestContext {
  get db(): Db;
  get companyId(): string;
}

/**
 * Spins up an isolated embedded Postgres (migrations auto-applied), seeds one
 * company per test, and cleans the named tables after each test. Returns a
 * context whose getters are valid inside `it()` blocks. Caller passes the list
 * of tables to truncate after each test, child-before-parent (FK order).
 */
export function withPipelineSchema(
  cleanupTables: { delete: unknown }[],
): SchemaTestContext {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase('sentinel-schema-');
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeAll(async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: 'Test Co', status: 'active' })
      .returning();
    companyId = company.id;
  });

  afterEach(async () => {
    for (const table of cleanupTables) {
      // @ts-expect-error drizzle delete typing across heterogeneous tables
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  return {
    get db() {
      return db;
    },
    get companyId() {
      return companyId;
    },
  };
}

export const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm -C server exec tsc --noEmit`
Expected: PASS (no errors referencing the new helper). If `companies` insert shape differs, open `packages/db/src/schema/companies.ts` and match its required columns.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/helpers/pipeline-schema-fixture.ts
git commit -m "test: add shared embedded-postgres pipeline schema fixture"
```

---

## Migration 0091 — leaf tables (`pipeline_requests`, `requirements_documents`)

These reference only `companies` (and `requirements_documents` references `pipeline_requests`). Nothing existing references them yet → zero inbound risk.

### Task 1: `pipeline_requests` table

**Files:**
- Create: `packages/db/src/schema/pipeline_requests.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/migrations/.next-scope.txt` (create)
- Test: `server/src/__tests__/schema/pipeline-tables.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/schema/pipeline-tables.test.ts
import { describe, expect, it } from 'vitest';
import { pipelineRequests } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from '../helpers/pipeline-schema-fixture.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('pipeline_requests', () => {
  const ctx = withPipelineSchema([pipelineRequests]);

  it('inserts with defaults and round-trips jsonb', async () => {
    const [row] = await ctx.db
      .insert(pipelineRequests)
      .values({
        companyId: ctx.companyId,
        source: 'manual_intake',
        ownerUserId: 'user-1',
        artifacts: { openApiSpec: { paths: {} } },
        extractedContext: { appName: 'payments' },
      })
      .returning();

    expect(row.id).toBeTruthy();
    expect(row.status).toBe('pending_confirmation'); // default
    expect(row.source).toBe('manual_intake');
    expect(row.artifacts).toEqual({ openApiSpec: { paths: {} } });
    expect(row.extractedContext).toEqual({ appName: 'payments' });
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'pipeline_requests'`
Expected: FAIL — `pipelineRequests` is not exported from `@sentinel/db`.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/pipeline_requests.ts
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';

export type PipelineRequestArtifacts = {
  openApiSpec?: Record<string, unknown>;
  postmanCollection?: Record<string, unknown>;
  functionalTests?: { repo: string; path: string };
  existingTestPlanId?: string;
  attachments?: { name: string; content: string; mimeType: string }[];
};

export type PipelineRequestExtractedContext = {
  candidateSlaTargets?: string[];
  protocolHints?: string[];
  appName?: string;
  systemOwner?: string;
};

// Stage 0 intake artifact. source uses the SAME intake tokens as
// pipeline_runs.trigger.type intake-origin set: { manual_intake, jira }.
export const pipelineRequests = pgTable('pipeline_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // 'manual_intake' | 'jira'
  rawDescription: text('raw_description'),
  jiraIssueKey: text('jira_issue_key'),
  jiraIssueUrl: text('jira_issue_url'),
  artifacts: jsonb('artifacts').$type<PipelineRequestArtifacts>().default({}),
  extractedContext: jsonb('extracted_context').$type<PipelineRequestExtractedContext>().default({}),
  requestedBy: text('requested_by'),
  ownerUserId: text('owner_user_id').notNull(),
  status: text('status').notNull().default('pending_confirmation'), // pending_confirmation | confirmed | rejected
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add the barrel export**

In `packages/db/src/schema/index.ts`, add (matching the existing export style):

```typescript
export {
  pipelineRequests,
  type PipelineRequestArtifacts,
  type PipelineRequestExtractedContext,
} from './pipeline_requests.js';
```

- [ ] **Step 5: Declare migration scope**

Create `packages/db/src/migrations/.next-scope.txt`:

```
# 0091: leaf intake + requirements tables
companies
pipeline_requests
requirements_documents
```

(We declare both new tables and the FK target `companies` now; Task 2 adds the second table before we generate, so a single migration `0091` covers both.)

- [ ] **Step 6: Do NOT generate yet** — proceed to Task 2 so both tables land in one migration. (If you generated now, you'd consume `0091` for one table; we want both leaf tables together.)

---

### Task 2: `requirements_documents` table + generate `0091`

**Files:**
- Create: `packages/db/src/schema/requirements_documents.ts`
- Modify: `packages/db/src/schema/index.ts`
- Test: `server/src/__tests__/schema/pipeline-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/schema/pipeline-tables.test.ts`:

```typescript
import { requirementsDocuments } from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';

d('requirements_documents', () => {
  const ctx = withPipelineSchema([requirementsDocuments]);

  it('defaults minSampleCount=200 and testIntent=conformance, stores sla targets', async () => {
    const targets: SlaTarget[] = [
      { id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 200, required: true },
    ];
    const [row] = await ctx.db
      .insert(requirementsDocuments)
      .values({
        companyId: ctx.companyId,
        appName: 'payments',
        ownerUserId: 'user-1',
        protocol: ['http'],
        syncModel: 'sync',
        slaTargets: targets,
      })
      .returning();

    expect(row.minSampleCount).toBe(200); // p95 floor default
    expect(row.testIntent).toBe('conformance'); // default
    expect(row.status).toBe('in_progress'); // default
    expect(row.slaTargets).toEqual(targets);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'requirements_documents'`
Expected: FAIL — `requirementsDocuments` / `SlaTarget` not exported.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/requirements_documents.ts
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { pipelineRequests } from './pipeline_requests.js';

// Canonical SLA element — the SINGLE source of truth (decision #8). `id` is the
// stable id that test_plans and sla_verdicts reference; never copied downstream.
export type SlaTarget = {
  id: string;
  source: string; // 'k6' | 'playwright' | 'apm:dynatrace' | ...
  metric: string; // 'p95_ms' | 'p99_ms' | 'error_rate' | 'tps' | ...
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  threshold: number;
  required: boolean;
  workflowScope?: string; // a workflowName for a per-workflow SLA (drives Stage-2 per-scenario)
  approvedByUserId?: string;
};

export type LoadModel = {
  peakConcurrentUsers?: number;
  peakTps?: number;
  peakMps?: number;
  loadProfile?: { targetUnit?: 'vus' | 'rate'; stages?: { duration: string; target: number }[] };
  trafficMix?: { workflow: string; percentage: number; description?: string }[];
};

export const requirementsDocuments = pgTable('requirements_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  pipelineRequestId: uuid('pipeline_request_id').references(() => pipelineRequests.id, { onDelete: 'set null' }),
  appName: text('app_name'),
  appDescription: text('app_description'),
  ownerUserId: text('owner_user_id'),
  protocol: jsonb('protocol').$type<string | string[]>(),
  syncModel: text('sync_model'), // sync | async | hybrid
  asyncDetails: jsonb('async_details').$type<{ measurementPoint?: string; sagaDescription?: string }>(),
  slaTargets: jsonb('sla_targets').$type<SlaTarget[]>().notNull().default([]),
  loadModel: jsonb('load_model').$type<LoadModel>(),
  authentication: jsonb('authentication').$type<Record<string, unknown>>(),
  testData: jsonb('test_data').$type<Record<string, unknown>>(),
  existingArtifacts: jsonb('existing_artifacts').$type<Record<string, unknown>>(),
  targetEnvironment: jsonb('target_environment').$type<Record<string, unknown>>(),
  dynatrace: jsonb('dynatrace').$type<Record<string, unknown>>(),
  minSampleCount: integer('min_sample_count').notNull().default(200), // p95 floor; percentile-aware
  testIntent: text('test_intent').notNull().default('conformance'), // conformance | baseline | exploratory
  status: text('status').notNull().default('in_progress'), // in_progress | complete | approved
  approvedByUserId: text('approved_by_user_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add the barrel export**

In `packages/db/src/schema/index.ts`:

```typescript
export {
  requirementsDocuments,
  type SlaTarget,
  type LoadModel,
} from './requirements_documents.js';
```

- [ ] **Step 5: Generate migration `0091`**

Run: `pnpm -C packages/db run generate`
Expected: creates `packages/db/src/migrations/0091_<slug>.sql` with two `CREATE TABLE` statements; `check-migration-scope.ts` passes and deletes `.next-scope.txt`. If it fails listing an undeclared table, add that table to `.next-scope.txt` and re-run.

- [ ] **Step 6: Review the generated SQL**

Run: `cat packages/db/src/migrations/0091_*.sql`
Expected: `CREATE TABLE "pipeline_requests"` and `"requirements_documents"` with the FK constraints; no `DROP`, no change to existing tables.

- [ ] **Step 7: Run both tests, verify they pass**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'pipeline_requests'` then `... -t 'requirements_documents'`
Expected: PASS (embedded Postgres auto-applies `0091`).

- [ ] **Step 8: Drift check + commit**

```bash
pnpm -C packages/db run check:drift
git add packages/db/src/schema/pipeline_requests.ts packages/db/src/schema/requirements_documents.ts \
  packages/db/src/schema/index.ts packages/db/src/migrations/0091_* \
  server/src/__tests__/schema/pipeline-tables.test.ts
git commit -m "feat(db): add pipeline_requests and requirements_documents (0091)"
```

---

## Migration 0092 — `pipeline_runs` (the parent)

### Task 3: `pipeline_runs` table + generate `0092`

**Files:**
- Create: `packages/db/src/schema/pipeline_runs.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/.next-scope.txt`
- Test: `server/src/__tests__/schema/pipeline-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
import { pipelineRuns } from '@sentinel/db';
import type { StageRecordMap, PipelineTrigger } from '@sentinel/db';

d('pipeline_runs', () => {
  const ctx = withPipelineSchema([pipelineRuns]);

  it('defaults verdict=pending, ciSignal=pending; stores trigger + stages jsonb', async () => {
    const trigger: PipelineTrigger = { type: 'manual_intake', source: 'ui' };
    const stages: StageRecordMap = {
      intake: { status: 'pending' },
      discovery: { status: 'pending' },
      plan: { status: 'pending' },
      generate: { status: 'pending' },
      validate: { status: 'pending' },
      execute: { status: 'pending' },
      analysis: { status: 'pending' },
      report: { status: 'pending' },
    };
    const [row] = await ctx.db
      .insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger, stages })
      .returning();

    expect(row.verdict).toBe('pending');
    expect(row.ciSignal).toBe('pending');
    expect(row.trigger).toEqual(trigger);
    expect(Object.keys(row.stages ?? {})).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'pipeline_runs'`
Expected: FAIL — `pipelineRuns` not exported.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/pipeline_runs.ts
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { testPlans } from './test_plans.js';
import { pipelineRequests } from './pipeline_requests.js';
import { requirementsDocuments } from './requirements_documents.js';

export type PipelineTrigger = {
  type: 'manual_intake' | 'jira' | 'ci' | 'scheduled' | 'manual_rerun';
  source: string;
  ref?: string;
  changedFiles?: string[];
};

export type StageRecord = {
  status: 'pending' | 'running' | 'complete' | 'skipped' | 'failed' | 'blocked';
  startedAt?: string;
  completedAt?: string;
  issueId?: string;
  assigneeAgentId?: string;
  skippedReason?: string; // NON-NULL whenever status === 'skipped'
  idempotencyKey?: string;
  error?: string;
  executionRunIds?: string[]; // execute stage only
};

export type StageRecordMap = {
  intake: StageRecord;
  discovery: StageRecord;
  plan: StageRecord;
  generate: StageRecord;
  validate: StageRecord;
  execute: StageRecord;
  analysis: StageRecord; // metrics + SLA + mechanical gate, ONE [ANL] Issue
  report: StageRecord;
};

export type BlockedAt = {
  stage: string;
  reason: string;
  questionId: string;
  interactionType: 'thread_interaction' | 'approval';
  interactionId: string;
  issueId: string;
};

export type ResolvedExecution = {
  loadProfile: Record<string, unknown>;
  executor: 'ramping-vus' | 'constant-arrival-rate' | 'ramping-arrival-rate' | 'constant-vus' | 'kafka' | 'streaming';
  executionModel: 'weighted-loop' | 'per-scenario';
  resolvedSteadyWindow: { startMs: number; endMs: number };
  testAssetVersions: { testAssetId: string; workflowName: string; engine: string; version: number }[];
  dataFileHashes: { name: string; sha256: string }[];
  secretRef: string;
  rngSeed: number;
  discoveredBreakpoint?: { rate: number; p95AtBreak: number; baselineP95: number; stopReason: string }; // DEFERRED: exploratory only
};

export const pipelineRuns = pgTable('pipeline_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  testPlanId: uuid('test_plan_id').references(() => testPlans.id, { onDelete: 'set null' }),
  pipelineRequestId: uuid('pipeline_request_id').references(() => pipelineRequests.id, { onDelete: 'set null' }),
  requirementsDocumentId: uuid('requirements_document_id').references(() => requirementsDocuments.id, { onDelete: 'set null' }),
  trigger: jsonb('trigger').$type<PipelineTrigger>().notNull(),
  stages: jsonb('stages').$type<StageRecordMap>().notNull(),
  verdict: text('verdict').notNull().default('pending'), // pending|running|pass|fail|blocked_on_human|inconclusive|error
  ciSignal: text('ci_signal').notNull().default('pending'), // pending|pass|fail|not_applicable
  blockedAt: jsonb('blocked_at').$type<BlockedAt>(),
  resolvedExecution: jsonb('resolved_execution').$type<ResolvedExecution>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add the barrel export**

In `packages/db/src/schema/index.ts`:

```typescript
export {
  pipelineRuns,
  type PipelineTrigger,
  type StageRecord,
  type StageRecordMap,
  type BlockedAt,
  type ResolvedExecution,
} from './pipeline_runs.js';
```

- [ ] **Step 5: Declare scope + generate `0092`**

Create `packages/db/src/migrations/.next-scope.txt`:

```
# 0092: pipeline_runs parent
companies
test_plans
pipeline_requests
requirements_documents
pipeline_runs
```

Run: `pnpm -C packages/db run generate`
Expected: `0092_<slug>.sql` with `CREATE TABLE "pipeline_runs"`, all FKs nullable except `companyId`. Scope check passes.

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'pipeline_runs'`
Expected: PASS.

- [ ] **Step 7: Drift check + commit**

```bash
pnpm -C packages/db run check:drift
git add packages/db/src/schema/pipeline_runs.ts packages/db/src/schema/index.ts \
  packages/db/src/migrations/0092_* server/src/__tests__/schema/pipeline-tables.test.ts
git commit -m "feat(db): add pipeline_runs parent state-machine table (0092)"
```

---

## Migration 0093 — child tables (`execution_runs`, `sla_verdicts`, `gate_resolutions`, `test_run_artifacts`)

> **Watch-point (circular FK):** `execution_runs.stdoutRef → test_run_artifacts.id` and `test_run_artifacts.executionRunId → execution_runs.id` reference each other. drizzle-kit creates both tables, then adds FK constraints via `ALTER` — this is fine in one migration. Both tables (and all FK targets) must be in `.next-scope.txt`.

### Task 4: `execution_runs` table

**Files:**
- Create: `packages/db/src/schema/execution_runs.ts`
- Modify: `packages/db/src/schema/index.ts`
- Test: `server/src/__tests__/schema/pipeline-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Append (defer the `stdoutRef` assertion to Task 7 once `test_run_artifacts` exists):

```typescript
import { executionRuns } from '@sentinel/db';

d('execution_runs', () => {
  const ctx = withPipelineSchema([executionRuns, pipelineRuns]);

  it('requires pipelineRunId, defaults status=queued', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(executionRuns)
      .values({ companyId: ctx.companyId, pipelineRunId: pr.id, engine: 'k6', binaryProfile: 'k6' })
      .returning();
    expect(row.status).toBe('queued');
    expect(row.pipelineRunId).toBe(pr.id);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'execution_runs'`
Expected: FAIL — `executionRuns` not exported.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/execution_runs.ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { pipelineRuns } from './pipeline_runs.js';
import { testRuns } from './test_runs.js';
import { testAssets } from './test_assets.js';
import { testRunArtifacts } from './test_run_artifacts.js';

export const executionRuns = pgTable('execution_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  pipelineRunId: uuid('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
  testAssetId: uuid('test_asset_id').references(() => testAssets.id, { onDelete: 'set null' }),
  engine: text('engine'),
  binaryProfile: text('binary_profile'), // resolvable k6 binary path/profile, NOT literal 'k6'
  workspaceRef: text('workspace_ref'),
  status: text('status').notNull().default('queued'), // queued|running|completed|failed|aborted
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  exitCode: integer('exit_code'),
  peakVus: integer('peak_vus'),
  totalIterations: integer('total_iterations'),
  totalRequests: integer('total_requests'),
  stdoutRef: uuid('stdout_ref').references(() => testRunArtifacts.id, { onDelete: 'set null' }),
  liveMetricFeed: text('live_metric_feed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Add the barrel export** — in `index.ts`: `export { executionRuns } from './execution_runs.js';`

- [ ] **Step 5: Commit the schema (migration generated in Task 7)** — do NOT generate yet; tables 4–7 land together in `0093`.

```bash
git add packages/db/src/schema/execution_runs.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add execution_runs schema (0093 pending)"
```

### Task 5: `sla_verdicts` table

**Files:**
- Create: `packages/db/src/schema/sla_verdicts.ts`
- Modify: `packages/db/src/schema/index.ts`
- Test: `server/src/__tests__/schema/pipeline-tables.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { slaVerdicts } from '@sentinel/db';

d('sla_verdicts', () => {
  const ctx = withPipelineSchema([slaVerdicts, pipelineRuns]);

  it('stores a windowed verdict joined to a stable slaTargetId', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(slaVerdicts).values({
      companyId: ctx.companyId, pipelineRunId: pr.id, slaTargetId: 't1',
      metric: 'p95_ms', operator: 'lt', threshold: 200, actualValue: 180,
      evaluationWindow: { startMs: 120_000, endMs: 720_000 },
      source: 'k6', status: 'pass', evaluatedOnSuccessOnly: true,
    }).returning();
    expect(row.status).toBe('pass');
    expect(row.evaluationWindow).toEqual({ startMs: 120_000, endMs: 720_000 });
    expect(row.evaluatedOnSuccessOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `... -t 'sla_verdicts'` → FAIL (`slaVerdicts` not exported).

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/sla_verdicts.ts
import { boolean, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { pipelineRuns } from './pipeline_runs.js';
import { executionRuns } from './execution_runs.js';
import { testRuns } from './test_runs.js';

export const slaVerdicts = pgTable('sla_verdicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  pipelineRunId: uuid('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
  executionRunId: uuid('execution_run_id').references(() => executionRuns.id, { onDelete: 'set null' }),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
  slaTargetId: text('sla_target_id').notNull(), // joins requirements_documents.slaTargets[].id (live, no copy)
  workflowName: text('workflow_name'),
  phase: text('phase'), // warmup|ramp_up|steady|ramp_down
  metric: text('metric'),
  operator: text('operator'),
  threshold: real('threshold'), // codebase uses real() for floats (spec §1: `real`), not doublePrecision
  actualValue: real('actual_value'),
  evaluationWindow: jsonb('evaluation_window').$type<{ startMs: number; endMs: number }>(),
  source: text('source'), // k6 | playwright | apm:dynatrace
  status: text('status').notNull(), // pass | fail | inconclusive
  evaluatedOnSuccessOnly: boolean('evaluated_on_success_only').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Barrel export** — `export { slaVerdicts } from './sla_verdicts.js';`
- [ ] **Step 5: Commit schema** — `git add ... && git commit -m "feat(db): add sla_verdicts schema (0093 pending)"`

### Task 6: `gate_resolutions` table

**Files:** Create `packages/db/src/schema/gate_resolutions.ts`; Modify `index.ts`; Test in `pipeline-tables.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { gateResolutions } from '@sentinel/db';

d('gate_resolutions', () => {
  const ctx = withPipelineSchema([gateResolutions, pipelineRuns]);

  it('stores outcome + total ciSignal', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(gateResolutions).values({
      companyId: ctx.companyId, pipelineRunId: pr.id,
      outcome: 'characterization', ciSignal: 'pass', resolvedBy: 'auto',
    }).returning();
    expect(row.outcome).toBe('characterization');
    expect(row.ciSignal).toBe('pass');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `... -t 'gate_resolutions'` → FAIL.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/gate_resolutions.ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { pipelineRuns } from './pipeline_runs.js';
import { testRuns } from './test_runs.js';

export const gateResolutions = pgTable('gate_resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  pipelineRunId: uuid('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
  // auto_pass|auto_fail|inconclusive|characterization|regression_approved|regression_rejected|baseline_approved|baseline_rejected
  outcome: text('outcome').notNull(),
  ciSignal: text('ci_signal').notNull(), // pass | fail — total on every path
  resolvedBy: text('resolved_by'), // userId | 'auto'
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Barrel export** — `export { gateResolutions } from './gate_resolutions.js';`
- [ ] **Step 5: Commit schema** — `git commit -m "feat(db): add gate_resolutions schema (0093 pending)"`

### Task 7: `test_run_artifacts` table + generate `0093`

**Files:** Create `packages/db/src/schema/test_run_artifacts.ts`; Modify `index.ts`; create `.next-scope.txt`; Test.

- [ ] **Step 1: Write the failing test**

```typescript
import { testRunArtifacts } from '@sentinel/db';

d('test_run_artifacts', () => {
  const ctx = withPipelineSchema([testRunArtifacts, pipelineRuns]);

  it('stores an artifact with default publishStatus=stored', async () => {
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never })
      .returning();
    const [row] = await ctx.db.insert(testRunArtifacts).values({
      companyId: ctx.companyId, pipelineRunId: pr.id,
      artifactType: 'k6_html_summary', storageRef: 's3://bucket/summary.html',
    }).returning();
    expect(row.artifactType).toBe('k6_html_summary');
    expect(row.publishStatus).toBe('stored');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `... -t 'test_run_artifacts'` → FAIL.

- [ ] **Step 3: Write the schema file**

```typescript
// packages/db/src/schema/test_run_artifacts.ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { pipelineRuns } from './pipeline_runs.js';
import { testRuns } from './test_runs.js';
// NOTE: executionRunId references execution_runs.id; the FK is created as an
// ALTER after both tables exist (circular with execution_runs.stdoutRef).
import { executionRuns } from './execution_runs.js';

export const testRunArtifacts = pgTable('test_run_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  pipelineRunId: uuid('pipeline_run_id').notNull().references(() => pipelineRuns.id, { onDelete: 'cascade' }),
  executionRunId: uuid('execution_run_id').references(() => executionRuns.id, { onDelete: 'set null' }),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
  // k6_html_summary|sentinel_summary|stdout_log|metrics_json_stream|dynatrace_deeplink|gha_workflow_bundle|performance_envelope
  artifactType: text('artifact_type').notNull(),
  storageRef: text('storage_ref').notNull(),
  url: text('url'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  publishStatus: text('publish_status').notNull().default('stored'), // stored | published | publish_failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Barrel export** — `export { testRunArtifacts } from './test_run_artifacts.js';`

- [ ] **Step 5: Declare scope + generate `0093`**

Create `packages/db/src/migrations/.next-scope.txt`:

```
# 0093: pipeline child tables
companies
pipeline_runs
test_runs
test_assets
execution_runs
sla_verdicts
gate_resolutions
test_run_artifacts
```

Run: `pnpm -C packages/db run generate`
Expected: `0093_<slug>.sql` with four `CREATE TABLE`s plus the cross-FK `ALTER`s for `execution_runs.stdout_ref` ↔ `test_run_artifacts.execution_run_id`. Scope check passes.

- [ ] **Step 6: Review the generated SQL** — confirm both circular FKs appear as `ADD CONSTRAINT ... FOREIGN KEY`, no `DROP`.

- [ ] **Step 7: Run all four child-table tests, verify they pass**

Run: `pnpm exec vitest run server/src/__tests__/schema/pipeline-tables.test.ts -t 'execution_runs'` (then `sla_verdicts`, `gate_resolutions`, `test_run_artifacts`)
Expected: PASS.

- [ ] **Step 8: Drift check + commit**

```bash
pnpm -C packages/db run check:drift
git add packages/db/src/schema/test_run_artifacts.ts packages/db/src/schema/index.ts \
  packages/db/src/migrations/0093_* server/src/__tests__/schema/pipeline-tables.test.ts
git commit -m "feat(db): add execution_runs, sla_verdicts, gate_resolutions, test_run_artifacts (0093)"
```

---

## Migration 0094 — additive alters to existing tables

All additive: new nullable columns / new-default columns only. No `NOT NULL` on populated columns, no drops. (The `metric_series.testRunId ON DELETE CASCADE` is **left untouched**.)

### Task 8: `test_runs += pipelineRunId`

**Files:** Modify `packages/db/src/schema/test_runs.ts`; Test in `server/src/__tests__/schema/altered-tables.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/schema/altered-tables.test.ts
import { describe, expect, it } from 'vitest';
import { testRuns, pipelineRuns, testPlans } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from '../helpers/pipeline-schema-fixture.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('test_runs.pipelineRunId', () => {
  const ctx = withPipelineSchema([testRuns, pipelineRuns, testPlans]);
  it('accepts a nullable pipelineRunId linking to a pipeline_runs row', async () => {
    const [plan] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [run] = await ctx.db.insert(testRuns)
      .values({ companyId: ctx.companyId, testPlanId: plan.id, pipelineRunId: pr.id }).returning();
    expect(run.pipelineRunId).toBe(pr.id);
  });
});
```

> NOTE: match the existing required columns of `testRuns`/`testPlans` — open `packages/db/src/schema/test_runs.ts` and `test_plans.ts` and add any other `.notNull()` columns to the `.values({...})` above.

- [ ] **Step 2: Run, verify it fails** — `pnpm exec vitest run server/src/__tests__/schema/altered-tables.test.ts -t 'pipelineRunId'` → FAIL (column missing).

- [ ] **Step 3: Add the column** — in `packages/db/src/schema/test_runs.ts`, add inside the column object and an import of `pipelineRuns`:

```typescript
import { pipelineRuns } from './pipeline_runs.js';
// ...
  pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
```

- [ ] **Step 4: Generate `0094` is deferred to Task 13** — all six alters land in one migration. For now just verify typecheck: `pnpm -C packages/db exec tsc --noEmit`. Commit the schema edit:

```bash
git add packages/db/src/schema/test_runs.ts server/src/__tests__/schema/altered-tables.test.ts
git commit -m "feat(db): test_runs.pipelineRunId column (0094 pending)"
```

### Task 9: `metric_series += executionRunId, workflowName, phase, digest, sampleCount`

**Files:** Modify `packages/db/src/schema/metric_series.ts`; Test in `altered-tables.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { metricSeries, executionRuns } from '@sentinel/db';

d('metric_series digest columns', () => {
  const ctx = withPipelineSchema([metricSeries]);
  it('stores per-workflow phase-tagged digest series', async () => {
    // seed whatever testRunId metric_series requires (open metric_series.ts to confirm FKs)
    const [row] = await ctx.db.insert(metricSeries).values({
      // ...existing required cols (testRunId etc.)...
      metric: 'http_req_duration', source: 'k6',
      workflowName: 'checkout', phase: 'steady',
      digest: { centroids: [] }, sampleCount: 1234,
    } as never).returning();
    expect(row.workflowName).toBe('checkout');
    expect(row.phase).toBe('steady');
    expect(row.sampleCount).toBe(1234);
  });
});
```

> Open `packages/db/src/schema/metric_series.ts` first and fill the existing required columns in `.values(...)` (it has a `testRunId` FK — seed a `testRuns` row like Task 8 and pass its id).

- [ ] **Step 2: Run, verify it fails** — FAIL (columns missing).

- [ ] **Step 3: Add the columns** — in `metric_series.ts`:

```typescript
import { executionRuns } from './execution_runs.js';
// add near the top (named seam for the deferred sharded t-digest merge — decision #1):
export type MetricDigest = Record<string, unknown>; // shape firmed when sharded merge lands
// add to columns:
  executionRunId: uuid('execution_run_id').references(() => executionRuns.id, { onDelete: 'set null' }),
  workflowName: text('workflow_name'),
  phase: text('phase'), // warmup|ramp_up|steady|ramp_down
  digest: jsonb('digest').$type<MetricDigest>(), // per-bucket t-digest/HDR blob (named seam below)
  sampleCount: integer('sample_count'),
```

(Ensure `jsonb`, `integer` are imported. Leave existing `value`/`rawValues`/`metadata` and the `testRunId` CASCADE untouched.)

- [ ] **Step 4: Typecheck + commit** — `pnpm -C packages/db exec tsc --noEmit`; `git commit -m "feat(db): metric_series digest-ready columns (0094 pending)"`

### Task 10: `test_assets += protocol, dataFiles, setupScript, teardownScript, generatedFrom, sourceRef`

**Files:** Modify `packages/db/src/schema/test_assets.ts`; Test in `altered-tables.test.ts`.

> `workflowName NOT NULL` and `UNIQUE(testPlanId, workflowName, engine)` are **deferred to `0095`** (Task 14) behind a backfill. This task adds only the additive nullable columns. (`assetType` is `text`, so `ci_workflow`/`existing_k6` are new allowed values needing no DDL change.)

- [ ] **Step 1: Write the failing test**

```typescript
import { testAssets, testPlans } from '@sentinel/db';

d('test_assets provenance columns', () => {
  const ctx = withPipelineSchema([testAssets, testPlans]);
  it('stores sourceRef provenance + generatedFrom', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [row] = await ctx.db.insert(testAssets).values({
      // ...existing required cols (testPlanId, engine, assetType, scriptContent)...
      testPlanId: plan.id,
      protocol: 'http', generatedFrom: 'existing_k6',
      sourceRef: { repoUrl: 'git@x', path: 'a.js', ref: 'main', importedSha: 'abc' },
      dataFiles: [], setupScript: null, teardownScript: null,
    } as never).returning();
    expect(row.generatedFrom).toBe('existing_k6');
    expect((row.sourceRef as { path?: string })?.path).toBe('a.js');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — FAIL.

- [ ] **Step 3: Add the columns** — in `test_assets.ts`:

```typescript
export type TestAssetSourceRef = { repoUrl: string; path: string; ref: string; importedSha: string };
// add to columns:
  protocol: text('protocol'),
  dataFiles: jsonb('data_files').$type<{ name: string; content: string; type: string; strategy: string }[]>(),
  setupScript: text('setup_script'),
  teardownScript: text('teardown_script'),
  generatedFrom: text('generated_from'), // openapi|postman|functional_tests|scratch|existing_k6
  sourceRef: jsonb('source_ref').$type<TestAssetSourceRef>(), // READ-ONLY provenance; a human commits
```

**EDIT the existing `testAssets` export line** in `index.ts` (it already exports `testAssets` — do NOT add a new line, that is a TS2300 duplicate-identifier error that fails the `tsc` step). Change the existing line to: `export { testAssets, type TestAssetSourceRef } from './test_assets.js';`. (Likewise in Task 11, `testPlans`/`LoadProfile` are **already** exported from `index.ts`, so Task 11 adds **no** barrel line — `LoadProfile` only widens in-place in `test_plans.ts`.)

- [ ] **Step 4: Typecheck + commit** — `git commit -m "feat(db): test_assets data/provenance columns (0094 pending)"`

### Task 11: `test_plans += requirementsDocumentId, executionModel`

**Files:** Modify `packages/db/src/schema/test_plans.ts`; Test in `altered-tables.test.ts`.

> The `loadProfile` discriminated-union widening is **type-only** (the column stays `jsonb`; old `{ vus, stages }` rows remain valid). Update the `LoadProfile` TS type but expect **no SQL change** for it.

- [ ] **Step 1: Write the failing test**

```typescript
import { testPlans, requirementsDocuments } from '@sentinel/db';

d('test_plans references requirements + executionModel', () => {
  const ctx = withPipelineSchema([testPlans, requirementsDocuments]);
  it('links requirementsDocumentId and stores executionModel', async () => {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId }).returning();
    const [row] = await ctx.db.insert(testPlans)
      .values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd.id, executionModel: 'per-scenario' }).returning();
    expect(row.requirementsDocumentId).toBe(rd.id);
    expect(row.executionModel).toBe('per-scenario');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — FAIL.

- [ ] **Step 3: Add the columns + widen the type** — in `test_plans.ts`:

```typescript
import { requirementsDocuments } from './requirements_documents.js';
// add to columns:
  requirementsDocumentId: uuid('requirements_document_id').references(() => requirementsDocuments.id, { onDelete: 'set null' }),
  executionModel: text('execution_model'), // weighted-loop | per-scenario
```

Replace the exported `LoadProfile` type with the protocol-tagged discriminated union from spec Stage 2 (includes the `constant-vus` true-baseline branch). Keep it a TS type only — `loadProfile` column stays `jsonb`.

- [ ] **Step 4: Typecheck + commit** — `git commit -m "feat(db): test_plans requirementsDocumentId + executionModel (0094 pending)"`

### Task 12: `baselines += baselineSetId` and `regressions += pipelineRunId, direction`

**Files:** Modify `packages/db/src/schema/baselines.ts`, `regressions.ts`; Test in `altered-tables.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { baselines, regressions } from '@sentinel/db';

d('baselines.baselineSetId + regressions direction', () => {
  const ctx = withPipelineSchema([regressions, baselines, pipelineRuns]);
  it('groups baseline rows and stores regression direction', async () => {
    const setId = '00000000-0000-0000-0000-000000000001';
    const [b] = await ctx.db.insert(baselines)
      .values({ /* ...existing required cols... */ baselineSetId: setId } as never).returning();
    expect(b.baselineSetId).toBe(setId);

    const [pr] = await ctx.db.insert(pipelineRuns)
      .values({ companyId: ctx.companyId, trigger: { type: 'ci', source: 'gha' }, stages: {} as never }).returning();
    const [r] = await ctx.db.insert(regressions)
      .values({ /* ...existing required cols... */ pipelineRunId: pr.id, direction: 'higher_is_worse' } as never).returning();
    expect(r.direction).toBe('higher_is_worse');
  });
});
```

> Open `baselines.ts`/`regressions.ts` and fill existing required columns.

- [ ] **Step 2: Run, verify it fails** — FAIL.

- [ ] **Step 3: Add the columns** — `baselines.ts`: `baselineSetId: uuid('baseline_set_id'),` · `regressions.ts`: `import { pipelineRuns } from './pipeline_runs.js';` then `pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }), direction: text('direction'),` (higher_is_worse | lower_is_worse). **Note:** `regressions.regressionType` stays the shipped free-text default in this plan; its conversion to the closed enum is deferred to `0095` (Task 14). Only `direction` (the one v1 baseline fix, decision #2) and `pipelineRunId` land here.

- [ ] **Step 4: Typecheck + commit** — `git commit -m "feat(db): baselines.baselineSetId + regressions direction/pipelineRunId (0094 pending)"`

### Task 13: Generate migration `0094` (all alters together)

**Files:** Create `packages/db/src/migrations/.next-scope.txt`; generate.

- [ ] **Step 1: Declare scope**

Create `packages/db/src/migrations/.next-scope.txt`:

```
# 0094: additive alters
test_runs
metric_series
test_assets
test_plans
baselines
regressions
pipeline_runs
execution_runs
requirements_documents
```

- [ ] **Step 2: Generate `0094`** — `pnpm -C packages/db run generate`. Expected: `0094_<slug>.sql` with `ALTER TABLE ... ADD COLUMN` only; the `loadProfile` widening produces **no** SQL (jsonb unchanged). Scope check passes.

- [ ] **Step 3: Review the SQL** — confirm only `ADD COLUMN` (all nullable / with default) and `ADD CONSTRAINT ... FOREIGN KEY`; **no `ALTER COLUMN ... SET NOT NULL`, no `DROP`, no unique constraint**.

- [ ] **Step 4: Run all altered-table tests, verify they pass** — `pnpm exec vitest run server/src/__tests__/schema/altered-tables.test.ts`

- [ ] **Step 5: Drift check + commit**

```bash
pnpm -C packages/db run check:drift
git add packages/db/src/schema/*.ts packages/db/src/migrations/0094_*
git commit -m "feat(db): additive alters for pipeline integration (0094)"
```

---

## Task 14: (DEFERRED — fast-follow, NOT v1-blocking) `0095` tightening

Per spec §5, the only constraint-tightening lives in `0095` **behind a backfill** and is out of this plan's critical path. Documented here so it isn't lost; do NOT implement until existing `test_assets` rows are backfilled.

- [ ] **Deferred:** backfill `test_assets.workflowName` for existing rows → then `0095`: `ALTER test_assets ALTER COLUMN workflow_name SET NOT NULL` + `CREATE UNIQUE INDEX ON test_assets(test_plan_id, workflow_name, engine)`; convert `regressions.regressionType` to the closed enum set deterministically from the metric. Each gets its own `.next-scope.txt`, generate, drift-check, migrate. **Leave unchecked — this is a flagged follow-up, not part of Plan 1's done-definition.**

---

## Task 15: Integration — full migrate, typecheck, all green

**Files:** none (verification + commit).

- [ ] **Step 1: Clean build of the db package**

Run: `pnpm -C packages/db run build`
Expected: `check:migrations` passes (numbering + journal consistent), `tsc` compiles, migrations copied to `dist/`.

- [ ] **Step 2: Apply all migrations to a scratch DB** (if a local dev DB is configured)

Run: `pnpm -C packages/db run migrate`
Expected: `0091`–`0094` apply cleanly, no errors.

- [ ] **Step 3: Run the full schema test suite**

Run: `pnpm exec vitest run server/src/__tests__/schema/`
Expected: all `pipeline-tables` and `altered-tables` tests PASS (or `skip` on a host without embedded-Postgres support — confirm the skip reason is platform, not a real failure).

- [ ] **Step 4: Workspace typecheck**

Run: `pnpm -C server exec tsc --noEmit && pnpm -C packages/db exec tsc --noEmit`
Expected: PASS — every new type resolves from `@sentinel/db`.

- [ ] **Step 5: Final drift check + commit**

```bash
pnpm -C packages/db run check:drift
git add -A
git commit -m "feat(db): data-model foundation complete — pipeline tables + additive alters (0091-0094)"
```

---

## Self-Review

**1. Spec coverage (Data Model §1–§6):**
- §1 net-new tables — `pipeline_requests` (T1), `requirements_documents` (T2), `pipeline_runs` (T3), `execution_runs` (T4), `sla_verdicts` (T5), `gate_resolutions` (T6), `test_run_artifacts` (T7). ✅
- §2 altered tables — `test_runs` (T8), `metric_series` (T9), `test_assets` (T10), `test_plans` (T11), `baselines`/`regressions` (T12). ✅
- §3 SLA single-source-of-truth — `SlaTarget` with stable `id` defined once on `requirements_documents`; `sla_verdicts.slaTargetId` is a `text` join key, not a copy. ✅
- §4 status-transition fields — enum-bearing `text` columns present (`verdict`, `ciSignal`, `status`, `outcome`); transition *logic* is Plan 4/6, not the schema. ✅ (schema-only here)
- §5 migration ordering & risk — additive `0091`→`0094`; `metric_series` CASCADE untouched; tightening isolated to deferred `0095` (T14). ✅
- §6 v1 columns built; deferred columns (`performance_envelope` artifactType, `discoveredBreakpoint`) are present as **values/optional fields** with no logic — correct (logic deferred). ✅

**2. Placeholder scan:** The `/* ...existing required cols... */` notes in T9/T10/T12 are intentional instructions to read the real table's required columns (those columns differ per table and must be read from source, not guessed) — each is paired with a "open X.ts first" directive, not a silent TODO. No `TBD`/`implement later`.

**3. Type consistency:** `pipelineRuns`/`PipelineTrigger`/`StageRecordMap`/`ResolvedExecution` are defined in T3 and referenced consistently in T4–T12 and the fixture. `SlaTarget` (T2) is referenced by the `sla_verdicts` join key (T5). `executionRuns` ↔ `testRunArtifacts` circular FK is declared in both (T4/T7) and resolved in the single `0093` migration. `constant-vus` appears in the `ResolvedExecution.executor` union (T3) and the deferred `LoadProfile` widening (T11), matching spec v2.1.
