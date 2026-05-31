# Performance Test Pipeline — Design Philosophy
**Date:** 2026-05-29 (verification punch-list applied 2026-05-30)  
**Status:** v2.1 — decisions locked, verification punch-list applied

---

## Foundational Principles

**The pipeline automates the performance test requirements meeting.** The starting point is zero knowledge. Someone — a human, a CI system, a Jira ticket, a PR — says "test this thing." The pipeline's first obligation is to understand what "this thing" is before it does anything else.

**Hybrid ownership model.** Humans define the envelope: what "good" looks like, what the SLAs are, what environments are approved. Agents make tactical decisions within that envelope: script generation, load profile construction, metric collection, regression triage. The boundary is: agents never autonomously commit to a decision that is expensive to reverse (a baseline, an SLA threshold, a test plan going to production). They propose; humans approve.

**Stop and ask rather than assume.** When the pipeline encounters ambiguity, it surfaces a specific question to a specific human and blocks. It never guesses at SLA thresholds, never infers "good enough" from thin data, never silently skips a stage. A blocked pipeline with a clear question is better than a running pipeline with bad assumptions baked in.

**The target is not ours.** We do not own, provision, or control the system under test. It is an external URL, an external API, an external Kafka cluster. The pipeline validates that the target is reachable and behaves as expected before loading it, but it cannot guarantee environment isolation or reproducibility. Baselines and regressions must account for environmental variance.

**Protocols are first-class.** HTTP/REST is one protocol among many. Kafka, gRPC, WebSocket, browser-driven flows, and async message pipelines are all valid test targets. Every stage must know which protocol it's dealing with because load generation, metric collection, and SLA definitions differ fundamentally across them.

**Sentinel is a thin domain layer on the Paperclip platform.** Everything below is built on the shipped Paperclip control plane — Issues, agents, ExecutionWorkspaces, the existing Drizzle schema. We complete the performance-testing domain layer; we never rewrite the platform underneath it.

---

## Architecture

### Philosophy

**Sentinel is an asset factory and an analysis control plane — not an execution orchestrator.** This is the single most important architectural commitment in the design, and it reframes every stage downstream of the Test Plan.

Sentinel never reaches into GitHub (or any customer CI system) to trigger a run. It does not hold CI credentials, it does not push commits, it does not invoke workflows. Instead, Sentinel **generates a self-reporting execution bundle** — the assets a customer's own runner needs to execute the test and report back. The customer's runner executes the bundle. Results flow **back** to Sentinel's ingestion endpoint, where the SLA verdict, gate, and report are computed.

**Control flows runner→Sentinel only, never Sentinel→GHA.** This is the locked meaning of "CI = an execution trigger against an existing TestPlan" (see Stage 0): CI is something the customer wires up against an asset Sentinel produced, not something Sentinel reaches out and pulls. Sentinel is upstream of the assets and downstream of the results; it is never in the middle pulling the trigger.

### The Execution Bundle

The generated bundle is a self-contained, self-reporting unit:

- **k6 script(s)** with an injected `handleSummary` (one per workflow — see Stage 3).
- **GitHub Actions workflow YAML** that runs the script in the customer's runner and POSTs results to Sentinel's ingestion endpoint, with a final step that polls Sentinel's verdict and **fails the job on `ciSignal='fail'`** (see Stage 8).
- **Data files** (CSV/JSON, consumable or reusable per the data strategy).
- **Config** — k6 `options.scenarios` emitted from configuration, not CLI flags, derived from the discriminated `loadProfile` (see Stage 2).

The bundle is generated as `test_assets` rows (the GHA workflow YAML is the new `ci_workflow` asset type) and stored as a first-class artifact (`test_run_artifacts.artifactType = gha_workflow_bundle`).

### The Portable Unit and the Harness Swap

**The portable unit is the k6 script + `handleSummary` — it is executor-agnostic.** The same script, producing the same `handleSummary` output, POSTing to the same ingestion endpoint, runs unchanged no matter what executes it. Only the **harness** swaps:

- **Now (testing Sentinel locally):** Sentinel's own **load-test-agent** spawns k6 in a Paperclip **ExecutionWorkspace**. This is how we prove the pipeline against real targets before any customer CI exists.
- **Later (production):** a **generated GitHub Actions workflow** runs the identical script in the customer's runner.

Both harnesses feed **ONE ingestion path**, and from there **ONE SLA → gate → report path**. The script does not know or care which harness ran it. This is the seam that keeps the whole design additive: switching from the local Paperclip harness to the generated GHA harness changes nothing about the script, the ingestion shape, or the verdict logic.

```
                  ┌─────────────────────────── Sentinel ───────────────────────────┐
                  │  ASSET FACTORY                          ANALYSIS CONTROL PLANE  │
                  │  ┌──────────────────┐                   ┌────────────────────┐  │
  Requirements →  │  │ generate bundle: │                   │ ingest → SLA verdict│ │
                  │  │  k6 + handleSummary│                  │  → gate → report    │ │
                  │  │  GHA YAML, data,  │                   └─────────▲──────────┘  │
                  │  │  config           │                             │ results     │
                  │  └────────┬─────────┘                              │ (runner→    │
                  └───────────┼─────────────────────────────────────── │  Sentinel)  ┘
                              │ portable unit                          │
                              ▼                                        │
              ┌──────────────────── HARNESS (swappable) ───────────────┴──────┐
              │  NOW: load-test-agent spawns k6 in Paperclip ExecutionWorkspace│
              │  LATER: generated GHA workflow runs in customer's runner       │
              └────────────────────────────────────────────────────────────────┘
```

### Why This Shape

- **No CI credentials, no blast radius into the customer's repo.** Sentinel hands over an asset; the customer owns when and how it runs. This honors "the target is not ours."
- **One ingestion contract.** Whether a percentile arrives as an exact in-script windowed sub-metric (single-instance k6) or, later, as a server-merged per-bucket t-digest (sharded/distributed load), the ingestion shape is the same. The harness swap and the scale-out swap are both **additive** (see Data Model §2).
- **One source-of-record discipline.** k6 client-side data is authoritative for synchronous protocols; Dynatrace server-side is authoritative for asynchronous protocols and diagnostic-only ("the why") for sync. The control plane applies this discipline regardless of which harness produced the run.

### Visualization Posture

Sentinel does **not** build custom charts. Visualization is Dynatrace deep-links (time-scoped to the run window) plus the native k6 HTML report, wrapped by a thin Sentinel summary that carries the verdict and links out (see Stage 9). The control plane curates and links; it does not re-implement observability.

---

---

## Stage 0: INTAKE

### Philosophy
The intake stage's job is to receive a trigger — any trigger, from any source — and normalize it into a structured request that the pipeline can reason about. It is not the agent's job at this stage to understand the system under test. It is only the agent's job to understand what is being asked and who asked it.

Every intake produces a `PipelineRequest`: a structured artifact capturing the source, the raw ask, and whatever structured data could be extracted automatically. If the trigger is an OpenAPI spec, the PipelineRequest has a `schema` field populated. If the trigger is a plain text message ("test the new payments API"), the PipelineRequest has only `rawDescription`. The downstream discovery stage will fill the gaps — intake never blocks on missing information.

The `PipelineRequest` is persisted in its own net-new `pipeline_requests` table (the upstream gate in the pipeline status-transition chain — see Data Model). It is the head of the chain: a `pipeline_runs` row and, after discovery, a `requirements_documents` row reference it by FK. Intake is the only entry into the pipeline that creates new knowledge; everything downstream is asset generation and analysis against what intake captured.

