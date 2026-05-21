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

  let pass: boolean;
  switch (target.operator) {
    case "lt":  pass = value < target.threshold; break;
    case "lte": pass = value <= target.threshold; break;
    case "gt":  pass = value > target.threshold; break;
    case "gte": pass = value >= target.threshold; break;
  }

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
