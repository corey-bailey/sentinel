# k6 Script Generation & Local Execution Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `TestPlan` + `RequirementsDocument` into a *real, runnable* k6 asset and prove the **local agent-run path** end-to-end: generate a canonical-template-conforming k6 script (with the `{workflow,phase}` tagging and a portable `handleSummary` that writes the native HTML report plus the raw k6 end-of-test summary JSON), run it for real via an `execFile`-based spawn in an ExecutionWorkspace cwd, read the summary back, transform it into `metric_series` rows, ingest them, and let Plan 2's `slaVerdictEngine` turn it into `sla_verdicts`.

**Architecture:** Two cooperating halves, both factory-function services (`service(db)`, no DAO). (1) A **pure generator** (`server/src/services/k6-generator/*`) — no I/O — that derives the steady-state window, `options.scenarios`, `options.thresholds`, `summaryTrendStats`, and the data files, then renders one k6 script string per TestPlan against the canonical template (`docs/superpowers/specs/2026-05-29-k6-http-canonical-template.draft.js`). The generated `handleSummary` is **portable and executor-agnostic** (spec Stage 5): it writes the native HTML report **and** `JSON.stringify(data)` — the *raw* k6 end-of-test summary (the standard k6 JSON-export idiom), **not** a Sentinel-shaped payload. (2) A **local harness/executor** (`k6-executor.ts`) that writes the script + data files into a per-run cwd, runs k6 via a real `execFile` `SpawnFn`, reads `summary-${TEST_RUN_ID}.json`, applies a **typed Sentinel-side transform** (`mapK6Summary`) to extract the windowed `{workflow,phase}`-tagged sub-metrics into flat `metric_series` rows, ingests them via Plan 2's `metricSeriesService`, and records an `execution_runs` row. Keeping the metric→row transform **in the harness (not in `handleSummary`)** is what makes the script identical across the local and the deferred GHA harness (spec rule 4): both run the same script and read the same raw summary; only the transform's *invocation site* differs (in-process now, server-side-after-POST for GHA later).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Drizzle ORM, Zod (already on the ingestion route), `node:child_process` `execFile`, Vitest 3 + embedded-Postgres (DB/service/integration tests), k6 (real-run smoke, skip-gated). **No new migration** — `test_assets` already carries `scriptContent/dataFiles/setupScript/teardownScript/generatedFrom/protocol`, and Plan 1 shipped `execution_runs`, `pipeline_runs`, `metric_series`, `requirements_documents`, `sla_verdicts`.

---

## Critical Context (read before any task)

### What Plan 3 is (and is NOT)

**IN scope (this plan):**
- The pure k6 **script generator** for v1 **HTTP/sync, generate-from-scratch** only, covering the three canonical shapes:
  - **Shape A — weighted-loop + `ramping-vus`** (aggregate SLAs, one `router()` scenario, `{workflow}` stamped per-request).
  - **Shape B — per-scenario + `constant-arrival-rate`** (per-workflow SLAs, one named scenario per workflow).
  - **True-baseline — `constant-vus {vus:1}`** (uncontended latency floor; whole run is steady minus a front-edge warmup guard).
