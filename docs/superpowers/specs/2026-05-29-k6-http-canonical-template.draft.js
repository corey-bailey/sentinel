// Reference (markers resolved against spec v2.1, 2026-05-30) — HTTP/sync k6 template
// for writing-plans. The former >>> GENERATOR MUST RESOLVE <<< markers are now RESOLVED
// against the locked v1 rules in 2026-05-29-performance-test-pipeline-design.md (v2.1).

// =============================================================================
// SENTINEL — CANONICAL k6 HTTP/SYNC SCRIPT TEMPLATE (v1 reference)
// writing-plans generates HTTP/sync assets AGAINST THIS TEMPLATE. It is the
// synthesis of Scenario A (weighted-loop + ramping-vus + reusable/SharedArray)
// and Scenario B (per-scenario + constant-arrival-rate + mixed/consumable).
//
// The generator picks ONE executionModel and ONE executor per plan; both shapes
// live here side-by-side, gated by comments, so the same template serves all
// four HTTP/sync permutations the v1 derivation table can produce:
//   { weighted-loop | per-scenario } x { ramping-vus | constant-arrival-rate }
//
// EVERY derivation cites its requirement signal + spec rule. The five rules the
// spec previously left undetermined are now RESOLVED inline (each marked RESOLVED:
// with the locked v1 rule it cites) — they map 1:1 to the spec punch-list.
// =============================================================================
import http from "k6/http";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// --- Environment (injected by BOTH harnesses: local load-test-agent + GHA) ---
const BASE          = __ENV.BASE_URL;                 // RequirementsDocument.targetEnvironment.baseUrl
const TEST_RUN_ID   = __ENV.TEST_RUN_ID;              // locked rule 1 (line 646): names the summary file
const AUTH_TOKEN    = __ENV.AUTH_TOKEN || "";         // from authConfig.secretKey, injected per-run

// =============================================================================
// 1. DATA  (Stage 3, lines 636-638)
//    reusable  -> SharedArray loaded ONCE, every VU reads same store (no blow-up)
//    consumable-> per-VU DISJOINT partition; two iterations never claim a record
//    mixed     -> both, partition isolated from the SharedArray
// =============================================================================
// REUSABLE (e.g. search terms / product catalog) — read-heavy, shared. [line 636]
const reusable = new SharedArray("reusable", () => JSON.parse(open("./reusable.json")));

// CONSUMABLE (e.g. order seeds for checkout) — backing store; the DISJOINT slice
// is computed per-iteration below, NOT by reading this whole array. [line 637]
const consumable = new SharedArray("consumable", () => JSON.parse(open("./consumable.json")));

// RESOLVED (consumable claim key) — spec v2.1 Stage 3, "Data handling" (the
// consumable-data bullets). The claim key is exec.scenario.iterationInTest — a
// per-scenario monotonically-increasing index valid under BOTH executor families
// (the closed ramping-vus pool AND the open arrival-rate executors). It must NOT be
// exec.vu.idInTest: a VU id is stable only for the closed ramping-vus pool, and an
// open arrival-rate executor recycles VU ids across iterations, so keying off the
// VU id would re-issue the same record to many iterations (COLLISIONS). The file is
// PRE-SHARDED per scenario into DISJOINT slices at generation time; each iteration
// draws iterationInTest from its own slice. Modulo-wrap is FORBIDDEN for consumable
// data — wrapping re-issues a consumed record, which is reuse (legal only for
// reusable data); a consumable scenario draws a strictly-increasing index and runs
// out (firing the setup() volume check below), never wraps.
function claimConsumable() {
  const i = exec.scenario.iterationInTest;            // monotonic per scenario, both models
  if (i >= consumable.length) {
    // Ran out of consumable records: this is a DATA-VOLUME shortfall, not a latency
    // signal. setup() must have verified volume >= expected iterations (see below).
    exec.test.abort(`consumable exhausted at iteration ${i} (need >= rate*duration)`);
  }
  return consumable[i];                               // disjoint: no two iterations share i
}

// =============================================================================
// 2. STEADY-STATE WINDOW  (Stage 6, line 898 — the window IS baked into the asset)
//    The {phase:steady} tag is the ONLY authoritative window source. It is stamped
//    per-request from exec.instance.currentTestRunDuration against these boundaries.
// =============================================================================
// RESOLVED (default stage-shaping) — spec v2.1 Stage 2, "Default Stage-Shaping (When
// Discovery Captured Only a Peak)". When the RequirementsDocument captured only a peak
// with no explicit loadProfile.stages, the plan derives DEFAULT stages from the peak
// (it does not refuse to derive): ramp-up = 10% of total duration (min 30s),
// steady = 80%, ramp-down = 10% (min 30s). The steady window begins only AFTER load is
// achieved and stabilized — i.e. at the ramp-up stage end PLUS a stabilization guard —
// so partially-loaded samples (VUs/arrival-rate still climbing) NEVER carry
// phase:steady. phaseFor() keys on this stabilized steady boundary, not the raw
// ramp-end instant. NOTE: the profile-stage labels are hyphenated (ramp-up/ramp-down);
// the emitted phase TAG values are the underscored enum members (ramp_up/ramp_down),
// matching metric_series.phase.
const RAMP_UP_END_S = Number(__ENV.RAMP_UP_END_S || 120);   // steady starts here
const STEADY_END_S  = Number(__ENV.STEADY_END_S  || 720);   // ramp-down starts here

