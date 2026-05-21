export type BaselineRecord = {
  id: string;
  testPlanId: string;
  metric: string;
  baselineValue: number;
  tolerancePct: number;
  isActive: boolean;
};

export type RunMetrics = Record<string, number>;

export type RegressionResult = {
  baselineId: string;
  metric: string;
  baselineValue: number;
  actualValue: number;
  deviationPct: number;
};

export type BaselineProposal = {
  proposedValues: RunMetrics;
};

export type DetectResult = {
  regressions: RegressionResult[];
  baselineProposal: BaselineProposal | null;
};

export function detectRegressions(
  baselines: BaselineRecord[],
  metrics: RunMetrics,
): DetectResult {
  const activeBaselines = baselines.filter((b) => b.isActive);

  if (activeBaselines.length === 0) {
    return {
      regressions: [],
      baselineProposal: { proposedValues: { ...metrics } },
    };
  }

  const regressions: RegressionResult[] = [];

  for (const baseline of activeBaselines) {
    const actual = metrics[baseline.metric];
    if (actual === undefined) continue;

    const deviationPct = ((actual - baseline.baselineValue) / baseline.baselineValue) * 100;

    if (deviationPct > baseline.tolerancePct) {
      regressions.push({
        baselineId: baseline.id,
        metric: baseline.metric,
        baselineValue: baseline.baselineValue,
        actualValue: actual,
        deviationPct: Math.round(deviationPct * 100) / 100,
      });
    }
  }

  return { regressions, baselineProposal: null };
}
