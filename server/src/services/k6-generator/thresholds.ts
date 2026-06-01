// server/src/services/k6-generator/thresholds.ts
import type { SlaTarget } from '@sentinel/db';
import { LATENCY_STAT_BY_METRIC } from './types.js';

const K6_OP: Record<SlaTarget['operator'], string> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

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

    const latencyStat = LATENCY_STAT_BY_METRIC[target.metric];
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