// RESOLVED (closed-model boundary semantics) — spec v2.1 Stage 6, "The warm-up guard
// also applies on the ramping-vus boundary." Under ramping-vus, currentTestRunDuration
// during ramp-up maps to a PARTIALLY loaded system (VUs climbing 0->target).
// phase:steady does NOT begin at the raw ramp-stage-end instant — it begins at the ramp
// stage end PLUS a stabilization guard, so partially-loaded samples (VUs still climbing
// or settling) carry phase:ramp_up, NEVER phase:steady. RAMP_UP_END_S below is therefore
// the STABILIZED steady boundary (stage end + guard), making the window deterministic.
// (For a zero-ramp run the whole run is steady minus a front-edge phase:warmup guard —
// Stage 6 "Zero-ramp runs".)
function phaseFor(t) {                                  // t = seconds since test start
  if (t < RAMP_UP_END_S) return "ramp_up";
  if (t < STEADY_END_S)  return "steady";              // <-- only these samples are authoritative
  return "ramp_down";
}

// Per-request param builder: stamps {workflow, phase} on EVERY request (line 667).
// For per-scenario, {workflow} could be a scenario-level tag, but stamping it
// per-request here makes ONE code path serve BOTH execution models.
function params(workflow) {
  const phase = phaseFor(exec.instance.currentTestRunDuration);
  return {
    tags: { workflow, phase },                         // {workflow,phase} -> windowed sub-metric
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  };
}

// =============================================================================
// 3. OPTIONS  —  the generator emits EXACTLY ONE of the two scenario blocks below
//    plus the matching threshold block. Shown together for reference.
// =============================================================================
export const options = {
  scenarios: {
    // -------------------------------------------------------------------------
    // SHAPE A — weighted-loop + ramping-vus   [Scenario A]
    //   DERIVED: peakConcurrentUsers set (line 472) -> ramping-vus (closed model);
    //            SLAs aggregate, no workflowScope (line 482) -> weighted-loop.
    //   ONE scenario runs the router(); the 70/30 mix is in-iteration selection.
    //   {workflow} is stamped PER-REQUEST inside router (NOT a scenario tag — a
    //   single scenario cannot carry distinct workflow tags). [closes PUNCH-LIST #2]
    // -------------------------------------------------------------------------
    weighted_loop: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m",  target: 500 },              // ramp_up   (target = VUs, closed model)
        { duration: "10m", target: 500 },              // steady    <- evaluation plateau
        { duration: "2m",  target: 0 },                // ramp_down
      ],
      gracefulRampDown: "30s",
      exec: "router",
    },

    // -------------------------------------------------------------------------
    // SHAPE B — per-scenario + constant-arrival-rate   [Scenario B]
    //   DERIVED: peakTps set, no peakConcurrentUsers (line 473) -> arrival-rate
    //            (open model HOLDS tps independent of latency, line 468);
    //            per-workflow SLAs exist (line 483) -> per-scenario, one named
    //            scenario per workflow, rate = weight x peakTps (line 595).
    //   {workflow} is a STATIC scenario-level tag (line 584). phase is per-request.
    // -------------------------------------------------------------------------
    // search:   { executor:"constant-arrival-rate", rate:1200, timeUnit:"1s", duration:"14m",
    //             preAllocatedVUs:200, maxVUs:800, exec:"search",   tags:{ workflow:"search"   } },
    // checkout: { executor:"constant-arrival-rate", rate:200,  timeUnit:"1s", duration:"14m",
    //             preAllocatedVUs:60,  maxVUs:300, exec:"checkout", tags:{ workflow:"checkout" } },
    // RESOLVED (rate -> preAllocatedVUs/maxVUs) — spec v2.1 Stage 2, "VU allocation for
    // the arrival-rate branch (preAllocatedVUs / maxVUs)." The allocation is DERIVED, not
    // guessed: by Little's Law, preAllocatedVUs = ceil(rate * p95_latency_estimate_seconds)
    // (the concurrency needed to sustain `rate` req/s at that service time); maxVUs ≈ 4 ×
    // preAllocatedVUs (headroom so k6 spins up extra VUs when latency grows under load —
    // exactly when headroom is most needed). The p95_latency_estimate is sourced from the
    // SLA p95 ceiling when present, else from the Stage 4 smoke-run measured latency.
    // Under-allocation makes k6 DROP iterations ("insufficient VUs") and silently fail to
    // hold peakTps — defeating the reason the open model was chosen. (A baseline run,
    // having no rate, needs no such allocation.)
  },

  thresholds: {
    // -------------------------------------------------------------------------
    // SHAPE A thresholds — AGGREGATE SLAs (no workflowScope). [lines 482-483, 900-902]
    //   Keyed on {phase,expected_response} ONLY — NO per-workflow block, because
    //   no per-workflow SLA exists. {workflow} sub-metrics still emit for DIAGNOSIS.
    // -------------------------------------------------------------------------
    "http_req_duration{expected_response:true,phase:steady}": ["p(95)<500"],
    "http_req_failed{phase:steady}": ["rate<0.01"],

    // -------------------------------------------------------------------------
    // SHAPE B thresholds — PER-WORKFLOW SLAs + one AGGREGATE error-rate. [PUNCH-LIST #6]
    //   Latency keyed per {workflow} (line 599); success-filtered (line 902).
    //   Error-rate target has NO workflowScope -> SINGLE doc-level key, NOT
    //   per-scenario (do NOT emit 4 error thresholds).
    // -------------------------------------------------------------------------
    // 'http_req_duration{workflow:checkout,phase:steady,expected_response:true}': ['p(95)<300'],
    // 'http_req_duration{workflow:search,phase:steady,expected_response:true}':   ['p(95)<200'],
    // 'http_req_failed{phase:steady}': ['rate<0.005'],   // aggregate, un-tagged by workflow
  },
};

