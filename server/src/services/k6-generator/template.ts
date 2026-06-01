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