- The generated `handleSummary` (portable) that writes the native HTML report **and** `JSON.stringify(data)` — the *raw* k6 end-of-test summary, the standard k6 idiom — into the run cwd. **No Sentinel-shaped payload lives in the script.**
- A typed, Sentinel-side transform (`mapK6Summary`) that turns the raw k6 summary into flat `metric_series` rows — invoked by the harness, not the script.
- A real `execFile`-based `SpawnFn`, a reworked `runK6` (runs `k6 run <script>` in a cwd, scenarios come from the script's `options`, **not** CLI flags), and `readK6Summary` (reads the raw summary + applies `mapK6Summary`).
- A minimal `executionRunService` (create / markRunning / complete) and a `k6Executor` that threads generate → write → run → read → transform → ingest → record.

**DEFERRED (later plans — do NOT build here):**
- Issue-driven orchestration: wiring the `[RUN:k6]` issue to the executor, and the `pipeline-builder` `assigneeAgentId` deadlock fix → **Plan 4**.
- The `ci_workflow` / GitHub Actions YAML generator (the `assetType` value stays reserved) → fast-follow after the local path.
- The `generated → approved_generated` human approval gate state transitions → Plan 6 / gate work.
- Non-HTTP protocols (Kafka/gRPC/WebSocket/Playwright). The generator **stop-and-asks** (throws a typed `UnsupportedProtocolError`) if it sees a non-HTTP protocol or an unsupported executor.
- Adapt-from-OpenAPI/Postman and import-existing-k6 input paths (v1 = generate-from-scratch only).
- Dynatrace/async source-of-record; `evaluationWindow` population on verdicts (Plan 2 leaves it null; Plan 4 wiring fills it).
- **HTML-summary artifact persistence** (spec Stage 9: a `test_run_artifacts` row, `artifactType = k6_html_summary`). The generated `handleSummary` *writes* the HTML into the run cwd, but persisting it as a `test_run_artifacts` row (and `stdout_log`) needs the artifact-storage model → **Plan 4** / Stage 9. v1 leaves the HTML in the workspace cwd; only the `metric_series` ingestion path is wired.
- **Harness-swap validation:** confirming the *identical* generated script + `handleSummary` runs the same way in the generated GHA workflow lands with the GHA generator → **Plan 4**. The local path is the proof of concept; the script and raw-summary contract are designed to be harness-invariant.

### The ingestion contract (the `handleSummary` target — from Plan 2, do not change)

The generated script's `summary-${TEST_RUN_ID}.json` must match the shape `metricSeriesService.ingest` accepts (and the SLA engine later joins on):

```typescript
// server/src/services/metric-series.ts (Plan 2 — already shipped)
type IngestSeriesEntry = {
  metric: string;                 // SLA-vocab key: 'p95_ms' | 'p99_ms' | 'p50_ms' | 'error_rate'
  workflowName?: string | null;   // MUST equal SlaTarget.workflowScope (case-sensitive) or both null
  phase?: 'warmup' | 'ramp_up' | 'steady' | 'ramp_down' | null;  // verdicts evaluate phase='steady' ONLY
  value: number;
  sampleCount?: number | null;    // < minSampleCount (default 200) → required target = inconclusive
  rawValues?: number[] | null;
  digest?: Record<string, unknown> | null;
};
type IngestPayload = { testRunId: string; executionRunId?: string | null; source: string; series: IngestSeriesEntry[]; };
```

The SLA engine join is **strict** (`server/src/services/sla-verdict-engine.ts`): for each `SlaTarget`, it looks up the steady-phase row keyed `` `${metric}|${source}|${workflowName ?? ''}` ``. A typo in `metric`, a mismatched `source` (must be `'k6'`), or a `workflowName` that doesn't equal `SlaTarget.workflowScope` makes the metric look **missing** → a required target resolves to **inconclusive**. The loop closes from two ends that must agree: the generator **declares a k6 threshold** per latency/error sub-metric (so k6 *materializes* that tagged sub-metric in the summary — see the k6 facts below), and the harness transform `mapK6Summary` **emits the canonical SLA-vocab metric names** (`p95_ms`, …) with `workflowName` parsed from the sub-metric's `{workflow:…}` tag. Both are driven by the same `slaTargets` vocabulary, so what k6 measures is exactly what the engine joins on.

> **Metric-vocabulary note:** `SlaTarget.metric` is a free-form `string` in the schema (no DB enum); `p95_ms` / `p99_ms` / `p50_ms` / `error_rate` is the convention **already established by Plan 2's tests** (which used `p95_ms` and `error_rate`). Discovery (Stage 1, a later plan) is responsible for authoring SLA targets with these tokens. The transform emits exactly these tokens; if Discovery later standardizes different tokens, update `summary-mapping.ts` and `thresholds.ts` together.

`SlaTarget` (`packages/db/src/schema/requirements_documents.ts`):
```typescript
type SlaTarget = {
  id: string; source: string; metric: string;
  operator: 'lt' | 'lte' | 'gt' | 'gte'; threshold: number;
  required: boolean; workflowScope?: string; approvedByUserId?: string;
};
```

### The metric-name vocabulary (the contract between generation and SLA targets)

SLA targets are authored in Discovery with this exact vocabulary; the generator emits these exact `metric` strings (matches Plan 2's tests, which used `p95_ms` and `error_rate`):

| `SlaTarget.metric` | k6 sub-metric base | k6 `values` stat key | unit |
|---|---|---|---|
| `p50_ms` | `http_req_duration{…,phase:steady,expected_response:true}` | `med` | ms |
| `p95_ms` | `http_req_duration{…,phase:steady,expected_response:true}` | `p(95)` | ms |
| `p99_ms` | `http_req_duration{…,phase:steady,expected_response:true}` | `p(99)` | ms |
| `error_rate` | `http_req_failed{phase:steady}` (aggregate, no `{workflow}`) | `rate` | fraction 0..1 |

Two non-obvious k6 facts the generator MUST honor:
1. **A tagged sub-metric only appears in `handleSummary(data).metrics` if a threshold is declared on that exact selector.** So the generator declares a threshold per sub-metric key it intends to read back. (The threshold expression also drives k6's own console pass/fail, but Sentinel's authoritative verdict is computed server-side by `slaVerdictEngine` from the ingested value — k6's threshold result is not the verdict.)
2. **`summaryTrendStats` controls which Trend stats are exposed.** k6's default omits `p(99)` and `count`. The generated `options` MUST set `summaryTrendStats: ["avg","min","med","max","p(90)","p(95)","p(99)","count"]` or `p99_ms` and `sampleCount` will be missing. The real-k6 smoke (Task 16) is the arbiter of the exact `values` keys; if real k6 differs from the fixtures, fix `summary-mapping.ts` + the fixtures, not the test expectations.

### Phase tagging (extends the canonical template)

The canonical template's `phaseFor(t)` is 3-branch (`ramp_up|steady|ramp_down`). Plan 3 generalizes it to a **4-branch** function so the `warmup` phase (a v1 `metric_series.phase` enum member and the spec's "front-edge cold-start exclusion") and the zero-ramp baseline case are expressible with one code path:

```javascript
function phaseFor(t) {                 // t = exec.instance.currentTestRunDuration (MILLISECONDS)
  var ts = t / 1000;                   // convert to seconds — boundaries are in seconds
  if (ts < WARMUP_END_S)  return "warmup";
  if (ts < RAMP_UP_END_S) return "ramp_up";
  if (ts < STEADY_END_S)  return "steady";  // ONLY these samples are authoritative
  return "ramp_down";
}
```

> **k6 gotcha (critical):** `exec.instance.currentTestRunDuration` is in **milliseconds**, not seconds. The window boundaries (`WARMUP_END_S` etc.) are in seconds, so `phaseFor` MUST divide by 1000 first. (The canonical-template draft omits this conversion — it is a latent bug there; the generated script fixes it.) Without the `/1000`, a 30s warmup would compare `30000 < 30` → every sample tags `ramp_down`, `steady` is never reached, and **every required verdict becomes `inconclusive`.**

Window boundaries per executor (computed by `window.ts`, baked as env defaults, overridable by the executor):
- **`ramping-vus`:** `WARMUP_END_S = 0`, `RAMP_UP_END_S =` end of the ramp stage(s), `STEADY_END_S =` start of ramp-down.
- **`constant-arrival-rate`:** `WARMUP_END_S = RAMP_UP_END_S = evaluationWindow.warmup`, `STEADY_END_S = warmup + steady` (no `ramp_up` region; the flat sustain has a warmup-then-steady-then-cooldown shape).
- **`constant-vus` (baseline):** `WARMUP_END_S = RAMP_UP_END_S = warmupGuardS` (default 30s), `STEADY_END_S = totalDuration` (whole post-warmup run is steady; no ramp-down).

### The current adapter is broken for real use (not just mocked)

`server/src/services/test-adapters/k6-adapter.ts` today runs `k6 run --out json=- --vus N --stage …` and `JSON.parse`s stdout as one summary object. Two bugs Plan 3 fixes:
- `--out json=-` emits a **per-sample NDJSON stream**, not a single summary object → real runs yield null metrics. The authoritative windowed percentiles live only in `handleSummary(data)`.
- A locked decision says scenarios come from `options.scenarios` **in the script config**, not `--vus`/`--stage` CLI flags. The reworked `runK6` drops those flags and runs `k6 run <script>` with env injected.

`runK6` is currently called **only from its test** (and `pipeline-builder.test.ts`), never from a production path — so reworking its signature is safe. Its existing tests (which assert `--vus`/`--stage` and the old summary parsing) are **rewritten** in Task 12.

### Codebase conventions (from recon — match exactly)

- **Services are factory functions:** `export function xService(db: Db) { async function m() {…} return { m }; }`. No classes, no DAO. Pure helpers are plain exported functions.
- **Many small files.** The generator is split by responsibility under `server/src/services/k6-generator/`.
- **ESM with `.js` specifiers** on every relative import. Drizzle from `'drizzle-orm'` / `'drizzle-orm/pg-core'`. Tables/types from `@sentinel/db`.
- **DB/service/integration tests** use the Plan-1 fixture `server/src/__tests__/helpers/pipeline-schema-fixture.ts` (`withPipelineSchema`, `embeddedPostgresSupport`). Guard with `const d = embeddedPostgresSupport.supported ? describe : describe.skip;`. Pass tables to `withPipelineSchema([...])` in **child-before-parent FK order**. `ctx.db` and `ctx.companyId` are getters.
- **Pure-unit tests** (generator helpers, spawn, summary mapping) need no DB and run unconditionally.
- **Run one test:** `pnpm exec vitest run <file>` (optionally `-t '<name>'`), path from repo root.
- **Gotcha:** `server/tsconfig.json` excludes `src/__tests__`, so `tsc --noEmit` does NOT typecheck test files — rely on vitest, not tsc, for test correctness.
- **Commits:** conventional commits — `feat(server):`, `test(server):`, `fix(server):`, imperative, no body.
- **Immutability:** build new objects; never mutate inputs (user coding-style rule).

### File structure (created/modified by this plan)

```
server/src/services/k6-generator/
  types.ts            # shared types: LoadProfile (v1 subset), Workflow, GenerateK6Input, GeneratedK6Asset, errors
  duration.ts         # parseDurationToSeconds / sumDurationsSeconds  (pure)
  window.ts           # resolveSteadyWindow(loadProfile) -> SteadyWindow  (pure)
  scenarios.ts        # buildScenarios(loadProfile, workflows) -> options.scenarios + exec-fn plan  (pure)
  thresholds.ts       # buildThresholds(slaTargets) -> Record<string,string[]>  (pure; declares the sub-metrics k6 must materialize)
  summary-mapping.ts  # mapK6Summary(rawK6Data) -> { series, run }  (pure, typed; the HARNESS-side transform)
  template.ts         # fixed template fragments (imports, phaseFor, params, claimConsumable, handleSummary)  (pure)
  render-script.ts    # assembleScript(parts) -> full k6 script string  (pure)
  data-files.ts       # buildDataFiles(workflows, data) -> dataFiles[] + expectedIterations  (pure)
  generate.ts         # generateK6Script(input) -> GeneratedK6Asset  (orchestrates the above)
server/src/services/test-adapters/
  spawn.ts            # createExecFileSpawn(): SpawnFn  (real node:child_process)
  k6-adapter.ts       # REWORKED: runK6(opts) + readK6Summary(cwd, testRunId)
server/src/services/
  execution-runs.ts   # executionRunService(db): create / markRunning / complete
  k6-executor.ts      # k6Executor(deps): run(input) -> generate-written script => run => ingest => record
```

---

## Task 1: Generator types + duration utility

**Files:**
- Create: `server/src/services/k6-generator/types.ts`
- Create: `server/src/services/k6-generator/duration.ts`
- Test: `server/src/__tests__/k6-generator/duration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/duration.test.ts
import { describe, expect, it } from 'vitest';
import { parseDurationToSeconds, sumDurationsSeconds } from '../../services/k6-generator/duration.js';

describe('parseDurationToSeconds', () => {
  it('parses seconds, minutes, hours, and combinations', () => {
    expect(parseDurationToSeconds('30s')).toBe(30);
    expect(parseDurationToSeconds('2m')).toBe(120);
    expect(parseDurationToSeconds('1h')).toBe(3600);
    expect(parseDurationToSeconds('1h30m')).toBe(5400);
    expect(parseDurationToSeconds('1m30s')).toBe(90);
  });

  it('throws on an unparseable duration', () => {
    expect(() => parseDurationToSeconds('soon')).toThrow(/duration/i);
    expect(() => parseDurationToSeconds('')).toThrow(/duration/i);
  });
});

describe('sumDurationsSeconds', () => {
  it('sums a list of k6 duration strings', () => {
    expect(sumDurationsSeconds(['2m', '10m', '2m'])).toBe(840);
    expect(sumDurationsSeconds([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/duration.test.ts`
Expected: FAIL — cannot import `parseDurationToSeconds`.

- [ ] **Step 3: Write the types and the duration utility**

```typescript
// server/src/services/k6-generator/types.ts
import type { SlaTarget } from '@sentinel/db';

// v1 LoadProfile subset (the spec's discriminated union; non-HTTP/unsupported executors are rejected).
export type RampStage = { duration: string; target: number };

export type RampingVusProfile = {
  protocol: 'http';
  executor: 'ramping-vus';
  startVUs?: number;
  stages: RampStage[];          // target = VUs
  gracefulRampDown?: string;
  thinkTime?: number;
};
export type ConstantArrivalRateProfile = {
  protocol: 'http';
  executor: 'constant-arrival-rate';
  rate: number;
  timeUnit: string;             // e.g. '1s'
  duration: string;
  evaluationWindow: { warmup: string; steady: string; cooldown: string };
  preAllocatedVUs?: number;     // derived if absent (Little's Law)
  maxVUs?: number;
};
export type ConstantVusProfile = {
  protocol: 'http';
  executor: 'constant-vus';     // TRUE BASELINE
  vus: number;                  // typically 1
  duration: string;
  warmupGuard?: string;         // default '30s'
};
export type LoadProfile = RampingVusProfile | ConstantArrivalRateProfile | ConstantVusProfile;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Workflow = {
  name: string;                 // 'checkout' | 'search' — MUST equal the SlaTarget.workflowScope it maps to
  weight: number;               // traffic-mix weight in [0,1]; sum across workflows ~= 1 (weighted-loop / arrival-rate split)
  request: {
    method: HttpMethod;
    path: string;               // e.g. '/checkout' (BASE_URL is prefixed at runtime)
    queryFromData?: string;     // reusable record field to interpolate into the query string (GET)
    bodyFromData?: boolean;     // POST/PUT/PATCH: JSON body is a claimed consumable record
  };
  dataStrategy: 'none' | 'reusable' | 'consumable';
};

export type GenerateK6Input = {
  loadProfile: LoadProfile;
  executionModel: 'weighted-loop' | 'per-scenario';
  workflows: Workflow[];
  slaTargets: SlaTarget[];      // requirements_documents.slaTargets[] (only source='k6' targets are realized in-script)
  data?: { reusable?: unknown[]; consumable?: unknown[] };
};

export type GeneratedDataFile = { name: string; content: string; type: 'json'; strategy: 'reusable' | 'consumable' };

export type GeneratedK6Asset = {
  engine: 'k6';
  protocol: 'http';
  binaryProfile: 'k6';
  assetType: 'generated';
  generatedFrom: 'scratch';
  scriptContent: string;
  dataFiles: GeneratedDataFile[];
  setupScript: null;            // setup() is embedded in scriptContent for v1
};
// NOTE: the metric→row transform lives in the HARNESS (mapK6Summary, Task 5), not in the asset.
// The generated script declares k6 thresholds (Task 4) so k6 materializes the tagged sub-metrics;
// the raw k6 summary it writes is transformed to metric_series rows by the executor (Task 14).

export class UnsupportedProtocolError extends Error {
  constructor(detail: string) {
    super(`Unsupported protocol/executor for v1 HTTP generation: ${detail}`);
    this.name = 'UnsupportedProtocolError';
  }
}
```

```typescript
// server/src/services/k6-generator/duration.ts
// k6 duration strings: integers suffixed h/m/s, concatenated (e.g. '1h30m', '90s', '2m').
const DURATION_RE = /^(\d+h)?(\d+m)?(\d+s)?$/;

export function parseDurationToSeconds(d: string): number {
  const trimmed = d.trim();
  const m = DURATION_RE.exec(trimmed);
  if (!trimmed || !m || (!m[1] && !m[2] && !m[3])) {
    throw new Error(`Unparseable k6 duration: "${d}"`);
  }
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseInt(m[3], 10) : 0;
  return h * 3600 + min * 60 + s;
}

export function sumDurationsSeconds(durations: string[]): number {
  return durations.reduce((acc, d) => acc + parseDurationToSeconds(d), 0);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/duration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/types.ts server/src/services/k6-generator/duration.ts server/src/__tests__/k6-generator/duration.test.ts
git commit -m "feat(server): k6-generator types + duration parsing utility"
```

---

## Task 2: Steady-state window resolution

**Files:**
- Create: `server/src/services/k6-generator/window.ts`
- Test: `server/src/__tests__/k6-generator/window.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/window.test.ts
import { describe, expect, it } from 'vitest';
import { resolveSteadyWindow } from '../../services/k6-generator/window.js';
import type { LoadProfile } from '../../services/k6-generator/types.js';

describe('resolveSteadyWindow', () => {
  it('ramping-vus: steady spans the plateau between ramp-up end and ramp-down start', () => {
    const lp: LoadProfile = {
      protocol: 'http', executor: 'ramping-vus', startVUs: 0,
      stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }],
    };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840,
    });
  });

  it('constant-arrival-rate: warmup then steady then cooldown', () => {
    const lp: LoadProfile = {
      protocol: 'http', executor: 'constant-arrival-rate', rate: 1200, timeUnit: '1s', duration: '14m',
      evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' },
    };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 60, rampUpEndS: 60, steadyEndS: 780, totalDurationS: 840,
    });
  });

  it('constant-vus baseline: whole run is steady minus the front-edge warmup guard', () => {
    const lp: LoadProfile = { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m' };
    expect(resolveSteadyWindow(lp)).toEqual({
      warmupEndS: 30, rampUpEndS: 30, steadyEndS: 300, totalDurationS: 300,
    });
  });

  it('constant-vus honors an explicit warmupGuard', () => {
    const lp: LoadProfile = { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m', warmupGuard: '10s' };
    expect(resolveSteadyWindow(lp)).toMatchObject({ warmupEndS: 10, rampUpEndS: 10, steadyEndS: 300 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/window.test.ts`
Expected: FAIL — cannot import `resolveSteadyWindow`.

- [ ] **Step 3: Write the window resolver**

```typescript
// server/src/services/k6-generator/window.ts
import { parseDurationToSeconds, sumDurationsSeconds } from './duration.js';
import type { LoadProfile } from './types.js';

export type SteadyWindow = {
  warmupEndS: number;
  rampUpEndS: number;
  steadyEndS: number;
  totalDurationS: number;
};

const DEFAULT_BASELINE_WARMUP_GUARD = '30s';

export function resolveSteadyWindow(lp: LoadProfile): SteadyWindow {
  if (lp.executor === 'ramping-vus') {
    const peak = Math.max(...lp.stages.map((s) => s.target));
    let cum = 0;
    let rampUpEndS = 0;
    let steadyEndS = 0;
    let reachedPeak = false;
    for (const stage of lp.stages) {
      const dur = parseDurationToSeconds(stage.duration);
      const start = cum;
      cum += dur;
      if (!reachedPeak && stage.target >= peak) {
        rampUpEndS = cum;          // steady begins at the end of the stage that first reaches peak
        steadyEndS = cum;
        reachedPeak = true;
      } else if (reachedPeak && stage.target >= peak) {
        steadyEndS = cum;          // extend steady across additional plateau stages
      } else if (reachedPeak && stage.target < peak) {
        steadyEndS = start;        // ramp-down begins → steady ends at this stage's start
        break;
      }
    }
    return { warmupEndS: 0, rampUpEndS, steadyEndS, totalDurationS: cum };
  }

  if (lp.executor === 'constant-arrival-rate') {
    const warmup = parseDurationToSeconds(lp.evaluationWindow.warmup);
    const steady = parseDurationToSeconds(lp.evaluationWindow.steady);
    const total = parseDurationToSeconds(lp.duration);
    return { warmupEndS: warmup, rampUpEndS: warmup, steadyEndS: warmup + steady, totalDurationS: total };
  }

  // constant-vus baseline
  const guard = parseDurationToSeconds(lp.warmupGuard ?? DEFAULT_BASELINE_WARMUP_GUARD);
  const total = parseDurationToSeconds(lp.duration);
  return { warmupEndS: guard, rampUpEndS: guard, steadyEndS: total, totalDurationS: total };
}

export { sumDurationsSeconds };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/window.ts server/src/__tests__/k6-generator/window.test.ts
git commit -m "feat(server): resolveSteadyWindow derives baked phase boundaries per executor"
```

---

## Task 3: Scenario builder

**Files:**
- Create: `server/src/services/k6-generator/scenarios.ts`
- Test: `server/src/__tests__/k6-generator/scenarios.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/scenarios.test.ts
import { describe, expect, it } from 'vitest';
import { buildScenarios } from '../../services/k6-generator/scenarios.js';
import type { GenerateK6Input } from '../../services/k6-generator/types.js';

const wf = (name: string, weight: number): GenerateK6Input['workflows'][number] => ({
  name, weight, request: { method: 'GET', path: `/${name}` }, dataStrategy: 'reusable',
});

describe('buildScenarios', () => {
  it('Shape A (ramping-vus): one weighted-loop scenario running the router', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'ramping-vus', startVUs: 0,
        stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      [wf('search', 0.7), wf('detail', 0.3)],
      'weighted-loop',
      { p95EstimateMs: 500 },
    );
    expect(Object.keys(out.scenarios)).toEqual(['weighted_loop']);
    expect(out.scenarios.weighted_loop).toMatchObject({ executor: 'ramping-vus', exec: 'router', startVUs: 0 });
    expect(out.execModel).toBe('weighted-loop');
  });

  it('Shape B (constant-arrival-rate): one named scenario per workflow with derived VU allocation', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'constant-arrival-rate', rate: 1000, timeUnit: '1s', duration: '14m',
        evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' } },
      [wf('search', 0.8), wf('checkout', 0.2)],
      'per-scenario',
      { p95EstimateMs: 200 },
    );
    expect(Object.keys(out.scenarios).sort()).toEqual(['checkout', 'search']);
    // rate = weight * total rate
    expect(out.scenarios.search).toMatchObject({ executor: 'constant-arrival-rate', rate: 800, exec: 'search', tags: { workflow: 'search' } });
    expect(out.scenarios.checkout).toMatchObject({ rate: 200, exec: 'checkout', tags: { workflow: 'checkout' } });
    // Little's Law: preAllocatedVUs = ceil(rate * p95s); search: ceil(800 * 0.2) = 160; maxVUs = 4x
    expect(out.scenarios.search.preAllocatedVUs).toBe(160);
    expect(out.scenarios.search.maxVUs).toBe(640);
  });

  it('baseline (constant-vus): single-VU router scenario', () => {
    const out = buildScenarios(
      { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '5m' },
      [wf('search', 1)],
      'weighted-loop',
      { p95EstimateMs: 300 },
    );
    expect(out.scenarios.baseline).toMatchObject({ executor: 'constant-vus', vus: 1, exec: 'router', duration: '5m' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/scenarios.test.ts`
Expected: FAIL — cannot import `buildScenarios`.

- [ ] **Step 3: Write the scenario builder**

```typescript
// server/src/services/k6-generator/scenarios.ts
import type { LoadProfile, Workflow } from './types.js';

// k6 scenario objects are JSON-serializable; we model them loosely (k6 validates at runtime).
export type K6Scenario = Record<string, unknown>;
export type ScenarioPlan = {
  scenarios: Record<string, K6Scenario>;
  execFns: string[];                 // exec function names the script must define: ['router'] or per-workflow names
  execModel: 'weighted-loop' | 'per-scenario';
};
export type ScenarioOpts = { p95EstimateMs: number };

// JS identifier from a workflow name (k6 exec must be a valid exported function name).
export function execName(workflow: string): string {
  const cleaned = workflow.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned.length > 0 ? cleaned : 'wf';
}

export function buildScenarios(
  lp: LoadProfile,
  workflows: Workflow[],
  executionModel: 'weighted-loop' | 'per-scenario',
  opts: ScenarioOpts,
): ScenarioPlan {
  if (lp.executor === 'ramping-vus') {
    return {
      scenarios: {
        weighted_loop: {
          executor: 'ramping-vus',
          startVUs: lp.startVUs ?? 0,
          stages: lp.stages,
          gracefulRampDown: lp.gracefulRampDown ?? '30s',
          exec: 'router',
        },
      },
      execFns: ['router'],
      execModel: 'weighted-loop',
    };
  }

  if (lp.executor === 'constant-vus') {
    return {
      scenarios: {
        baseline: { executor: 'constant-vus', vus: lp.vus, duration: lp.duration, exec: 'router' },
      },
      execFns: ['router'],
      execModel: 'weighted-loop',
    };
  }

  // constant-arrival-rate → per-scenario, one named scenario per workflow.
  const p95s = Math.max(opts.p95EstimateMs / 1000, 0.001);
  const scenarios: Record<string, K6Scenario> = {};
  const execFns: string[] = [];
  for (const wf of workflows) {
    const rate = Math.max(1, Math.round(lp.rate * wf.weight));
    const preAllocatedVUs = lp.preAllocatedVUs ?? Math.max(1, Math.ceil(rate * p95s));
    const maxVUs = lp.maxVUs ?? preAllocatedVUs * 4;
    const fn = execName(wf.name);
    scenarios[wf.name] = {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: lp.timeUnit,
      duration: lp.duration,
      preAllocatedVUs,
      maxVUs,
      exec: fn,
      tags: { workflow: wf.name },
    };
    execFns.push(fn);
  }
  return { scenarios, execFns, execModel: 'per-scenario' };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/scenarios.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/scenarios.ts server/src/__tests__/k6-generator/scenarios.test.ts
git commit -m "feat(server): buildScenarios emits Shape A/B/baseline options.scenarios"
```

---

## Task 4: Threshold derivation (materialize the sub-metrics k6 must expose)

The generator declares one k6 threshold per latency/error sub-metric the SLA targets reference. The threshold's only structural job here is to make k6 **materialize that tagged sub-metric** in the end-of-test summary (a tagged selector appears in `data.metrics` only if a threshold is declared on it). The harness-side transform (Task 5) reads those sub-metrics back out.

**Files:**
- Create: `server/src/services/k6-generator/thresholds.ts`
- Test: `server/src/__tests__/k6-generator/thresholds.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/thresholds.test.ts
import { describe, expect, it } from 'vitest';
import { buildThresholds } from '../../services/k6-generator/thresholds.js';
import type { SlaTarget } from '@sentinel/db';

const t = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: o.source ?? 'k6', required: o.required ?? true,
  workflowScope: o.workflowScope, ...o,
});

describe('buildThresholds', () => {
  it('aggregate latency + error-rate (no workflowScope) → single keys', () => {
    expect(buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 500 }),
      t({ metric: 'error_rate', operator: 'lt', threshold: 0.01 }),
    ])).toEqual({
      'http_req_duration{expected_response:true,phase:steady}': ['p(95)<500'],
      'http_req_failed{phase:steady}': ['rate<0.01'],
    });
  });

  it('per-workflow latency: one key per workflow; multiple percentiles share a key; error-rate stays aggregate', () => {
    const out = buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 300, workflowScope: 'checkout' }),
      t({ metric: 'p99_ms', operator: 'lt', threshold: 600, workflowScope: 'checkout' }),
      t({ metric: 'p95_ms', operator: 'lt', threshold: 200, workflowScope: 'search' }),
      t({ metric: 'error_rate', operator: 'lt', threshold: 0.005 }), // aggregate, NOT per-workflow
    ]);
    expect(out['http_req_duration{workflow:checkout,phase:steady,expected_response:true}']).toEqual(['p(95)<300', 'p(99)<600']);
    expect(out['http_req_duration{workflow:search,phase:steady,expected_response:true}']).toEqual(['p(95)<200']);
    expect(out['http_req_failed{phase:steady}']).toEqual(['rate<0.005']);
  });

  it('ignores non-k6 targets and unknown metrics', () => {
    expect(buildThresholds([
      t({ metric: 'p95_ms', operator: 'lt', threshold: 500, source: 'apm:dynatrace' }),
      t({ metric: 'mystery', operator: 'lt', threshold: 1 }),
    ])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/thresholds.test.ts`
Expected: FAIL — cannot import `buildThresholds`.

- [ ] **Step 3: Write the threshold builder**

```typescript
// server/src/services/k6-generator/thresholds.ts
import type { SlaTarget } from '@sentinel/db';

const K6_OP: Record<SlaTarget['operator'], string> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

// SLA-vocab latency metric → the k6 Trend values stat key (only used to render the threshold expression).
const LATENCY_STAT: Record<string, string> = { p50_ms: 'med', p95_ms: 'p(95)', p99_ms: 'p(99)' };

function latencyKey(workflowScope?: string): string {
  return workflowScope
    ? `http_req_duration{workflow:${workflowScope},phase:steady,expected_response:true}`
    : 'http_req_duration{expected_response:true,phase:steady}';
}

// Declares one k6 threshold per sub-metric the SLA targets reference, so k6 MATERIALIZES that tagged
// sub-metric in the end-of-test summary (a tagged selector only appears in data.metrics if thresholded).
// The threshold expression also drives k6's own console pass/fail; Sentinel's authoritative verdict is
// computed server-side by slaVerdictEngine from the ingested value, NOT from k6's threshold result.
// The harness-side mapK6Summary (Task 5) reads these same sub-metrics back out by tag.
export function buildThresholds(targets: SlaTarget[]): Record<string, string[]> {
  const thresholds: Record<string, string[]> = {};
  const push = (key: string, expr: string) => { (thresholds[key] ??= []).push(expr); };

  for (const target of targets) {
    if (target.source !== 'k6') continue;

    const latencyStat = LATENCY_STAT[target.metric];
    if (latencyStat) {
      push(latencyKey(target.workflowScope), `${latencyStat}${K6_OP[target.operator]}${target.threshold}`);
      continue;
    }
    if (target.metric === 'error_rate') {
      // Error-rate target has no per-workflow scope in v1 → single aggregate key (never per-scenario).
      push('http_req_failed{phase:steady}', `rate${K6_OP[target.operator]}${target.threshold}`);
      continue;
    }
    // Unknown metric vocab → not realizable in v1 HTTP generation; skip (Discovery validates vocab upstream).
  }
  return thresholds;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/thresholds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/thresholds.ts server/src/__tests__/k6-generator/thresholds.test.ts
git commit -m "feat(server): buildThresholds materializes the k6 sub-metrics SLA targets reference"
```

---

## Task 5: `mapK6Summary` — the harness-side transform (raw k6 summary → metric_series rows)

`handleSummary` writes the **raw** k6 end-of-test summary (`JSON.stringify(data)`); the harness turns it into Sentinel ingestion rows. This transform is the most failure-prone seam, so it is a **typed, directly-tested TS function** (no in-script string eval). It walks `data.metrics`, finds the steady-phase tagged sub-metrics k6 materialized via the Task-4 thresholds, and emits one row per SLA-vocab metric — parsing `workflowName` from the `{workflow:…}` tag. Keeping it in the harness (not the script) is what makes the script harness-invariant (spec rule 4).

**Files:**
- Create: `server/src/services/k6-generator/summary-mapping.ts`
- Test: `server/src/__tests__/k6-generator/summary-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/summary-mapping.test.ts
import { describe, expect, it } from 'vitest';
import { mapK6Summary } from '../../services/k6-generator/summary-mapping.js';

// Representative RAW k6 handleSummary(data) shape, with summaryTrendStats including med/p(95)/p(99)/count.
const data = {
  metrics: {
    // base (untagged) metric — must be IGNORED for series (no '{...}' tag)
    http_req_duration: { type: 'trend', values: { avg: 200, med: 170, 'p(95)': 340, 'p(99)': 470, count: 3000 } },
    // per-workflow, success-filtered, steady latency sub-metric (materialized by a Task-4 threshold)
    'http_req_duration{workflow:checkout,phase:steady,expected_response:true}': {
      type: 'trend', values: { avg: 210, min: 90, med: 180, max: 900, 'p(90)': 320, 'p(95)': 350, 'p(99)': 480, count: 1200 },
    },
    // aggregate error rate, steady (no workflow tag)
    'http_req_failed{phase:steady}': { type: 'rate', values: { rate: 0.004, passes: 1195, fails: 5 } },
    vus_max: { type: 'gauge', values: { value: 500, max: 500 } },
    http_reqs: { type: 'counter', values: { count: 1500, rate: 17.8 } },
    iterations: { type: 'counter', values: { count: 1500, rate: 17.8 } },
  },
};

describe('mapK6Summary', () => {
  it('emits p50/p95/p99 rows from a steady success-filtered latency sub-metric, workflowName from the tag', () => {
    const { series } = mapK6Summary(data);
    expect(series).toContainEqual({ metric: 'p50_ms', workflowName: 'checkout', phase: 'steady', value: 180, sampleCount: 1200 });
    expect(series).toContainEqual({ metric: 'p95_ms', workflowName: 'checkout', phase: 'steady', value: 350, sampleCount: 1200 });
    expect(series).toContainEqual({ metric: 'p99_ms', workflowName: 'checkout', phase: 'steady', value: 480, sampleCount: 1200 });
  });

  it('emits an aggregate error_rate row (workflowName null) with sampleCount = passes+fails', () => {
    const { series } = mapK6Summary(data);
    expect(series).toContainEqual({ metric: 'error_rate', workflowName: null, phase: 'steady', value: 0.004, sampleCount: 1200 });
  });

  it('ignores untagged base metrics and non-steady sub-metrics', () => {
    const { series } = mapK6Summary({
      metrics: {
        http_req_duration: { type: 'trend', values: { 'p(95)': 999, count: 10 } },
        'http_req_duration{workflow:x,phase:ramp_up,expected_response:true}': { type: 'trend', values: { 'p(95)': 999, count: 10 } },
      },
    });
    expect(series).toEqual([]);
  });

  it('extracts peakVus / totalRequests / totalIterations for the execution_runs row', () => {
    expect(mapK6Summary(data).run).toEqual({ peakVus: 500, totalRequests: 1500, totalIterations: 1500 });
  });

  it('tolerates a missing metrics object', () => {
    expect(mapK6Summary({})).toEqual({ series: [], run: { peakVus: null, totalRequests: null, totalIterations: null } });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/summary-mapping.test.ts`
Expected: FAIL — cannot import `mapK6Summary`.

- [ ] **Step 3: Write the transform**

```typescript
// server/src/services/k6-generator/summary-mapping.ts
// Harness-side transform: RAW k6 end-of-test summary (data) -> Sentinel metric_series rows.
// The windowed percentiles are computed IN-RUNNER by k6 over the {workflow,phase}-tagged threshold
// sub-metrics (Task 4); this only re-keys them to the SLA vocabulary — it does NOT recompute anything.

export type K6MetricValues = Record<string, number>;
export type K6RawSummary = { metrics?: Record<string, { type?: string; values?: K6MetricValues }> };

export type MappedSeriesEntry = {
  metric: string;
  workflowName: string | null;
  phase: 'steady';
  value: number;
  sampleCount: number | null;
};
export type MappedSummary = {
  series: MappedSeriesEntry[];
  run: { peakVus: number | null; totalRequests: number | null; totalIterations: number | null };
};

// SLA-vocab latency metric → the k6 Trend values stat key.
const LATENCY_STATS: Array<{ metric: string; stat: string }> = [
  { metric: 'p50_ms', stat: 'med' },
  { metric: 'p95_ms', stat: 'p(95)' },
  { metric: 'p99_ms', stat: 'p(99)' },
];

// Parse a tagged sub-metric key like 'http_req_duration{workflow:checkout,phase:steady,expected_response:true}'.
function parseTags(key: string): { base: string; tags: Record<string, string> } | null {
  const m = /^([^{]+)\{(.*)\}$/.exec(key);
  if (!m) return null; // untagged base metric (no braces) → not a sub-metric we ingest
  const tags: Record<string, string> = {};
  for (const pair of m[2]!.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    tags[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return { base: m[1]!.trim(), tags };
}

export function mapK6Summary(data: K6RawSummary): MappedSummary {
  const metrics = data.metrics ?? {};
  const series: MappedSeriesEntry[] = [];

  for (const [key, m] of Object.entries(metrics)) {
    const parsed = parseTags(key);
    if (!parsed || !m?.values) continue;
    const { base, tags } = parsed;
    if (tags.phase !== 'steady') continue; // only the authoritative window is ingested for verdicts
    const workflowName = tags.workflow ?? null;

    if (base === 'http_req_duration' && tags.expected_response === 'true') {
      const count = typeof m.values.count === 'number' ? m.values.count : null;
      for (const { metric, stat } of LATENCY_STATS) {
        const value = m.values[stat];
        if (typeof value === 'number') series.push({ metric, workflowName, phase: 'steady', value, sampleCount: count });
      }
    } else if (base === 'http_req_failed') {
      const value = m.values.rate;
      if (typeof value === 'number') {
        // NOTE: k6 reverses the passes/fails semantics on http_req_failed; we only SUM them for
        // sampleCount, so the swap is irrelevant. Never read passes/fails individually for a verdict.
        const passes = typeof m.values.passes === 'number' ? m.values.passes : 0;
        const fails = typeof m.values.fails === 'number' ? m.values.fails : 0;
        const sampleCount = passes + fails > 0 ? passes + fails : null;
        series.push({ metric: 'error_rate', workflowName, phase: 'steady', value, sampleCount });
      }
    }
  }

  const num = (k: string, f: string): number | null => {
    const v = metrics[k]?.values?.[f];
    return typeof v === 'number' ? v : null;
  };
  return {
    series,
    run: {
      peakVus: num('vus_max', 'max') ?? num('vus_max', 'value'),
      totalRequests: num('http_reqs', 'count'),
      totalIterations: num('iterations', 'count'),
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/summary-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/summary-mapping.ts server/src/__tests__/k6-generator/summary-mapping.test.ts
git commit -m "feat(server): mapK6Summary transforms raw k6 summary into metric_series rows"
```

---

## Task 6: Fixed template fragments

**Files:**
- Create: `server/src/services/k6-generator/template.ts`
- Test: `server/src/__tests__/k6-generator/template.test.ts`

The verbatim, non-varying parts of the script (imports, `phaseFor`, `params`, `claimConsumable`, and the portable `handleSummary`). Pure string constants/functions; the test asserts the load-bearing pieces. **`handleSummary` writes only the native HTML report, the RAW k6 summary JSON, and stdout** — the metric→row transform lives in the harness (`mapK6Summary`, Task 5), not the script.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/template.test.ts
import { describe, expect, it } from 'vitest';
import { K6_IMPORTS, fixedHelpers, handleSummarySource } from '../../services/k6-generator/template.js';

describe('template fragments', () => {
  it('imports the http/exec/data modules and the reporter libs', () => {
    expect(K6_IMPORTS).toContain('import http from "k6/http"');
    expect(K6_IMPORTS).toContain('import exec from "k6/execution"');
    expect(K6_IMPORTS).toContain('k6-reporter');
    expect(K6_IMPORTS).toContain('k6-summary');
  });

  it('phaseFor is 4-branch, converts ms→s, and params stamps {workflow,phase}', () => {
    const h = fixedHelpers();
    expect(h).toContain('function phaseFor(t)');
    expect(h).toContain('var ts = t / 1000');           // k6 currentTestRunDuration is MILLISECONDS
    expect(h).toContain('return "warmup"');
    expect(h).toContain('return "steady"');
    expect(h).toContain('tags: { workflow: workflow, phase: phase }');
    expect(h).toContain('function claimConsumable()');
    expect(h).toContain('exec.scenario.iterationInTest'); // NOT exec.vu.idInTest
    expect(h).not.toContain('exec.vu.idInTest');
  });

  it('handleSummary writes the html report, the RAW k6 summary json, and stdout — no Sentinel payload', () => {
    const src = handleSummarySource();
    expect(src).toContain('export function handleSummary(data)');
    expect(src).toContain('"summary-" + TEST_RUN_ID + ".html"');
    expect(src).toContain('"summary-" + TEST_RUN_ID + ".json"');
    expect(src).toContain('JSON.stringify(data)');       // raw k6 summary, not a shaped ingestion payload
    expect(src).toContain('htmlReport(data)');
    expect(src).toContain('textSummary(data');
    expect(src).not.toContain('buildIngestionSeries');   // the transform lives in the harness (Task 5)
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/template.test.ts`
Expected: FAIL — cannot import `K6_IMPORTS`.

- [ ] **Step 3: Write the template fragments**

```typescript
// server/src/services/k6-generator/template.ts

export const K6_IMPORTS = [
  'import http from "k6/http";',
  'import exec from "k6/execution";',
  'import { SharedArray } from "k6/data";',
  'import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";',
  'import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";',
].join('\n');

// phaseFor + params + claimConsumable. Window boundaries (WARMUP_END_S/RAMP_UP_END_S/STEADY_END_S),
// reusable/consumable SharedArrays, AUTH_TOKEN and BASE are defined by render-script.ts above this block.
export function fixedHelpers(): string {
  return `
function phaseFor(t) {                 // t = exec.instance.currentTestRunDuration (MILLISECONDS)
  var ts = t / 1000;                   // boundaries are in seconds — k6 returns ms, so convert first
  if (ts < WARMUP_END_S)  return "warmup";
  if (ts < RAMP_UP_END_S) return "ramp_up";
  if (ts < STEADY_END_S)  return "steady";  // only steady samples are authoritative
  return "ramp_down";
}

function params(workflow) {
  var phase = phaseFor(exec.instance.currentTestRunDuration);
  return {
    tags: { workflow: workflow, phase: phase },
    headers: AUTH_TOKEN ? { Authorization: "Bearer " + AUTH_TOKEN } : {},
  };
}

function claimConsumable() {
  var i = exec.scenario.iterationInTest;   // monotonic per scenario, both executor families
  if (i >= consumable.length) {
    exec.test.abort("consumable exhausted at iteration " + i + " (need >= rate*duration)");
  }
  return consumable[i];                    // disjoint: no two iterations share i; modulo-wrap FORBIDDEN
}`;
}

// handleSummary is PORTABLE and executor-agnostic (spec Stage 5, rule 4): the native HTML report + the
// RAW k6 end-of-test summary (JSON.stringify(data)) + stdout. It does NOT shape a Sentinel ingestion
// payload — the harness's mapK6Summary (Task 5) transforms the raw summary into metric_series rows.
export function handleSummarySource(): string {
  return `
export function handleSummary(data) {
  var out = {};
  out["summary-" + TEST_RUN_ID + ".html"] = htmlReport(data);
  out["summary-" + TEST_RUN_ID + ".json"] = JSON.stringify(data);   // RAW k6 summary — transformed by the harness
  out["stdout"] = textSummary(data, { indent: " ", enableColors: true });
  return out;
}`;
}
```

> Note: the template uses string-concat (`"summary-" + TEST_RUN_ID + ".html"`) rather than JS template literals so the assembled script never collides with the template literals `render-script.ts` uses to build it. The test asserts the concat form, matching the source exactly.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/template.ts server/src/__tests__/k6-generator/template.test.ts
git commit -m "feat(server): portable k6 template fragments (phaseFor ms→s, raw-summary handleSummary)"
```

---

## Task 7: Script renderer

**Files:**
- Create: `server/src/services/k6-generator/render-script.ts`
- Test: `server/src/__tests__/k6-generator/render-script.test.ts`

Assembles the full script string and validates it is syntactically parseable via `node --check`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/render-script.test.ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleScript } from '../../services/k6-generator/render-script.js';

const baseParts = {
  window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720, totalDurationS: 840 },
  scenarios: { weighted_loop: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }], gracefulRampDown: '30s', exec: 'router' } },
  thresholds: { 'http_req_duration{expected_response:true,phase:steady}': ['p(95)<500'], 'http_req_failed{phase:steady}': ['rate<0.01'] },
  execModel: 'weighted-loop' as const,
  execFnsSource: 'export function router() { http.get(BASE + "/search", params("search")); }',
  hasReusable: true,
  hasConsumable: false,
};

describe('assembleScript', () => {
  it('bakes window defaults, options, summaryTrendStats and the exec fns', () => {
    const src = assembleScript(baseParts);
    expect(src).toContain('var WARMUP_END_S = Number(__ENV.WARMUP_END_S || 0);');
    expect(src).toContain('var RAMP_UP_END_S = Number(__ENV.RAMP_UP_END_S || 120);');
    expect(src).toContain('var STEADY_END_S = Number(__ENV.STEADY_END_S || 720);');
    expect(src).toContain('"summaryTrendStats"');
    expect(src).toContain('p(99)');
    expect(src).toContain('export const options =');
    expect(src).toContain('export function router()');
    expect(src).toContain('export function handleSummary(data)');
    expect(src).toContain('JSON.stringify(data)'); // handleSummary writes the raw k6 summary
  });

  it('produces a syntactically valid ES module (node --check)', () => {
    const src = assembleScript(baseParts);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k6gen-')), 'script.mjs');
    fs.writeFileSync(file, src);
    // node --check parses syntax only; remote imports are not fetched.
    expect(() => execFileSync('node', ['--check', file])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/render-script.test.ts`
Expected: FAIL — cannot import `assembleScript`.

- [ ] **Step 3: Write the renderer**

```typescript
// server/src/services/k6-generator/render-script.ts
import { K6_IMPORTS, fixedHelpers, handleSummarySource } from './template.js';
import type { SteadyWindow } from './window.js';
import type { K6Scenario } from './scenarios.js';

export type AssembleParts = {
  window: SteadyWindow;
  scenarios: Record<string, K6Scenario>;
  thresholds: Record<string, string[]>;
  execModel: 'weighted-loop' | 'per-scenario';
  execFnsSource: string;     // the exported exec function(s): router() or per-workflow fns
  hasReusable: boolean;
  hasConsumable: boolean;
};

const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'];

export function assembleScript(p: AssembleParts): string {
  const options = {
    scenarios: p.scenarios,
    thresholds: p.thresholds,
    summaryTrendStats: SUMMARY_TREND_STATS,
  };

  const dataDecls: string[] = [];
  if (p.hasReusable) dataDecls.push('var reusable = new SharedArray("reusable", function () { return JSON.parse(open("./reusable.json")); });');
  if (p.hasConsumable) dataDecls.push('var consumable = new SharedArray("consumable", function () { return JSON.parse(open("./consumable.json")); });');

  return [
    '// GENERATED by Sentinel k6-generator (v1 HTTP/sync, scratch). Do not hand-edit; regenerate.',
    K6_IMPORTS,
    '',
    '// --- Environment (injected per-run by the harness) ---',
    'var BASE = __ENV.BASE_URL;',
    'var TEST_RUN_ID = __ENV.TEST_RUN_ID;',
    'var AUTH_TOKEN = __ENV.AUTH_TOKEN || "";',
    '',
    '// --- Baked steady-state window boundaries (overridable via env; seconds) ---',
    `var WARMUP_END_S = Number(__ENV.WARMUP_END_S || ${p.window.warmupEndS});`,
    `var RAMP_UP_END_S = Number(__ENV.RAMP_UP_END_S || ${p.window.rampUpEndS});`,
    `var STEADY_END_S = Number(__ENV.STEADY_END_S || ${p.window.steadyEndS});`,
    '',
    ...(dataDecls.length ? ['// --- Data ---', ...dataDecls, ''] : []),
    fixedHelpers(),
    '',
    `export const options = ${JSON.stringify(options, null, 2)};`,
    '',
    'export function setup() {',
    '  // Consumable volume is verified at generation time (expectedIterations); claimConsumable aborts on shortfall.',
    '  return { runId: TEST_RUN_ID };',
    '}',
    'export function teardown() {}',
    '',
    '// --- Exec functions ---',
    p.execFnsSource,
    '',
    handleSummarySource(),
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/render-script.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/render-script.ts server/src/__tests__/k6-generator/render-script.test.ts
git commit -m "feat(server): assembleScript renders a syntactically-valid k6 ES module"
```

---

## Task 8: Data-file builder

**Files:**
- Create: `server/src/services/k6-generator/data-files.ts`
- Test: `server/src/__tests__/k6-generator/data-files.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/data-files.test.ts
import { describe, expect, it } from 'vitest';
import { buildDataFiles } from '../../services/k6-generator/data-files.js';
import type { Workflow } from '../../services/k6-generator/types.js';

const wf = (name: string, dataStrategy: Workflow['dataStrategy']): Workflow => ({
  name, weight: 1, request: { method: 'GET', path: `/${name}` }, dataStrategy,
});

describe('buildDataFiles', () => {
  it('emits reusable.json when any workflow uses reusable data', () => {
    const out = buildDataFiles([wf('search', 'reusable')], { reusable: [{ term: 'a' }, { term: 'b' }] });
    expect(out.dataFiles).toEqual([{ name: 'reusable.json', content: JSON.stringify([{ term: 'a' }, { term: 'b' }]), type: 'json', strategy: 'reusable' }]);
    expect(out.hasReusable).toBe(true);
    expect(out.hasConsumable).toBe(false);
  });

  it('emits consumable.json and reports record count for the volume check', () => {
    const out = buildDataFiles([wf('checkout', 'consumable')], { consumable: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(out.hasConsumable).toBe(true);
    expect(out.consumableCount).toBe(3);
    expect(out.dataFiles.find((f) => f.name === 'consumable.json')?.strategy).toBe('consumable');
  });

  it('defaults to an empty reusable file when reusable is required but no records supplied', () => {
    const out = buildDataFiles([wf('search', 'reusable')], {});
    expect(out.dataFiles.find((f) => f.name === 'reusable.json')?.content).toBe('[]');
  });

  it('emits no data files when all workflows use dataStrategy none', () => {
    const out = buildDataFiles([wf('ping', 'none')], {});
    expect(out.dataFiles).toEqual([]);
    expect(out.hasReusable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/data-files.test.ts`
Expected: FAIL — cannot import `buildDataFiles`.

- [ ] **Step 3: Write the data-file builder**

```typescript
// server/src/services/k6-generator/data-files.ts
import type { GeneratedDataFile, Workflow } from './types.js';

export type DataFilePlan = {
  dataFiles: GeneratedDataFile[];
  hasReusable: boolean;
  hasConsumable: boolean;
  consumableCount: number;
};

export function buildDataFiles(
  workflows: Workflow[],
  data: { reusable?: unknown[]; consumable?: unknown[] } = {},
): DataFilePlan {
  const hasReusable = workflows.some((w) => w.dataStrategy === 'reusable' || w.dataStrategy === 'mixed' as never);
  const hasConsumable = workflows.some((w) => w.dataStrategy === 'consumable' || w.dataStrategy === 'mixed' as never);

  const dataFiles: GeneratedDataFile[] = [];
  if (hasReusable) {
    dataFiles.push({ name: 'reusable.json', content: JSON.stringify(data.reusable ?? []), type: 'json', strategy: 'reusable' });
  }
  const consumable = data.consumable ?? [];
  if (hasConsumable) {
    dataFiles.push({ name: 'consumable.json', content: JSON.stringify(consumable), type: 'json', strategy: 'consumable' });
  }

  return { dataFiles, hasReusable, hasConsumable, consumableCount: hasConsumable ? consumable.length : 0 };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/data-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/data-files.ts server/src/__tests__/k6-generator/data-files.test.ts
git commit -m "feat(server): buildDataFiles emits reusable/consumable data files"
```

---

## Task 9: `generateK6Script` orchestrator

**Files:**
- Create: `server/src/services/k6-generator/generate.ts`
- Test: `server/src/__tests__/k6-generator/generate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generator/generate.test.ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateK6Script } from '../../services/k6-generator/generate.js';
import { UnsupportedProtocolError } from '../../services/k6-generator/types.js';
import type { GenerateK6Input } from '../../services/k6-generator/types.js';
import type { SlaTarget } from '@sentinel/db';

const sla = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: o.source ?? 'k6', required: o.required ?? true, workflowScope: o.workflowScope, ...o,
});

function nodeChecks(src: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k6gen-')), 'script.mjs');
  fs.writeFileSync(file, src);
  execFileSync('node', ['--check', file]); // throws if syntax invalid
}

describe('generateK6Script', () => {
  it('Shape A — weighted-loop aggregate: one router, aggregate thresholds, valid module', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [
        { name: 'product-search', weight: 0.7, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' },
        { name: 'product-detail', weight: 0.3, request: { method: 'GET', path: '/products', queryFromData: 'id' }, dataStrategy: 'reusable' },
      ],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.01 })],
      data: { reusable: [{ term: 'x', id: '1' }] },
    };
    const asset = generateK6Script(input);
    expect(asset).toMatchObject({ engine: 'k6', protocol: 'http', assetType: 'generated', generatedFrom: 'scratch', binaryProfile: 'k6' });
    expect(asset.dataFiles.map((f) => f.name)).toEqual(['reusable.json']);
    expect(asset.scriptContent).toContain('export function router()');
    expect(asset.scriptContent).toContain('http_req_duration{expected_response:true,phase:steady}'); // threshold materializes the sub-metric
    expect(asset.scriptContent).toContain('export function handleSummary(data)');
    nodeChecks(asset.scriptContent);
  });

  it('Shape B — per-scenario: one exec fn + threshold per workflow', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-arrival-rate', rate: 1000, timeUnit: '1s', duration: '14m', evaluationWindow: { warmup: '1m', steady: '12m', cooldown: '1m' } },
      executionModel: 'per-scenario',
      workflows: [
        { name: 'search', weight: 0.8, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' },
        { name: 'checkout', weight: 0.2, request: { method: 'POST', path: '/checkout', bodyFromData: true }, dataStrategy: 'consumable' },
      ],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 200, workflowScope: 'search' }), sla({ metric: 'p95_ms', operator: 'lt', threshold: 300, workflowScope: 'checkout' }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.005 })],
      data: { reusable: [{ term: 'x' }], consumable: [{ sku: 'a' }, { sku: 'b' }] },
    };
    const asset = generateK6Script(input);
    expect(asset.scriptContent).toContain('export function search()');
    expect(asset.scriptContent).toContain('export function checkout()');
    expect(asset.scriptContent).toContain('claimConsumable()');
    expect(asset.scriptContent).toContain('http_req_duration{workflow:search,phase:steady,expected_response:true}');
    expect(asset.dataFiles.map((f) => f.name).sort()).toEqual(['consumable.json', 'reusable.json']);
    nodeChecks(asset.scriptContent);
  });

  it('baseline — constant-vus: single-VU router, whole run steady', () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/health' }, dataStrategy: 'none' }],
      slaTargets: [sla({ metric: 'p95_ms', operator: 'lt', threshold: 100 })],
    };
    const asset = generateK6Script(input);
    expect(asset.scriptContent).toContain('"executor": "constant-vus"');
    expect(asset.dataFiles).toEqual([]);
    nodeChecks(asset.scriptContent);
  });

  it('throws UnsupportedProtocolError for non-http protocols', () => {
    const input = {
      loadProfile: { protocol: 'kafka', producerRate: 100, duration: '5m' } as never,
      executionModel: 'per-scenario', workflows: [], slaTargets: [],
    } as unknown as GenerateK6Input;
    expect(() => generateK6Script(input)).toThrow(UnsupportedProtocolError);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/generate.test.ts`
Expected: FAIL — cannot import `generateK6Script`.

- [ ] **Step 3: Write the orchestrator**

```typescript
// server/src/services/k6-generator/generate.ts
import { resolveSteadyWindow } from './window.js';
import { buildScenarios, execName } from './scenarios.js';
import { buildThresholds } from './thresholds.js';
import { buildDataFiles } from './data-files.js';
import { assembleScript } from './render-script.js';
import { UnsupportedProtocolError, type GenerateK6Input, type GeneratedK6Asset, type Workflow } from './types.js';

const SUPPORTED_EXECUTORS = new Set(['ramping-vus', 'constant-arrival-rate', 'constant-vus']);

// Estimate the p95 latency (ms) used for arrival-rate VU allocation: the lowest p95 SLA ceiling if present, else 500.
function p95EstimateMs(input: GenerateK6Input): number {
  const p95s = input.slaTargets.filter((t) => t.source === 'k6' && t.metric === 'p95_ms').map((t) => t.threshold);
  return p95s.length ? Math.min(...p95s) : 500;
}

function requestSource(wf: Workflow): string {
  const url = wf.request.queryFromData
    ? `BASE + ${JSON.stringify(wf.request.path)} + "?${wf.request.queryFromData}=" + encodeURIComponent(String(rec.${wf.request.queryFromData}))`
    : `BASE + ${JSON.stringify(wf.request.path)}`;
  const tag = JSON.stringify(wf.name);
  if (wf.request.method === 'GET' || wf.request.method === 'DELETE') {
    const method = wf.request.method.toLowerCase();
    return `http.${method}(${url}, params(${tag}));`;
  }
  const method = wf.request.method.toLowerCase();
  const body = wf.request.bodyFromData ? 'JSON.stringify(claimConsumable())' : '"{}"';
  return `http.${method}(${url}, ${body}, params(${tag}));`;
}

// Picks a reusable record for a workflow body; only emitted when the workflow reads reusable data.
function recordPick(wf: Workflow): string {
  if (wf.dataStrategy === 'reusable') return '  var rec = reusable[Math.floor(Math.random() * reusable.length)];\n';
  return '';
}

function buildWeightedRouter(workflows: Workflow[]): string {
  // Cumulative-weight selection over Math.random(); {workflow} stamped per-request inside the chosen branch.
  const anyReusable = workflows.some((w) => w.dataStrategy === 'reusable');
  const lines: string[] = ['export function router() {'];
  if (anyReusable) lines.push('  var rec = reusable.length ? reusable[Math.floor(Math.random() * reusable.length)] : {};');
  lines.push('  var r = Math.random();');
  let acc = 0;
  workflows.forEach((wf, i) => {
    acc += wf.weight;
    const cond = i === workflows.length - 1 ? 'else {' : `${i === 0 ? 'if' : 'else if'} (r < ${acc.toFixed(6)}) {`;
    lines.push(`  ${cond}`);
    lines.push(`    ${requestSource(wf)}`);
    lines.push('  }');
  });
  lines.push('}');
  return lines.join('\n');
}

function buildPerScenarioFns(workflows: Workflow[]): string {
  return workflows.map((wf) => {
    const body: string[] = [`export function ${execName(wf.name)}() {`];
    if (wf.dataStrategy === 'reusable') body.push('  var rec = reusable[exec.scenario.iterationInTest % reusable.length];');
    body.push(`  ${requestSource(wf)}`);
    body.push('}');
    return body.join('\n');
  }).join('\n\n');
}

export function generateK6Script(input: GenerateK6Input): GeneratedK6Asset {
  const lp = input.loadProfile;
  if ((lp as { protocol?: string }).protocol !== 'http' || !SUPPORTED_EXECUTORS.has((lp as { executor?: string }).executor ?? '')) {
    throw new UnsupportedProtocolError(`${(lp as { protocol?: string }).protocol}/${(lp as { executor?: string }).executor}`);
  }

  const window = resolveSteadyWindow(lp);
  const scenarioPlan = buildScenarios(lp, input.workflows, input.executionModel, { p95EstimateMs: p95EstimateMs(input) });
  const thresholds = buildThresholds(input.slaTargets);
  const dataPlan = buildDataFiles(input.workflows, input.data);

  const execFnsSource = scenarioPlan.execModel === 'per-scenario'
    ? buildPerScenarioFns(input.workflows)
    : buildWeightedRouter(input.workflows);

  const scriptContent = assembleScript({
    window,
    scenarios: scenarioPlan.scenarios,
    thresholds,
    execModel: scenarioPlan.execModel,
    execFnsSource,
    hasReusable: dataPlan.hasReusable,
    hasConsumable: dataPlan.hasConsumable,
  });

  return {
    engine: 'k6',
    protocol: 'http',
    binaryProfile: 'k6',
    assetType: 'generated',
    generatedFrom: 'scratch',
    scriptContent,
    dataFiles: dataPlan.dataFiles,
    setupScript: null,
  };
}
```

> The `recordPick` helper is intentionally unused once `buildWeightedRouter`/`buildPerScenarioFns` inline the record selection — delete it if your build's linter flags unused exports, or keep it private. (It exists to make the record-selection rule explicit.) Prefer deleting it before commit to satisfy the no-dead-code rule.

- [ ] **Step 4: Run the test, verify it passes** (remove the unused `recordPick` if the linter complains)

Run: `pnpm exec vitest run server/src/__tests__/k6-generator/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-generator/generate.ts server/src/__tests__/k6-generator/generate.test.ts
git commit -m "feat(server): generateK6Script renders complete v1 HTTP/sync k6 assets"
```

---

## Task 10: Persist generated assets (extend `testAssetService.create`)

`testAssetService.create` currently inserts only a subset of columns, dropping `dataFiles`, `setupScript`, `teardownScript`, `generatedFrom`, and `protocol`. Extend it so a generated asset round-trips.

**Files:**
- Modify: `server/src/services/test-assets.ts`
- Test: `server/src/__tests__/test-assets-generated.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/test-assets-generated.test.ts
import { describe, expect, it } from 'vitest';
import { testAssets, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { testAssetService } from '../services/test-assets.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

d('testAssetService.create (generated asset fields)', () => {
  const ctx = withPipelineSchema([testAssets, testPlans]);

  it('persists scriptContent, dataFiles, setupScript, generatedFrom, protocol for a generated asset', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const svc = testAssetService(ctx.db);
    const row = await svc.create(ctx.companyId, {
      testPlanId: plan!.id,
      engine: 'k6',
      assetType: 'generated',
      protocol: 'http',
      generatedFrom: 'scratch',
      scriptContent: 'export default function () {}',
      dataFiles: [{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }],
      setupScript: null,
    });
    const [persisted] = await ctx.db.select().from(testAssets).where(eq(testAssets.id, row.id));
    expect(persisted?.assetType).toBe('generated');
    expect(persisted?.protocol).toBe('http');
    expect(persisted?.generatedFrom).toBe('scratch');
    expect(persisted?.scriptContent).toBe('export default function () {}');
    expect(persisted?.dataFiles).toEqual([{ name: 'reusable.json', content: '[]', type: 'json', strategy: 'reusable' }]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/test-assets-generated.test.ts`
Expected: FAIL — `dataFiles`/`generatedFrom`/`protocol` are not persisted (assertions return null).

- [ ] **Step 3: Extend the service** (`server/src/services/test-assets.ts`)

Replace the `AssetType` and `CreateTestAssetInput` types and the `create` body:

```typescript
export type AssetType = "human_authored" | "generated" | "approved_generated";
export type DataFile = { name: string; content: string; type: string; strategy: string };

export type CreateTestAssetInput = {
  testPlanId: string;
  name?: string;
  engine: Engine;
  scriptContent?: string;
  scriptPath?: string;
  assetType?: AssetType;
  protocol?: string;
  generatedFrom?: string;
  dataFiles?: DataFile[];
  setupScript?: string | null;
  teardownScript?: string | null;
};
```

In `create`, expand the `.values({...})` to include the new columns:

```typescript
      const [row] = await db
        .insert(testAssets)
        .values({
          companyId,
          testPlanId: data.testPlanId,
          name: data.name ?? `${data.engine}-script`,
          engine: data.engine,
          scriptContent: data.scriptContent ?? null,
          scriptPath: data.scriptPath ?? null,
          assetType: data.assetType ?? "human_authored",
          protocol: data.protocol ?? null,
          generatedFrom: data.generatedFrom ?? null,
          dataFiles: data.dataFiles ?? null,
          setupScript: data.setupScript ?? null,
          teardownScript: data.teardownScript ?? null,
          version,
        })
        .returning();
      return row!;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/test-assets-generated.test.ts`
Expected: PASS. Also re-run the existing asset tests to confirm no regression: `pnpm exec vitest run server/src/__tests__/test-assets.test.ts` (if present).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/test-assets.ts server/src/__tests__/test-assets-generated.test.ts
git commit -m "feat(server): persist generated-asset columns (dataFiles/protocol/generatedFrom/setup)"
```

---

## Task 11: Real `execFile`-based SpawnFn

**Files:**
- Create: `server/src/services/test-adapters/spawn.ts`
- Test: `server/src/__tests__/spawn.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/spawn.test.ts
import { describe, expect, it } from 'vitest';
import { createExecFileSpawn } from '../services/test-adapters/spawn.js';

describe('createExecFileSpawn', () => {
  const spawn = createExecFileSpawn();

  it('captures stdout and a zero exit code on success', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stdout.write("hello")'], { env: {} });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello');
  });

  it('captures a non-zero exit code and stderr without throwing', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(7)'], { env: {} });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toContain('boom');
  });

  it('passes env vars through to the child', async () => {
    const res = await spawn(process.execPath, ['-e', 'process.stdout.write(process.env.FOO || "")'], { env: { FOO: 'bar' } });
    expect(res.stdout).toBe('bar');
  });

  it('rethrows ENOENT for a missing binary', async () => {
    await expect(spawn('definitely-not-a-real-binary-xyz', [], { env: {} })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/spawn.test.ts`
Expected: FAIL — cannot import `createExecFileSpawn`.

- [ ] **Step 3: Write the real spawn**

```typescript
// server/src/services/test-adapters/spawn.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SpawnFn, SpawnResult } from "./k6-adapter.js";

const execFileAsync = promisify(execFile);

// A real SpawnFn backed by node:child_process.execFile. Captures stdout/stderr/exitCode and does NOT
// throw on a non-zero exit (k6 exits non-zero when thresholds breach — that is a result, not an error).
// ENOENT (binary missing) is rethrown so runK6 can translate it into a clear message.
export function createExecFileSpawn(opts: { maxBuffer?: number } = {}): SpawnFn {
  const maxBuffer = opts.maxBuffer ?? 128 * 1024 * 1024; // k6 stdout can be large
  return async (cmd, args, runOpts): Promise<SpawnResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        env: runOpts.env,
        cwd: runOpts.cwd,
        maxBuffer,
      });
      return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
      if (e.code === "ENOENT") throw err;
      if (typeof e.code === "number") {
        return { exitCode: e.code, stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? "").toString() };
      }
      throw err;
    }
  };
}
```

> This imports `SpawnFn`/`SpawnResult` from `k6-adapter.js`; Task 12 adds `cwd` to the `SpawnFn` opts. If you implement Task 12 first, this compiles cleanly. If you implement this first, temporarily widen the `runOpts` param to `{ env: Record<string,string>; cwd?: string }` inline — Task 12 makes it canonical.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/test-adapters/spawn.ts server/src/__tests__/spawn.test.ts
git commit -m "feat(server): real execFile-based SpawnFn for k6 execution"
```

---

## Task 12: Rework `runK6` + add `readK6Summary`

**Files:**
- Modify: `server/src/services/test-adapters/k6-adapter.ts`
- Modify (rewrite): `server/src/__tests__/k6-adapter.test.ts`

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `server/src/__tests__/k6-adapter.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type SpawnResult, runK6, readK6Summary } from '../services/test-adapters/k6-adapter.js';

describe('runK6', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs `k6 run <script>` in the cwd with no --vus/--stage flags', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies SpawnResult);
    await runK6({
      scriptPath: 'script.js', cwd: '/work/run-1', testRunId: 'tr-1',
      baseUrl: 'http://localhost:3000', window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720 }, spawnFn,
    });
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe('k6');
    expect(args).toEqual(['run', 'script.js']);
    expect(args).not.toContain('--vus');
    expect(args).not.toContain('--stage');
    expect(opts.cwd).toBe('/work/run-1');
    expect(opts.env).toMatchObject({ BASE_URL: 'http://localhost:3000', TEST_RUN_ID: 'tr-1', RAMP_UP_END_S: '120', STEADY_END_S: '720' });
  });

  it('injects EXECUTION_RUN_ID and AUTH_TOKEN when provided', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } satisfies SpawnResult);
    await runK6({
      scriptPath: 's.js', cwd: '/w', testRunId: 'tr', executionRunId: 'er-9', authToken: 'tok',
      baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn,
    });
    const [, , opts] = spawnFn.mock.calls[0]!;
    expect(opts.env).toMatchObject({ EXECUTION_RUN_ID: 'er-9', AUTH_TOKEN: 'tok' });
  });

  it('marks failed=true on a non-zero exit (threshold breach)', async () => {
    const spawnFn = vi.fn().mockResolvedValue({ exitCode: 99, stdout: '', stderr: 'thresholds failed' } satisfies SpawnResult);
    const res = await runK6({ scriptPath: 's.js', cwd: '/w', testRunId: 'tr', baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn });
    expect(res.exitCode).toBe(99);
    expect(res.failed).toBe(true);
    expect(res.summaryFileName).toBe('summary-tr.json');
  });

  it('translates ENOENT into a clear "install k6" error', async () => {
    const spawnFn = vi.fn().mockRejectedValue(Object.assign(new Error('spawn k6 ENOENT'), { code: 'ENOENT' }));
    await expect(runK6({ scriptPath: 's.js', cwd: '/w', testRunId: 'tr', baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 }, spawnFn }))
      .rejects.toThrow(/k6.*not found|install k6/i);
  });
});

describe('readK6Summary', () => {
  it('reads and parses the RAW k6 summary json from the cwd (transform happens in the harness)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6sum-'));
    const rawK6Data = { metrics: { 'http_req_duration{expected_response:true,phase:steady}': { type: 'trend', values: { 'p(95)': 180, count: 1200 } } } };
    await fs.writeFile(path.join(cwd, 'summary-tr-1.json'), JSON.stringify(rawK6Data));
    const out = await readK6Summary(cwd, 'tr-1');
    expect(out.metrics?.['http_req_duration{expected_response:true,phase:steady}']?.values?.['p(95)']).toBe(180);
  });

  it('throws a clear error when the summary file is missing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6sum-'));
    await expect(readK6Summary(cwd, 'absent')).rejects.toThrow(/summary-absent\.json/);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-adapter.test.ts`
Expected: FAIL — new `runK6` signature / `readK6Summary` not present.

- [ ] **Step 3: Rewrite `k6-adapter.ts`**

Replace the entire file:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { K6RawSummary } from "../k6-generator/summary-mapping.js"; // type-only: the raw k6 summary shape

export type SpawnResult = { exitCode: number; stdout: string; stderr: string };
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
) => Promise<SpawnResult>;

export type K6Window = { warmupEndS: number; rampUpEndS: number; steadyEndS: number };

export type K6RunOptions = {
  scriptPath: string;            // path RELATIVE to cwd (k6 reads ./reusable.json etc. from cwd)
  cwd: string;                   // the per-run ExecutionWorkspace working directory
  testRunId: string;             // -> TEST_RUN_ID env, names summary-<id>.json
  baseUrl: string;
  window: K6Window;
  executionRunId?: string;
  authToken?: string;
  spawnFn: SpawnFn;
  extraEnv?: Record<string, string>;
  binary?: string;               // default 'k6'
};

export type K6RunResult = {
  exitCode: number;
  failed: boolean;               // true when k6 exits non-zero (e.g. threshold breach or script error)
  summaryFileName: string;       // summary-<testRunId>.json — read via readK6Summary
  stdout: string;
  stderr: string;
};

export async function runK6(opts: K6RunOptions): Promise<K6RunResult> {
  const { scriptPath, cwd, testRunId, baseUrl, window, executionRunId, authToken, spawnFn, extraEnv = {}, binary = "k6" } = opts;

  // Scenarios come from the script's options block (locked decision), NOT --vus/--stage CLI flags.
  const args = ["run", scriptPath];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BASE_URL: baseUrl,
    TEST_RUN_ID: testRunId,
    WARMUP_END_S: String(window.warmupEndS),
    RAMP_UP_END_S: String(window.rampUpEndS),
    STEADY_END_S: String(window.steadyEndS),
    ...(executionRunId ? { EXECUTION_RUN_ID: executionRunId } : {}),
    ...(authToken ? { AUTH_TOKEN: authToken } : {}),
    ...extraEnv,
  };

  let result: SpawnResult;
  try {
    result = await spawnFn(binary, args, { env, cwd });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Error(`k6 not found: install k6 and ensure it is in PATH`);
    throw err;
  }

  return {
    exitCode: result.exitCode,
    failed: result.exitCode !== 0,
    summaryFileName: `summary-${testRunId}.json`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Reads the RAW k6 end-of-test summary (what the generated handleSummary wrote via JSON.stringify(data)).
// The harness/executor applies mapK6Summary to turn this into metric_series rows — the adapter stays generic.
export async function readK6Summary(cwd: string, testRunId: string): Promise<K6RawSummary> {
  const file = path.join(cwd, `summary-${testRunId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`k6 summary not found: expected summary-${testRunId}.json in ${cwd} (did handleSummary run?)`);
  }
  return JSON.parse(raw) as K6RawSummary;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-adapter.test.ts`
Expected: PASS. Also confirm `pipeline-builder.test.ts` still passes (it referenced `runK6` only incidentally): `pnpm exec vitest run server/src/__tests__/pipeline-builder.test.ts` — if it imported the old `runK6`/`parseK6Summary` signature, update that import/usage minimally (it does not actually execute k6).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/test-adapters/k6-adapter.ts server/src/__tests__/k6-adapter.test.ts
git commit -m "fix(server): rework runK6 for real execution (options-driven scenarios, handleSummary JSON)"
```

