import type { SlaTarget } from "@sentinel/db";

export type SLAOperator = "lt" | "lte" | "gt" | "gte";
export type SLASource = "k6" | "playwright" | "pytest" | "mocha" | "apm:dynatrace" | string;

export type SLATarget = {
  id: string;
  metric: string;
  operator: SLAOperator;
  threshold: number;
  source: SLASource;
};

export type SLAEvaluation = {
  targetId: string;
  metric: string;
  status: "pass" | "fail" | "skipped";
  actualValue?: number;
  threshold?: number;
  reason?: string;
};

export type EvalOptions = {
  apmUnavailable?: boolean;
};

export type AllTargetsResult = {
  outcome: "all_pass" | "breach";
  breaches: SLAEvaluation[];
  skipped: SLAEvaluation[];
  evaluations: SLAEvaluation[];
};

export function evaluateSLATarget(
  target: SLATarget,
  value: number | undefined | null,
  opts: EvalOptions = {},
): SLAEvaluation {
  const base = { targetId: target.id, metric: target.metric };

  if (value === undefined || value === null || Number.isNaN(value)) {
    const isApm = target.source.startsWith("apm:");
    const reason = isApm && opts.apmUnavailable
      ? `APM unavailable — metric ${target.metric} could not be fetched`
      : `Metric ${target.metric} unavailable`;
    return { ...base, status: "skipped", reason };
  }

  const pass = passesThreshold(target.operator, value, target.threshold);

  if (pass) {
    return { ...base, status: "pass", actualValue: value, threshold: target.threshold };
  }
  return { ...base, status: "fail", actualValue: value, threshold: target.threshold };
}

export function evaluateAllTargets(
  targets: SLATarget[],
  metrics: Record<string, number>,
  opts: EvalOptions = {},
): AllTargetsResult {
  const evaluations: SLAEvaluation[] = targets.map((t) =>
    evaluateSLATarget(t, metrics[t.metric], opts),
  );

  const breaches = evaluations.filter((e) => e.status === "fail");
  const skipped = evaluations.filter((e) => e.status === "skipped");

  return {
    outcome: breaches.length > 0 ? "breach" : "all_pass",
    breaches,
    skipped,
    evaluations,
  };
}

export type ClassifyInput = {
  value: number | null | undefined;
  sampleCount: number | null | undefined;
  minSampleCount: number;
  runHealthy: boolean; // false if executionRun aborted/failed/exitCode!=0
};
export type Verdict = { status: "pass" | "fail" | "inconclusive" | "skipped"; actualValue?: number };

// Single source of truth for the SLA operator comparison — shared by evaluateSLATarget and classifyVerdict.
export function passesThreshold(op: SLAOperator, value: number, threshold: number): boolean {
  switch (op) {
    case "lt":  return value < threshold;
    case "lte": return value <= threshold;
    case "gt":  return value > threshold;
    case "gte": return value >= threshold;
  }
}

// Decision #7 / Stage 6: a REQUIRED target never false-greens — missing/under-sampled/unhealthy => inconclusive.
// fail is reserved for measured + breached. An OPTIONAL unmeasured target is 'skipped' (recorded, non-blocking).
export function classifyVerdict(
  t: Pick<SlaTarget, "operator" | "threshold" | "required">,
  input: ClassifyInput,
): Verdict {
  const measured = input.value !== null && input.value !== undefined && !Number.isNaN(input.value);
  // required → inconclusive, optional → skipped; carry actualValue only when a value was measured.
  const notGreen = (): Verdict => ({
    status: t.required ? "inconclusive" : "skipped",
    ...(measured ? { actualValue: input.value! } : {}),
  });
  if (!measured) return notGreen();
  if (!input.runHealthy) return notGreen();
  if ((input.sampleCount ?? 0) < input.minSampleCount) return notGreen();
  return { status: passesThreshold(t.operator, input.value!, t.threshold) ? "pass" : "fail", actualValue: input.value! };
}