// =============================================================================
// 4. SETUP / TEARDOWN  (Stage 3, line 637 — required for consumable data)
// =============================================================================
export function setup() {
  // Consumable: VERIFY VOLUME up front so the run fails loud, not silently mid-test.
  // RESOLVED (volume formula) — spec v2.1 Stage 3, "setup() VOLUME CHECK (abort loud on
  // shortfall)." setup() counts available consumable records and aborts the run loudly
  // when records < expectedIterations (a stop-and-ask, never a degraded/wrapping run).
  // expectedIterations is computed at generation time:
  //   - arrival-rate scenario: Σ over consumable scenarios of (rate × steadyDurationSec)
  //   - ramping-vus scenario:   peakVUs × steadyDurationSec / meanIterationLatencySec
  // For VERY-HIGH-cardinality consumable data, the generate-in-setup() path (synthesize
  // each record deterministically from a high-cardinality id keyed off iterationInTest,
  // so no finite file can run out) is the answer — but that is the Kafka/async FAST-FOLLOW,
  // NOT v1; the v1 mechanism is the iterationInTest claim key against a pre-sharded file.
  // Reusable needs no seeding. If a reset API exists, seed/clean here.
  return { runId: TEST_RUN_ID };
}

export function teardown(/* data */) {
  // Reset/clean consumed records if a reset mechanism is configured; else no-op.
}

// =============================================================================
// 5. EXEC FUNCTIONS
// =============================================================================
// SHAPE A router — weighted-loop. Each iteration selects a workflow by weight.
// {workflow} MUST be stamped per-request (params(...)) — closes PUNCH-LIST #2.
export function router() {
  const rec = reusable[Math.floor(Math.random() * reusable.length)];  // reusable read
  if (Math.random() < 0.70) {
    http.get(`${BASE}/search?q=${rec.term}`, params("product-search"));   // 70%
  } else {
    http.get(`${BASE}/products/${rec.id}`,   params("product-detail"));   // 30%
  }
}

// SHAPE B per-scenario exec functions — one per named scenario.
export function search() {
  const rec = reusable[exec.scenario.iterationInTest % reusable.length]; // reusable: wrap OK
  http.get(`${BASE}/search?q=${rec.term}`, params("search"));
}
export function checkout() {
  const order = claimConsumable();                                       // consumable: DISJOINT
  http.post(`${BASE}/checkout`, JSON.stringify(order), params("checkout"));
}

// =============================================================================
// 6. handleSummary  (Stage 3 locked rules 1-4, lines 644-663 — NON-NEGOTIABLE)
//   - filename keyed by TEST_RUN_ID (rule 1) so it correlates to execution_runs
//   - written to ExecutionWorkspace cwd, read back by name after exit (rule 2)
//   - DISTINCT from the --out json live stream (rule 3)
//   - IDENTICAL across local-Paperclip and GHA harnesses (rule 4)
//   - INFORMATIONAL ONLY: the authoritative verdict is the windowed sub-metric
//     http_req_duration{...,phase:steady,expected_response:true} p95, NOT this HTML
//     aggregate (line 890).
// =============================================================================
export function handleSummary(data) {
  return {
    [`summary-${TEST_RUN_ID}.html`]: htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
// binaryProfile = plain "k6" for HTTP (no xk6 extension). [Stage 3, line 688]