---

## Task 13: `executionRunService`

**Files:**
- Create: `server/src/services/execution-runs.ts`
- Test: `server/src/__tests__/execution-runs-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/execution-runs-service.test.ts
import { describe, expect, it } from 'vitest';
import { executionRuns, pipelineRuns, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { executionRunService } from '../services/execution-runs.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

// pipeline_runs.trigger and .stages are NOT NULL — minimal stubs for tests.
const PR_STUB = {
  trigger: { type: 'manual_intake' as const, source: 'test' },
  stages: {
    intake: { status: 'pending' }, discovery: { status: 'pending' }, plan: { status: 'pending' },
    generate: { status: 'pending' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' },
  },
};

d('executionRunService', () => {
  const ctx = withPipelineSchema([executionRuns, testRuns, pipelineRuns, testPlans]);

  async function seed() {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [run] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: run!.id }).returning();
    return { pipelineRunId: run!.id, testRunId: tr!.id };
  }

  it('creates a queued execution run, marks it running, then completes it with metrics', async () => {
    const { pipelineRunId, testRunId } = await seed();
    const svc = executionRunService(ctx.db);

    const created = await svc.create(ctx.companyId, { pipelineRunId, testRunId, engine: 'k6', binaryProfile: 'k6', workspaceRef: '/tmp/run-1' });
    expect(created.status).toBe('queued');

    await svc.markRunning(created.id);
    const completed = await svc.complete(created.id, { status: 'completed', exitCode: 0, peakVus: 500, totalRequests: 1500, totalIterations: 1500 });
    expect(completed.status).toBe('completed');
    expect(completed.exitCode).toBe(0);
    expect(completed.peakVus).toBe(500);

    const [row] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, created.id));
    expect(row?.completedAt).toBeTruthy();
    expect(row?.startedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/execution-runs-service.test.ts`
