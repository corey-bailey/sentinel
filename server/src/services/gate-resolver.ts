// server/src/services/gate-resolver.ts
// Pure Stage-8 gate matrix. Maps REQUIRED-scoped SLA verdict counts (+ testIntent) to a gate outcome
// and a total ciSignal (pass|fail on every path). Baseline/regression outcomes (Stage 7) and the
// inconclusive → blocked_on_human escalation are deferred; v1 maps inconclusive → ciSignal 'fail'.

export type GateInput = {
  testIntent: string; // 'conformance' | 'baseline' | 'exploratory'
  requiredTargetCount: number;
  requiredFailCount: number;
  requiredInconclusiveCount: number;
};
export type GateOutcome = 'auto_pass' | 'auto_fail' | 'inconclusive' | 'characterization';
export type GateResult = { outcome: GateOutcome; ciSignal: 'pass' | 'fail' };

export function resolveGate(input: GateInput): GateResult {
  if (input.testIntent === 'baseline' || input.testIntent === 'exploratory' || input.requiredTargetCount === 0) {
    return { outcome: 'characterization', ciSignal: 'pass' };
  }
  if (input.requiredFailCount > 0) return { outcome: 'auto_fail', ciSignal: 'fail' };
  if (input.requiredInconclusiveCount > 0) return { outcome: 'inconclusive', ciSignal: 'fail' };
  return { outcome: 'auto_pass', ciSignal: 'pass' };
}

// outcome → the pipeline_runs.verdict value.
export function verdictForOutcome(outcome: GateOutcome): 'pass' | 'fail' | 'inconclusive' {
  if (outcome === 'auto_fail') return 'fail';
  if (outcome === 'inconclusive') return 'inconclusive';
  return 'pass'; // auto_pass | characterization
}

// Stage-7 human resolutions: approving a baseline proposal or waiving a flagged regression
// terminalizes a blocked_on_human run; rejecting fails it.
export type HumanGateAction = 'baseline_approved' | 'baseline_rejected' | 'regression_approved' | 'regression_rejected';
export type HumanGateResult = { outcome: HumanGateAction; ciSignal: 'pass' | 'fail'; verdict: 'pass' | 'fail' };

export function resolveHumanGate(action: HumanGateAction): HumanGateResult {
  const approved = action === 'baseline_approved' || action === 'regression_approved';
  return { outcome: action, ciSignal: approved ? 'pass' : 'fail', verdict: approved ? 'pass' : 'fail' };
}
