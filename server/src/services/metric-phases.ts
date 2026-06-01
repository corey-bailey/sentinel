// Single source of truth for the load-phase vocabulary an executor stamps on each
// metric_series row (Stage 6 windowing). The route's zod validator, the ingest
// service's type, and the verdict engine's steady-window filter all derive from this.
export const METRIC_PHASES = ["warmup", "ramp_up", "steady", "ramp_down"] as const;
export type MetricPhase = (typeof METRIC_PHASES)[number];

// SLA verdicts are evaluated only over the steady-state window (decision #7 / Stage 6).
export const SLA_EVALUATION_PHASE: MetricPhase = "steady";