Expected: FAIL — cannot import `executionRunService`.

- [ ] **Step 3: Write the service**

```typescript
// server/src/services/execution-runs.ts
import { eq } from "drizzle-orm";
import { executionRuns, type Db } from "@sentinel/db";

export type CreateExecutionRunInput = {
  pipelineRunId: string;
  testRunId?: string | null;
  testAssetId?: string | null;
  engine: string;
  binaryProfile?: string | null;
  workspaceRef?: string | null;
};

export type CompleteExecutionRunInput = {
  status: "completed" | "failed" | "aborted";
  exitCode?: number | null;
  peakVus?: number | null;
  totalRequests?: number | null;
  totalIterations?: number | null;
};

export function executionRunService(db: Db) {
  async function create(companyId: string, data: CreateExecutionRunInput) {
    const [row] = await db
      .insert(executionRuns)
      .values({
        companyId,
        pipelineRunId: data.pipelineRunId,
        testRunId: data.testRunId ?? null,
        testAssetId: data.testAssetId ?? null,
        engine: data.engine,
        binaryProfile: data.binaryProfile ?? null,
        workspaceRef: data.workspaceRef ?? null,
        status: "queued",
      })
      .returning();
    return row!;
  }

  async function markRunning(id: string) {
    const [row] = await db
      .update(executionRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(executionRuns.id, id))
      .returning();
    return row!;
  }

  async function complete(id: string, data: CompleteExecutionRunInput) {
    const [row] = await db
      .update(executionRuns)
      .set({
        status: data.status,
        exitCode: data.exitCode ?? null,
        peakVus: data.peakVus ?? null,
        totalRequests: data.totalRequests ?? null,
        totalIterations: data.totalIterations ?? null,
        completedAt: new Date(),
      })
      .where(eq(executionRuns.id, id))
      .returning();
    return row!;
  }

  return { create, markRunning, complete };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/execution-runs-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/execution-runs.ts server/src/__tests__/execution-runs-service.test.ts
git commit -m "feat(server): executionRunService create/markRunning/complete"
```