**There are exactly two first-class intake paths: manual and Jira monitoring.** Everything else (CI, scheduled runs, PR webhooks) operates against an existing TestPlan — those are *execution* triggers, not *intake* triggers. They re-run an already-understood plan; they create no `PipelineRequest`. This is the architectural seam that makes Sentinel an asset factory plus analysis control plane rather than an execution orchestrator: intake fires only when something new needs to be understood, and the resulting bundle is what later gets executed (by Sentinel's own load-test-agent now, by a generated GitHub Actions workflow later) and self-reported back. Control flows runner→Sentinel, never the reverse.

### Intake Path 1: Manual

A human directly requests a test. The interface can be:
- A form in the Sentinel UI ("Request a performance test")
- A plain-text prompt to the intake agent
- A pasted URL, OpenAPI spec, or Postman collection

Manual intake is always tied to a specific user who becomes the owner of the RequirementsDocument and the primary human contact for all gate decisions downstream.

### Intake Path 2: Jira Monitoring

The intake agent periodically polls (or receives webhooks from) a configured Jira project for issues that signal a performance testing need. This is not a passive listener — the agent actively decides whether a Jira issue warrants a pipeline.

**What the agent looks for:**
- Issues in a configured project/board with a label, component, or custom field indicating performance testing is needed (e.g. label: `perf-test-required`, component: `performance`, custom field: `Performance Test` = `Required`)
- Issues whose acceptance criteria mention performance targets (e.g. "must handle 500 concurrent users", "p95 < 200ms", "load test before release")
- Issues in a specific status (e.g. `Ready for Performance Test`, `In QA`) — configurable per project
- New issues assigned to a configured "performance testing" team or individual

**What the agent extracts from a Jira issue:**
- Title and description → `rawDescription`
- Acceptance criteria → candidate SLA targets (to be confirmed in discovery)
- Linked Epic/story → system/app context
- Attachments → potential OpenAPI specs, Postman collections, test scripts
- Linked issues → existing requirements or related test plans
- Assignee/reporter → owner of the RequirementsDocument
- Labels/components → protocol hints, system hints

**Deduplication rule:** Before creating a PipelineRequest from a Jira issue, check whether a PipelineRequest or TestPlan already references that Jira issue ID. If one exists and is active (not failed/cancelled), skip. If the existing one failed, surface it and ask whether to retry or create a new request.

**The agent does not create a pipeline for every matching issue.** It creates a PipelineRequest and immediately presents it to the issue assignee or reporter: "I found a performance testing requirement in Jira issue {KEY}. Here's what I extracted — should I start the requirements discovery process?" The human confirms before discovery begins. This prevents runaway pipelines from noisy Jira boards.

### Trigger Sources

Triggers split into two closed origins, matching the `PipelineRun.trigger.type` taxonomy exactly (see The Pipeline Object and Data Model). **Intake-origin** triggers create a new `PipelineRequest`; **execution-origin** triggers create none and run against an existing TestPlan.

| Source | Origin | `trigger.type` | Fires |
|--------|--------|----------------|-------|
| Manual UI/prompt | Intake | `manual_intake` | When a human submits a new test request |
| Jira monitoring | Intake | `jira` | When the agent detects a qualifying issue |
| CI deploy webhook | Execution | `ci` | Against an existing TestPlan only |
| Cron schedule | Execution | `scheduled` | Against an existing TestPlan only |
| Manual re-run | Execution | `manual_rerun` | Against an existing TestPlan only |

> The former `requirement_created` type (never defined) and the bare ambiguous `manual` (which conflated new-intake with re-run) are **dropped from `trigger.type`**. At the run layer, manual *intake* is `manual_intake`; manual *re-run of an existing plan* is `manual_rerun`. The split by origin is what keeps intake as the sole knowledge-creating entry point.

> **One vocabulary for the intake origin (fix 12).** `pipeline_requests.source ∈ { manual_intake, jira }` is identical to the intake-origin subset of `pipeline_runs.trigger.type` — same tokens, no translation, no bridge. The bare `manual` and the undefined `requirement_created` are dropped. The request layer simply omits the execution-origin tokens (`ci`, `scheduled`, `manual_rerun`) because a re-run never creates a `PipelineRequest`.

### Jira Integration Config
```
JiraIntegrationConfig {
  companyId
  jiraBaseUrl
  projectKeys: string[]         // which projects to monitor
  triggerLabels?: string[]       // e.g. ["perf-test-required"]
  triggerStatuses?: string[]     // e.g. ["Ready for Performance Test"]
  triggerComponents?: string[]
  triggerCustomField?: { fieldId, value }
  assigneeMapping?: Record<jiraUserId, sentinelUserId>
  pollIntervalMinutes: number    // how often to check (default: 15)
  webhookSecret?: string         // if Jira push webhooks are configured instead
}
```

### Inputs
Any of: URL, natural language description, OpenAPI spec, Postman collection, Jira issue (with all its fields and attachments), PR diff, functional test suite, repo URL

### Outputs
```
PipelineRequest {                  // persisted in the net-new pipeline_requests table
  id
  source: "manual_intake" | "jira" // SAME intake tokens as the RUN-layer trigger.type —
                                   //   no translation. Execution-origin tokens
                                   //   (ci / scheduled / manual_rerun) NEVER appear at the
                                   //   request layer. (See the intake-vocabulary note under Trigger Sources.)
  rawDescription?: string
  jiraIssueKey?: string         // e.g. "PROJ-1234"
  jiraIssueUrl?: string
  artifacts: {
    openApiSpec?: object
    postmanCollection?: object
    functionalTests?: { repo, path }
    existingTestPlanId?: string
    attachments?: [{ name, content, mimeType }]
  }
  extractedContext: {
    candidateSlaTargets?: string[]   // human-readable, not validated yet
    protocolHints?: string[]
    appName?: string
    systemOwner?: string
  }
  requestedBy: userId | agentId
  ownerUserId: string           // who gates all downstream human decisions
  companyId
  createdAt
  status: "pending_confirmation" | "confirmed" | "rejected"
}
```

### Agent Behavior
- For manual intake: create PipelineRequest immediately, advance to Discovery
- For Jira intake: create PipelineRequest in `pending_confirmation` status, notify owner, wait for confirmation before advancing
- Extract whatever structured data is available from artifacts — populate `extractedContext` to give Discovery a head start
- If a matching active TestPlan already exists for this request, notify the owner and ask: run against the existing plan (an execution-origin re-run, no new PipelineRequest), or start fresh discovery?
- Never advance to Discovery without a confirmed owner who will respond to gate questions

### Failure Mode
None. Intake never fails — it captures whatever it receives and passes it forward. The only thing that can go wrong is a malformed webhook signature or auth failure, which is an infrastructure error, not a pipeline error.

---

## Stage 1: DISCOVERY (The Requirements Meeting)

### Philosophy
This is the most important stage in the entire pipeline, and the one most likely to be underinvested. Every failure downstream — wrong load profile, wrong SLA thresholds, tests that don't represent real traffic, scripts that test the wrong thing — traces back to bad discovery.

Discovery automates the performance test requirements meeting. A requirements meeting is not a form. It is a structured conversation that builds a shared mental model between the tester and the system owner. The agent's job is to conduct that conversation — asking questions, validating answers, surfacing contradictions, and refusing to proceed until it has enough information to write a correct plan.

The conversation is sequential but not rigid. Some questions unlock others. Knowing the protocol (Kafka vs HTTP) determines which load metrics are even meaningful. Knowing whether data is consumable or reusable changes the entire data strategy. The agent must understand these dependencies and ask in the right order.

**The output of discovery is a Requirements Document that a performance engineer would sign off on.** If a senior performance engineer looked at the Requirements Document and said "I couldn't run a test from this," discovery is incomplete.

**The Requirements Document is the single source of truth for SLA targets.** This is the most consequential structural decision in the entire pipeline. The SLA targets captured here are the *only* authoritative copy — they are **referenced by stable id, never copied**, by the TestPlan (Stage 2) and by every `SLAVerdict` (Stage 6) and `GateResolution` (Stage 8) downstream. The original design carried SLA targets in three places (RequirementsDocument, TestPlan, verdict), which drifts the moment anyone edits one copy. Eliminating that drift is the job of this stage: when an SLA target is edited here, every plan and verdict that references it reflects the change immediately, with no reconciliation job. The downstream join is mechanical — `sla_verdicts.slaTargetId` joins `requirements_documents.slaTargets[].id` directly (see **Data Model & Migrations §3**).

**Discovery's output is backed by a new `requirements_documents` table — not a widening of the thin `requirements` table.** The shipped `requirements` table carries only `name`, `description`, `slaTargets`, `source`, `jiraIssueId`, and `coverageStatus`. The Requirements Document needs roughly fifteen fields that table lacks (`protocol`, `syncModel`, `asyncDetails`, `loadModel`, `authentication`, `testData`, `existingArtifacts`, `targetEnvironment`, `dynatrace`, owner and approval columns). It is therefore a **net-new table**, introduced additively (decision #8). The full DDL lives in **Data Model & Migrations §1**; the entity shape this stage produces is below.

### The Required Questions (in dependency order)

**1. What are we testing?**
- App name, team/owner, brief description of the system
- Is this a new system or an existing one with prior test history?

**2. What protocol?**
- HTTP/REST, GraphQL, gRPC, WebSocket, Kafka/event-driven, browser-based (Playwright), SOAP, or combination
- This gates every downstream decision — ask this early
- The answer here is what selects which branch of the TestPlan's protocol-tagged load-profile union instantiates in Stage 2 (`http`/`grpc`/`websocket`/`browser` → VU or arrival-rate executors; `kafka` → producer/consumer-rate; streaming → connection-based). Capture it precisely.

**3. Synchronous or asynchronous?**
- Sync: request → response, latency is measurable directly
- Async: request → ack → event/callback later, latency is end-to-end message processing time
- Combination: sync API that triggers async downstream work (e.g. POST /order returns 201 but fulfillment is async)
- If async: what is the SLA measured against? Message enqueue time? Consumer processing time? End-to-end saga completion?
- **This answer determines the source of record for percentiles downstream.** For sync protocols, k6's client-side windowed sub-metrics are authoritative (Stage 6). For async, Dynatrace's server-side native percentiles are authoritative — there is no client-side latency to measure. Capturing `syncModel` correctly here is what lets Stage 6 pick the right authoritative source; getting it wrong silently measures the wrong thing.

**4. What are the SLA targets?**
- Response time: p50, p95, p99 thresholds (e.g. "p95 under 200ms")
- Error rate: maximum acceptable error rate (e.g. "< 0.1%")
- Throughput: minimum TPS, RPS, messages/sec
- **Is each target REQUIRED or optional?** Every SLA target carries an explicit `required: boolean`. This is load-bearing for the gate: a **required** target that cannot be measured forces the run to `inconclusive` (never a false-green pass — Stage 6, Stage 8), while an optional target's absence does not. The gate reads exactly these `required` flags (Stage 8). Do not leave it implicit — set it on every target.
- **Are these targets per-workflow or aggregate?** This is load-bearing for Stage 2: if any SLA is scoped to a specific workflow (e.g. "checkout p95 < 300ms" distinct from "search p95 < 120ms"), the test plan must use the `per-scenario` execution model so each workflow is independently measurable; if all SLAs are aggregate, a `weighted-loop` model suffices. Record the workflow scope on each target.
- If they don't know: help them derive it from business requirements ("how many orders per minute at peak?")
- Note: SLA thresholds require human approval before becoming official — the agent can propose based on industry standards, but a human must confirm. Each target carries its own `approvedByUserId`; **every required target must be approved before plan creation is allowed** (see Human Gate and **Data Model §4**).

**5. What is the expected load?**
- Peak concurrent users (for browser/session-based tests) → drives a `ramping-vus` executor
- Peak requests per second / transactions per second (for API tests) → drives an arrival-rate executor (`constant-arrival-rate` / `ramping-arrival-rate`)
- Peak messages per second (for event-driven tests) → drives the Kafka producer/consumer-rate branch
- Is this a single peak or a profile? (ramp up, sustain, ramp down)
- Is there a known traffic pattern? (e.g. "3x traffic on Monday morning, flat otherwise")
- **Capture the explicit load profile (ramp-up / steady-state plateau / ramp-down stages), not just the peak.** The steady-state plateau is an up-front design input: Stage 6 derives the SLA evaluation window from the stage phases (the plateau between the last ramp-up and the first ramp-down), and that window is baked into the generated execution asset. Re-cutting the window later means regenerate-and-rerun, so it must be decided here.

**6. What workflows are being executed?**
- For any non-trivial system, real traffic is a mix of workflows, not a single endpoint
- List every workflow that will run during the test
- What percentage of traffic does each workflow represent?
- Example: "60% product search, 25% add to cart, 10% checkout, 5% account management"
- These percentages become the traffic-mix load model — if wrong, the test is wrong. A single TestPlan produces one workflow asset per entry here (each tagged with its `workflowName`), so the workflow list directly determines how many scripts Stage 3 generates.

**7. Authentication and authorization**
- How does the test authenticate? API key, OAuth2 client credentials, session cookie, JWT, mTLS?
- Are test credentials available? Where are they stored?
- Are there authorization boundaries to test? (e.g. "user A cannot see user B's data")
- Rate limiting: does auth apply rate limits that would interfere with load testing?

**8. Test data**
- What data does the test need to execute? (user accounts, product IDs, order IDs, etc.)
- Is the data reusable or consumable?
  - **Reusable**: same records can be hit repeatedly (e.g. product search, read-heavy APIs)
  - **Consumable**: each test run uses up records (e.g. create order, send message, register user)
- For consumable data: how much is needed? Can it be regenerated? Is there a reset API?
- How much backend data is needed for realistic results? (e.g. "search needs 10M products to be realistic")
- Where does test data come from? Pre-seeded in the environment? Generated by the test? Pulled from a snapshot?

**9. Existing artifacts**
- Are there functional test cases we can adapt? (Selenium, Cypress, Postman, Pytest)
- Is there a repo we can access?
- Is there an OpenAPI spec, Swagger doc, or Postman collection?
- Are there existing k6 or JMeter scripts?
- These artifacts can dramatically accelerate script generation — always ask

**10. Environment details**
- What is the target URL / endpoint? (Never discoverable — always ask)
- Is this a stable environment or is it shared/volatile?
- Are there any known constraints on the environment? (e.g. "don't hit more than 100 RPS or the shared DB will impact other teams")
- The target is external and third-party: we validate it is reachable and behaves as expected (Stage 4), but we never provision or warm it.

**11. Dynatrace configuration**
This is a required question cluster, not optional. Dynatrace is the visualization and server-side monitoring layer for all test runs — and for async protocols it is the *authoritative* source of record for percentiles, not merely diagnostic.

- Is Dynatrace instrumented on the target application?
- What is your Dynatrace tenant URL? (e.g. `https://abc12345.live.dynatrace.com`)
- What is the Dynatrace API token we should use for querying? (read-only, stored in Secrets)
- What is the **service entity ID** for this application in Dynatrace? (e.g. `SERVICE-1234ABCD`) — this is required to pull server-side metrics during the test. If they don't know it, help them find it: "Search for your service name in Dynatrace under Services and copy the entity ID from the URL."
- Do you have an existing Dynatrace dashboard for this service? If yes, provide the dashboard URL — we will link to it from the test run report rather than building a separate chart.
- If no dashboard exists: should we create one scoped to the test run time window? We can generate a Dynatrace dashboard link with the exact start/end timestamps of each run.
- Which server-side metrics matter for this test? Common choices:
  - Service response time (server-side latency, complements k6 client-side p95)
  - Service error rate (4xx/5xx from the server's perspective)
  - Throughput (requests/min on the service)
  - Database call time (average and max DB query duration)
  - External call time (downstream service latency)
  - CPU and memory saturation (infrastructure headroom during peak load)
  - JVM/GC metrics (for Java services)
- Note: if the target is **synchronous**, Dynatrace is diagnostic-only ("the why" behind a client-side breach) — k6 remains authoritative for the verdict. If the target is **asynchronous**, Dynatrace is the *only* place a meaningful latency percentile exists, so a complete `dynatrace` block (tenant, token, service entity ID) is **mandatory**, not optional. For a shared external service, Dynatrace data is contaminated by other tenants' traffic, which is precisely why it is authoritative only for async and diagnostic-only for sync.
- If Dynatrace is genuinely unavailable for a sync target, we can proceed with k6 client-side metrics only — but we lose visibility into whether performance issues are in the application, the database, or infrastructure. For an async target, absence of Dynatrace is a stop-and-ask: there is no fallback source of record.

### Conversation Rules
- Ask one cluster of questions at a time, not a 20-item form
- Validate answers for internal consistency ("you said 500 concurrent users but your SLA is p95 < 50ms — for an external API that's aggressive, have you validated this is achievable?")
- If an answer unlocks a new question branch, ask the branch questions before moving on
- Surface contradictions explicitly: "You said data is reusable, but your workflow includes account registration — that's consumable data. How should we handle that?"
- Never move to Stage 2 with unresolved contradictions — stop and ask; there is no degraded fall-through

### The No-SLA / No-Load Branch (Discovery does not dead-block)

A customer may arrive with **no SLA targets and/or no load model** — they don't yet know what "good" looks like, or they want to learn the system's behavior before committing to a threshold. Discovery does **not** dead-block on this. It **recognizes the gap** and offers a path forward rather than refusing to proceed:

- **BASELINE run** (`testIntent = baseline`) — establish the uncontended single-user latency floor. This is **v1**: it derives the `constant-vus {vus:1}` branch (Stage 2), the run characterizes the floor, and Stage 8 resolves it to the **`characterization`** gate outcome (a `pass` CI signal, human-promotable to a proposed SLA/baseline). This is the right answer when the customer wants to know "how fast is one request when nothing is contending?"
- **EXPLORATORY characterization** (`testIntent = exploratory`) — a no-SLA discovery ramp that pushes load until the system shows distress, to find the knee/breakpoint and recommend an SLA. This intent is **recognized in v1** (Discovery offers it; it too resolves to the `characterization` gate outcome), but the **distress-ramp generator is DEFERRED to the analysis wave** — so when a customer picks it, **tell them characterization is coming** and, for now, either capture the intent for the deferred path or steer them to a baseline run.

**The relaxation is narrow.** Choosing baseline or exploratory relaxes **only** the SLA-target / load-model block — it does **not** relieve the rest of the requirements meeting. Discovery **still stop-and-asks Q3 (synchronous vs asynchronous)** and **Q8 (the data strategy — reusable vs consumable)**: refusing to commit an SLA does not tell us how to measure latency or how to source test data, and getting either wrong silently tests the wrong thing. A no-SLA customer is still owed a complete, signed-off RequirementsDocument on every axis except the thresholds they explicitly deferred.

### Outputs
The entity below is persisted to the net-new `requirements_documents` table (**Data Model §1**). Every field maps to a column there; this is the shape the discovery agent produces, not a redefinition of the DDL.

```
RequirementsDocument {
  id                              // stable id; the single source of truth all
                                  // downstream stages reference, never copy
  companyId
  pipelineRequestId
  appName, appDescription
  ownerUserId                     // gates all downstream human decisions

  testIntent: "conformance" | "baseline" | "exploratory"
                                  // conformance = known SLAs -> validate -> gate.
                                  // baseline = uncontended single-user floor characterization
                                  //   (v1: constant-vus branch, resolves to the characterization
                                  //   gate outcome — Stage 8).
                                  // exploratory = no-SLA discovery ramp. RECOGNIZED in v1
                                  //   (Discovery offers it, it resolves to the characterization
                                  //   gate outcome); the distress-ramp GENERATOR that drives a
                                  //   load-to-knee ramp is DEFERRED to the analysis wave.

  protocol: "http" | "grpc" | "kafka" | "websocket" | "browser" | string[]
  syncModel: "sync" | "async" | "hybrid"   // selects the Stage-6 source of record
  asyncDetails?: { measurementPoint, sagaDescription }

  // CANONICAL SLA TARGETS — the only authoritative copy in the system.
  // Referenced by stable id downstream (TestPlan, SLAVerdict, GateResolution);
  // never snapshotted, never copied. Editing here propagates everywhere.
  slaTargets: [{
    id: string                    // STABLE id — sla_verdicts.slaTargetId joins this
    source: "k6" | "playwright" | "apm:dynatrace" | string
          // which feed EVALUATES this target. Aligned with SLAVerdict.source:
          //   k6 (sync source of record), playwright (browser harness),
          //   apm:dynatrace (async source of record / sync diagnostic).
    metric: "p95_ms" | "p99_ms" | "error_rate" | "tps" | "mps"
          | "saga_completion_ms" | string
    operator: "lt" | "lte" | "gt" | "gte"
    threshold: number
    required: boolean             // REQUIRED target: if it cannot be measured, the run is
                                  //   inconclusive (never a false-green pass). The gate reads
                                  //   exactly this flag (fix 4, Stage 8). Optional targets do
                                  //   not force inconclusive on absence.
    workflowScope?: string        // a workflowName for a per-workflow SLA;
                                  //   absent = aggregate. Drives Stage-2 execution model.
    approvedByUserId?: string     // must be set before plan creation (required targets)
  }]

  // Captures every input the Stage-2 protocol-tagged discriminated load-profile
  // union consumes. WHICH executor branch instantiates is DERIVED from these:
  //   peakConcurrentUsers -> ramping-vus
  //   peakTps             -> constant/ramping-arrival-rate
  //   peakMps             -> Kafka producer/consumer-rate
  loadModel: {
    peakConcurrentUsers?: number  // -> ramping-vus executor
    peakTps?: number              // -> arrival-rate executor
    peakMps?: number              // messages/sec for Kafka -> producer/consumer-rate
    loadProfile: {
      // explicit ramp-up / steady-state / ramp-down stages.
      // the steady-state plateau is the up-front design input from which
      // Stage 6 derives its SLA evaluation window (baked into the generated asset).
      targetUnit: "vus" | "rate"   // what stages[].target counts at the REQUIREMENTS layer,
                                   //   recorded BEFORE the Stage-2 executor is derived so the
                                   //   number is unambiguous. A target authored as TPS (rate)
                                   //   must NOT be silently reinterpreted as VUs downstream.
      stages: [{ duration: string, target: number }]
    }
    trafficMix: [{
      workflow: string            // becomes a TestAsset.workflowName in Stage 3
      percentage: number
      description: string
    }]
  }

  authentication: {
    type: "api_key" | "oauth2_client" | "session" | "jwt" | "mtls" | "none"
    credentialReference: string   // where creds live (Secrets key name)
    rateLimitAware: boolean
  }

  testData: {
    dataStrategy: "reusable" | "consumable" | "mixed"
    consumableItems?: [{ name, volumeNeeded, resetMechanism }]
    backendDataVolume?: string
    existingDataSource?: string
  }

  existingArtifacts: {
    openApiSpec?: string          // URL or content
    postmanCollection?: string
    functionalTestRepo?: string
    existingScripts?: [{ engine, path }]
    // existingArtifacts are READ-ONLY inputs — Sentinel imports and adapts them in
    // Stage 3 (recording origin in TestAsset.sourceRef) and never writes back to the
    // repo; see Stage 3 "Reusing & updating existing assets".
  }

  targetEnvironment: {
    baseUrl: string
    environmentType: "staging" | "production" | "dev" | "unknown"
    knownConstraints?: string[]
  }

  // Full Dynatrace block. Mandatory for async targets (authoritative source of
  // record); for sync targets it is diagnostic-only and may be omitted only if
  // DT is genuinely unavailable.
  dynatrace?: {
    tenantUrl: string                  // e.g. https://abc12345.live.dynatrace.com
    apiTokenSecretKey: string          // Secrets store reference (read-only token)
    serviceEntityId: string            // e.g. SERVICE-1234ABCD
    existingDashboardUrl?: string      // link to existing DT dashboard
    createDashboardPerRun: boolean     // whether to generate time-scoped dashboard links
    trackedMetrics: string[]           // which DT metrics to pull during execution
    // e.g. ["builtin:service.response.time", "builtin:service.errors.total.count",
    //        "builtin:service.requestCount.total", "ext:db.query.time"]
  }

  // Global minimum sample count for a meaningful percentile (the min-sample guard).
  // If a required target's evaluated sampleCount falls below this, Stage 6 resolves
  // the target to `inconclusive` (fix: insufficient-sample trigger). A per-target
  // override may be set on slaTargets[]; absent that, this document-level value applies.
  minSampleCount: number               // default 200 (p95 floor); the deterministic threshold both
                                       //   Stage 6 ("min-sample guard") and Stage 8 step 2 read.
                                       //   PERCENTILE-AWARE: the floor scales with the strictest
                                       //   percentile among slaTargets[] (~10/(1-p): p95 -> 200 =
                                       //   default, p99 -> ~1000).

  status: "in_progress" | "complete" | "approved"
  approvedByUserId?: string
  approvedAt?: timestamp
}
```

### Human Gate
The Requirements Document requires explicit human approval before Stage 2. The agent proposes; a human (ideally the system owner or a performance engineer) reviews and approves. This is not a rubber stamp — if the SLA thresholds look wrong, this is where to catch it.

The gate is a chain of states on the `requirements_documents` row (see the status-transition table in **Data Model §4**):
- `in_progress` — discovery still gathering; Stage 2 cannot start.
- `complete` — discovery has everything; awaiting human approval. This is the **stop-and-ask** gate.
- `approved` (**and** every required `slaTargets[].approvedByUserId` set) — plan creation is allowed, and the SLA targets become referenceable by stable id from the TestPlan and all verdicts.

Plan creation may not begin until the document is `approved` and all required SLA targets are individually approved. This stage Issue is the Paperclip `[DIS]` Issue (the 3-letter prefix matching the stage↔Issue mapping table under The Pipeline Object); its status is the authoritative driver — `StageRecord.status` for discovery is a derived projection of that Issue, not a parallel state machine.


---

## Stage 2: TEST PLAN

### Philosophy
A test plan is the engineering translation of the Requirements Document. Where the Requirements Document is conversational and human-readable, the test plan is precise and machine-executable. It answers: exactly what executor will run, against exactly what endpoints, with exactly what data, at exactly what load — in a form that compiles directly into k6 `options.scenarios`.

The agent writes the first draft of the test plan from the Requirements Document. It should not require further human input at this stage — if the Requirements Document is complete, the test plan should be **derivable**. Every consequential field of the plan is *derived from* the RequirementsDocument, not invented here: the protocol, the sync/async model, and the load figures (`peakConcurrentUsers` / `peakTps` / `peakMps`) deterministically select which load-profile branch instantiates and which executor it uses. If the agent cannot derive a complete test plan from the Requirements Document, the Requirements Document is incomplete and discovery must resume (stop-and-ask — no degraded fall-through).

The test plan owns the **load profile** and the **execution model**. It translates "500 concurrent users with a 5-minute ramp-up" into a concrete executor stage array; it translates "sustain 2,000 TPS" into an open-model arrival-rate executor; it translates "60% search, 25% cart, 10% checkout" into either weighted iteration selection or named per-scenario blocks; and it translates the data strategy into concrete data-file references or generation scripts.

The test plan does **not** own the SLA targets. Those live exactly once, on the RequirementsDocument, and the plan **references them by stable id** (decision #8). There is no copy on the plan, no snapshot, no reconciliation. Editing an SLA target in the RequirementsDocument is immediately reflected at evaluation time.

### The Load Profile Is a Protocol-Tagged Discriminated Union

The original draft modeled `loadProfile` as a single flat shape — `{ vus, stages }` — which is HTTP-and-closed-model only. That is wrong for two reasons, and both are load-bearing (decision #3, contradiction 3):

**1. Protocols are first-class, so the profile must be protocol-tagged.** A Kafka producer load is described by `producerRate` (messages/sec injected), not by a VU count. A streaming/WebSocket load is described by `concurrentConnections` and `messagesPerConnectionPerSec`. Forcing all of these into `{ vus, stages }` loses the dimension that actually defines the load. The profile is therefore a discriminated union, tagged first by protocol family and then by an explicit k6 **`executor`** discriminator.

**2. A closed model cannot hold a throughput target.** `ramping-vus` is a *closed* model: it controls *concurrency* (how many VUs loop), not *arrival rate* (how many requests start per second). Under a closed model, achieved TPS is an emergent function of VU count and server latency — `TPS ≈ VUs / iterationDuration`. The moment the system under test slows down, iterations take longer, throughput *drops*, and the test silently backs off exactly when you most need sustained pressure. **You cannot guarantee a TPS/MPS SLA with a concurrency-controlled executor.** Therefore: a `peakTps` requirement derives an **open-model arrival-rate executor** (`constant-arrival-rate` for a flat target, `ramping-arrival-rate` for a profiled target), which holds requests-per-second regardless of latency by allocating VUs dynamically; a `peakConcurrentUsers` requirement derives `ramping-vus`; a `peakMps` Kafka requirement derives the Kafka producer-rate branch. The derivation is mechanical and lives in the table below.

**VU allocation for the arrival-rate branch (`preAllocatedVUs` / `maxVUs`).** An arrival-rate executor holds the target rate only if it has enough VUs to absorb in-flight latency; under-allocation makes k6 **drop iterations** and silently fail to hold the rate. The allocation is derived, not guessed:
- `preAllocatedVUs = ceil(rate × p95_latency_estimate_seconds)` — by Little's Law, the concurrency needed to sustain `rate` requests/sec at that service time.
- `maxVUs ≈ 4 × preAllocatedVUs` — headroom so k6 can spin up extra VUs when latency grows under load (the moment headroom is most needed).
- The **`p95_latency_estimate`** is sourced from the SLA p95 ceiling when one is present; otherwise from the Stage 4 smoke-run measured latency. (A baseline run, having no rate, needs no such allocation.)

| RequirementsDocument signal | Derived branch | Executor | Why |
|---|---|---|---|
| `peakConcurrentUsers` (session/browser) | `ramping-vus` | `ramping-vus` | Concurrency is the goal; sessions are the unit |
| `peakTps` / `peakRps`, flat target | `arrival-rate` | `constant-arrival-rate` | Open model holds TPS independent of latency |
| `peakTps` / `peakRps`, profiled (ramp/sustain/ramp) | `arrival-rate` | `ramping-arrival-rate` | Open model + staged target schedule |
| `peakMps` (Kafka) | `kafka` | (xk6-kafka producer/consumer) | Rate is messages/sec, not VUs |
| WebSocket / SSE streaming | `streaming` | (long-lived connections) | Load is connections × msg-rate, not iterations |
| `testIntent = baseline` (or a 1-VU characterization request) | `constant-vus` | `constant-vus {vus:1}` | Uncontended floor; throughput is the OUTPUT, not a target — no peak figure derives it |

**Baseline is derived from `testIntent`, not from a peak load figure.** A well-specified baseline request carries its intent (a single-user latency floor) and needs no `peakConcurrentUsers` / `peakTps` / `peakMps` at all — throughput is the *output* of a baseline, never an input to it. The Stage-2 "derivable" contract is therefore: the `cannot derive → resume discovery` rule must **NOT** bounce a well-specified baseline request just because `loadModel` has no peak. Absence-of-peak is a stop-and-ask *only* when `testIntent` is a load/throughput intent that genuinely requires one.

**Sustain-throughput evaluation window — where the window origin comes from.** The two arrival-rate executors derive their evaluation window differently, and conflating them loses the window origin:
- A **profiled** throughput target derives `ramping-arrival-rate` **with explicit rate stages**, so the evaluation window comes directly from the stage phases (the steady plateau between the last ramp-up stage and the first ramp-down stage).
- A **flat sustain** `constant-arrival-rate` has **no stages**, so on its own it has no window origin. It MUST therefore carry an explicit `evaluationWindow: { warmup, steady, cooldown }` duration triple (the field on the `constant-arrival-rate` branch below) that *defines* the evaluation window — without the triple a flat rate has nothing to derive `phase:steady` from.

**What the generator emits for "sustain N TPS":** `ramping-arrival-rate` by default — a short ramp-up + steady + ramp-down — so the window origin is the stage schedule, not an out-of-band triple. The bare `constant-arrival-rate { warmup, steady, cooldown }` form is reserved for when a truly flat injection rate is explicitly required.

### Default Stage-Shaping (When Discovery Captured Only a Peak)

When the RequirementsDocument captured only a **peak** figure with no explicit `loadProfile.stages`, the plan does not refuse to derive — it derives **default stages** from the peak:

- **ramp-up** = 10% of total duration (minimum 30s)
- **steady** = 80% of total duration
- **ramp-down** = 10% of total duration (minimum 30s)

> **Stage label vs. phase tag (hyphen vs. underscore).** The load-PROFILE stage labels here (`ramp-up` / `ramp-down`) are hyphenated by convention, but the `phase` TAG values the VU stamps on each sample are the underscored enum members `ramp_up` / `ramp_down` — matching `metric_series.phase` (`warmup | ramp_up | steady | ramp_down`). A profile stage named `ramp-up` produces samples tagged `phase:ramp_up`; the two are the same concept in different layers, not different tokens. No reinterpretation across the hyphen/underscore boundary.

The steady window begins only **after load is achieved and stabilized** — that is, at the ramp-up stage end **plus a stabilization guard** — so that partially-loaded samples taken while VUs/arrival-rate are still climbing **never** carry `phase:steady`. The `phaseFor()` request-time tagging (Stage 3) keys on this stabilized steady boundary, not the raw ramp-end instant.

This is what makes a peak-only plan genuinely **derivable**: a captured peak deterministically yields a complete stage schedule, closing the false "derivable" claim where a bare peak previously had no stages to derive a window from.

### The Execution Model Is Also Requirements-Driven

Orthogonal to *how load is shaped* is *how the workflow mix is realized*. Two strategies, selected by whether per-workflow SLAs exist:

- **`weighted-loop`** — a single executor runs one script that, each iteration, selects a workflow according to the traffic-mix weights (e.g. 60/25/10/5). Cheapest to run; correct when the SLAs are aggregate (one p95 across all traffic).
- **`per-scenario`** — each workflow becomes its **own named k6 scenario** with its own executor, its own slice of the load, and its own threshold block. **Selected iff the RequirementsDocument carries per-workflow SLAs** — because a per-workflow SLA (`checkout p95 < 300ms`) can only be evaluated if `checkout` requests are isolated into their own scenario with a `{workflow:checkout}`-tagged threshold. This is what makes the windowed per-workflow percentile in Stage 6 exact rather than an aggregate average.

Two precision rules make `per-scenario` exact:
- **Every workflow gets its own named scenario — even SLA-less ones.** Under `per-scenario`, *all* workflows in the traffic mix compile to their own named scenario, not just the ones carrying a per-workflow SLA. This preserves weight fidelity (each workflow injects at its own `weight × peak` rate) and tag isolation (each workflow's samples are cleanly separable), regardless of whether that specific workflow is gated.
- **A target with NO `workflowScope` compiles to a SINGLE doc-level threshold.** An aggregate target (e.g. a global error-rate ceiling with no `workflowScope`) becomes **one** threshold over the steady window at the document level — it is **NEVER** duplicated per scenario. Duplicating it would evaluate the same aggregate SLA N times against N partial sub-metrics and produce N spurious verdicts; the aggregate is evaluated exactly once across all traffic.

`per-scenario` is the bridge to the Stage 6 source-of-record decision: tagged scenarios produce the `{workflow, phase}`-tagged sub-metrics that the in-runner percentile computation depends on.

### Scenarios Are Emitted From Config, Not CLI Flags

The plan compiles into **`options.scenarios` inside the generated k6 script's config object** — never into `k6 run --vus … --duration …` CLI flags. CLI flags can express only a single closed `ramping-vus`-like load; they cannot express arrival-rate executors, multiple named scenarios, per-scenario tags, or per-scenario thresholds at all. The portable unit of this whole pipeline is the k6 script + `handleSummary` (executor-agnostic across the local Paperclip harness and the generated GHA workflow); baking the full scenario set into the script's `options` is what keeps that unit self-contained and identical across both harnesses. The generator reads `loadProfile` + `executionModel` from the TestPlan and writes the corresponding `options.scenarios` map.

### Workflow Assets Are Referenced By FK, Not An Inline String

The original `workflowWeights[].scriptRef?: string` was a soft, optional, free-text pointer that could dangle or duplicate. It is replaced by a real foreign-key relationship: a workflow's generated script lives in `test_assets`, keyed by **`UNIQUE (testPlanId, workflowName, engine)`** with **`workflowName NOT NULL`** (see the Data Model section for the `test_assets` columns). The TestPlan carries the traffic mix and weights; the *script* for each `(workflowName, engine)` is resolved through that key. Regeneration of a workflow script **replaces** the keyed asset rather than appending a duplicate, and a plan can never reference a script that does not exist. One TestPlan therefore fans out to many workflow assets — one per `(workflowName, engine)` pair the traffic mix demands.

### Staging
The discriminated union **expresses all protocols now** — the type is complete on day one so the schema never has to change to admit gRPC, Kafka, or streaming. The **generators and adapters are built incrementally**: HTTP/sync (`ramping-vus` + `constant-arrival-rate`) ships first and is the only branch with a working generator in v1; the arrival-rate-for-throughput, Kafka, and streaming branches are reserved by the type and filled in fast-follow. The model leads; the code follows.

### Outputs
```
TestPlan {
  id
  requirementsDocumentId        // FK → requirements_documents.id; SLA targets
                                 //      are read THROUGH this, never copied (decision #8)
  name, description

  protocol: string              // derived from RequirementsDocument.protocol

  engines: string[]             // ["k6"] | ["playwright"] | ["k6", "playwright"]

  // ── Protocol-tagged discriminated load profile (decision #3) ──
  // WHICH branch instantiates is DERIVED from the RequirementsDocument:
  //   peakConcurrentUsers → ramping-vus     (closed model — concurrency)
  //   peakTps / peakRps   → arrival-rate     (open model — holds throughput)
  //   peakMps             → kafka            (producer/consumer rate)
  //   websocket/sse       → streaming        (connections × msg-rate)
  loadProfile:
    | { protocol: "http" | "grpc" | "graphql"
        executor: "ramping-vus"
        startVus?: number
        stages: [{ duration: string, target: number }]   // target = VUs
        gracefulRampDown?: string
        thinkTime?: number }                              // ms pause between iterations
    | { protocol: "http" | "grpc" | "graphql"
        executor: "constant-arrival-rate"
        rate: number, timeUnit: string                    // e.g. 2000 per "1s"
        duration: string
        // Flat constant-arrival-rate has NO stages, so on its own it has no window
        // origin. This triple is the REQUIRED carrier the sustain-window rule above
        // mandates — it DEFINES the {warmup, steady, cooldown} evaluation window the
        // VU derives phase:steady from. Required only for this reserved flat form;
        // the default "sustain N TPS" emit is ramping-arrival-rate (window from stages).
        evaluationWindow: { warmup: string, steady: string, cooldown: string }
        preAllocatedVUs: number, maxVUs: number }         // VUs allocated to HOLD the rate
    | { protocol: "http" | "grpc" | "graphql"
        executor: "ramping-arrival-rate"
        startRate: number, timeUnit: string
        stages: [{ duration: string, target: number }]    // target = arrival RATE
        preAllocatedVUs: number, maxVUs: number }
    | { protocol: "kafka"
        producerRate?: number       // messages/sec injected   (from peakMps)
        consumerRate?: number       // messages/sec drained
        duration: string }
    | { protocol: "websocket" | "sse"
        concurrentConnections: number
        messagesPerConnectionPerSec: number
        duration: string }
    | { protocol: "http" | "grpc" | "graphql"
        executor: "constant-vus"        // TRUE BASELINE — uncontended single-user latency floor
        vus: number                     // typically 1; NO thinkTime => iterations fire back-to-back
        duration: string }              // SIZED to accrue >= minSampleCount steady samples (Stage 6)
  // Note: iteration-count executors (per-vu-iterations / shared-iterations) are reserved by
  //       type for "run exactly N iterations" baselines (fast-follow), not built in v1.

  // ── How the workflow mix is realized (decision #3) ──
  executionModel: "weighted-loop" | "per-scenario"
                                // per-scenario IFF per-workflow SLAs exist on the
                                // RequirementsDocument (enables {workflow}-tagged thresholds)

  workflowWeights: [{
    workflowName: string        // joins test_assets.workflowName (FK, NOT NULL)
    weight: number              // 0-100, must sum to 100
                                // NOTE: scriptRef removed — the script is resolved via the
                                // UNIQUE(testPlanId, workflowName, engine) key on test_assets
  }]

  targetEnvironment: {
    baseUrl: string
    apmProvider?: string
    apmServiceId?: string
  }

  dataConfig: {
    strategy: "reusable" | "consumable" | "mixed"
    dataSources: [{ name, type: "file" | "api" | "generated", reference }]
  }

  authConfig: {
    type: string
    secretKey: string           // reference to Secrets store
  }

  // NO slaTargets field. SLA targets are NOT copied onto the plan — they are
  // referenced live via requirementsDocumentId and joined at evaluation time
  // by sla_verdicts.slaTargetId → requirements_documents.slaTargets[].id (decision #8).

  filePatterns: string[]        // CI trigger patterns (execution against THIS plan)
  schedule?: string             // cron for scheduled runs
  isActive: boolean
}
```

> **k6 compilation sketch (config, not CLI).** A `peakTps: 2000` flat HTTP requirement with per-workflow SLAs compiles to a `per-scenario` plan whose generated script carries:
> ```javascript
> export const options = {
>   scenarios: {
>     // NOTE: `tags: { workflow }` is a SCENARIO-LEVEL tag (static, set here).
>     // The `phase` tag is NOT set here — it is stamped PER-REQUEST inside the exec
>     // function by the VU (see below), reading exec.instance.currentTestRunDuration
>     // against the steady-state window. That is the source of the `phase:steady`
>     // threshold key two lines down.
>     checkout: { executor: "constant-arrival-rate", rate: 200, timeUnit: "1s",
>                 duration: "10m", preAllocatedVUs: 100, maxVUs: 400,
>                 exec: "checkout", tags: { workflow: "checkout" } },
>     search:   { executor: "constant-arrival-rate", rate: 1200, timeUnit: "1s",
>                 duration: "10m", preAllocatedVUs: 200, maxVUs: 800,
>                 exec: "search", tags: { workflow: "search" } },
>     // … one scenario per workflowWeights[] entry, rate = weight × peakTps …
>   },
>   thresholds: {
>     // `phase:steady` is produced by the PER-REQUEST tag below, NOT by the scenario tags.
>     'http_req_duration{workflow:checkout,phase:steady}': ['p(95)<300'],
>     // … per-workflow tagged thresholds drive the Stage-6 windowed verdict …
>   },
> };
>
> // Per-request phase tagging — this is what produces the `phase` tag the threshold keys on.
> export function checkout() {
>   const currentPhase = phaseFor(exec.instance.currentTestRunDuration); // warmup|ramp_up|steady|ramp_down
>   http.get(`${BASE}/checkout`, { tags: { phase: currentPhase } });     // stamps phase per request
> }
> ```
> The arrival-rate executor holds 2,000 req/s by allocating VUs as latency demands — the closed `ramping-vus` model could not. The `{ workflow }` tag is scenario-level; `phase` is stamped per request, so the `phase:steady` threshold key has a defined source within this same example.

### Human Gate
The agent presents the test plan to the human who approved the Requirements Document. Specific review points:
- Does the **executor choice** match the load intent? (concurrency target → `ramping-vus`; throughput target → arrival-rate — confirm the open model was chosen for any TPS/MPS SLA)
- Does the load profile match the traffic model they described?
- Are the workflow weights correct, and do they sum to 100?
- Is the `executionModel` right — `per-scenario` only where per-workflow SLAs genuinely exist?
- Is the data strategy viable for their environment?

---

## Stage 3: SCRIPT GENERATION

### Philosophy
Script generation is where the test plan becomes a **portable, self-reporting execution bundle**. This is the heart of Sentinel-as-asset-factory: the stage does not run anything and never reaches into the customer's CI. It emits a bundle — a k6 script, the data files it consumes, setup/teardown, and (for production) a generated GitHub Actions workflow YAML — that *some other harness* will execute and that reports its own results back to Sentinel's ingestion endpoint. The portable unit is the k6 script + `handleSummary`; it is executor-agnostic. Only the harness swaps: Sentinel's own load-test-agent spawning k6 in a Paperclip `ExecutionWorkspace` (now, for testing Sentinel locally) versus the generated GHA workflow running on the customer's runner (later, in production). Same script, same `TEST_RUN_ID`, same ingestion endpoint, same SLA/gate/report path. Control flows runner→Sentinel only.

This stage has a clear priority order for sourcing the k6 script:

1. **Existing scripts (read from a repo or prior asset)** — if a human-authored or previously approved script already exists for this workflow — in the customer's repo, in our own test repo, or as a stored `test_assets` row — **import and reuse it; do not regenerate what already works.** Sentinel discovers existing k6 by cloning the referenced repo **read-only** into a Paperclip `ExecutionWorkspace` (from `RequirementsDocument.existingArtifacts.functionalTestRepo` / `existingScripts[]`), parsing the scripts, and recording each script's origin in `TestAsset.sourceRef` (`repoUrl`, `path`, `ref`, `importedSha`). An imported manual script is `human_authored`; a previously Sentinel-generated script a human committed is `approved_generated`. See *Reusing & updating existing assets* below.
2. **Adapt from artifacts** — if there's a Postman collection, OpenAPI spec, or functional test, transform it. A k6 script derived from an OpenAPI spec is more trustworthy than one generated from scratch.
3. **Generate from scratch** — if nothing exists, generate from the RequirementsDocument workflow descriptions. This is the lowest-confidence path and requires the most review.

Generated scripts are always in `generated` status. They require human approval before being promoted to `approved_generated`. Only `human_authored` and `approved_generated` scripts run in production test executions. `generated` scripts can run in preview/validation executions for review purposes.

**Data handling is part of script generation.** A script that uses a static list of 10 user IDs is wrong for a 500-VU test. The generation stage must produce not just the script but the data files, data generation utilities, and data validation checks. The data strategy maps directly onto k6 constructs:
- **Reusable data** (read-heavy: product search, lookups) → loaded once into a `SharedArray` so every VU reads the same backing store with no per-VU memory blow-up.
- **Consumable data** (each iteration uses up a record: create order, register user, send message) → **claimed per iteration off a monotonic key** so two iterations never claim the same record. The claim key is **`exec.scenario.iterationInTest`** — a per-scenario monotonically increasing index that is valid under **both** executor families (the closed `ramping-vus` pool *and* the open arrival-rate executors). It must NOT be `exec.vu.idInTest`: a VU id is stable only for the closed ramping-vus pool, and an open arrival-rate executor recycles VU ids across iterations, so keying off the VU id would re-issue the same record to many iterations. Pre-shard the consumable data file **per scenario into DISJOINT slices** at generation time, and have each iteration draw `iterationInTest` (modulo its own scenario's slice size) from that slice.
  - **FORBID modulo-wrap for consumable data.** Wrapping the index back to the start of the slice (`iterationInTest % sliceSize`) re-issues an already-consumed record — that is **reuse, which is legal only for reusable data**. A consumable scenario must draw a strictly increasing index and run out (triggering the volume check below), never wrap.
  - **`setup()` VOLUME CHECK (abort loud on shortfall).** The generated `setup()` must count the available consumable records and **abort the run loudly** when `records < expectedIterations`, rather than silently wrapping or starving mid-run. `expectedIterations` is computed at generation time: for an **arrival-rate** scenario it is `Σ over consumable scenarios of (rate × steadyDurationSec)`; for a **ramping-vus** scenario it is a VU-throughput estimate (`peakVUs × steadyDurationSec / meanIterationLatencySec`). A shortfall is a stop-and-ask, not a degraded run.
  - A **generate-in-`setup()`** path — synthesizing each consumable record deterministically from a high-cardinality id keyed off `iterationInTest` (so no finite file can run out) — is the answer for very-high-volume consumable data, but it is the **Kafka/async fast-follow**, NOT v1. The `iterationInTest` claim key against a pre-sharded file is the v1 mechanism.
- Consumable data also requires a setup/teardown strategy baked into the script (seed/verify volume in `setup()`, clean up or reset in `teardown()`).
- **Mixed** → both, with the consumable partition isolated from the reusable `SharedArray`.

**The canonical HTTP/sync k6 template is the reference the generator produces against.** The reference implementation lives at `docs/superpowers/specs/2026-05-29-k6-http-canonical-template.draft.js`. It is the shape the v1 HTTP/sync generator emits — every generated HTTP/sync script should match its structure. It covers all three v1 HTTP/sync shapes:
- **Weighted-loop** — a single executor whose iteration body is a router that selects a workflow by traffic-mix weight and **stamps `{workflow}` per request inside the router** (so each request carries its own workflow tag); the aggregate latency threshold is keyed `{expected_response:true, phase:steady}` with **NO per-workflow threshold block** (the aggregate SLA is evaluated exactly once across all traffic — see Stage 2's aggregate-target rule).
- **Per-scenario** — each workflow compiled to its own named scenario with its own `{workflow}`-tagged threshold block.
- **True-baseline** — the uncontended `constant-vus {vus:1}` shape (throughput is the output, not a target — see Stage 2's `testIntent = baseline` row).

**Protocol awareness is critical.** A k6 script for HTTP looks nothing like a k6 script for Kafka (using the xk6-kafka extension), which looks nothing like a Playwright script. The agent must select the right script template, the right k6 module, and the right *binary profile* for the protocol defined in the TestPlan. **Staging:** the asset model expresses all protocols now; the generators/adapters are built incrementally — HTTP/sync first.

### `handleSummary` and the per-run output contract (non-negotiable)

**Every k6 script must include `handleSummary`.** This is the executor-agnostic reporting seam — it is what produces the native HTML report Stage 9 stores, regardless of which harness ran the script. A k6 script without it produces no stored artifact. The generator injects it into *every* k6 asset regardless of source (generated, adapted from OpenAPI, adapted from Postman). The contract has four locked rules:

1. **`TEST_RUN_ID` is injected as an environment variable** by the harness at execution time and read inside the script as `__ENV.TEST_RUN_ID`, so the output filename is unique per run and the summary can be correlated back to the right `execution_runs` row (fix 5).
2. **The summary is written into the per-run `ExecutionWorkspace` cwd**, then read back from that workspace by name after the process exits (fix 6). The `handleSummary` return keys are relative filenames; the harness owns the cwd. This is what makes the local-Paperclip path and the GHA path identical — both write into a per-run working directory and both read the same file back.
3. **The `handleSummary` HTML is a different artifact from the streaming feed.** The `--out json=-` (or `--out json=…`) stream is the live time-series feed; the `handleSummary` HTML is the end-of-run native report. They are distinct `test_run_artifacts` rows (`metrics_json_stream` vs `k6_html_summary`) and must never be conflated (fix 7).
4. **The exact same `handleSummary` ships in the local harness and the generated GHA workflow.** The harness swap is additive: nothing in the script changes when execution moves from Paperclip-local to the customer's GHA runner.

```javascript
// Required in every generated k6 script — executor-agnostic
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

export function handleSummary(data) {
  // Written into the per-run ExecutionWorkspace cwd; read back by name after exit.
  return {
    [`summary-${__ENV.TEST_RUN_ID}.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
```

### Windowed per-workflow sub-metrics (SYNC protocols)

For SYNC protocols, **k6 is the source of record** and percentiles are computed **in-runner**, not server-side. To make `http_req_duration{workflow:checkout,phase:steady}` p95 an *exact* windowed per-workflow percentile over only the matching samples, the generated script **must tag every request with `{ workflow, phase }`**:

- **`workflow`** identifies which traffic-mix workflow the request belongs to (checkout, search, …) so each workflow gets its own sub-metric percentile — aggregated p95 across workflows is useless for diagnosis.
- **`phase`** identifies the load phase (`warmup | ramp_up | steady | ramp_down`, matching the `metric_series.phase` enum — `warmup` is the front-edge cold-start exclusion built in v1). The VU derives it at request time from `exec.instance.currentTestRunDuration` against the steady-state window, which is an **up-front design input baked into the asset** (re-cutting the window = regenerate the asset + rerun). Tagging this way lets k6 emit a tagged threshold whose percentile is computed over *only* the steady-state samples — an exact windowed percentile, no post-hoc trimming.

These tags flow straight through to ingestion: `metric_series` carries `workflowName` + `phase`, and the Stage-6 `sla_verdicts` join on the `{ workflow, phase }`-scoped sub-metric. In-script tagging is exact **only for single-instance k6**; sharded/distributed load escalates to per-bucket t-digests merged server-side (or k6 Cloud). That swap is **additive** — the ingestion contract (`metric_series.digest` + `sampleCount`) already reserves it, so the generator emits the same tagged script either way.

For ASYNC protocols the script still runs and reports, but the authoritative percentiles come from Dynatrace server-side (decision #6) — the in-script tags remain useful as diagnostic correlation but are not the source of record.

### The CI execution harness is a GENERATED ASSET

The production execution harness is **not** something Sentinel operates — it is **generated as a TestAsset** of type **`ci_workflow`**: a GitHub Actions workflow YAML **for a human to commit** into the customer's repo. **Sentinel produces it; a human commits it** — Sentinel holds no git credentials and never pushes (Architecture §). The customer's runner executes it; results POST back. Sentinel never triggers GHA. The generated workflow has four locked responsibilities:

1. **Build the right k6 binary.** If the protocol needs an extension (`xk6-kafka`, the browser module, gRPC extras), the workflow includes an **xk6 build step** that produces a binary with those extensions — not a bare `k6` (fix 8). The resolvable binary path/profile is carried on `execution_runs.binaryProfile`; the workflow materializes it.
2. **Run the script** against the configured target, injecting `TEST_RUN_ID` as an env var and using a per-run working directory as the `ExecutionWorkspace` cwd, with the live `--out json` stream kept distinct from the `handleSummary` HTML written into that cwd.
3. **POST the summary back** to Sentinel's ingestion endpoint — the `handleSummary` HTML and the streamed metrics flow back to the same ingestion shape Sentinel's local harness uses. Control is runner→Sentinel.
4. **Final gate-verdict step.** A last step **polls Sentinel's verdict endpoint and fails the job** on `ciSignal='fail'` (Stage 8). This is the *only* CI signal path — Sentinel never pushes into GHA; the workflow pulls the verdict and fails itself. An `inconclusive` verdict fails the job too (never false-green).

The `ci_workflow` asset ships **fast-follow**: the `assetType` value is reserved now and the local Paperclip-harness path (k6 in an `ExecutionWorkspace`) is proven first; the GHA-workflow generator that produces and stores the bundle (`test_run_artifacts.artifactType = gha_workflow_bundle`) lands immediately after. Because the script and reporting contract are identical across both harnesses, generating the GHA bundle is purely additive.

### Script Types by Protocol
- **HTTP/REST** → k6 with `http` module *(ships first)*
- **GraphQL** → k6 with HTTP + query body construction
- **gRPC** → k6 with `k6/net/grpc` module *(requires xk6 build profile)*
- **WebSocket** → k6 with `k6/ws` module
- **Kafka** → k6 with `xk6-kafka` extension *(requires xk6 build profile)*
- **Browser** → Playwright (or k6 browser module for hybrid) *(requires xk6 build profile)*
- **Async/saga** → custom instrumentation script + correlation ID tracking (percentiles authoritative from Dynatrace, not k6 — decision #6)

### Outputs
A TestPlan produces **many** workflow assets (one per workflow in the traffic mix) plus, for production, one `ci_workflow` asset. Each asset is keyed `UNIQUE(testPlanId, workflowName, engine)` so regeneration *replaces* rather than duplicates.

```
TestAsset {
  id
  testPlanId
  workflowName: string          // a single TestPlan has many workflow assets
  engine: string
  binaryProfile?: string        // resolvable k6 binary path/profile (NOT literal 'k6');
                                //   names the xk6 build needed for kafka/browser/grpc
  protocol: string
  assetType: "human_authored" | "generated" | "approved_generated" | "ci_workflow"
  scriptContent: string         // for ci_workflow: the GitHub Actions workflow YAML
  dataFiles: [{ name, content, type: "csv" | "json" | "generated",
                strategy: "reusable" | "consumable" }]   // reusable→SharedArray, consumable→per-VU partition
  setupScript?: string          // data seeding / volume verification (k6 setup())
  teardownScript?: string       // data cleanup / reset (k6 teardown())
  version: number
  generatedFrom?: "openapi" | "postman" | "functional_tests" | "scratch" | "existing_k6"
  sourceRef?: { repoUrl, path, ref, importedSha }   // origin of an imported/updated asset;
                                //   READ-ONLY provenance — Sentinel never pushes; a human commits
}
```

> The full DDL for `test_assets` (the added `workflowName`, `protocol`, `dataFiles`, `setupScript`, `teardownScript`, `generatedFrom` columns, the extended `assetType` enum including `ci_workflow`, and the `UNIQUE(testPlanId, workflowName, engine)` key) lives in the Data Model section — this block is the runtime object shape.

### Reusing & updating existing assets — humans own every git write

Sentinel can **read and edit** existing test assets, but it performs **no git writes**: cloning is read-only, edits happen in a Paperclip `ExecutionWorkspace`, and every commit / push / pull-request is done **by a human**. This is the locked no-push architecture (Architecture §: "it does not hold CI credentials, it does not push commits") applied to assets.

- **Read.** Existing k6 — manually authored, or previously generated by us and committed by a human — is cloned read-only and imported as a `TestAsset` with `sourceRef` recording its origin (`repoUrl`, `path`, `ref`, `importedSha`).
- **Update.** When Sentinel adapts or improves an existing test, it edits in its workspace, stores the new `version`, and emits a **human-facing handoff**: the updated file content, a diff, and the `sourceRef` path telling the human exactly where to commit it. Sentinel never opens the PR.
- **The human's PR review *is* the approval gate.** Merging the human's commit/PR is the same act as the `generated → approved_generated` promotion — agents propose a diff, humans approve by merging. No separate gate, and it reinforces hybrid ownership.
- **Provenance round-trips.** Because `sourceRef` is recorded on import, a later update knows where the canonical copy lives, so "update a repo of an existing test" is a read → edit-locally → hand-back loop, never a Sentinel push.

### Human Gate
Every `generated` script requires human review before promotion to `approved_generated`. The review must confirm:
- Does the script actually test the described workflow?
- Does the script **tag every request `{ workflow, phase }`** so SYNC percentiles are windowed per-workflow in-runner?
- Does the script include the required `handleSummary` (with `TEST_RUN_ID` injected, output written to the run workspace, distinct from the JSON stream)?
- Does the data strategy match what the environment can support — reusable in a `SharedArray`, consumable partitioned per VU with setup/teardown?
- Are there any hardcoded values that should be parameterized?
- Does the script handle auth correctly?

The generated `ci_workflow` asset is reviewed on the same gate: does the workflow build the correct binary profile, run with `TEST_RUN_ID`, POST the summary back, and end with the gate-verdict check that fails the job on `ciSignal='fail'` or `inconclusive`?

---

## Stage 4: ENVIRONMENT VALIDATION

### Philosophy
We do not own the target environment. We cannot provision it, warm it, or guarantee its state. But we can — and must — verify it is ready before we load it.

Environment validation is a pre-flight check, not a smoke test. It does not test functionality. It answers: "Is the target reachable, is it responding with expected status codes, is auth working, and is the environment under a load that would pollute our results?"

If any pre-flight check fails, the pipeline stops and asks. It does not fall through to a degraded execution. A test run against an unhealthy environment produces misleading results — it will look like a regression when the environment was already struggling.

**Baseline pollution detection via Dynatrace.** Before running, query Dynatrace for the service's current response time and error rate, then compare against the trailing 1-hour average for that service. If either metric is already at >150% of its ambient baseline, the environment is already stressed — our results will be inflated and cannot be fairly compared to existing baselines. Surface this to the human with the specific numbers ("current p95 is 320ms vs 1-hour average of 180ms") and ask whether to proceed.

**Use Dynatrace-native transforms, never client-side math (fixes 1, 2).** The ambient check uses the same correctness contract the execution adapter uses, so the pre-flight number is computed the same way the post-run verdict will be:
- **Latency is a DT-native percentile transform**, not a client-side computation over per-bucket averages. The "current p95" is `builtin:service.response.time:percentile(95):fold` evaluated over the recent window and the trailing-1h window separately — never an average of bucket averages, which would silently understate the tail.
- **Error rate is count-weighted**, not a mean of per-bucket rates: `builtin:service.errors.total.count : fold` divided by `builtin:service.requestCount.total : fold` over the same window. Averaging per-minute error *rates* gives every bucket equal weight regardless of traffic and produces a wrong ambient number; weighting by request count is the only honest aggregation.

**Be ingest-lag aware.** Dynatrace ingestion lags wall-clock time (server-side metrics typically settle tens of seconds to a couple of minutes behind real time). A naive "from = now" query reads the still-filling, under-counted leading edge and reports an artificially *low* ambient load — exactly the false-green that lets us load a busy environment. The ambient query therefore ends at `now - ingestLagBufferMs` (default ~120s, configurable) rather than `now`, and the comparison window must contain enough settled buckets to be meaningful. If the most recent settled bucket is older than the staleness bound (the entity has effectively stopped reporting), this check yields **inconclusive**, not a pass — handled as a stop-and-ask, never silently skipped.

**DT is for pollution detection here, not source-of-record arbitration.** The sync/async authority split (k6 authoritative for SYNC, Dynatrace authoritative for ASYNC) governs the *verdict* in Stage 6. At pre-flight, Dynatrace is the only vantage point on the *target's* ambient state regardless of protocol, so the ambient check runs for any DT-configured target. It is a gate on environmental contamination, not a latency verdict.

If Dynatrace is not configured for this TestPlan, **skip every DT-dependent check and do not block** — the absence of Dynatrace is an expected configuration, not a failure. Fall back to reachability, auth, smoke test, and data-availability checks only. The run proceeds; we simply lose the ambient-pollution and server-side-correlation signals, and the report says so.

### Checks
1. **Reachability** — `GET {baseUrl}/health` or equivalent. Must return 2xx.
2. **Auth validation** — perform the auth flow with test credentials. Must succeed and return a valid token/session.
3. **Endpoint smoke test** — send one request per workflow at minimum load (1 VU, 1 iteration). Must return expected status codes. This catches "the endpoint doesn't exist at this URL" before loading 500 VUs.
4. **Dynatrace ambient load check** — query the Metrics v2 API using DT-native transforms for the configured `serviceEntityId`:
   - latency: `builtin:service.response.time:percentile(95):fold`
   - error rate: `builtin:service.errors.total.count:fold` ÷ `builtin:service.requestCount.total:fold`
   Evaluate each over a recent settled window (`to = now − ingestLagBufferMs`) and over the trailing 1-hour window, then compare. If the recent value is elevated >150% of the trailing-1h ambient baseline, flag for human review with the specific numbers. If the most recent settled bucket is stale, return **inconclusive** and stop-and-ask. If Dynatrace is not configured, skip.
5. **Dynatrace entity reachability** — confirm the service entity ID exists and is currently reporting settled data. If the entity ID is wrong or the service has stopped reporting, surface this before the test starts. A test run where we can't correlate server-side data is a degraded run — the human should know. If Dynatrace is not configured, skip.
6. **Data availability check** — if consumable data is needed, verify the data source has sufficient volume.

### Failure Handling
Each check has an explicit failure action:
- Reachability fails → block, notify, ask human to confirm environment status
- Auth fails → block, ask human to verify credentials in Secrets store
- Smoke test fails → block, surface the exact error response, ask how to proceed
- Dynatrace ambient elevated → warn with specific numbers, ask whether to proceed or wait
- Dynatrace ambient inconclusive (entity stale / too few settled buckets) → stop-and-ask, never proceed silently on a missing signal
- Dynatrace entity not found → warn, ask human to verify service entity ID in TestPlan config, offer to proceed without DT monitoring
- Data insufficient → block, provide guidance on how to replenish
- Dynatrace not configured → no failure; skip all DT checks and proceed on reachability + auth + smoke + data only

---

## Stage 5: EXECUTION

### Philosophy
Execution is the mechanical stage. By the time we get here, every decision has been made: the scripts are approved, the data is ready, the environment is validated, the load profile is defined. Execution should be boring.

What makes execution hard is that it runs for a long time (minutes, not seconds), it is stateful, it can fail partway through, and it produces a continuous stream of data rather than a single result. The pipeline must handle all of these.

**Sentinel is an asset factory and analysis control plane — not an execution orchestrator.** This is the load-bearing reframe of the entire stage. Sentinel never reaches into GitHub to trigger a run, and it never pushes commands into a GitHub Actions runner. Instead, Stage 3 produced a **portable, self-reporting execution bundle**: the k6 script, its `handleSummary`, the data files, and the run config. Execution is whatever **harness** picks up that bundle, runs it, and reports the results *back* to Sentinel. Control flows **runner→Sentinel only, never Sentinel→GHA**.

**The portable unit is the k6 script + `handleSummary` — it is executor-agnostic.** The exact same script, producing the exact same tagged sub-metrics and the exact same HTML summary, runs identically no matter who invokes it. Only the **harness** swaps:

- **Local harness (NOW — for testing Sentinel itself):** Sentinel's own `load-test-agent` spawns the k6 binary inside a Paperclip `ExecutionWorkspace`. The agent owns the process lifecycle, captures stdout, watches the live feed, and reads back the `handleSummary` output from the workspace cwd.
- **Generated GHA harness (LATER — production):** the bundle includes a **generated GitHub Actions workflow YAML** (`assetType = ci_workflow`) that the customer's own runner executes on their infrastructure. The workflow runs the identical k6 script and POSTs results back to Sentinel's ingestion endpoint. Sentinel generates and stores this YAML; the customer's CI runs it.

Both harnesses feed **one ingestion contract**. The k6 process streams live metrics and, on completion, the harness POSTs the metric series and the summary back to Sentinel's ingestion endpoint — `POST` of `metric_series` rows + the `handleSummary` artifact, keyed by `TEST_RUN_ID`. Whether the k6 process ran in a Paperclip workspace three feet away or in a customer's GHA runner across the internet, **the metrics are POSTed back the same way, to the same endpoint, in the same shape.** Same script, same ingestion endpoint, same downstream SLA/gate/report path. The harness is a swappable seam; everything downstream of ingestion is invariant to it.

**Live streaming is non-negotiable.** A 10-minute load test with no visibility until it's done is a black box. The execution stage streams metrics in real time: current RPS, current p95, current error rate, VU count. This serves two purposes: humans can watch the test and abort early if something goes wrong; the analysis stage can begin pre-processing while the test is still running. The streaming feed (`--out json=-`) is a **different artifact** from the `handleSummary` HTML — the former is the transient live channel, the latter is the stored per-run report. The live feed is surfaced via the `ExecutionRun.liveMetricFeed` SSE endpoint regardless of where the k6 process physically runs; in the GHA case the runner forwards samples to the ingestion endpoint and Sentinel re-broadcasts them on the SSE channel.

**Graceful abort.** If the error rate spikes above a configurable threshold mid-test (e.g. >10% errors for 30 consecutive seconds), the pipeline should surface an abort option to the human. Continuing to hammer a broken endpoint produces no useful data and may cause real harm to the target environment. Abort is harness-local: the local agent signals its k6 process; the GHA runner honors an abort flag polled from Sentinel — but Sentinel never reaches into the runner to kill it, it only publishes the abort intent for the runner to act on.

**Parallel execution.** When a TestPlan has multiple engines (e.g. both k6 and Playwright), they execute concurrently by default. This reflects real traffic — users don't stop browsing while the API is being hit. Each engine invocation is its own `ExecutionRun` row under the same `pipelineRunId`, so the multi-engine fan-out is modeled, not flattened. The load model defines the mix; execution honors it. `engine` and `binaryProfile` are resolved per `ExecutionRun` so a Kafka run (`xk6-kafka`) or a browser run does not collide with the plain HTTP `k6` binary.

**Per-workflow and per-phase tagging in results.** The k6 script runs the workflow mix, but metrics must be tagged by **both** workflow and phase. p95 for "checkout" and p95 for "search" are different numbers with different SLAs; aggregated p95 is almost useless for diagnosis. Critically, the percentile is computed **in-runner** over `{workflow, phase}`-tagged sub-metrics: `http_req_duration{workflow:checkout,phase:steady}` p95 is an exact windowed per-workflow percentile over only the matching samples, because each VU tags its `phase` from `exec.instance.currentTestRunDuration` against the steady-state window baked into the bundle. The execution stage must preserve those tags in `metric_series` (`workflowName` + `phase` columns). This in-script tagging is exact **only for single-instance k6**; sharded/distributed load escalates to per-bucket t-digests merged server-side. The ingestion contract is designed so that swap is **additive** — the same POST shape carries either a scalar windowed sub-metric or a `digest`/`sampleCount` blob, with no schema change downstream.

> **Asset gating (from the status-transition table):** only assets with `assetType ∈ {human_authored, approved_generated}` run in production executions. A bare `generated` asset runs **preview-only**. The harness does not relax this — a local preview run and a production GHA run gate on the same asset status.

### Execution Record
One `ExecutionRun` per harness invocation — one engine, one asset, under one pipeline run. This is the **harness-swap seam**: the same row models a k6 process spawned in a Paperclip `ExecutionWorkspace` (now) or a step in a generated GHA workflow (later). The reporting contract is identical; only `workspaceRef` / `binaryProfile` differ.

```
ExecutionRun {
  id
  companyId
  pipelineRunId              // the parent pipeline run (multi-engine fan-out lives here)
  testRunId?                 // the per-execution child it materializes (nullable: a run can
                             //   precede test_runs materialization; see §1 DDL nullability)
  testAssetId
  engine: string
  binaryProfile: string      // resolvable k6 binary path/profile (NOT literal "k6")
                             // — enables xk6-kafka / browser builds
  workspaceRef: string       // per-run ExecutionWorkspace cwd (local harness);
                             // handleSummary output is written here and read back by TEST_RUN_ID
  status: "queued" | "running" | "completed" | "failed" | "aborted"
  startedAt, completedAt     // startedAt is the ANCHOR for every Dynatrace from=… query
  exitCode?: number
  stdoutRef?: string         // FK to the stdout_log test_run_artifacts row (artifactType=stdout_log);
                             //   NOT a free string — references test_run_artifacts.id (Stage 9, fix)
  liveMetricFeed: string     // SSE endpoint ref (transient) — re-broadcast for GHA runners
  peakVus: number
  totalIterations: number
  totalRequests: number
}
```

### The Ingestion Contract (executor-agnostic)
Both harnesses report through the **same** path, so the harness is invisible downstream:

1. **Live channel (transient).** The k6 `--out json=-` stream is forwarded as samples. Local: the load-test-agent reads stdout directly. GHA: the runner POSTs samples to Sentinel's ingestion endpoint, which re-broadcasts them on `liveMetricFeed`.
2. **Metric series (durable).** Tagged sub-metrics — `http_req_duration{workflow,phase}` and friends — are written to `metric_series` scoped by `executionRunId` + `workflowName` + `phase`. Single-instance ships exact windowed values; distributed ships `digest`/`sampleCount` blobs. **Metrics are POSTed back regardless of executor location.**
3. **Summary artifact (durable).** On completion the harness reads the `handleSummary` HTML (named by `TEST_RUN_ID`, written to `workspaceRef`) and POSTs it back as a `test_run_artifacts` row (`artifactType = k6_html_summary`).

Sentinel's ingestion endpoint is the single sink. It does not care whether the bytes came from a Paperclip workspace or a customer GHA runner.

### Dynatrace Monitoring During Execution
While the k6/Playwright process is running, a parallel Dynatrace polling loop runs concurrently **on the Sentinel side** (it does not depend on the harness location). Every 30 seconds it queries the Metrics v2 API for the configured server-side metrics and writes them to `metric_series` with `source = "apm:dynatrace"`. This gives real-time server-side visibility alongside the client-side load generator stream.

The loop anchors every query on the exact `ExecutionRun.startedAt` timestamp — every metric query uses `from=startedAt` so the server-side data is precisely correlated to the load test window. Because both harnesses populate the same `ExecutionRun.startedAt`, the DT correlation is identical whether the test ran locally or in GHA.

Dynatrace percentiles come from **DT-native transforms** (e.g. `builtin:service.response.time:percentile(95):fold`), never client-computed from per-bucket averages; DT error rate is **count-weighted** (`errors.total.count / requestCount.total` over the window), never a mean of per-bucket rates. For shared external services DT is contaminated by other tenants, so **DT is authoritative only for ASYNC protocols** and **diagnostic-only ("the why") for SYNC** — where k6 client-side is the source of record.

If the Dynatrace API returns errors during polling, log them but do not abort the test. Client-side k6 metrics are always primary for sync targets; Dynatrace enrichment is secondary. A test run without Dynatrace data is still a valid sync test run.

### MetricSeries Granularity
Two levels:
- **Windowed sub-metric / aggregate** — the per-`{workflow, phase}` percentile (and overall errorRate/TPS) computed over the steady-state window. This is the **source of record** for SLA evaluation in Stage 6 (sync → k6; async → Dynatrace).
- **Time-series** — same metrics sampled every 10 seconds (k6) or 30 seconds (Dynatrace) throughout the run. **The 10s/30s time-series is correlation-only and is NEVER the percentile source of record.** The authoritative percentile is the windowed sub-metric (SYNC, in-runner) or the DT-native `:percentile`/`:fold` transform (ASYNC) — not these coarse time-series samples. Used only for correlation: "k6 showed p95 spiking at minute 4 — what did Dynatrace show for DB query time at the same moment?" (This mirrors the Stage 6 disclaimer that the scalar `value`/`rawValues` columns are informational only.)

`metric_series` records carry `source` (k6/playwright client-side vs Dynatrace server-side), `workflowName`, and `phase`, plus the digest-ready `digest`/`sampleCount` seam for the single-instance→sharded swap. The scalar `value`/`rawValues` columns are retained only for the informational k6 HTML path, not as the percentile source of record. SLA targets are evaluated against the authoritative source per protocol (decision #6).

---

## Stage 6: METRICS COLLECTION & SLA VALIDATION

### Philosophy
Raw execution output is noise. This stage transforms it into signal. Two outputs: structured `metric_series` records, and SLA verdicts (one `sla_verdicts` row per target). This is where the asset-factory contract pays off: the verdict is computed identically whether the harness was Sentinel's own load-test-agent spawning k6 in a Paperclip `ExecutionWorkspace` (now) or a step in the generated GHA workflow (later). Same script, same `handleSummary`, same ingestion endpoint, same SLA path. Control flows runner→Sentinel only — Sentinel never reaches back into the runner.

The critical design decision is: **what constitutes a metric breach?** A single request taking 2 seconds doesn't mean p95 is above threshold. A 5-second spike during ramp-up might be an outlier or it might be the canary for a real problem. The SLA evaluation must be computed over the correct statistical window — the steady-state plateau of the test, not the ramp-up — and over the correct *samples* — successful responses only, not requests that errored out.

### The source-of-record split (sync vs async)

There is exactly one authoritative percentile per SLA target, and which engine owns it is determined by the protocol's sync/async model. This is not a preference; it is a correctness invariant.

**SYNC protocols → k6 client-side is the source of record.** For request/response protocols (HTTP, gRPC, WebSocket request-reply, browser flows), the latency the user experiences *is* the client-side latency, and k6 measures it at the source. We do **not** ask Dynatrace for the sync percentile — DT is server-side, sees a different population of requests, and for a shared external service is contaminated by other tenants' traffic. For SYNC, **Dynatrace is diagnostic-only — "the why," never "the number."** When a k6 p95 breaches, DT explains *why* (DB query time, downstream call latency, GC pause, CPU saturation) in the same time window, but the breach itself is decided by k6.

**ASYNC protocols → Dynatrace server-side is the source of record.** For event-driven and saga-style flows (Kafka, fire-and-forget, request→ack→event-later), there is no client-side latency that means anything — the client got an ack in 5ms while the actual work happened downstream over the next 800ms. The meaningful number lives on the server. For ASYNC, Sentinel queries the **Dynatrace Metrics v2 API for native percentiles** over the test window and treats that as authoritative. k6 here only drives load and confirms the producer/ack path; it does not own the SLA percentile.

This split is the locked resolution of the two long-standing contradictions: client-side k6 is authoritative for SYNC, server-side Dynatrace is authoritative for ASYNC, and DT is strictly diagnostic for the sync case.

### How the authoritative percentile is computed

**SYNC — exact, windowed, per-workflow sub-metrics computed IN-RUNNER.** The k6 script does not emit one global `http_req_duration`; it emits `{workflow, phase}`-tagged sub-metrics, and the steady-state percentile is a **tagged threshold** evaluated over only the samples carrying the matching tags. So `http_req_duration{workflow:checkout,phase:steady}` p95 is an exact windowed per-workflow percentile over precisely the checkout requests that fired during steady state — not an aggregate, not an interpolation across phases. Each VU stamps `phase` (`warmup | ramp_up | steady | ramp_down`, with `warmup` the front-edge cold-start exclusion) on every sample by reading `exec.instance.currentTestRunDuration` against the load-profile stage boundaries, so the windowing is done at sample time, in-runner, with no server-side post-hoc bucketing. The windowed sub-metric verdict — *not* the whole-run aggregate in the k6 HTML — is the authoritative SLA number. The k6 native HTML report (Stage 9) shows whole-run aggregates and is informational only; it does not decide pass/fail.

> **In-script tagging is exact only for single-instance k6.** When load is sharded across distributed runners, no single instance sees the full sample population, so a tagged threshold computed in-runner is no longer the global percentile. The escalation is **per-bucket t-digests (or HDR histograms) merged server-side** (or k6 Cloud's own aggregation). The ingestion contract is designed so this swap is **additive**: `metric_series` already carries `digest jsonb` (the per-bucket t-digest/HDR blob) + `sampleCount` alongside the scalar `value`. Single-instance ships exact windowed sub-metrics today; distributed escalation merges digests server-side with **no schema change**. (Not implemented in v1 — single-instance exact windowing only — but the seam is reserved.)

**ASYNC — Dynatrace-native transforms, never client-recomputed.** Async percentiles come from DT-native Metrics v2 transforms over the test window — e.g. `builtin:service.response.time:percentile(95):fold` anchored at `from=executionRun.startedAt, to=executionRun.completedAt`. Sentinel **never** computes a percentile from per-bucket averages returned by DT — averaging bucket averages is statistically wrong; the percentile must be asked of DT directly via its `:percentile(n)` transform. Likewise, **DT error rate is count-weighted** (`errors.total.count / requestCount.total` summed over the window), never a mean of the per-bucket rate series — a mean-of-rates silently over-weights low-traffic buckets.

### The steady-state window is derived from stage phases, not "last 60%"

The evaluation window is **not** a fixed fraction of test duration. It is derived from the load-profile **stage phases**: the plateau between the last ramp-up stage and the first ramp-down stage. For SYNC this is enforced directly by the `phase:steady` tag (the VU only stamps `steady` while inside that plateau); for ASYNC it is the `{ startMs, endMs }` passed to the DT query's `from/to`. The steady-state definition is an **up-front design input baked into the generated asset** — the stage array in the TestPlan's `loadProfile` *is* the window definition. Re-cutting the window is not a re-evaluation knob; it means regenerating the asset and rerunning. `evaluationWindow` on the verdict is the materialized `{ startMs, endMs }` of that plateau, not a runtime-tunable "last N%."

**Zero-ramp runs: the whole run is the steady window minus a warm-up guard.** A run with **no ramp stages** — a flat `constant-vus` baseline, or a flat `constant-arrival-rate` sustain — has no ramp-up/ramp-down plateau to cut between, so there is no plateau-derived window. For these, **the entire run is the steady window, minus a warm-up exclusion at the front.** This warm-up exclusion is a concept **DISTINCT from a load ramp**: there is no climbing load, but there *is* a cold-start transient (JIT compilation, TLS handshakes, connection-pool fill, DNS priming) whose latency is unrepresentative. The first `warmupGuardSec` of any run is therefore tagged **`phase:warmup`** and is **never authoritative** — warm-up samples are excluded from the percentile exactly the way `ramp_up` samples are, but for a different reason (cold-start priming, not partial load). The steady window for a zero-ramp run is `[warmupGuardSec, runEnd]`.

**The warm-up guard also applies on the ramping-vus boundary.** Even when there *are* ramp stages, `phase:steady` does not begin at the raw ramp-stage-end instant — it begins at the ramp stage end **plus a stabilization guard**, so that partially-loaded samples taken while VUs/arrival-rate are still climbing or settling carry `phase:ramp_up`, **never** `phase:steady`. (This is the same stabilized-boundary rule Stage 2's `phaseFor()`/default stage-shaping references; warm-up at the very front of the run and the stabilization guard at the ramp→steady boundary are both front-edge exclusions that keep unrepresentative samples out of the authoritative window.)

### Latency is evaluated over successful responses only

Latency percentiles are computed over `{expected_response:true}` samples only. A 504 that returns in 30ms must not deflate the p95, and a connection reset that hangs for the full timeout must not inflate it under the guise of "latency" — those are error-rate signals, not latency signals. The raw `http_req_duration` (which mixes successes and failures) is **informational only**; the authoritative percentile is over the success-filtered sub-metric `http_req_duration{expected_response:true,workflow,phase}` — a **distinct tagged series** from raw `http_req_duration`, not the same series re-read. `sla_verdicts.evaluatedOnSuccessOnly` records this so the verdict is self-describing.

### A missing REQUIRED metric never silently passes

If a REQUIRED SLA target (one whose `requirements_documents.slaTargets[].required = true`) has no data to evaluate against — the metric was never emitted, the workflow never executed, the run aborted before steady state, or the sample count is below `minSampleCount` (the min-sample guard, read from the RequirementsDocument; see Stage 1) — the verdict for that target resolves to **`inconclusive`**. The gate maps `inconclusive` to **`ciSignal='fail'`** or escalates the pipeline to **`blocked_on_human`** (Stage 8). It is **never** recorded as `skipped` and silently rolled into a green pass, and it is **never** recorded as `fail` either — `fail` is reserved for a target that *was* measured and breached its threshold. The distinction matters: `fail` deterministically maps to `auto_fail` at the gate, whereas `inconclusive` is precisely the trigger Stage 8 step 2 reads to fire the inconclusive outcome. Resolving a missing required metric to `inconclusive` (not `fail`) is what makes the verdict→gate routing total and non-contradictory while still honoring stop-and-ask: a pipeline that *could not measure* a required SLA is inconclusive, not passing and not breached. The absence of a number is itself a finding. `sla_verdicts.status` therefore has no `skipped` value for required targets — only `pass | fail | inconclusive` — and `inconclusive` propagates to the gate as `ciSignal='fail'` or `blocked_on_human`, never false-green.

**The min-sample floor is evaluated against the SUCCESS-FILTERED population of the SAME sub-metric the SLA is keyed on.** `minSampleCount` is not compared against some global request count — it is compared against the `sampleCount` of *exactly* the series the target's percentile is cut over: the **success-filtered** (`{expected_response:true}`) population, scoped to the **same sub-metric the SLA is keyed on**. For a per-workflow SLA that means the per-workflow success population (`http_req_duration{expected_response:true,workflow:checkout,phase:steady}`); for an aggregate SLA it means the aggregate success population; it is **never** measured against a sub-slice that carries no SLA. A target is only as well-sampled as its own authoritative series.

This produces an intended **success-starvation** interaction: a workflow with a high error rate can have its *success* population fall below `minSampleCount` even when it fired plenty of total requests — because the errored requests do not count toward the success-filtered latency series. When that happens, **that target resolves `inconclusive`** (insufficient successful samples to trust the percentile), and the error-rate target for the same workflow independently breaches on its own count-based series. This is **intended behavior**, not a bug: a path drowning in errors *should not* also report a confident latency pass on the handful of requests that happened to succeed.

For a **`constant-vus` true-baseline**, this floor sets a duration constraint: the run `duration` must be long enough that the steady (post-warm-up) success population clears `minSampleCount`. At 1 VU the achievable count is `iterations ≈ (duration − warmupGuardSec) / mean_iteration_latency`, so `duration` must be sized so that `iterations ≥ minSampleCount` over the post-warm-up window — otherwise a perfectly healthy baseline resolves `inconclusive` purely for being too short.

> **Optional targets differ.** An *optional* SLA target (`required = false`) that cannot be measured does **not** force the run to `inconclusive` — its absence is recorded but does not block. Only **required** targets drive the inconclusive guard. This is why the `required` flag (Stage 1, Data Model §3) is load-bearing.

### MetricSeries: ingestion shape (consistent with the canonical data model)

Every ingested series is scoped per execution and per workflow and is digest-ready so the single-instance→distributed swap is additive. The authoritative percentile source is the windowed sub-metric / DT-native transform; the scalar `value`/`rawValues` columns are retained **only** for the informational k6 HTML path, not as the source of record.

```
MetricSeries (ingestion-relevant fields) {
  testRunId          // ON DELETE CASCADE retained as-is
  executionRunId     // scopes the series to one harness invocation
  workflowName       // per-workflow scoping for {workflow,phase} windowing
  phase              // "warmup" | "ramp_up" | "steady" | "ramp_down" — set by the VU
                     //   via exec.instance.currentTestRunDuration. "warmup" is the
                     //   front-edge cold-start exclusion (JIT/TLS/pool/DNS priming),
                     //   never authoritative. (The exploratory per-step "step_<rate>"
                     //   phases are DEFERRED with exploratory mode — not emitted in v1.)
  metric             // e.g. http_req_duration, http_req_failed, iterations.
                     //   NOTE: the SUCCESS-FILTERED latency sub-metric
                     //   (http_req_duration{expected_response:true,workflow,phase}) is the
                     //   AUTHORITATIVE latency series and is a DISTINCT tagged series from
                     //   raw http_req_duration (which is informational). They are not the
                     //   same row — mirroring sla_verdicts.evaluatedOnSuccessOnly.
  source             // "k6" (authoritative for SYNC)
                     //   | "apm:dynatrace" (authoritative for ASYNC, diagnostic for SYNC)
                     //   | "playwright"
  digest             // per-bucket t-digest / HDR-histogram blob — the
                     //   additive seam for server-side merge under sharding
  sampleCount        // population size behind the digest; this is the value the
                     //   min-sample guard compares against RequirementsDocument.minSampleCount
                     //   for the missing/insufficient-required-metric rule
  value, rawValues   // scalar — INFORMATIONAL ONLY (k6 HTML path), NOT
                     //   the percentile source of record
  metadata           // retained from the shipped schema (free-form correlation context)
}
```

### SLA Verdict

One `sla_verdicts` row per target, computed over the authoritative windowed sub-metric (SYNC) or DT-native percentile (ASYNC). `slaTargetId` joins `requirements_documents.slaTargets[].id` directly — the single source of truth, read live, never copied.

```
SLAVerdict {
  id
  pipelineRunId
  executionRunId
  testRunId
  slaTargetId            // joins requirements_documents.slaTargets[].id (live, no snapshot)
  workflowName           // the {workflow} tag scoping the windowed percentile
  phase                  // typically "steady" — the plateau the percentile is cut over
  metric
  operator
  threshold
  actualValue            // the windowed sub-metric (SYNC) or DT-native :percentile (ASYNC)
  evaluationWindow: { startMs, endMs }   // the steady-state plateau between last
                                         //   ramp-up and first ramp-down — NOT "last 60%"
  source: "k6" | "playwright" | "apm:dynatrace"
                         // k6 authoritative for SYNC; DT authoritative for ASYNC;
                         //   DT diagnostic-only for SYNC. Aligned with slaTargets[].source.
  evaluatedOnSuccessOnly: boolean        // latency cut over {expected_response:true} only;
                                         //   raw http_req_duration is informational
  status: "pass" | "fail" | "inconclusive"
                         // pass  = measured, met threshold
                         // fail  = measured, breached threshold (→ gate auto_fail)
                         // inconclusive = a REQUIRED metric could not be measured (missing /
                         //   never emitted / run aborted before steady / sampleCount <
                         //   minSampleCount). NEVER skipped-and-silently-pass, and NEVER
                         //   recorded as `fail`. The gate maps inconclusive → ciSignal='fail'
                         //   or escalates pipeline to blocked_on_human (Stage 8 step 2).
}
```

The Metrics v2 final query runs at test completion for the ASYNC source-of-record path and for SYNC diagnostics, pulling the full `:percentile`/`:fold` transforms for the entire run window (`from=executionRun.startedAt, to=executionRun.completedAt`), and fills any gaps left by the 30-second polling loop. For SYNC, this DT pull is correlation/diagnostic data only — it tells the human *why* a k6 breach happened in the same window; it does not override the k6 verdict.

---

## Stage 7: BASELINE COMPARISON

> **DEFERRED — not built in v1.** The Stage-6 SLA verdict ships now; the baseline *distribution* logic described here does not. The `baselines` / `regressions` tables exist and accept rows, but the comparator that turns those rows into a worsening flag is a fast-follow. The data captured in Stage 6 (`{workflow, phase}`-windowed digests, per-execution `metric_series`, `sampleCount`) **already supports** this stage, so resuming it is purely additive — no schema migration beyond the v2 columns noted below. **The one piece applied even in v1 is direction-awareness** (the `regressions.direction` field, fix 3): everything else waits.

### Philosophy
An SLA verdict tells you whether the system met its absolute targets. A baseline comparison tells you whether it got *worse relative to last time*. These are different questions and both matter.

A system can pass all SLAs and still be regressing. If p95 was 80ms last week and is 150ms this week, it passed the 200ms SLA but something changed. The baseline catches this. This is why the baseline is a separate stage from the gate, not a clause inside it — the SLA check is mechanical and absolute; the baseline check is statistical and relative.

**Baselines are not automatic.** A baseline is a deliberate human decision: "this run represents acceptable performance, and future runs should be compared to it." The first run for a new TestPlan cannot have a meaningful baseline comparison — it produces a `baseline_proposal` that a human must approve before it becomes the active baseline. This prevents a bad first run from poisoning every future comparison. This human-gated, never-silently-promoted property is non-negotiable and survives into the resumed design.

**Baseline staleness.** A baseline from 6 months ago may not be meaningful if the system has been intentionally scaled up or the load model has changed. Baselines carry a `validFrom` and optionally a `validUntil`. If the TestPlan's `loadProfile` changes significantly — a different `executor` branch, a materially different peak — the existing baseline is invalidated and a new proposal generated. A baseline is only comparable against runs produced from the *same* generated asset family.

**Tolerance is configurable per metric.** p95 latency might tolerate ±15% variance (environments vary). Error rate might tolerate ±0.01%. These are different numbers and are set deliberately in the TestPlan, not defaulted globally. The shipped `baselines.tolerancePct` (one row per metric) is the carrier.

**Regression types matter for triage.** A regression in p99 latency is often a specific outlier code path. A regression in throughput (TPS) is often infrastructure saturation. A regression in error rate is often a bug. A regression in saga-completion rate is often an async dependency stalling. Surfacing the regression *type* helps the human triage faster — so `regressions.regressionType` is set deterministically from the metric (`latency_p95 | latency_p99 | throughput | error_rate | saga_completion | …`, fix 11), never the free-text `"regression"` default it ships with today.

### Locked Approach (when resumed)
The resumed comparator is a **distribution model**, not a one-run-vs-one-run diff:

- **Distribution over K clean runs.** A baseline is the distribution of a metric over the **K most recent clean (non-polluted) approved runs** — stored compactly as **median + stddev + sampleN** per metric, not the raw sample set. K clean runs, not "the last run," so a single noisy environment doesn't define the baseline and ordinary variance doesn't read as regression.
- **Dual-threshold worsening flag.** A new run is flagged as a regression only when it deviates in the **worsening** direction by **BOTH** (a) more than the per-metric `tolerancePct` **AND** (b) more than `z * stddev`. Requiring both a relative gate and a statistical-significance gate suppresses two distinct false-positive classes: large-but-noisy metrics (the z gate catches) and tiny-but-consistent drift inside a metric's natural variance (the tolerance gate catches).
- **Direction from the SLA operator** *(fix 3 — the ONE thing applied in v1)*. "Worsening" is **direction-aware**, derived from the target's SLA `operator`: for a `<`/`<=` metric (latency, error rate) worsening is *up*; for a `>`/`>=` metric (throughput, saga-completion rate) worsening is *down*. A throughput or saga-completion **collapse** must be detectable, not only an upward latency drift. The `regressions.direction` column lands now so the schema is honest about this from day one even though the comparator that reads it is deferred.
- **Cold start = low-confidence fixed tolerance.** With fewer than K clean runs, stddev is meaningless. The comparator falls back to a **fixed-tolerance, explicitly low-confidence** check (tolerance only, **no z gate** — `zScore` is undefined/meaningless with < K runs) and the verdict is labelled as such — it never masquerades as a high-confidence statistical result.
- **Exclude DT-polluted runs.** Runs whose Dynatrace server-side window was contaminated by other tenants on a shared external service (decision #6 — DT is authoritative only for ASYNC, diagnostic-only for SYNC) are **excluded from the baseline distribution**. A polluted run neither defines the baseline nor is judged against it for ASYNC-sourced metrics.
- **Mann-Whitney is foreclosed — deliberately.** A full nonparametric distribution test (Mann-Whitney U) would need the **per-run raw sample sets** retained. The compact `median + stddev + sampleN` storage **foreclosed this on purpose** — the storage choice is the design decision. The median+stddev+z model is the accepted trade: bounded storage, no raw-sample retention, good-enough significance for a regression gate.

### baselineSetId — grouping per-metric rows (contradiction 4)
The shipped `baselines` table is **one row per metric**. A single approved run produces *many* such rows (one per tracked metric). Without a grouping key those rows are an unordered bag — you can't atomically promote, invalidate, or compare "the baseline from run X" as a unit. **`baselines.baselineSetId uuid`** is the atomic-set wrapper: every per-metric row produced by ONE approved run shares one `baselineSetId`. Promotion, staleness invalidation, and the K-clean-runs window all operate on **sets**, not loose rows. The table keeps its one-row-per-metric shape; `baselineSetId` is purely the additive grouping seam. The resumed-v2 columns (`median`, `stddev`, `sampleN`, `direction`) hang off these same rows.

### Regression (resumed shape)
```
Regression {
  id
  pipelineRunId                 // joins the run under comparison (fix 16)
  baselineSetId                 // the baseline set this run was judged against
  testRunId
  metric: string                // e.g. "http_req_duration{workflow:checkout,phase:steady} p95"
  regressionType:               // closed enum, set deterministically from metric (fix 11)
    "latency_p95" | "latency_p99" | "throughput" | "error_rate" | "saga_completion" | string
  direction: "worsening" | "improving"   // fix 3 — derived from the SLA operator
  baselineMedian: number
  baselineStddev: number
  baselineSampleN: number       // K clean runs feeding the distribution
  actualValue: number
  deltaPct: number              // signed, relative to baselineMedian
  zScore: number                // meaningful only at high confidence (≥ K clean runs)
  tolerancePct: number          // per-metric, from the TestPlan baseline config
  flagged: boolean              // true iff worsening AND |deltaPct| > tolerancePct AND
                                //   (confidence === "high" ? |zScore| > z : true)
                                //   — i.e. the z gate applies ONLY at high confidence;
                                //   on cold start (confidence === "low") it flags on tolerance
                                //   alone (no z gate), per the locked cold-start fallback.
  confidence: "high" | "low"    // "low" on cold start (< K clean runs)
}
```

A flagged regression is what drives the deferred Stage-8 `regression_review` outcome; an unflagged comparison and a first-ever run drive `baseline_proposal`. Both are **deferred-analysis paths** — v1 Stage 8 emits only `auto_pass | auto_fail | inconclusive` (decision #7), and the regression/baseline-proposal gate outcomes are reserved-but-not-implemented `gate_resolutions.outcome` values. When this stage resumes, the Stage-6 capture already in place means it slots in additively with no migration beyond the v2 columns above.

---

---

## Stage 8: GATE

### Philosophy
The gate is where the pipeline decides: does this result allow CI to proceed, or does a human need to look at it first? It is the seam between Sentinel's **analysis control plane** and the customer's **execution runner** — and the direction of that seam is fixed. Sentinel never reaches into GitHub to flip a check. Instead, the gate computes a verdict, persists it, and exposes it on an ingestion/verdict endpoint; a **final step in the generated GitHub Actions workflow polls that endpoint and fails (or passes) the job itself.** Control flows runner→Sentinel only. The same verdict path serves the local Paperclip-harness execution today and the generated GHA workflow later — the gate logic does not change when the harness swaps.

**The gate is requirements-driven, not analysis to construct.** The gate criteria are not invented at gate time. They are exactly the `slaTargets` captured in the RequirementsDocument during Discovery (Stage 1) and referenced — by stable id, never copied — through the TestPlan (decision #8). The gate does not re-derive thresholds, re-window percentiles, or second-guess the SLA evaluation. Stage 6 already produced the authoritative per-target `SLAVerdict` rows over the correct windowed sub-metric. **Stage 8 v1 is a mechanical fold of those verdicts into a single CI signal** — `auto_pass` if every required target passed, `auto_fail` if any breached. There is no model, no heuristic, no human judgment in the v1 happy path. The gate is a deterministic function of `sla_verdicts` plus the RequirementsDocument's `required` flags.

**Stop-and-ask is enforced at the gate by an explicit `inconclusive` outcome — never a false green.** The dangerous failure mode is a gate that silently passes when it lacks the evidence to fail honestly: a required SLA target that was skipped because its metric never arrived, a run that was aborted mid-flight, or a sample too small to compute a trustworthy percentile (below `RequirementsDocument.minSampleCount` — Stage 1). A naive gate that only knows `pass | fail` will resolve these to `pass` and ship a regression. Sentinel resolves them to `inconclusive`, which maps to a **failing or blocking CI signal**, honoring the foundational "stop and ask rather than assume" principle (decision #7, contradiction 6). An inconclusive gate is a feature, not a defect — it is the pipeline refusing to certify something it cannot stand behind. Critically, Stage 6 already resolved these conditions to a per-target `sla_verdicts.status = inconclusive` (not `fail`), so the gate's inconclusive outcome fires off a verdict status it can actually read — the routing is total.

**CI should only be held up by things a human can actually resolve.** If a required SLA breached, failing CI is correct — there is a real problem and a clear owner. If a metric is missing or the run aborted, the honest answer is "we don't know," and the pipeline either fails the build or escalates to `blocked_on_human` rather than waving it through. What the gate must **never** do is block CI on something the human cannot resolve from the build context (for example, a first-run baseline that does not yet exist) — those paths are handled by the deferred-analysis outcomes below and always yield a passing signal.

### The Gate Outcomes

The gate resolves to exactly one `outcome`, each of which deterministically maps to a `ciSignal`:

| Outcome | When | `ciSignal` | Human required? | v1 status |
|---|---|---|---|---|
| `auto_pass` | All required SLA targets pass; no missing required metric | `pass` | No | **v1** |
| `auto_fail` | Any required SLA target `status = fail` (measured + breached) | `fail` | No — the test said "no," and that is final until the underlying problem is fixed | **v1** |
| `inconclusive` | Any required SLA `status = inconclusive` (its metric never arrived / skipped), the run was `aborted` or `failed`, or the sample is below `minSampleCount` | `fail` (and, on escalation, `pipeline_runs.verdict = blocked_on_human` while `ciSignal` stays `fail`) — **never a false green** | Possibly (escalation path) | **v1** |
| `characterization` | `testIntent ∈ { baseline, exploratory }`, OR the run carried **no required SLA targets** — there is nothing to gate, so the run *characterizes* the floor/envelope instead of asserting pass/fail | `pass` | No (auto) — but **human-promotable** to a proposed SLA/baseline | **v1** |
| `regression_approved` / `regression_rejected` | SLAs pass but a baseline regression exceeded tolerance in the worsening direction; a human decides whether it is a real problem or acceptable drift | `pass` / `fail` respectively | Yes | **DEFERRED-analysis** |
| `baseline_approved` / `baseline_rejected` | First run for this TestPlan — no baseline exists; a human approves or rejects the run as the new baseline | **always `pass`** | Yes | **DEFERRED-analysis** |

**v1 emits `auto_pass | auto_fail | inconclusive | characterization`.** The four regression/baseline outcomes are valid `outcome` values and their rows can exist, but their decision logic is part of the **deferred Stage-7 baseline work** (decision #2) — not built now. They are listed here so the enum and the `ciSignal` mapping are total from day one; their analysis-construction paths land when baseline comparison resumes.

**The `characterization` outcome is the SAME outcome both true-baseline (v1) and the deferred exploratory ramp use** — a run with `testIntent ∈ { baseline, exploratory }` or with **no required SLA targets** has nothing to assert pass/fail against, so it resolves to `characterization` (`ciSignal = 'pass'`) and reports the measured floor/envelope, human-promotable to a proposed SLA/baseline. **This is what stops the empty-required-set false-green:** a no-required-SLA run must NOT resolve to a *vacuous* `auto_pass` (every-required-target-passed is trivially true over an empty set, which would silently certify a run that gated nothing). Routing it to `characterization` makes the "I gated nothing, I merely characterized" case explicit and auditable instead of masquerading as a green conformance pass.

**Baseline proposals can never fail the build.** Both `baseline_approved` and `baseline_rejected` resolve to `ciSignal = 'pass'`. You cannot fail a run against a baseline that does not exist; the worst a first run can do is decline to *become* the baseline. `baseline_rejected` is added (fix 14) precisely so that the rejection path has a defined, non-undefined CI signal — rejecting a proposed baseline still lets CI proceed, it just means no active baseline was established. This keeps `ciSignal` total: there is no `outcome` for which the signal is undefined.

### Gate Resolution

`GateResolution` is persisted (canonical `gate_resolutions` table — see the Data Model section; not redefined here). It is the durable record of the Stage-8 verdict→CI signal:

```
GateResolution {
  id
  companyId
  pipelineRunId               // the parent pipeline run (the gate's scope)
  testRunId                   // the per-execution record evaluated
  outcome:
      "auto_pass"             // v1: all required SLAs pass
    | "auto_fail"             // v1: a required SLA breached (status=fail)
    | "inconclusive"          // v1: a required SLA status=inconclusive / aborted / insufficient-sample
    | "characterization"      // v1: testIntent ∈ {baseline, exploratory} OR no required SLA targets —
                              //   nothing to gate; characterizes the floor/envelope instead.
                              //   ciSignal "pass", human-promotable. NOTE: "envelope_characterized"
                              //   appears in prose as a documentation SYNONYM ONLY — the persisted,
                              //   CHECK-constrained gate_resolutions.outcome value is ALWAYS
                              //   "characterization" (the alias is never written to the enum).
    | "regression_approved"   // DEFERRED-analysis
    | "regression_rejected"   // DEFERRED-analysis
    | "baseline_approved"     // DEFERRED-analysis — always ciSignal "pass"
    | "baseline_rejected"     // DEFERRED-analysis (fix 14) — always ciSignal "pass"
  ciSignal: "pass" | "fail"   // TOTAL: every outcome maps to exactly one signal. NOT NULL.
                              //   On the inconclusive→blocked_on_human escalation, ciSignal is
                              //   set to 'fail' (the conservative default) while
                              //   pipeline_runs.verdict carries blocked_on_human — so the
                              //   NOT NULL column is never undefined on the escalation path.
  resolvedBy: userId | "auto" // "auto" for the v1 mechanical outcomes
  resolvedAt: timestamp
  comment?: string
  createdAt
}
```

**The v1 resolution algorithm is mechanical and deterministic:**

1. Read the `sla_verdicts` for this `pipelineRunId`, each joined to its `requirements_documents.slaTargets[].id` via `slaTargetId` (the single source of truth — no copied thresholds). Read the `required` flag for each target from the RequirementsDocument.
2. If any **required** SLA target has a verdict `status = inconclusive` (its metric never arrived, the workflow never ran, the run aborted before steady state, or the evaluated `sampleCount` is below `RequirementsDocument.minSampleCount`), or the backing `execution_runs.status ∈ { aborted, failed }` → `outcome = inconclusive`. Map to `ciSignal = 'fail'`. When a human owner is configured to adjudicate, also escalate `pipeline_runs.verdict = blocked_on_human` (carrying `blockedAt.interactionType = 'approval'`) — `gate_resolutions.ciSignal` remains `'fail'` (the conservative default) so the NOT NULL column is total on the escalation path.
3. Else if any **required** SLA verdict `status = fail` → `outcome = auto_fail`, `ciSignal = 'fail'`.
4. Else if `RequirementsDocument.testIntent ∈ { baseline, exploratory }` **OR** the run carried **no required SLA targets** (the required set is empty) → `outcome = characterization`, `ciSignal = 'pass'`. The run characterizes the floor/envelope rather than asserting a conformance verdict; it is **human-promotable** to a proposed SLA/baseline. **This branch is taken BEFORE step 5** precisely so an empty required set never falls through to a *vacuous* `auto_pass` (every-required-passed is trivially true over zero targets — a false green). This is the SAME outcome the true-baseline (v1) and the deferred exploratory ramp both use.
5. Else (all required verdicts `pass`, none inconclusive, none missing, and there **was** a non-empty required set under `testIntent = conformance`) → `outcome = auto_pass`, `ciSignal = 'pass'`.
6. `resolvedBy = 'auto'` for all four v1 outcomes (`auto_pass | auto_fail | inconclusive | characterization`). A human **promoting** a `characterization` result into a proposed SLA/baseline records their `userId`; the deferred regression/baseline outcomes set `resolvedBy = userId`.

> **Note on routing totality.** Step 2 reads `status = inconclusive` directly because Stage 6 resolves a missing/insufficient *required* metric to `inconclusive` (never `fail`, never `skipped`). Step 3 reads `status = fail` only for targets that were *measured and breached*. This makes the verdict→outcome map total and non-contradictory: there is no condition that produces `fail` at Stage 6 but `inconclusive` at the gate, or vice versa.

Because the verdict is driven entirely by referenced SLA targets and persisted `sla_verdicts`, editing an SLA target in the RequirementsDocument is reflected at the gate with no reconciliation step — there is one copy of the truth, and the gate reads through to it.

### Gate → CI Mechanism (runner→Sentinel only)

**The gate is the only place a CI signal originates, and Sentinel never pushes it.** There is no Sentinel→GitHub webhook, no Sentinel-initiated status check, no Sentinel call into the GHA API. Instead:

1. The gate resolves and persists `gate_resolutions.ciSignal` against the `pipelineRunId`.
2. The **generated GitHub Actions workflow** (the `ci_workflow` asset, emitted by the asset factory) carries a **final step** that polls Sentinel's verdict endpoint for this run's `pipelineRunId`.
3. That step **fails the job** (`exit 1`) on `ciSignal = 'fail'` and passes on `ciSignal = 'pass'`, attaching the report URL. The job blocks (or times out to a failing state) while the verdict is still `pending` — it never interprets a missing verdict as a pass.

This is the locked "CI = execution trigger against an existing TestPlan, control flows runner→Sentinel": the customer's runner executes the portable bundle, self-reports results to Sentinel's ingestion endpoint, then asks Sentinel for the verdict and gates itself. The identical verdict path serves Sentinel's own load-test-agent harness today — the only thing that swaps is who reads `ciSignal`, not how it is computed.

---

## Stage 9: REPORT

### Philosophy
The report is the artifact that outlives the pipeline run. Long after the per-execution `TestRun` record is archived, the report should be findable, readable, and shareable. It is the primary output for non-engineering stakeholders.

This stage closes the asset-factory loop. Sentinel is an **asset factory + analysis control plane**, not an execution orchestrator — it never reaches into GitHub to read results. Instead, the execution bundle it generated is **self-reporting**: whatever harness ran the k6 script (Sentinel's own `load-test-agent` spawning k6 in a Paperclip `ExecutionWorkspace` now, the customer's generated GitHub Actions runner later) writes its artifacts and pushes them **back** to Sentinel's ingestion endpoint. Control flows runner→Sentinel only. Stage 9's job is to capture those self-reported artifacts as first-class stored records, then assemble the human-facing summary on top of them. The reporting contract is identical across both harnesses — the portable unit is the k6 script + `handleSummary`, and only the harness around it swaps.

A performance test report must answer five questions without requiring the reader to dig into raw data:
1. Did we pass? (one-word verdict, visible immediately)
2. What did we test? (test plan name, target, date, load profile)
3. Where did we fail or regress, if anywhere? (specific metrics, specific workflows)
4. How do we compare to last time? (baseline comparison summary — deferred for v1, see Stage 7)
5. What should we do next? (recommendation — fix this endpoint, approve baseline, rerun, etc.)

**Dynatrace is the visualization layer — we do not build charts.** Initially, and for the foreseeable future, the report does not embed custom charts. Instead, every report includes a Dynatrace deep-link scoped to the exact time window of the run. This link opens the Dynatrace dashboard (existing or auto-generated) pre-filtered to `from=executionRun.startedAt&to=executionRun.completedAt` for the configured service entity. The reader gets the full Dynatrace visualization experience — service flow, hotspots, DB calls, infrastructure — without us rebuilding it. The run window anchor is the `execution_runs.startedAt`/`completedAt` pair, the same anchor used for every server-side correlation query upstream.

**Auto-generated Dynatrace dashboard link.** If `dynatrace.createDashboardPerRun` is true on the RequirementsDocument, the report publisher constructs a Dynatrace deep-link URL that opens the service's built-in dashboards filtered to the run window. Format:
```
{tenantUrl}/ui/services/{serviceEntityId}?gtf=custom&gta={startedAtMs}&gte={completedAtMs}
```
If an existing dashboard URL is configured, append the same `gtf/gta/gte` params to it instead. The deep-link itself is persisted as a `TestRunArtifact` (`artifactType = dynatrace_deeplink`) so the report renders identically whether or not the live Dynatrace tenant is reachable at view time.

### Artifacts are first-class entities (store-first, publish-second)

Every output of this stage is a row in the net-new **`test_run_artifacts`** table (see Data Model §1). Artifacts are **stored before they are published**: the store succeeds independently of any external push, so a Slack/Jira/Confluence outage can never lose the report. The `publishStatus` field (`stored | published | publish_failed`) tracks the external push separately from the durable store.

```
TestRunArtifact {
  id
  pipelineRunId            // FK → pipeline_runs.id (required; the run this artifact belongs to)
  executionRunId?          // FK → execution_runs.id (nullable: pipeline-level artifacts
                           //   like the Sentinel summary span all executions, not one)
  testRunId?               // FK → test_runs.id (nullable: pipeline-level artifacts such as
                           //   sentinel_summary have no single per-execution test_run)
  artifactType:            // closed enum — CANONICAL column name (matches the §1 DDL and the
                           //   Architecture references). NOTE: an earlier draft called this
                           //   field `kind`; the canonical column is `artifactType` everywhere.
      "k6_html_summary"    //   the k6 native handleSummary HTML (per execution)
    | "sentinel_summary"   //   the thin Sentinel summary HTML (per pipeline run)
    | "stdout_log"         //   captured execution stdout (execution_runs.stdoutRef → this row)
    | "metrics_json_stream"//   the streaming --out json feed (distinct artifact, see below)
    | "dynatrace_deeplink" //   persisted time-scoped DT URL
    | "gha_workflow_bundle"//   the generated GitHub Actions workflow YAML bundle (fast-follow)
  assetId?                 // FK → test_assets.id (the generated asset this artifact derives from,
                           //   e.g. the k6 workflow asset or the ci_workflow asset)
  storageRef               // durable internal storage handle (object store key)
  url                      // stable, shareable URL — survives pipeline-run archival
                           //   (canonical column name `url`; the §1 DDL labels it "url (stable)")
  contentType
  sizeBytes?
  publishStatus: "stored" | "published" | "publish_failed"
  createdAt
}
```

This entity supersedes the loosely-typed report references of the original draft. Two consequences flow from it:

- **`ExecutionRun.stdoutRef` is an artifact FK, not a free string.** The execution stage does not carry an opaque log-path string; the captured stdout is a `test_run_artifacts` row of `artifactType = stdout_log`, and `execution_runs.stdoutRef` references that artifact's `id` (consistent with the Stage 5 ExecutionRun shape and the §1 `execution_runs` DDL annotation). Logs are findable, addressable, and lifecycle-governed exactly like every other artifact.
- **The streaming feed and the summary HTML are different artifacts (fix 7).** The live `--out json=-` metrics stream that fed Stage 5's real-time view is captured as `metrics_json_stream`; the `handleSummary` HTML is `k6_html_summary`. They are produced by different mechanisms at different times and are stored as distinct rows — never conflated.

**The harness swap is additive at the artifact layer.** The same `test_run_artifacts` shape holds the bundle whether it was produced by the local Paperclip harness or by the customer's GHA runner. The generated GitHub Actions workflow YAML is itself stored as a `gha_workflow_bundle` artifact — the asset factory's product is a first-class, retrievable thing, not an ephemeral file. The `gha_workflow_bundle` artifactType ships **fast-follow**: the local Paperclip-harness reporting path is proven first, then the GHA-bundle generator lands without any schema change.

### The two human-facing artifacts

**Artifact 1 — k6 native HTML report (`artifactType = k6_html_summary`).** Every k6 script generated by Stage 3 includes a `handleSummary` function using the `k6-reporter` library (benc-uk/k6-reporter). This runs automatically at the end of k6 execution and produces a self-contained HTML file with the full k6 metrics breakdown — all built-in metrics, the `{workflow, phase}`-tagged sub-metrics, per-URL breakdowns, VU ramp chart, checks table, thresholds table. No post-processing needed; k6 writes it into the per-run `ExecutionWorkspace` cwd, named by `TEST_RUN_ID` so every run's report is uniquely addressable.

```javascript
// Required in every generated k6 script — identical under both harnesses
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

export function handleSummary(data) {
  return {
    [`summary-${__ENV.TEST_RUN_ID}.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
```

Whatever harness ran the script reads this file from the workspace, posts it back to Sentinel's ingestion endpoint, and Sentinel stores it as a `k6_html_summary` artifact scoped to its `executionRunId`. This is the full raw execution record — everything k6 measured. It is the **informational** view: the authoritative per-workflow windowed percentiles live in `metric_series` (decision #1), not in this HTML.

**Artifact 2 — Sentinel summary report (`artifactType = sentinel_summary`).** A lighter, pipeline-level report that wraps the verdict, the SLA evaluation, the (deferred-for-v1) regression analysis, and links to both the k6 report and Dynatrace. This is what gets posted to Slack/Jira/Confluence — not the raw k6 report. It is a pipeline-level artifact (no `executionRunId`, no `testRunId`), since a single pipeline run may have spanned multiple executions.

**What the Sentinel summary report contains:**
- Verdict badge, sourced directly from `pipeline_runs.verdict`: **PASS / FAIL / INCONCLUSIVE / BLOCKED ON HUMAN**. `INCONCLUSIVE` (skipped-required-SLA, aborted, or insufficient-sample) and `BLOCKED ON HUMAN` are first-class, load-bearing states — the report **never** renders a false-green PASS for a run that did not actually clear its required SLAs (decision #7, fix 4).
- SLA table: one row per `sla_verdicts` record — workflow, phase, metric, threshold, actual value, pass/fail/inconclusive — evaluated over the windowed steady-state plateau, not aggregate.
- Regression table: present but **deferred for v1** — when Stage 7 baseline logic resumes, this surfaces metric, baseline value, actual value, deviation %, and the worsening direction. v1 renders only the direction-aware comparator output if present.
- Link: "Full k6 execution report →" (the stored `k6_html_summary` artifact's `url`)
- Link: "View server-side metrics in Dynatrace →" (the stored `dynatrace_deeplink` artifact)
- Recommendation: one sentence the human should act on
- Run metadata: test plan, trigger, duration, peak VUs, total requests, error count

### Report destinations are configurable

A critical production SLA breach goes to Slack immediately and opens a Jira P1. A nightly run posts a summary to a Slack channel and attaches to the PR that triggered it. A weekly trend report goes to Confluence. The report publisher does not hardcode destinations — it reads them from configuration and pushes the already-stored `sentinel_summary` artifact's `url`. Because store precedes publish, a failed push leaves the artifact intact with `publishStatus = publish_failed`, retriable without re-running the test.

### Relationship to the CI signal
Stage 9 produces the report; it does **not** decide pass/fail. The gate (Stage 8) owns the verdict, and the CI signal is delivered by a **final step in the generated GHA workflow** that polls Sentinel's verdict endpoint and fails the job on `ciSignal='fail'` — Sentinel never pushes into GitHub. The report is the human-readable companion to that machine signal: the GHA job's failure annotation links to the `sentinel_summary` artifact's `url`, so a red CI check is one click from the full explanation.

---

## The Pipeline Object (PipelineRun)

### Philosophy

None of this works without a first-class `PipelineRun` that tracks state across the full intake→report chain (8 `StageRecord` keys — `intake, discovery, plan, generate, validate, execute, analysis, report` — where the metrics/compare/gate trio collapses into one `analysis` stage; see §1's 8-key map). The current `test_runs` row with a single `status` field cannot express a multi-stage, human-gated, resumable state machine — so we introduce `pipeline_runs` as a **NEW PARENT table, purely additively** (decision #4). `test_runs` is **not renamed and not dropped**; it is demoted to the per-execution child record and gains a single nullable `pipelineRunId` FK. Every net-new entity — `execution_runs`, `sla_verdicts`, `gate_resolutions`, `test_run_artifacts` — points at `pipelineRunId`, never at the old root. All existing FKs and the `metric_series.testRunId ON DELETE CASCADE` are left untouched (see Data Model §5). Nothing about the legacy `test_runs` lifecycle changes.

**The Issue is authoritative; the StageRecord is a derived projection (decision #5).** Sentinel is a thin domain layer on the Paperclip platform — and Paperclip already ships a battle-tested Issue state machine with assignment, blocking, threading, and approval. We do **not** build a second, parallel, drift-prone status machine on top of it. Each stage is driven by exactly one Paperclip Issue created through `issueService.create()`. `StageRecord.status` is computed *from* the backing Issue chain on read; it is never the source of truth. There is one place a stage's truth lives, and it is the Issue.

**Every stage Issue is created already-assigned, with blockers routed, to prevent deadlock (fix 15).** A stage Issue created with no assignee and no blocker-routing sits forever — the classic orchestration deadlock. So every stage Issue is created via `issueService.create({ assigneeAgentId, blockers })` in one call: a mapped `assigneeAgentId` (the agent that owns that stage of work) and any cross-stage `blockers` (the upstream Issues that gate it, per the status-transition table in Data Model §4). The pipeline never emits an unassigned, unblocked, unrouted stage Issue.

**Analysis is deferred, so it is ONE stage, not three (contradiction 7, decision #5).** For v1 the three analysis-family stages — metrics, compare, gate — collapse into a **single `analysis` StageRecord** backed by a single `[ANL]` Issue. We do not split the pipeline into a ten-issue, 1:1 stage↔Issue explosion when the compare/baseline logic is deferred (Stage 7) and the gate is mechanical (Stage 8). One `[ANL]` Issue covers windowed SLA evaluation + the mechanical gate; resuming baseline analysis later is additive and does not re-shape the StageRecord map.

**Skip is a total state, never a hole (fix 13).** A stage that does not run records `status='skipped'` **and** a non-null `skippedReason`. A null status or a silently-absent stage is forbidden — the state machine must be total so that "did this stage run, and if not why" is always answerable from the record alone. This matters most on the execution-trigger path below, where several upstream stages are deliberately skipped.

### The PipelineRun shape

```typescript
PipelineRun {
  id
  companyId
  testPlanId?                  // nullable: a run can predate plan creation when discovery is in flight
  pipelineRequestId?
  requirementsDocumentId?      // nullable until discovery completes

  // trigger.type is a CLOSED enum split by ORIGIN (fix 12). The undefined
  // `requirement_created` and the ambiguous bare `manual` are DROPPED at this layer.
  // (pipeline_requests.source ∈ { manual_intake, jira } uses the SAME intake tokens as
  //  trigger.type — no translation — see Stage 0 Trigger Sources note.)
  trigger: {
    type:
      // intake-origin (something NEW must be understood):
      | "manual_intake" | "jira"
      // execution-origin (run against an EXISTING TestPlan):
      | "ci" | "scheduled" | "manual_rerun"
    source: string
    ref?: string               // PR number, commit SHA, cron expression
    changedFiles?: string[]
  }

  // Stage map. StageRecord.status is a DERIVED PROJECTION of the backing
  // Paperclip Issue chain — there is no parallel state machine.
  // For v1 the analysis FAMILY (metrics + compare + gate) collapses into a
  // SINGLE `analysis` StageRecord backed by one [ANL] Issue (contradiction 7).
  stages: {
    intake:    StageRecord    // skipped on the execution-trigger path
    discovery: StageRecord    // skipped if a RequirementsDocument already exists
    plan:      StageRecord    // skipped if a TestPlan already exists
    generate:  StageRecord    // skipped iff coverage is already complete
    validate:  StageRecord
    execute:   StageRecord     // see executionRunIds[] below
    analysis:  StageRecord     // metrics + SLA + mechanical gate, ONE [ANL] Issue
    report:    StageRecord
  }

  // verdict is DERIVED (see invariants), never set independently
  verdict: "pending" | "running" | "pass" | "fail"
         | "blocked_on_human" | "inconclusive" | "error"
  ciSignal: "pending" | "pass" | "fail" | "not_applicable"  // pending until gate completes

  blockedAt?: {
    stage: string
    reason: string
    questionId: string
    interactionType: "thread_interaction" | "approval"  // decision #5
    interactionId: string      // the Paperclip thread/approval awaiting input
    issueId: string            // the backing stage Issue that is blocked
  }

  resolvedExecution?: ResolvedExecution   // reproducibility snapshot (see below)

  startedAt, completedAt, createdAt, updatedAt
}
```

`slaVerdicts` and `regressions` are **no longer inline arrays** on the PipelineRun. They are persisted in their own tables (`sla_verdicts`, `regressions`) keyed by `pipelineRunId` (Data Model §1/§2). The `PipelineRun` carries identity and derived rollup state; the verdicts are joined, not embedded.

### StageRecord and the stage↔Issue mapping

`StageRecord` is a thin projection. The authoritative state — assignment, blocking, threading, approval — lives on the Paperclip Issue it points at, recorded in the existing `test_run_issues` mapping table (the shipped stage↔Issue link).

```typescript
StageRecord {
  // TOTAL status enum (fix 13). A skipped stage MUST also set skippedReason.
  status: "pending" | "running" | "complete" | "skipped" | "failed" | "blocked"
  startedAt?, completedAt?
  issueId?: string             // the Paperclip Issue driving this stage (authoritative)
  assigneeAgentId?: string     // the agent the Issue was created already-assigned to (fix 15)
  skippedReason?: string       // NON-NULL whenever status === "skipped"
  idempotencyKey?: string      // see resumability — mutations are keyed, not blind
  error?: string
}
```

The mapping is explicit, not implicit: every stage Issue is created through `issueService.create({ assigneeAgentId, blockers })`, persisted to `test_run_issues`, and the resulting `issueId` is stamped onto the StageRecord. Reading a stage's status means reading the Issue chain and projecting it down to one of the six total states. The `analysis` StageRecord points at the single `[ANL]` Issue; the other StageRecords point at their respective stage Issues.

| Stage | Issue prefix | Mapped `assigneeAgentId` (owner of the work) |
|---|---|---|
| intake | `[INT]` | intake agent |
| discovery | `[DIS]` | discovery agent (human-gated approval) |
| plan | `[PLN]` | test-plan agent |
| generate | `[GEN]` | script-generation agent |
| validate | `[VAL]` | environment-validation agent |
| execute | `[EXE]` | load-test-agent (spawns the harness) |
| analysis | `[ANL]` | analysis agent (metrics + SLA + mechanical gate) |
| report | `[RPT]` | report agent |

### The execution-trigger path (run against an existing TestPlan)

The locked architecture is explicit here: **`ci`, `scheduled`, and `manual_rerun` are execution triggers, not intake triggers.** They fire against an *existing* TestPlan and skip everything that produces one. The pipeline starts at validate/execute, not at intake.

On an execution trigger the stage map is initialized as:

```typescript
stages: {
  intake:    { status: "skipped", skippedReason: "execution-trigger: no new request to intake" }
  discovery: { status: "skipped", skippedReason: "execution-trigger: RequirementsDocument already exists (referenced live by stable id)" }
  plan:      { status: "skipped", skippedReason: "execution-trigger: TestPlan already exists" }
  generate:  // skipped IFF coverage is complete; otherwise it runs
  validate:  { status: "pending" }   // entry point
  execute:   { status: "pending" }
  analysis:  { status: "pending" }
  report:    { status: "pending" }
}
```

- **`generate` is skipped iff coverage is complete.** Coverage is complete when every workflow in the TestPlan's `trafficMix` has an approved asset (`assetType ∈ {human_authored, approved_generated}`) keyed by the `UNIQUE(testPlanId, workflowName, engine)` constraint. If any workflow lacks an approved asset, `generate` runs to fill the gap; otherwise it records `status='skipped'`, `skippedReason='coverage complete: all trafficMix workflows have approved assets'`.
- **Entry point is `validate`.** The execution-trigger path begins at environment validation (Stage 4), then execute (Stage 5), then the single `analysis` Issue (Stages 6/8), then report (Stage 9) — honoring the locked "CI = execution trigger against an existing TestPlan." Control still flows runner→Sentinel only; nothing here reaches into GitHub.
- The intake-origin path (`manual_intake`, `jira`) runs the full chain from `intake` forward, with `discovery`/`plan`/`generate` gated by their upstream Issue states per Data Model §4.

### Resumability & idempotency

Re-execution is a **first-class, common case** (CI fires on every qualifying push). The rules:

- **Re-execution creates a NEW `PipelineRun`.** A rerun is never an in-place mutation of a prior run's verdict; each trigger materializes a fresh `pipeline_runs` row (and fresh `execution_runs`). History is append-only — comparing run N to run N−1 (deferred Stage 7) depends on this.
- **StageRecords mutate under an idempotency key.** Each stage transition carries a `StageRecord.idempotencyKey`; replaying the same transition (crash-recovery, at-least-once delivery from the Issue event stream) is a no-op rather than a double-advance. The Issue is authoritative, so the projection re-derives deterministically.
- **A crashed ExecutionRun resolves to `failed` with partial data quarantined.** If a harness invocation dies mid-run, its `execution_runs.status='failed'` and any `metric_series` already ingested for it are tagged `partial` and `excluded` — they are retained for forensics but never feed an SLA verdict or a baseline. A partial run never silently produces a green gate.
- **Dynatrace queries are guarded against null `completedAt`.** Every DT `from=…&to=…` query uses `from=executionRun.startedAt` and `to=executionRun.completedAt`. When `completedAt` is null (run still in flight, crashed, or aborted), the adapter **must not** substitute "now" or an open-ended window — it guards the null and either polls the live window with an explicit transient bound or skips the final fold until `completedAt` is set. A null-`completedAt` DT fold is a correctness bug, not a default.
- **A gate block is an open approval row.** When the gate blocks on a human, that is not a flag on the PipelineRun — it is a real open approval interaction on the `[ANL]` Issue. `blockedAt.interactionType='approval'`, `blockedAt.interactionId` points at it, `blockedAt.issueId` is the `[ANL]` Issue. **The un-block contract:** the human resolving that approval (or replying in the thread, for `interactionType='thread_interaction'`) transitions the backing Issue; the PipelineRun's `verdict` and `ciSignal` are then re-derived from the projection. Sentinel does not poll a side-channel — resolving the Paperclip interaction *is* the unblock.

### Reproducibility: the `resolvedExecution` snapshot

A PipelineRun must be reproducible after the fact, even though the *plan* references live SLA targets and the TestPlan can be re-edited. The `loadProfile` is a discriminated union (decision #3) and the steady-state window is an up-front design input baked into the generated asset (decision #1) — so the run must record **what was actually executed**, distinct from what the (mutable) plan now says.

```typescript
ResolvedExecution {
  loadProfile: LoadProfile        // the discriminated-union instance ACTUALLY run (resolved branch)
  executor: "ramping-vus" | "constant-vus" | "constant-arrival-rate" | "ramping-arrival-rate"
            | "kafka" | "streaming"     // constant-vus {vus:1} = the true-baseline branch
  executionModel: "weighted-loop" | "per-scenario"
  resolvedSteadyWindow: { startMs, endMs }   // the windowed-percentile window baked into the asset.
                                             //   For a constant-vus baseline run this is the WHOLE
                                             //   run minus the warm-up guard (no ramp plateau to cut).
  discoveredBreakpoint?: {                   // DEFERRED — populated ONLY for (deferred) exploratory
    rate: number                             //   runs; the rate at which the knee/breakpoint appeared
    p95AtBreak: number
    baselineP95: number
    stopReason: string
  }
  testAssetVersions: [{ testAssetId, workflowName, engine, version }]
  dataFileHashes: [{ name, sha256 }]          // exact data files consumed
  secretRef: string               // the Secrets store reference resolved at run time (NOT the secret)
  rngSeed: number                 // seed for any randomized data selection — replayable
}
```

This snapshot is what makes "re-cut the steady window = regenerate + rerun" honest: the *old* run carries the *old* `resolvedSteadyWindow` and asset versions, so it remains interpretable after the plan is re-cut. It records a `secretRef`, never a secret value.

**Baseline vs exploratory in the snapshot.** For a **`constant-vus` baseline** run, `resolvedSteadyWindow` is the **whole run minus the warm-up guard** — a zero-ramp baseline has no ramp plateau to cut between, so the entire post-warm-up run is the steady window (Stage 6's zero-ramp rule). `discoveredBreakpoint` is populated **only for (deferred) exploratory** runs — it is the knee/breakpoint output of the distress detector, which is not built in v1, so on every v1 run (baseline or conformance) it is absent.

### ExecutionRun linkage and the N-parallel rollup

`ExecutionRun` (defined in Stage 5) carries **`pipelineRunId NOT NULL`** (fix 16) — it points at the parent pipeline, and a nullable `testRunId` at the per-execution child it materializes. The `execute` StageRecord carries the list of execution runs it spawned:

```typescript
stages.execute: StageRecord & {
  executionRunIds: string[]     // one entry per harness invocation (engine × asset)
}
```

A single `execute` stage can fan out to **N parallel ExecutionRuns** — e.g. k6 and Playwright running concurrently to mirror real traffic (Stage 5). The rollup rule for the `execute` StageRecord:

- `complete` **iff** every `executionRunIds[]` entry reached `status='completed'`.
- `failed` if **any** entry is `failed` (and not recoverable) — its partial `metric_series` are tagged `partial`+`excluded`.
- `running` while any entry is `queued | running`.
- An `aborted` entry escalates the PipelineRun `verdict` to `inconclusive` (never a false-green `pass`), per the gate's inconclusive guard.

### Invariants: verdict and ciSignal are DERIVED

`verdict` and `ciSignal` are **never written directly** — they are computed from the stage projection so they cannot drift from the Issue chain:

- **Any stage `blocked` → `verdict = blocked_on_human`** (with `blockedAt` populated, carrying `interactionType`).
- **Any stage `failed` → `verdict = error`.**
- **Any required SLA metric missing / a run `aborted` / insufficient sample → `verdict = inconclusive`** (the gate's inconclusive guard — fix 4, decision #7 — never resolves these to a false-green `pass`).
- **All stages `complete | skipped` → `verdict` = the gate outcome** projected from `gate_resolutions` (`pass | fail | inconclusive`). The `characterization` gate outcome (a `baseline | exploratory` or empty-required-set run) projects to a **`pass`** verdict — it certifies nothing failed and characterizes the floor/envelope, distinct from a vacuous conformance pass.
- **While any stage is `running` → `verdict = running`.**
- **`ciSignal` stays `pending` until the gate (within the `analysis` Issue) completes**, then projects from `gate_resolutions.ciSignal` (`pass | fail`); `not_applicable` only for runs with no CI consumer. The CI signal is consumed by a **final step in the generated GHA workflow** that polls Sentinel's verdict endpoint and fails the job on `fail` — Sentinel never pushes into GHA.

Because verdict is a pure function of the (Issue-derived) stage projection, replaying events, recovering from a crash, or resolving a blocked approval all converge to the same answer with no reconciliation job.

---

## Data Model & Migrations

> **Grounding note.** This section is written against the *real* shipped Drizzle schema under `packages/db/src/schema/`. The current tables are thin: `test_runs` (per-execution, FK to `companies`/`test_plans`/`requirements`), `test_plans` (`loadProfile` is the flat `{ vus, stages }` type), `test_assets` (no `workflowName`, no `ci_workflow` assetType, no uniqueness key), `metric_series` (`testRunId` ON DELETE CASCADE, `metric`/`source`/`value`/`rawValues`/`metadata` only), `baselines` (one row **per metric** with `tolerancePct` + `isActive`), `regressions` (free-text `regressionType` defaulting to `"regression"`, FK to `baselines`/`testRuns`/`issues`), `requirements` (thin: `name`, `description`, `slaTargets: SLATargetRecord[]` where each carries `{ id, metric, operator, threshold, source }`, `source`, `jiraIssueId`, `coverageStatus`), and `test_run_issues` (the stage↔Issue mapping table). Migrations are sequential Drizzle SQL files (currently through `0088_*`), generated from `dist/schema/*.js` into `src/migrations/` and gated by `check:migrations`, `check-migration-scope.ts`, and `check:drift`. Everything below is **additive** unless explicitly flagged.

This pipeline is an **asset factory + analysis control plane**, not an execution orchestrator. Sentinel never reaches into GitHub to trigger runs. The data model therefore centers on three jobs: (1) capturing requirements as a durable, referenceable artifact; (2) describing a portable, executor-agnostic execution bundle (k6 script + `handleSummary` + data + config + a generated GHA workflow); and (3) ingesting self-reported results that flow back from whatever harness ran the bundle (Sentinel's own load-test-agent now, the customer's GHA runner later). The schema must make the harness swap **additive**: same `metric_series` ingestion shape whether the percentile arrives as an exact in-script windowed sub-metric (single-instance k6) or as a server-merged per-bucket t-digest (sharded/distributed). Control flows runner→Sentinel only.

---

### 1. Net-New Tables

#### `pipeline_runs` (NEW PARENT)

**Purpose.** The first-class pipeline state machine that the current single-status `test_runs` row cannot express. One `pipeline_runs` row spans all stages — **`intake → discovery → plan → generate → validate → execute → analysis → report`** (8 stages), where **`analysis` = metrics + SLA evaluation + the mechanical gate, backed by ONE `[ANL]` Issue**. The legacy metrics/compare/gate family does **not** appear as three separate stages here — it collapses into the single `analysis` StageRecord (locked decision #5, contradiction 7). It is a **new parent**, introduced additively; `test_runs` is demoted to the per-execution child (see §2).

**Key columns.**
- `id uuid PK`
- `companyId uuid NOT NULL → companies.id`
- `testPlanId uuid → test_plans.id` (nullable: a run can predate plan creation when discovery is in flight)
- `pipelineRequestId uuid → pipeline_requests.id` *(see note below)*
- `requirementsDocumentId uuid → requirements_documents.id` (nullable until discovery completes)
- `trigger jsonb` — `{ type, source, ref?, changedFiles? }`. **`trigger.type` is a closed enum split by origin (fix 12, contradiction 9):** intake-origin `{ manual_intake, jira }` vs execution-origin `{ ci, scheduled, manual_rerun }`. The undefined `requirement_created` and the ambiguous bare `manual` from the original draft are **dropped at this run layer**. (The request layer keeps `pipeline_requests.source ∈ { manual_intake, jira }` — the SAME intake tokens as `trigger.type`, with no translation — Stage 0 Trigger Sources note.)
- `stages jsonb` — map of stage name → `StageRecord`. `StageRecord = { status, startedAt?, completedAt?, issueId?, assigneeAgentId?, skippedReason?, idempotencyKey?, error? }`. **The map has 8 keys** (`intake, discovery, plan, generate, validate, execute, analysis, report`) — the three analysis-family stages collapse into the SINGLE `analysis` StageRecord backed by one `[ANL]` Issue (locked decision #5, contradiction 7) — not a 1:1 ten-issue split.
- `verdict text` — status enum `pending | running | pass | fail | blocked_on_human | inconclusive | error`. `inconclusive` is new and load-bearing (fix 4, #7): a skipped/insufficient-required-SLA / aborted run resolves here, never to a false-green `pass`.
- `ciSignal text` — `pass | fail | pending | not_applicable`
- `blockedAt jsonb` — `{ stage, reason, questionId, interactionType, interactionId, issueId }` where `interactionType ∈ { thread_interaction, approval }` (decision #5).
- `startedAt`, `completedAt`, `createdAt`, `updatedAt`

**StageRecord status enum (total — fix 13, decision #5).** `pending | running | complete | skipped | failed | blocked`. A skipped stage **must** record `status='skipped'` + a non-null `skippedReason`; null is forbidden so the state machine is total. `StageRecord.status` is a **derived projection** of the backing Paperclip Issue chain — there is no parallel drifting state machine. The Issue is authoritative.

> **`pipeline_requests` note.** The Stage-0 intake artifact (`PipelineRequest`: `source ∈ { manual_intake, jira }`, `jiraIssueKey?`, `artifacts`, `extractedContext`, `ownerUserId`, `status ∈ {pending_confirmation, confirmed, rejected}`) becomes its own NEW table `pipeline_requests`. It is the upstream gate in the status-transition table (§4). Listed here for FK completeness; full column set lives in the Stage-0 section. `pipeline_requests.source ∈ { manual_intake, jira }` uses the SAME intake tokens as `pipeline_runs.trigger.type` — no translation (§Stage 0).

#### `requirements_documents` (NEW — not an extension of `requirements`)

**Purpose.** The signed-off output of Stage 1 (Discovery). This is a **new table**, NOT a widening of the thin `requirements` table — it needs ~15 fields `requirements` lacks (`protocol`, `syncModel`, `asyncDetails`, `loadModel`, `authentication`, `testData`, `existingArtifacts`, `targetEnvironment`, `dynatrace`, `minSampleCount`, owner, approval columns). It is the **single source of truth for SLA targets** (decision #8, §3).

**Key columns.**
- `id uuid PK`, `companyId uuid NOT NULL → companies.id`
- `pipelineRequestId uuid → pipeline_requests.id`
- `appName text`, `appDescription text`, `ownerUserId text`
- `testIntent text NOT NULL DEFAULT 'conformance'` — `conformance | baseline | exploratory`. The discovery-captured intent of the run, referenced downstream: **Stage 2** branches on it (`baseline → constant-vus {vus:1}`; the `cannot-derive → resume discovery` rule does NOT bounce a well-specified baseline for lacking a peak); **Stage 8** routes `baseline | exploratory` (and any empty-required-set run) to the `characterization` gate outcome instead of a vacuous `auto_pass`; **Stage 9** selects the report shape (a characterization/floor report vs a conformance pass/fail report). `exploratory` is recognized in v1 but its distress-ramp generator is deferred.
- `protocol jsonb` — `string | string[]` (`http | grpc | kafka | websocket | browser | …`)
- `syncModel text` — `sync | async | hybrid`
- `asyncDetails jsonb` — `{ measurementPoint, sagaDescription }`
- `slaTargets jsonb NOT NULL DEFAULT []` — **canonical SLA element** (contradiction 8, §3): each `{ id, source, metric, operator, threshold, required, workflowScope?, approvedByUserId? }`. `id` + `source` reconcile the shipped `SLATargetRecord`; `required` backs the missing-required-metric rule (fix 4) and the gate's required/optional distinction; `approvedByUserId` reconciles the spec draft. `source ∈ { k6, playwright, apm:dynatrace, … }` — aligned with `sla_verdicts.source`. This is the **stable id** that `test_plans` and `sla_verdicts` reference.
- `loadModel jsonb` — `{ peakConcurrentUsers?, peakTps?, peakMps?, loadProfile, trafficMix[] }`
- `authentication jsonb`, `testData jsonb`, `existingArtifacts jsonb`, `targetEnvironment jsonb`, `dynatrace jsonb`
- `minSampleCount int NOT NULL DEFAULT 200` — the **min-sample guard threshold** read by Stage 6 and Stage 8 step 2. A required target whose evaluated `metric_series.sampleCount` falls below this resolves to `inconclusive`. The default **200 is the p95 floor** (≈ 10/(1−0.95)) since most clients evaluate at the 95th percentile; the guard is **percentile-aware** — for a stricter percentile in `slaTargets[]` the floor scales up (p99 ≈ 1,000), derived from the strictest target. A per-target override may live on `slaTargets[]`; absent that, this document-level value applies. Defining it here makes the insufficient-sample inconclusive trigger deterministic across implementers.
- `status text` — `in_progress | complete | approved` (the discovery human-gate states)
- `approvedByUserId text`, `approvedAt`, `createdAt`, `updatedAt`

#### `execution_runs` (NEW)

**Purpose.** One per harness invocation (one engine, one asset) under a pipeline run. This is where the **harness-swap seam** lives: the same row models a k6 process spawned in a Paperclip `ExecutionWorkspace` (now) or a step in a generated GHA workflow (later). The reporting contract is identical.

**Key columns.**
- `id uuid PK`, `companyId uuid NOT NULL → companies.id`
- `pipelineRunId uuid NOT NULL → pipeline_runs.id` (fix 16)
- `testRunId uuid → test_runs.id` (**nullable** — the per-execution child it materializes; a run may exist before `test_runs` materialization)
- `testAssetId uuid → test_assets.id`
- `engine text`, `binaryProfile text` — resolvable k6 binary path/profile, NOT the literal `'k6'` (fix 8: enables `xk6-kafka`/browser)
- `workspaceRef text` — the per-run `ExecutionWorkspace` cwd (fix 6); `handleSummary` output is written here and read back named by `TEST_RUN_ID` (fixes 5, 6)
- `status text` — enum `queued | running | completed | failed | aborted`
- `startedAt`, `completedAt` — `startedAt` is the **anchor** for every Dynatrace `from=…` query (server-side correlation)
- `exitCode int`, `peakVus int`, `totalIterations int`, `totalRequests int`
- `stdoutRef uuid → test_run_artifacts.id (artifactType=stdout_log)` — **an artifact FK, not a free string** (Stage 9). The captured stdout is a `test_run_artifacts` row; this column references its `id`.
- `liveMetricFeed text` — SSE endpoint ref (transient)

#### `sla_verdicts` (NEW — replaces the inline `SLAVerdict[]` on the pipeline object)

**Purpose.** Persisted per-target pass/fail from Stage 6, computed over the **authoritative windowed sub-metric** (contradiction 1).

**Key columns.**
- `id uuid PK`, `companyId uuid NOT NULL → companies.id`
- `pipelineRunId uuid NOT NULL → pipeline_runs.id` (fix 16)
- `executionRunId uuid → execution_runs.id`
- `testRunId uuid → test_runs.id` (**nullable** — a verdict can predate `test_runs` materialization; consistent with `execution_runs.testRunId`)
- `slaTargetId text NOT NULL` — **joins `requirements_documents.slaTargets[].id`** (§3: single source of truth, no copy)
- `workflowName text`, `phase text` — the `{workflow, phase}` tags that scope the windowed percentile
- `metric text`, `operator text`, `threshold real`, `actualValue real`
- `evaluationWindow jsonb` — `{ startMs, endMs }`, derived from loadProfile **stage phases** (the plateau between last ramp-up and first ramp-down), NOT a fixed "last 60%" (fix 10)
- `source text` — `k6 | playwright | apm:dynatrace` (k6 authoritative for SYNC; DT authoritative for ASYNC — decision #6); aligned with `requirements_documents.slaTargets[].source`
- `status text` — status enum `pass | fail | inconclusive`. **A missing/insufficient REQUIRED metric resolves to `inconclusive` — NOT `fail` and NOT `skipped`** (fix 4, contradiction 6). `fail` is reserved for a target that was measured and breached. `inconclusive` is exactly what the gate (§4) reads to fire the inconclusive outcome → `ciSignal='fail'` or escalate to `blocked_on_human`, never false-green.
- `evaluatedOnSuccessOnly boolean` — latency percentiles evaluated over `{expected_response:true}` samples only (a distinct tagged series from raw `http_req_duration`, which is informational only — fix 9).
- `createdAt`

#### `gate_resolutions` (NEW)

**Purpose.** The Stage-8 verdict→CI signal. v1 is **mechanical** auto_pass/auto_fail/inconclusive on the SLA verdict (decision #7) — it is NOT an analysis-construction item. Regression-review and baseline-proposal outcomes are **deferred-analysis paths** (their rows can exist but the logic ships later).

**Key columns.**
- `id uuid PK`, `companyId uuid NOT NULL → companies.id`
- `pipelineRunId uuid NOT NULL → pipeline_runs.id` (fix 16)
- `testRunId uuid → test_runs.id` (**nullable** — consistent with the other child tables)
- `outcome text` — status enum `auto_pass | auto_fail | inconclusive | characterization | regression_approved | regression_rejected | baseline_approved | baseline_rejected`. **`characterization` is added (v1)** — a `testIntent ∈ { baseline, exploratory }` run, or any run with an **empty required-SLA set**, resolves here (`ciSignal='pass'`, human-promotable) instead of falling through to a *vacuous* `auto_pass`; this is the same outcome true-baseline (v1) and the deferred exploratory ramp both use, and it is what stops the empty-required-set false-green. **`baseline_rejected` is added (fix 14)** so `ciSignal` is never undefined; a `baseline_approved` / baseline-proposal path **always yields `ciSignal='pass'`** (can't fail against a nonexistent baseline). The `inconclusive` outcome (fix 4/#7) maps to `ciSignal='fail'`; on escalation `pipeline_runs.verdict='blocked_on_human'` while this row's `ciSignal` stays `'fail'` — never a false green, never NULL.
- `ciSignal text NOT NULL` — `pass | fail`. **Total on every path, including the `blocked_on_human` escalation** (set to `'fail'` conservatively while the block lives on `pipeline_runs.verdict` / the `[ANL]` Issue).
- `resolvedBy text` — `userId | 'auto'`, `resolvedAt`, `comment text`, `createdAt`

> The CI signal is consumed by a **final step in the generated GHA workflow** that polls Sentinel's verdict endpoint and fails the job on `ciSignal='fail'`. Sentinel never pushes into GHA.

#### `test_run_artifacts` (NEW)

**Purpose.** First-class stored artifacts (store-first, publish-second). Holds both the **k6 native HTML report** (per-run, named by `TEST_RUN_ID`) and the **thin Sentinel summary report**, plus stdout logs and the generated GHA workflow bundle. Distinguishes the streaming feed (`--out json=-`) from the `handleSummary` HTML — they are **different artifacts** (fix 7).

**Key columns.**
- `id uuid PK`, `companyId uuid NOT NULL → companies.id`
- `pipelineRunId uuid NOT NULL → pipeline_runs.id` (fix 16)
- `executionRunId uuid → execution_runs.id` (**nullable** for pipeline-level artifacts like the Sentinel summary)
- `testRunId uuid → test_runs.id` (**nullable** — pipeline-level artifacts such as `sentinel_summary` have no single per-execution `test_run`; consistent with the other child tables)
- `artifactType text` — **canonical column name** (used here, in the Architecture section, and in Stage 3/9; the Stage 9 runtime object uses the same `artifactType` field — the earlier `kind` alias is retired). Status/kind enum `k6_html_summary | sentinel_summary | stdout_log | metrics_json_stream | dynatrace_deeplink | gha_workflow_bundle | performance_envelope`. **`performance_envelope` is RESERVED but DEFERRED** — the per-step p95-vs-load series + breakpoint + recommended SLA produced by the (deferred) exploratory ramp; the value is enumerated now so it is total from day one, but no v1 renderer emits it (it lands with exploratory mode in the analysis wave).
- `storageRef text NOT NULL`, `url text` (stable — the runtime object's `url` field maps to this column), `contentType text`, `sizeBytes int`
- `publishStatus text` — `stored | published | publish_failed` (store succeeds independently of external push)
- `createdAt`

---

### 2. Altered Tables

#### `test_runs` — stays the per-execution record

- **+ `pipelineRunId uuid → pipeline_runs.id`** (nullable during backfill window, see §5). `test_runs` is no longer the root; it is the child execution record. All existing FKs (`companyId`, `testPlanId`, `requirementId`) and the `metric_series.testRunId` ON DELETE CASCADE are **left untouched** (decision #4).
- Existing `triggerType` / `status` / `resultSignal` retained for backward compatibility; the pipeline-level verdict now lives on `pipeline_runs.verdict`.

#### `metric_series` — digest-ready ingestion

- **+ `executionRunId uuid → execution_runs.id`** and **+ `workflowName text`** (fix 16) so series are scoped per execution and per workflow — required for `http_req_duration{workflow,phase}` windowing.
- **+ `phase text`** — the phase tag the VU sets via `exec.instance.currentTestRunDuration`; enum `warmup | ramp_up | steady | ramp_down`. **`warmup`** is the front-edge cold-start exclusion (JIT/TLS/pool/DNS priming), never authoritative — it is the only steady window a zero-ramp `constant-vus` baseline cuts (the whole run minus the warm-up guard). (The deferred exploratory per-step `step_<rate>` phases are NOT emitted in v1.)
- `source text` already exists (`k6 | apm:dynatrace | …`) — retained.
- **+ digest-ready storage:** `digest jsonb` (per-bucket t-digest / HDR-histogram blob) **+ `sampleCount int`**. This is the additive seam for the single-instance→sharded swap (decision #1): single-instance k6 ships exact windowed sub-metrics; distributed load escalates to per-bucket digests **merged server-side** with no schema change. `sampleCount` is also the value the **min-sample guard** compares against `requirements_documents.minSampleCount` (Stage 6/8). The scalar `value` / `rawValues` columns are **retained only for the informational k6 HTML path**, not as the percentile source of record.
- The existing **`metadata`** column is **retained** (free-form correlation context) — for consistency with the grounding note and the Stage 6 `MetricSeries` shape.
- ON DELETE CASCADE on `testRunId` is **left as-is** (decision #4, §5).

> **Dynatrace ingestion correctness (fixes 1, 2; baked into the adapter, surfaced here for the digest contract):** ASYNC percentiles come from DT-native transforms (`builtin:service.response.time:percentile(95):fold`) — never client-computed from per-bucket averages. DT error rate is **count-weighted** (`errors.total.count / requestCount.total` over the window), never a mean of per-bucket rates. For shared external services DT is contaminated by other tenants, so DT is **authoritative only for ASYNC** and **diagnostic-only ("the why") for SYNC** (decision #6, contradiction 2). The 10s/30s time-series cadence is correlation-only and never the percentile source of record (Stage 5).

#### `test_assets` — workflow + CI-workflow asset

- **+ `workflowName text NOT NULL`** — a single TestPlan has many workflow assets; the traffic mix demands per-workflow scripts.
- **+ extend `assetType`** to include **`ci_workflow`** (the generated GHA workflow YAML) alongside `human_authored | generated | approved_generated`.
- **+ `protocol text`**, **+ `dataFiles jsonb`**, **+ `setupScript text`**, **+ `teardownScript text`**, **+ `generatedFrom text`** (`openapi | postman | functional_tests | scratch | existing_k6`), **+ `sourceRef jsonb`** (`{ repoUrl, path, ref, importedSha }` — read-only provenance for an imported/updated asset; Sentinel never pushes, a human commits) — to carry the consumable/reusable data strategy and provenance.
- **+ UNIQUE (`testPlanId`, `workflowName`, `engine`)** — keys an asset so regeneration replaces rather than duplicates.

#### `test_plans` — discriminated load profile, referenced SLAs

- **`loadProfile` widened from the flat `{ vus, stages }`** to a **protocol-tagged discriminated union** (decision #3, contradiction 3) with an explicit `executor` discriminator: `ramping-vus | constant-vus | constant-arrival-rate | ramping-arrival-rate`, plus Kafka `{ producerRate, consumerRate }` and streaming `{ concurrentConnections, messagesPerConnectionPerSec }`. (`constant-vus {vus:1}` is the **true-baseline** branch derived from `testIntent = baseline`.) **+ `executionModel text`** = `weighted-loop | per-scenario` (per-scenario iff per-workflow SLAs exist). k6 `options.scenarios` are emitted from **config**, not CLI flags. Which branch instantiates is **derived from the RequirementsDocument** (protocol + sync/async; `peakConcurrentUsers→ramping-vus`, `peakTps→arrival-rate`, `peakMps→Kafka`). **Staging:** the union expresses all protocols now; generators/adapters are built incrementally (HTTP/sync first).
- **+ `requirementsDocumentId uuid → requirements_documents.id`** — and SLA targets are **referenced by stable id, not copied** (§3). The old inline `slaTargets`-copied-onto-the-plan pattern is removed to kill the 3-copy drift.
- Existing `engines`, `apmProvider`, `apmServiceId`, `filePatterns`, `schedule`, `isActive` retained.

#### `baselines` / `regressions` — exist now, logic deferred (§6)

- **`baselines` + `baselineSetId uuid`** — groups the per-metric rows produced by ONE approved run into a single logical baseline (contradiction 4). The table keeps its one-row-per-metric shape; `baselineSetId` is the atomic-set wrapper. Resumed-v2 logic adds `median`, `stddev`, `sampleN`, `direction` (distribution over K clean, non-polluted runs).
- **`regressions.regressionType` becomes a closed enum** set deterministically from the metric (fix 11) — `latency_p95 | latency_p99 | throughput | error_rate | saga_completion | …` — not the free-text-never-populated `"regression"` default.
- **`regressions` + `pipelineRunId uuid → pipeline_runs.id`** (fix 16) + a `direction` column. **Direction-awareness is the ONE baseline fix applied even in v1** (decision #2, fix 3, contradiction 5): the comparator must flag deviation in the **worsening** direction derived from the SLA operator (so a throughput/saga *collapse* is detectable, not only upward latency drift).

---

### 3. SLA-Target Identity Resolution (single source of truth)

The original design carried SLA targets in **three places** (RequirementsDocument, TestPlan, and the verdict), which drifts. The canonical resolution (decision #8, contradictions 8):

1. **`requirements_documents.slaTargets[]`** is the **only** authoritative copy. Each element is **`{ id, source, metric, operator, threshold, required, workflowScope?, approvedByUserId? }`**: a **stable `id`**; `source` (the evaluating feed, `k6 | playwright | apm:dynatrace | …`, aligned with `sla_verdicts.source`); `required: boolean` (load-bearing for the missing-required-metric rule and the gate's required/optional split — fix 4); `workflowScope?` (a `workflowName` for a per-workflow SLA, which drives the Stage-2 `per-scenario` execution model); and `approvedByUserId`.
2. **`test_plans`** does **not** copy SLA targets — it references them live via `requirementsDocumentId` (no snapshot; the targets are read through at evaluation time).
3. **`sla_verdicts.slaTargetId`** joins `requirements_documents.slaTargets[].id` directly.

This collapses three copies to one. Editing an SLA target in the RequirementsDocument is immediately reflected in every plan and verdict that references it — no reconciliation job, no drift.

---

### 4. Status-Transition Table (upstream gates downstream)

The pipeline is a chain of human-gated state machines. Each upstream state **gates** the entry of the next stage; a downstream stage may not start until its upstream is in the required terminal state.

| Upstream entity & state | Gates entry of | Downstream effect |
|---|---|---|
| `pipeline_requests.status = pending_confirmation` | (nothing) | Jira-origin requests block here until owner confirms; manual-origin auto-advance |
| `pipeline_requests.status = confirmed` | **Discovery (Stage 1)** | A `requirements_documents` row may be created |
| `pipeline_requests.status = rejected` | — | Pipeline terminates; `pipeline_runs.verdict` never leaves `pending` |
| `requirements_documents.status = in_progress` | (blocks Plan) | Discovery still gathering; Stage 2 cannot start |
| `requirements_documents.status = complete` | (blocks Plan) | Awaiting human approval — **stop-and-ask** gate |
| `requirements_documents.status = approved` (+ all required `slaTargets[].approvedByUserId` set) | **Test Plan (Stage 2)** → Generate → Validate | Plan creation allowed; SLA targets become referenceable |
| `test_assets.assetType ∈ {human_authored, approved_generated}` | **Execution (Stage 5)** | Only approved/human assets run in production executions; `generated` runs preview-only |
| `execution_runs.status = completed` | **Analysis: Metrics/SLA (Stage 6)** | Windowed verdicts computed; `aborted`/`failed` → `pipeline_runs.verdict = inconclusive` |
| `sla_verdicts` all `pass` **and no required metric inconclusive/missing** **and a non-empty required set under `testIntent = conformance`** | **Analysis: Gate (Stage 8) → auto_pass** | `gate_resolutions.ciSignal = pass` |
| `requirements_documents.testIntent ∈ {baseline, exploratory}` **OR** no required SLA targets (empty required set) | **Gate → characterization** | `ciSignal = pass`; characterizes the floor/envelope, human-promotable — NOT a vacuous `auto_pass` |
| any required `sla_verdicts.status = fail` (measured + breached) | **Gate → auto_fail** | `ciSignal = fail` |
| any required `sla_verdicts.status = inconclusive` / run aborted / sampleCount < minSampleCount | **Gate → inconclusive** | `ciSignal = fail`; on escalation `pipeline_runs.verdict = blocked_on_human` (gate row `ciSignal` stays `fail`) — never false-green |
| `gate_resolutions` resolved | **Report (Stage 9)** | Artifacts stored, then published |

> The Stage-6 metrics/SLA gate and the Stage-8 mechanical gate are **two phases of the single `analysis` StageRecord** (one `[ANL]` Issue), not two independent StageRecords. They are listed as separate transition rows for clarity of the gating logic, but they share one Issue and one StageRecord (decision #5, contradiction 7).

`pipeline_runs.verdict` is the rollup: `running` while any stage is active, `blocked_on_human` whenever any stage is `blocked` (with `blockedAt.interactionType`), and a terminal `pass | fail | inconclusive | error` once the gate resolves.

---

### 5. Migration Ordering & Risk (lowest blast radius)

The **TestRun→PipelineRun promotion is purely additive** — `pipeline_runs` is a NEW parent table, not a rename or a column drop on `test_runs`. The existing `metric_series.testRunId` ON DELETE CASCADE and all current FKs are **left untouched** (decision #4: additive now, tighten later). Recommended ordering, lowest blast radius first — each migration is independently shippable and reversible because nothing existing is dropped or made NOT NULL on populated columns:

1. **`0089` — create leaf tables with no inbound FKs from existing data:** `pipeline_requests`, `requirements_documents`. Zero risk; nothing references them yet.
2. **`0090` — create `pipeline_runs`** (FKs out to the §1 tables, all nullable). Still zero inbound pressure on existing rows.
3. **`0091` — create `execution_runs`, `sla_verdicts`, `gate_resolutions`, `test_run_artifacts`** (all FK to `pipeline_runs`, all new). New writes only. `execution_runs.stdoutRef` and the `test_run_artifacts` self/cross references are created in this step.
4. **`0092` — ALTER existing tables additively:** add **nullable** `test_runs.pipelineRunId`; add `metric_series.executionRunId`/`workflowName`/`phase`/`digest`/`sampleCount` (retaining `metadata`); add `test_assets.protocol`/`dataFiles`/`setupScript`/`teardownScript`/`generatedFrom` and **extend** (not constrain) `assetType`; add `test_plans.requirementsDocumentId` + widen `loadProfile` type (jsonb is structurally unchanged, only the TS discriminated-union type narrows — no SQL data migration); add `baselines.baselineSetId`, `regressions.pipelineRunId`/`direction`. All nullable, no backfill required.
5. **`0093` (deferred / fast-follow) — tighten:** make `test_assets.workflowName NOT NULL` and add the `UNIQUE(testPlanId, workflowName, engine)` constraint **only after** existing rows are backfilled; convert `regressions.regressionType` to the closed enum. These are the only constraints that can fail against existing data, so they ship last, behind a backfill.

**Risk callouts.** (a) The only data-loss-class change is the deferred `NOT NULL`/`UNIQUE` on `test_assets` — gated behind a backfill in `0093`. (b) `loadProfile` widening is a **type-only** change at the SQL layer (column stays `jsonb`); old `{ vus, stages }` rows remain valid `ramping-vus` instances, so no rewrite. (c) CASCADE is deliberately not tightened — if a `test_runs` row is deleted, `metric_series` still cascades exactly as today; the new `execution_runs`/`sla_verdicts`/etc. point at `pipeline_runs` and are governed by *its* (additive) lifecycle, which does not retroactively change `test_runs` behavior.

---

### 6. v1 vs Deferred (data layer)

**Built in v1 (data + logic):**
- `pipeline_requests`, `requirements_documents`, `pipeline_runs`, `execution_runs`, `sla_verdicts`, `gate_resolutions`, `test_run_artifacts`.
- `test_runs.pipelineRunId`; `metric_series` digest-ready columns; `test_assets` workflow/data columns; `test_plans` discriminated `loadProfile` + referenced SLAs.
- Mechanical Stage-8 gate (auto_pass/auto_fail + `inconclusive` guard + the `characterization` outcome).
- **True-baseline:** the `constant-vus {vus:1}` branch + the `warmup` phase + the **whole-run-is-the-steady-window** rule (minus the warm-up guard) + **duration sized from `minSampleCount`** (the post-warm-up success population must clear the floor or the run resolves `inconclusive` for being too short).
- **The `characterization` gate outcome** (`testIntent ∈ { baseline, exploratory }` or empty-required-set → `characterization`, never a vacuous `auto_pass`).
- **The `testIntent` column** (`requirements_documents.testIntent`) + **Discovery recognition of a no-SLA / no-load customer** (offer baseline or exploratory; relax only the SLA/load block; still stop-and-ask Q3 sync/async and Q8 data strategy).
- Direction-aware comparator field (`regressions.direction`) — the one baseline fix applied now.
- HTTP/sync generators and adapters first (the union expresses all protocols; only HTTP/sync ships).

**Tables exist, logic deferred:**
- **`baselines` / `regressions` tables exist and accept rows, but the Stage-7 baseline *distribution* logic (median+stddev+N over K clean runs, z-score + tolerance worsening flag, cold-start low-confidence, DT-polluted exclusion, `baselineSetId` grouping) is DEFERRED.** The §1/§2 capture (windowed digests, per-workflow series, direction field) already supports it, so resuming it is purely additive — no schema migration required beyond the v2 columns noted in §2.
- **`ci_workflow` asset type ships fast-follow** — the column value is reserved now; the GHA-workflow generator that produces and stores the bundle (`test_run_artifacts.artifactType = gha_workflow_bundle`) lands immediately after the local Paperclip-harness path is proven.
- **Sharded/distributed t-digest server-side merge** is reserved by the `digest`/`sampleCount` columns but not implemented in v1 (single-instance exact windowing only).
- **Regression-review and baseline-proposal gate outcomes** (`regression_approved/rejected`, `baseline_approved/rejected`) are valid `gate_resolutions.outcome` values but their analysis-construction paths are deferred; v1 only emits `auto_pass | auto_fail | inconclusive | characterization`.

**Deferred to the analysis wave (recognized in v1, NOT built):**
- **The exploratory DISTRESS DETECTOR generator** — the load-to-knee ramp that drives `testIntent = exploratory`: a **rolling per-step p95** computed from the `--out json` live stream, **early baseline capture**, a **knee compare** against that baseline, and a **hard cap** stop condition. `testIntent = exploratory` is recognized at Discovery and routes to the `characterization` gate outcome, but the generator that actually ramps to distress is deferred.
- **Per-step `{ phase: step_<rate> }` windows** — the per-load-step sub-metric windows the distress detector tags; not emitted in v1 (only `warmup | ramp_up | steady | ramp_down`).
- **The `performance_envelope` artifact + report renderer** — the per-step p95-vs-load series + breakpoint + recommended SLA (`test_run_artifacts.artifactType = performance_envelope`, reserved); ramp defaults; `ResolvedExecution.discoveredBreakpoint`; and the **Stage-7 cross-shape comparison**.

**Kafka / async fast-follow gaps (DOCUMENTED so they are not lost; NOT built in v1):**
- The `kafka` `loadProfile` branch needs a **real underlying executor** — arrival-rate at `producerRate` (xk6-kafka has no native rate executor), with `stages`/window — not just a `{ producerRate, consumerRate }` shape.
- A **Dynatrace end-to-end SAGA-COMPLETION metric** for async (not the single-service `builtin:service.response.time`) — the async source of record must measure end-to-end message processing, not one hop.
- Wire **`asyncDetails.measurementPoint`** into the DT query so the async percentile is taken at the captured measurement point.
- **Kafka/async Stage-4 environment validation** — broker reachability, topic existence, produce-confirm (the sync reachability/auth/smoke pre-flight does not cover a broker).
- **High-cardinality consumable data** — `generate-in-setup()` for consumable items too large to ship as data files.
- **DT sample-count** feeding the min-sample guard for async targets (the DT-native percentile needs a `sampleCount` so the insufficient-sample → `inconclusive` rule works on the async path too).

---

## v1 Scope & Deferred

### Philosophy

Sentinel is an **asset factory + analysis control plane**, not an execution orchestrator. It never reaches into GitHub to trigger a run. It generates a self-reporting execution bundle — the k6 script + `handleSummary` + data files + config + (later) a GitHub Actions workflow YAML — and the customer's runner executes it. Results flow **back** to Sentinel's ingestion endpoint. Control flows **runner→Sentinel only, never Sentinel→GHA**.

This reframe is what makes v1 tractable. The **portable unit** is the k6 script (with its `handleSummary`), which is executor-agnostic. Only the **harness** swaps:

- **NOW (v1):** Sentinel's own `load-test-agent` spawns k6 inside a Paperclip `ExecutionWorkspace`. This is how we test Sentinel against real targets locally, end-to-end, before any GHA generator exists.
- **LATER (fast-follow):** a **generated** GitHub Actions workflow runs the *same* k6 script on the customer's runner.

Same script, same ingestion endpoint, same SLA/gate/report path. The data model is designed so that swap is **purely additive** (see Data Model §1–§2): identical `metric_series` shape whether a percentile arrives as an exact in-script windowed sub-metric (single-instance k6) or a server-merged per-bucket t-digest (sharded). Because the harness is a seam and not a fork, "build the local path first, generate the GHA workflow second" costs nothing in rework.

The locked principles are unchanged: **hybrid ownership**; **stop-and-ask on ambiguity** (no degraded fall-through — a blocked pipeline with a clear question beats a running one with bad assumptions); **external/third-party target** (validate, never provision); **intake = manual + Jira only**; **visualization = Dynatrace deep-links + native k6 HTML + a thin Sentinel summary** (no custom charts); and Sentinel is a **thin domain layer on the Paperclip platform** — we complete the domain layer, we never rewrite the platform.

### What v1 Builds (the end-to-end local path)

v1 ships the **complete pipeline against a local Paperclip harness**, intake through report:

`intake → discovery → plan → generate (k6 script + LOCAL run harness) → validate → execute → analysis (metric CAPTURE + mechanical SLA gate) → report`

| Stage | v1 scope |
|---|---|
| **0 Intake** | Full. Manual + Jira only; produces `PipelineRequest` in `pending_confirmation` (Jira) or auto-advances (manual). Unchanged. |
| **1 Discovery** | Full. Produces the signed-off `RequirementsDocument` — the **single source of truth for SLA targets**, each carrying a `required` flag and the document-level `minSampleCount`. Human-gated. Unchanged. |
| **2 Test Plan** | Full, with a **protocol-tagged discriminated `loadProfile`** and SLA targets **referenced by stable id**, not copied. |
| **3 Generate** | k6 script + `handleSummary` + data files + config, **emitted as a portable bundle**. The **LOCAL run harness** (load-test-agent in an ExecutionWorkspace) is wired now. GHA-workflow generation is deferred. |
| **4 Validate** | Full pre-flight (reachability, auth, smoke, Dynatrace ambient/entity, data volume). Stop-and-ask on any failure. Unchanged. |
| **5 Execute** | Full, via the local harness. Live SSE stream, graceful abort, per-workflow + per-phase tagging. `ExecutionRun` is the harness-swap seam. Unchanged in shape. |
| **6/8 Analysis** | One `analysis` StageRecord / `[ANL]` Issue. Full metric **capture + SYNC SLA percentiles** (k6 source of record for SYNC via `{workflow, phase}`-tagged sub-metrics; Dynatrace for ASYNC, diagnostic-only for SYNC; capture is digest-ready). Plus the **mechanical gate**: `auto_pass`/`auto_fail` on the SLA verdict (criteria from `RequirementsDocument.slaTargets`), plus the **`inconclusive` guard** (missing/insufficient REQUIRED SLA → `sla_verdicts.status=inconclusive` → gate `inconclusive` → CI fail or `blocked_on_human`, never false-green). |
| **9 Report** | Full. Dynatrace deep-link + native k6 HTML + thin Sentinel summary. Store-first, publish-second. Unchanged. |

**The one analysis fix applied even in v1:** the comparator is **direction-aware**. The worsening direction is derived from the SLA operator, so a throughput or saga-completion *collapse* is detectable, not only upward latency drift. This is the single field (`regressions.direction`) carried forward from the deferred baseline work because it is cheap and the capture already supports it.

### What v1 Defers

These are **deferred, not designed-away** — each resumes additively because v1 capture already supports it. No schema migration beyond the noted v2 columns is required to turn any of them on.

| Deferred | Why deferred | Resumption cost |
|---|---|---|
| **Baseline / regression analysis (Stage 7)** | The distribution logic (median + stddev + N over K clean non-polluted runs, z-score + tolerance worsening flag, cold-start low-confidence, DT-polluted exclusion, `baselineSetId` grouping) is real work and not on the critical path for a first mechanical gate. | Additive. The windowed digests, per-workflow series, and `direction` field captured in v1 already feed it. `baselines`/`regressions` tables exist and accept rows now. |
| **GHA-workflow generation** | Prove the local harness path first. The script is portable; only the harness swaps. | Fast-follow. `test_assets.assetType` reserves the `ci_workflow` value; the generator emits a `gha_workflow_bundle` artifact and a final job step that polls Sentinel's verdict endpoint and fails on `ciSignal='fail'`. Sentinel never pushes into GHA. |
| **Non-HTTP protocol generators/adapters** | The `loadProfile` discriminated union expresses **all** protocols (HTTP, gRPC, WebSocket, Kafka, browser) now; building every adapter at once is unnecessary. | Incremental. HTTP/sync generators and adapters ship first; the model is already shaped for Kafka `producerRate/consumerRate`, streaming `concurrentConnections/messagesPerConnectionPerSec`, and arrival-rate executors. |
| **Sharded/distributed t-digest server-side merge** | Single-instance k6 in-script tagging is exact and sufficient for v1. | Additive. The `digest` / `sampleCount` columns reserve the seam; distributed load escalates to per-bucket digests merged server-side with no schema change. |
| **Regression-review & baseline-proposal gate outcomes** | These are analysis-construction paths that depend on the deferred Stage 7. | `gate_resolutions.outcome` already enumerates `regression_approved/rejected` and `baseline_approved/rejected`; v1 only emits `auto_pass | auto_fail | inconclusive | characterization`. |
| **Exploratory distress-detector generator** | `testIntent = exploratory` is recognized at Discovery and routes to the `characterization` gate outcome, but the load-to-knee ramp itself (rolling per-step p95 from the `--out json` stream, early baseline capture, knee compare, hard cap) is real generator work and not on the critical path for v1. | Additive. `testIntent`, the `characterization` outcome, the `performance_envelope` artifactType, `ResolvedExecution.discoveredBreakpoint`, and the per-step `step_<rate>` phase tag are all reserved now. Adds the ramp generator + the `performance_envelope` renderer + Stage-7 cross-shape comparison. |
| **Kafka / async path** | v1 ships HTTP/sync end-to-end. The async fixes are documented but deferred: the `kafka` branch needs a real underlying executor (arrival-rate at `producerRate` + stages/window); a DT **end-to-end saga-completion** metric (not single-service `builtin:service.response.time`); wiring `asyncDetails.measurementPoint` into the DT query; Kafka/async Stage-4 env validation (broker/topic/produce-confirm); high-cardinality consumable `generate-in-setup()`; and a DT `sampleCount` for the min-sample guard on async targets. | Incremental. The `loadProfile` union, `syncModel`, `asyncDetails`, and the `apm:dynatrace` source-of-record seam already exist; each gap is an additive adapter/validation, no schema migration. |

### What Changes About the Current Implementation (updated)

The current codebase has the right domain model at the table level but is a thin platform layer missing the Sentinel domain. The locks change the list as follows — everything below is **additive** over the shipped schema:

1. **`RequirementsDocument` becomes a net-new `requirements_documents` table** — NOT a widening of the thin `requirements` table (it needs ~15 fields that table lacks: `protocol`, `syncModel`, `asyncDetails`, `loadModel`, `authentication`, `testData`, `existingArtifacts`, `targetEnvironment`, `dynatrace`, `minSampleCount`, owner/approval columns). It is the **single source of truth for SLA targets**, each carrying a `required` flag (decision #8).
2. **`PipelineRun` is introduced as a NEW PARENT table** (`pipeline_runs`) — `test_runs` is demoted to the per-execution child with an added `pipelineRunId` FK. Additive: existing FKs and the `metric_series.testRunId` ON DELETE CASCADE are left untouched (decision #4).
3. **Stage status is a derived projection of the Paperclip Issue chain** — `StageRecord.status` does not run a parallel state machine; the Issue is authoritative (decision #5). The three analysis-family stages (metrics/compare/gate) collapse into a **single `analysis` StageRecord** backed by one `[ANL]` Issue for v1 — not a 10-issue 1:1 split. `blockedAt` carries `interactionType ∈ { thread_interaction, approval }`.
4. **Protocol is explicit everywhere via a discriminated `loadProfile`** — `test_plans.loadProfile` widens from the flat `{ vus, stages }` to a protocol-tagged discriminated union with an explicit `executor` (`ramping-vus | constant-arrival-rate | ramping-arrival-rate`) plus Kafka and streaming branches; `executionModel ∈ { weighted-loop, per-scenario }`. Which branch instantiates is **derived from the RequirementsDocument**. k6 `options.scenarios` are emitted from config, not CLI flags (decision #3).
5. **TestPlan references SLA targets by stable id, not by copy** — the old inline `slaTargets`-copied-onto-the-plan pattern is removed to kill the three-copy drift. `sla_verdicts.slaTargetId` joins `requirements_documents.slaTargets[].id` directly (decision #8).
6. **TestAsset gains workflow + data + CI-workflow columns** — `+ workflowName NOT NULL` (a plan has many workflow assets), `+ protocol`, `+ dataFiles`, `+ setupScript`, `+ teardownScript`, `+ generatedFrom`, `+ UNIQUE(testPlanId, workflowName, engine)` (regeneration replaces, not duplicates), and `assetType` extended with **`ci_workflow`** (reserved for the deferred GHA generator).
7. **Environment validation stays a first-class pre-flight stage** — reachability, auth, smoke, Dynatrace ambient/entity, data volume; stop-and-ask, no degraded fall-through (unchanged).
8. **SLA evaluation is windowed and source-aware** — the evaluation window is the **plateau between last ramp-up and first ramp-down** derived from `loadProfile` stage phases, NOT a fixed "last 60%". SYNC percentiles come from `{workflow, phase}`-tagged in-runner k6 sub-metrics (source of record); ASYNC from DT-native transforms; DT is diagnostic-only for SYNC (decisions #1, #6). Latency percentiles evaluate over `{expected_response:true}` samples only. A missing/insufficient REQUIRED metric → `inconclusive` (never `fail`, never silent pass).
9. **`metric_series` becomes digest-ready** — `+ executionRunId`, `+ workflowName`, `+ phase`, `+ digest jsonb`, `+ sampleCount` (the min-sample-guard input); `metadata` retained. The scalar `value`/`rawValues` are retained only for the informational k6 HTML path, not as the percentile source of record. This is the additive seam for the single-instance→sharded swap.
10. **The gate is requirements-driven and mechanical for v1** — `gate_resolutions` emits `auto_pass | auto_fail | inconclusive | characterization`; the verdict→CI signal is a final step in the generated GHA workflow (deferred) that fails the job on `ciSignal='fail'`. `ciSignal` is NOT NULL and total on every path (escalation sets `fail` while `pipeline_runs.verdict='blocked_on_human'`). An **`inconclusive` guard** prevents false-green on missing/insufficient-required-SLA / aborted runs. Regression-review and baseline-proposal outcomes are reserved but deferred (decision #7).
11. **Report stays a first-class stored artifact** — `test_run_artifacts` (discriminator column `artifactType`, stable-URL column `url`) holds the k6 native HTML, the thin Sentinel summary, stdout (referenced by `execution_runs.stdoutRef`), the Dynatrace deep-link, and (deferred) the `gha_workflow_bundle`. Store-first, publish-second; destinations configurable (unchanged).
12. **Baseline distribution logic is deferred but its seam exists now** — `baselines + baselineSetId`, `regressions.regressionType` becomes a closed enum derived from the metric, and `regressions` gains `pipelineRunId` + `direction`. **Direction-awareness is the one Stage-7 fix applied in v1**; the rest of the distribution analysis (median+stddev+N, z-score, cold-start, DT-pollution exclusion) is deferred (decision #2).
