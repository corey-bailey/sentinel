// server/src/services/k6-generator/estimate.ts
// Shared between Stage-2 plan derivation (test-plan-generator) and Stage-3 script
// generation (scenarios) so VU allocation has exactly one source of truth.

type SlaTargetLike = { source: string; metric: string; threshold: number };

// Estimate the p95 latency (ms) used for arrival-rate VU allocation: the lowest p95 SLA ceiling if present, else 500.
export function p95EstimateMs(slaTargets: SlaTargetLike[]): number {
  const p95s = slaTargets.filter((t) => t.source === "k6" && t.metric === "p95_ms").map((t) => t.threshold);
  return p95s.length ? Math.min(...p95s) : 500;
}

// Little's Law: VUs needed to hold an arrival rate = rate × expected request duration.
// maxVUs gives 4× headroom for latency spikes before k6 drops iterations.
export function allocateArrivalRateVUs(rate: number, p95Ms: number): { preAllocatedVUs: number; maxVUs: number } {
  const p95s = Math.max(p95Ms / 1000, 0.001);
  const preAllocatedVUs = Math.max(1, Math.ceil(rate * p95s));
  return { preAllocatedVUs, maxVUs: preAllocatedVUs * 4 };
}