---

## Task 14: `k6Executor` — write → run → read → ingest → record

**Files:**
- Create: `server/src/services/k6-executor.ts`
- Test: `server/src/__tests__/k6-executor.test.ts`

The executor accepts an injected `spawnFn` so tests use a **fake k6** that writes a raw k6 summary (`data.metrics`) into the cwd. The workspace `cwd` is provided by the caller (Plan 4 wires real workspace provisioning; here tests use `fs.mkdtemp`).

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-executor.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executionRuns, metricSeries, pipelineRuns, testRuns, testPlans } from '@sentinel/db';
import { eq } from 'drizzle-orm';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { k6Executor } from '../services/k6-executor.js';
import type { SpawnFn } from '../services/test-adapters/k6-adapter.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

// pipeline_runs.trigger and .stages are NOT NULL — minimal stubs for tests.
const PR_STUB = {
  trigger: { type: 'manual_intake' as const, source: 'test' },
  stages: {
    intake: { status: 'pending' }, discovery: { status: 'pending' }, plan: { status: 'pending' },
    generate: { status: 'pending' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' },
  },
};

// Fake k6: writes a RAW k6 end-of-test summary (data.metrics) into the cwd, then exits 0.
function fakeK6(p95: number, sampleCount: number, run: { peakVus: number; totalRequests: number; totalIterations: number }): SpawnFn {
  return async (_cmd, _args, opts) => {
    const testRunId = opts.env.TEST_RUN_ID;
    const data = {
      metrics: {
        'http_req_duration{workflow:checkout,phase:steady,expected_response:true}': {
          type: 'trend', values: { med: p95 - 20, 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount },
        },
        vus_max: { type: 'gauge', values: { max: run.peakVus } },
        http_reqs: { type: 'counter', values: { count: run.totalRequests } },
        iterations: { type: 'counter', values: { count: run.totalIterations } },
      },
    };
    await fs.writeFile(path.join(opts.cwd!, `summary-${testRunId}.json`), JSON.stringify(data));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

d('k6Executor.run', () => {
  const ctx = withPipelineSchema([metricSeries, executionRuns, testRuns, pipelineRuns, testPlans]);

  it('writes script+data, runs, transforms the raw summary, ingests rows, completes the run', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'queued' }).returning();

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6exec-'));
    const spawnFn = fakeK6(180, 1200, { peakVus: 500, totalRequests: 1500, totalIterations: 1500 });

    const executor = k6Executor({ db: ctx.db, spawnFn });
    const result = await executor.run({
      companyId: ctx.companyId,
      executionRunId: er!.id,
      testRunId: tr!.id,
      cwd,
      asset: { scriptContent: 'export default function(){}', dataFiles: [{ name: 'reusable.json', content: '[]' }] },
      baseUrl: 'http://localhost:9999',
      window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 },
    });

    expect(result.status).toBe('completed');
    expect(result.ingestedCount).toBe(3); // p50_ms, p95_ms, p99_ms from one steady latency sub-metric

    // script + data written to cwd
    expect(await fs.readFile(path.join(cwd, 'script.js'), 'utf8')).toContain('export default');
    expect(await fs.readFile(path.join(cwd, 'reusable.json'), 'utf8')).toBe('[]');

    // metric_series rows ingested with k6 source + steady phase
    const rows = await ctx.db.select().from(metricSeries).where(eq(metricSeries.executionRunId, er!.id));
    expect(rows).toHaveLength(3);
    const p95 = rows.find((r) => r.metric === 'p95_ms');
    expect(p95).toMatchObject({ workflowName: 'checkout', phase: 'steady', source: 'k6', value: 180, sampleCount: 1200 });

    // execution run completed with run metrics
    const [erRow] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, er!.id));
    expect(erRow).toMatchObject({ status: 'completed', exitCode: 0, peakVus: 500, totalRequests: 1500 });
  });

  it('marks the execution run failed when k6 exits non-zero (no summary written)', async () => {
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p2' }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, ...PR_STUB }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, engine: 'k6', status: 'queued' }).returning();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6exec-'));
    const spawnFn: SpawnFn = async () => ({ exitCode: 1, stdout: '', stderr: 'script error' });

    const executor = k6Executor({ db: ctx.db, spawnFn });
    const result = await executor.run({
      companyId: ctx.companyId, executionRunId: er!.id, testRunId: null, cwd,
      asset: { scriptContent: 'boom', dataFiles: [] }, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 1, steadyEndS: 2 },
    });
    expect(result.status).toBe('failed');
    expect(result.ingestedCount).toBe(0);
    const [erRow] = await ctx.db.select().from(executionRuns).where(eq(executionRuns.id, er!.id));
    expect(erRow?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-executor.test.ts`
Expected: FAIL — cannot import `k6Executor`.

- [ ] **Step 3: Write the executor**

```typescript
// server/src/services/k6-executor.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@sentinel/db";
import { runK6, readK6Summary, type SpawnFn, type K6Window } from "./test-adapters/k6-adapter.js";
import { mapK6Summary } from "./k6-generator/summary-mapping.js";
import { metricSeriesService } from "./metric-series.js";
import { executionRunService } from "./execution-runs.js";

export type K6ExecutorDeps = { db: Db; spawnFn: SpawnFn; binary?: string };

export type K6ExecutionInput = {
  companyId: string;
  executionRunId: string;
  testRunId: string | null;
  cwd: string;
  asset: { scriptContent: string; dataFiles: Array<{ name: string; content: string }> };
  baseUrl: string;
  window: K6Window;
  authToken?: string;
};

export type K6ExecutionResult = {
  status: "completed" | "failed";
  exitCode: number;
  ingestedCount: number;
};

const SCRIPT_FILENAME = "script.js";

export function k6Executor(deps: K6ExecutorDeps) {
  const metrics = metricSeriesService(deps.db);
  const runs = executionRunService(deps.db);

  async function run(input: K6ExecutionInput): Promise<K6ExecutionResult> {
    // 1. Materialize the asset into the per-run workspace cwd.
    await fs.writeFile(path.join(input.cwd, SCRIPT_FILENAME), input.asset.scriptContent);
    for (const f of input.asset.dataFiles) {
      await fs.writeFile(path.join(input.cwd, f.name), f.content);
    }

    // 2. Run k6 for real.
    await runs.markRunning(input.executionRunId);
    const runResult = await runK6({
      scriptPath: SCRIPT_FILENAME,
      cwd: input.cwd,
      testRunId: input.testRunId ?? input.executionRunId,
      executionRunId: input.executionRunId,
      baseUrl: input.baseUrl,
      window: input.window,
      authToken: input.authToken,
      spawnFn: deps.spawnFn,
      binary: deps.binary,
    });

    // 3. A non-zero exit before a summary is written => failed run, no metrics.
    if (runResult.failed) {
      await runs.complete(input.executionRunId, { status: "failed", exitCode: runResult.exitCode });
      return { status: "failed", exitCode: runResult.exitCode, ingestedCount: 0 };
    }

    // 4. Read the RAW k6 summary the generated handleSummary wrote, transform it (harness-side), ingest.
    const raw = await readK6Summary(input.cwd, input.testRunId ?? input.executionRunId);
    const { series, run } = mapK6Summary(raw);
    let ingestedCount = 0;
    if (input.testRunId && series.length > 0) {
      const created = await metrics.ingest(input.companyId, {
        testRunId: input.testRunId,
        executionRunId: input.executionRunId,
        source: "k6",
        series,
      });
      ingestedCount = created.length;
    }

    // 5. Record run-level metrics on the execution run.
    await runs.complete(input.executionRunId, {
      status: "completed",
      exitCode: runResult.exitCode,
      peakVus: run.peakVus,
      totalRequests: run.totalRequests,
      totalIterations: run.totalIterations,
    });

    return { status: "completed", exitCode: runResult.exitCode, ingestedCount };
  }

  return { run };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/k6-executor.ts server/src/__tests__/k6-executor.test.ts
git commit -m "feat(server): k6Executor threads write→run→read→ingest→record (local path)"
```

---

## Task 15: End-to-end integration — generate → fake-run → ingest → evaluate → verdicts

This is the proof the whole local path produces correct `sla_verdicts` **without** requiring k6 installed: a fake k6 emits a raw summary for exactly the sub-metrics the generator's thresholds declared, the executor's `mapK6Summary` transforms it, and Plan 2's `slaVerdictEngine` turns the rows into verdicts.

**Files:**
- Test: `server/src/__tests__/k6-generation-execution-e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/k6-generation-execution-e2e.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  executionRuns, metricSeries, pipelineRuns, requirementsDocuments, slaVerdicts, testRuns, testPlans,
} from '@sentinel/db';
import type { SlaTarget } from '@sentinel/db';
import { embeddedPostgresSupport, withPipelineSchema } from './helpers/pipeline-schema-fixture.js';
import { generateK6Script } from '../services/k6-generator/generate.js';
import { buildThresholds } from '../services/k6-generator/thresholds.js';
import { k6Executor } from '../services/k6-executor.js';
import { slaVerdictEngine } from '../services/sla-verdict-engine.js';
import type { GenerateK6Input } from '../services/k6-generator/types.js';
import type { SpawnFn } from '../services/test-adapters/k6-adapter.js';

const d = embeddedPostgresSupport.supported ? describe : describe.skip;

// pipeline_runs.trigger and .stages are NOT NULL — minimal stubs for tests.
const PR_STUB = {
  trigger: { type: 'manual_intake' as const, source: 'test' },
  stages: {
    intake: { status: 'pending' }, discovery: { status: 'pending' }, plan: { status: 'pending' },
    generate: { status: 'pending' }, validate: { status: 'pending' }, execute: { status: 'pending' },
    analysis: { status: 'pending' }, report: { status: 'pending' },
  },
};

// Fake k6 that synthesizes a RAW k6 data.metrics tree from the SAME thresholds the generator declared,
// so the summary it writes is exactly what real k6 would emit for those materialized sub-metrics. The
// executor's mapK6Summary then transforms it — so this exercises the real transform end-to-end.
// `values` sets the metric values (and thus pass/fail); sampleCount drives the min-sample guard.
function fakeK6FromThresholds(targets: SlaTarget[], values: { p95_ms?: number; error_rate?: number }, sampleCount: number): SpawnFn {
  const thresholds = buildThresholds(targets);
  return async (_cmd, _args, opts) => {
    const testRunId = opts.env.TEST_RUN_ID;
    const metrics: Record<string, { type: string; values: Record<string, number> }> = {
      vus_max: { type: 'gauge', values: { max: 500 } },
      http_reqs: { type: 'counter', values: { count: sampleCount } },
      iterations: { type: 'counter', values: { count: sampleCount } },
    };
    for (const key of Object.keys(thresholds)) {
      if (key.startsWith('http_req_duration')) {
        const p95 = values.p95_ms ?? 0;
        metrics[key] = { type: 'trend', values: { med: Math.max(p95 - 20, 0), 'p(95)': p95, 'p(99)': p95 + 50, count: sampleCount } };
      } else if (key.startsWith('http_req_failed')) {
        metrics[key] = { type: 'rate', values: { rate: values.error_rate ?? 0, passes: sampleCount, fails: 0 } };
      }
    }
    await fs.writeFile(path.join(opts.cwd!, `summary-${testRunId}.json`), JSON.stringify({ metrics }));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const sla = (o: Partial<SlaTarget> & Pick<SlaTarget, 'metric' | 'operator' | 'threshold'>): SlaTarget => ({
  id: o.id ?? `t-${o.metric}-${o.workflowScope ?? 'agg'}`, source: 'k6', required: o.required ?? true, workflowScope: o.workflowScope, ...o,
});

d('k6 generation → execution → SLA verdict (local path)', () => {
  const ctx = withPipelineSchema([slaVerdicts, metricSeries, executionRuns, testRuns, pipelineRuns, requirementsDocuments, testPlans]);

  async function seed(targets: SlaTarget[]) {
    const [rd] = await ctx.db.insert(requirementsDocuments).values({ companyId: ctx.companyId, slaTargets: targets, minSampleCount: 200 }).returning();
    const [plan] = await ctx.db.insert(testPlans).values({ companyId: ctx.companyId, name: 'p', requirementsDocumentId: rd!.id }).returning();
    const [pr] = await ctx.db.insert(pipelineRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, requirementsDocumentId: rd!.id, ...PR_STUB }).returning();
    const [tr] = await ctx.db.insert(testRuns).values({ companyId: ctx.companyId, testPlanId: plan!.id, pipelineRunId: pr!.id }).returning();
    const [er] = await ctx.db.insert(executionRuns).values({ companyId: ctx.companyId, pipelineRunId: pr!.id, testRunId: tr!.id, engine: 'k6', status: 'queued' }).returning();
    return { pipelineRunId: pr!.id, testRunId: tr!.id, executionRunId: er!.id };
  }

  it('aggregate p95 under threshold + healthy run → pass verdict', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 }), sla({ metric: 'error_rate', operator: 'lt', threshold: 0.01 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);

    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: 500 }, { duration: '10m', target: 500 }, { duration: '2m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'search', weight: 1, request: { method: 'GET', path: '/search', queryFromData: 'term' }, dataStrategy: 'reusable' }],
      slaTargets: targets,
      data: { reusable: [{ term: 'x' }] },
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 180, error_rate: 0.004 }, 1200);

    const exec = k6Executor({ db: ctx.db, spawnFn });
    const r = await exec.run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 120, steadyEndS: 720 } });
    expect(r.status).toBe('completed');

    const verdicts = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(verdicts.passCount).toBe(2);
    expect(verdicts.failCount).toBe(0);
    expect(verdicts.inconclusiveCount).toBe(0);

    const rows = await ctx.db.select().from(slaVerdicts).where(eq(slaVerdicts.executionRunId, executionRunId));
    expect(rows.every((v) => v.status === 'pass')).toBe(true);
  });

  it('p95 over threshold → fail verdict', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 200 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }] },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'search', weight: 1, request: { method: 'GET', path: '/search' }, dataStrategy: 'none' }],
      slaTargets: targets,
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 480 }, 1200);
    await k6Executor({ db: ctx.db, spawnFn }).run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 0, rampUpEndS: 60, steadyEndS: 360 } });

    const v = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(v.failCount).toBe(1);
  });

  it('under-sampled required metric → inconclusive (never false-green)', async () => {
    const targets = [sla({ metric: 'p95_ms', operator: 'lt', threshold: 500 })];
    const { pipelineRunId, testRunId, executionRunId } = await seed(targets);
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '2m' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/health' }, dataStrategy: 'none' }],
      slaTargets: targets,
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6e2e-'));
    const spawnFn = fakeK6FromThresholds(targets, { p95_ms: 50 }, 12); // 12 < minSampleCount 200
    await k6Executor({ db: ctx.db, spawnFn }).run({ companyId: ctx.companyId, executionRunId, testRunId, cwd, asset, baseUrl: 'http://x', window: { warmupEndS: 30, rampUpEndS: 30, steadyEndS: 120 } });

    const v = await slaVerdictEngine(ctx.db).evaluate({ companyId: ctx.companyId, pipelineRunId, executionRunId });
    expect(v.inconclusiveCount).toBe(1);
    expect(v.passCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/k6-generation-execution-e2e.test.ts`
Expected: FAIL initially if any wiring is off (it depends on Tasks 9, 12, 13, 14 + Plan 2's engine).

- [ ] **Step 3: Make it pass**

No new production code — this test integrates already-built pieces. If it fails, the failure is the truth: a metric-name/workflowName/source/phase mismatch between generation and the engine join. Debug by printing the ingested `metric_series` rows and the `slaTargets`, and reconcile `thresholds.ts`/`generate.ts` with `sla-verdict-engine.ts`'s `rowKey`. Do NOT weaken the assertions.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/k6-generation-execution-e2e.test.ts`
Expected: PASS (3 cases: pass / fail / inconclusive).

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/k6-generation-execution-e2e.test.ts
git commit -m "test(server): e2e generate→execute→ingest→evaluate produces correct sla_verdicts"
```

---

## Task 16: Real-k6 smoke (skip-gated)

Confirms the generated script actually parses and runs in **real k6**, emits `summary-<id>.json` with the expected `series`/`run` shape, and that the `summaryTrendStats`/sub-metric `values` keys match `summary-mapping.ts`. Gated on a k6 binary being present (mirrors the embedded-Postgres gating pattern).

**Files:**
- Create: `server/src/__tests__/helpers/k6-binary.ts`
- Test: `server/src/__tests__/k6-real-smoke.test.ts`

- [ ] **Step 1: Write the gate helper + the failing test**

```typescript
// server/src/__tests__/helpers/k6-binary.ts
import { execFileSync } from 'node:child_process';

export const k6Support = (() => {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false };
  }
})();
```

```typescript
// server/src/__tests__/k6-real-smoke.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateK6Script } from '../services/k6-generator/generate.js';
import { runK6, readK6Summary } from '../services/test-adapters/k6-adapter.js';
import { mapK6Summary } from '../services/k6-generator/summary-mapping.js';
import { createExecFileSpawn } from '../services/test-adapters/spawn.js';
import { k6Support } from './helpers/k6-binary.js';
import type { GenerateK6Input } from '../services/k6-generator/types.js';

const d = k6Support.available ? describe : describe.skip;

d('real k6 smoke (constant-vus baseline against a local server)', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('generates, runs, and emits a parseable summary with steady-phase p95', async () => {
    const input: GenerateK6Input = {
      loadProfile: { protocol: 'http', executor: 'constant-vus', vus: 1, duration: '8s', warmupGuard: '1s' },
      executionModel: 'weighted-loop',
      workflows: [{ name: 'health', weight: 1, request: { method: 'GET', path: '/' }, dataStrategy: 'none' }],
      slaTargets: [{ id: 't1', source: 'k6', metric: 'p95_ms', operator: 'lt', threshold: 1000, required: true }],
    };
    const asset = generateK6Script(input);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'k6smoke-'));
    await fs.writeFile(path.join(cwd, 'script.js'), asset.scriptContent);

    const res = await runK6({
      scriptPath: 'script.js', cwd, testRunId: 'smoke-1', baseUrl,
      window: { warmupEndS: 1, rampUpEndS: 1, steadyEndS: 8 }, spawnFn: createExecFileSpawn(),
    });
    expect(res.exitCode).toBe(0);

    const raw = await readK6Summary(cwd, 'smoke-1');     // raw k6 summary written by handleSummary
    const { series, run } = mapK6Summary(raw);           // the harness-side transform under real k6 output
    const p95 = series.find((s) => s.metric === 'p95_ms' && s.phase === 'steady');
    expect(p95).toBeDefined();
    expect(typeof p95!.value).toBe('number');
    expect(p95!.sampleCount).toBeGreaterThan(0);
    expect(run.totalRequests).toBeGreaterThan(0);
  }, 30_000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run server/src/__tests__/k6-real-smoke.test.ts`
Expected: If k6 is NOT installed → the suite is **skipped** (reported as skipped, not failed). If k6 IS installed → it runs and must PASS. (Note: the generated script imports the k6-reporter and k6-summary libs from remote URLs; the smoke needs network access for those imports.)

- [ ] **Step 3: If it runs and fails, fix the generator/mapping, not the test**

A real-k6 failure here is the highest-signal bug in the plan: it means k6's actual `data.metrics` keys or `values` stat names differ from `summary-mapping.ts`/`thresholds.ts`. Inspect the real `summary-smoke-1.json` (handleSummary already writes the raw `data`) and reconcile the stat keys (`p(95)`, `med`, `count`, `rate`) and the sub-metric key/tag format `mapK6Summary` parses. Update `summary-mapping.ts` + its Task-5 fixture together.

- [ ] **Step 4: Confirm skip/pass**

Run: `pnpm exec vitest run server/src/__tests__/k6-real-smoke.test.ts`
Expected: skipped (no k6) or PASS (k6 present).

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/helpers/k6-binary.ts server/src/__tests__/k6-real-smoke.test.ts
git commit -m "test(server): skip-gated real-k6 smoke validates generated script end-to-end"
```

---

## Final verification (run after all tasks)

- [ ] **Full server test suite:** `pnpm -C server exec vitest run` — all green, no regressions in Plan 1/2 suites (`metric-series-service`, `sla-verdict-engine`, schema tests).
- [ ] **DB build + drift:** `pnpm -C packages/db run build` and `pnpm -C packages/db run check:drift` — no drift (Plan 3 adds no migration; if drift appears you accidentally changed a schema file — revert it).
- [ ] **Typecheck:** `pnpm -C packages/db exec tsc --noEmit` and `pnpm -C server exec tsc --noEmit` — clean. (Reminder: server tsconfig excludes `src/__tests__`, so test-only type errors surface only under vitest.)

---

## Self-Review

**1. Spec coverage (Stage 3, v1 HTTP/sync scratch generation):**
- Canonical-template-conforming generation for all three v1 shapes — weighted-loop/`ramping-vus` (Task 3/9), per-scenario/`constant-arrival-rate` (Task 3/9), true-baseline/`constant-vus` (Task 3/9) ✅
- `{workflow, phase}` per-request tagging via `params()`; 4-branch `phaseFor` incl. `warmup` (Task 6) ✅
- Steady window derived from stages/evaluationWindow and **baked into the asset** as env defaults (Task 2/7) ✅
- Data handling: reusable→`SharedArray`, consumable→`iterationInTest` claim key (NOT `exec.vu.idInTest`), modulo-wrap forbidden, `setup()` present (Task 6/8/9) ✅
- `handleSummary` portable & non-negotiable rules: `TEST_RUN_ID`-keyed filename, written to cwd, distinct from the `--out json` *live stream*, **identical across harnesses** — it writes only the HTML report + the *raw* k6 summary (`JSON.stringify(data)`) + stdout (Task 6). The metric→row transform is the harness's job (`mapK6Summary`, Task 5/14), not the script's — so the script stays harness-invariant (spec Stage 5) ✅
- Windowed per-workflow sub-metrics flow to ingestion with `workflowName`+`phase`; thresholds declared per sub-metric key so k6 materializes them; `summaryTrendStats` includes `p(99)`+`count`; `mapK6Summary` re-keys in-runner percentiles to SLA vocab (no server-side recompute) (Task 4/5/7) ✅
- Aggregate (no `workflowScope`) vs per-workflow threshold shapes; single aggregate error-rate key (Task 4) ✅
- Real local execution path: `execFile` SpawnFn, options-driven `runK6` (no CLI `--vus/--stage`, no `--out json` as the metrics source), summary read back from cwd, ingest via Plan 2, record `execution_runs` (Task 11/12/13/14) ✅
- End-to-end produces correct `sla_verdicts` (pass/fail/inconclusive incl. min-sample guard) (Task 15) ✅
- **Deliberately deferred** (stated in Critical Context): issue orchestration + assignee deadlock (Plan 4), `ci_workflow`/GHA generator, approval-gate transitions, non-HTTP protocols (stop-and-ask via `UnsupportedProtocolError`), OpenAPI/Postman/import-existing inputs, Dynatrace/async, `evaluationWindow` population. No migration (test_assets + Plan-1 tables already suffice).

**2. Placeholder scan:** No `TBD`/`implement later`. The one flagged item is a concrete instruction, not a gap: Task 9's `recordPick` helper is explicitly marked for deletion before commit (no-dead-code rule). Task 11's note about `SpawnFn` opts ordering with Task 12 is a sequencing instruction. Task 15 Step 3 deliberately has no new code — it integrates prior tasks. Every `pipelineRuns` insert in Tasks 13/14/15 supplies the NOT-NULL `trigger`+`stages` via a shared `PR_STUB`.

**3. Type consistency:** `GenerateK6Input`/`GeneratedK6Asset` (Task 1) thread through `buildScenarios`/`buildThresholds`/`generateK6Script` (Tasks 3/4/9). The metric→row transform `mapK6Summary` (`MappedSummary` = `{series, run}`, Task 5) is consumed by `k6-executor.ts` (Task 14) and the real-k6 smoke (Task 16); its `K6RawSummary` type is the (type-only) return of `readK6Summary` (Task 12). `SpawnFn`/`SpawnResult`/`K6Window` are defined in `k6-adapter.ts` (Task 12) and consumed by `spawn.ts` (Task 11), `k6-executor.ts` (Task 14), and tests — Task 11's note covers the build-order dependency. The executor's ingest payload (`{testRunId, executionRunId, source:'k6', series}`) matches `metricSeriesService.ingest`'s `IngestPayload` exactly (Plan 2), and the emitted `series` entries (`metric, workflowName, phase, value, sampleCount`) match `IngestSeriesEntry`. The SLA join contract (`metric`=SLA vocab, `source`='k6', `workflowName`=`workflowScope`, `phase`='steady') closes from two ends that agree by convention: `buildThresholds` (Task 4) materializes the sub-metrics; `mapK6Summary` (Task 5) emits the canonical metric names with `workflowName` parsed from the tag — both driven by the same `slaTargets`, verified end-to-end (Task 15). `executionRunService.complete` field names (`status/exitCode/peakVus/totalRequests/totalIterations`) match the `execution_runs` columns from Plan 1.
