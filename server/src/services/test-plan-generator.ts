// server/src/services/test-plan-generator.ts
// Pure Stage-2 derivation: RequirementsDocument → TestPlan shape. The spec calls this
// mechanical — if the document is complete, the plan is derivable without judgment.
// Gaps (not errors) are returned when derivation is impossible; the caller routes them
// back to discovery.
import type { SlaTarget, LoadModel, LoadProfile } from "@sentinel/db";
import { allocateArrivalRateVUs, p95EstimateMs } from "./k6-generator/estimate.js";

export type DerivationGap = { field: string; reason: string };

export type RequirementsDocumentInput = {
  id: string;
  appName?: string | null;
  protocol?: string | string[] | null;
  slaTargets: SlaTarget[];
  loadModel?: LoadModel | null;
  minSampleCount: number;
  testIntent: string;
};

export type DerivedTestPlan = {
  name: string;
  engines: string[];
  requirementsDocumentId: string;
  executionModel: "weighted-loop" | "per-scenario";
  loadProfile: LoadProfile;
};

export type DeriveResult = { plan: DerivedTestPlan } | { gaps: DerivationGap[] };

const HTTP_FAMILY = new Set(["http", "grpc", "graphql"]);
const SECONDS_PER_MINUTE = 60;

function primaryProtocol(rd: RequirementsDocumentInput): string | null {
  const protocols = Array.isArray(rd.protocol) ? rd.protocol : rd.protocol ? [rd.protocol] : [];
  return protocols[0] ?? null;
}

// 10/80/10 ramp/steady/ramp-down shaping with 30s floors on the ramps.
export function deriveDefaultStages(peak: number, totalDurationMinutes = 10): Array<{ duration: string; target: number }> {
  const totalSec = totalDurationMinutes * SECONDS_PER_MINUTE;
  const rampSec = Math.max(30, Math.round(totalSec * 0.1));
  const steadySec = totalSec - 2 * rampSec;
  return [
    { duration: `${rampSec}s`, target: peak },
    { duration: `${steadySec}s`, target: peak },
    { duration: `${rampSec}s`, target: 0 },
  ];
}

// per-scenario iff any SLA target is workflow-scoped (per-workflow verdicts need per-workflow scenarios).
export function selectExecutionModel(slaTargets: SlaTarget[]): "weighted-loop" | "per-scenario" {
  return slaTargets.some((t) => t.workflowScope) ? "per-scenario" : "weighted-loop";
}

export function validateWorkflowWeights(
  trafficMix: LoadModel["trafficMix"],
  slaTargets: SlaTarget[],
): DerivationGap[] {
  const gaps: DerivationGap[] = [];
  const mix = trafficMix ?? [];
  const scopedTargets = slaTargets.filter((t) => t.workflowScope);

  if (mix.length > 0) {
    if (mix.some((w) => !w.workflow || w.workflow.trim().length === 0)) {
      gaps.push({ field: "loadModel.trafficMix", reason: "a traffic-mix entry has no workflow name" });
    }
    const sum = mix.reduce((s, w) => s + w.percentage, 0);
    if (Math.abs(sum - 100) > 0.001) {
      gaps.push({ field: "loadModel.trafficMix", reason: `workflow weights sum to ${sum}, expected 100` });
    }
  }
  const names = new Set(mix.map((w) => w.workflow));
  for (const t of scopedTargets) {
    if (mix.length === 0 || !names.has(t.workflowScope!)) {
      gaps.push({ field: "slaTargets", reason: `workflowScope '${t.workflowScope}' has no matching trafficMix workflow` });
    }
  }
  return gaps;
}

// Baseline duration sized to accrue >= minSampleCount steady samples at ~1 iteration
// per p95Estimate with a 2x safety factor, floored at 2 minutes.
export function baselineDuration(minSampleCount: number, p95Ms: number): string {
  const seconds = Math.ceil((minSampleCount * (p95Ms / 1000) * 2) / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
  return `${Math.max(120, seconds) / SECONDS_PER_MINUTE}m`;
}

export function selectLoadProfile(rd: RequirementsDocumentInput): { profile: LoadProfile } | { gaps: DerivationGap[] } {
  const protocol = primaryProtocol(rd);
  if (!protocol) return { gaps: [{ field: "protocol", reason: "no protocol declared" }] };
  if (!HTTP_FAMILY.has(protocol)) {
    return { gaps: [{ field: "protocol", reason: `protocol '${protocol}' is not derivable in v1 (http/grpc/graphql only)` }] };
  }
  const proto = protocol as "http" | "grpc" | "graphql";
  const lm = rd.loadModel ?? {};
  const p95 = p95EstimateMs(rd.slaTargets);

  // TRUE BASELINE: uncontended single-user floor — must not bounce on a missing peak.
  if (rd.testIntent === "baseline") {
    return { profile: { protocol: proto, executor: "constant-vus", vus: 1, duration: baselineDuration(rd.minSampleCount, p95) } };
  }

  // Explicit stages from discovery win over peak-derived shaping.
  const explicitStages = lm.loadProfile?.stages;
  if (explicitStages && explicitStages.length > 0) {
    if (lm.loadProfile?.targetUnit === "rate") {
      // ramping-arrival-rate is typed but not executable by the v1 generator/window
      // resolution — honest gap rather than a plan the pipeline can't run.
      return { gaps: [{ field: "loadModel.loadProfile", reason: "rate-unit stages (ramping-arrival-rate) are not derivable in v1 — declare a flat peakTps instead" }] };
    }
    return { profile: { protocol: proto, executor: "ramping-vus", startVus: 0, stages: explicitStages } };
  }

  // "sustain N TPS" → open model holding throughput. v1 emits the FLAT
  // constant-arrival-rate branch (the only arrival-rate executor Stage 3 supports),
  // carrying the mandatory evaluation-window triple shaped 10/80/10.
  if (lm.peakTps) {
    const { preAllocatedVUs, maxVUs } = allocateArrivalRateVUs(lm.peakTps, p95);
    const [ramp, steady] = deriveDefaultStages(lm.peakTps);
    const totalSec = 10 * SECONDS_PER_MINUTE;
    return {
      profile: {
        protocol: proto, executor: "constant-arrival-rate", rate: lm.peakTps, timeUnit: "1s",
        duration: `${totalSec}s`,
        evaluationWindow: { warmup: ramp!.duration, steady: steady!.duration, cooldown: ramp!.duration },
        preAllocatedVUs, maxVUs,
      },
    };
  }

  // "N concurrent users" → closed model.
  if (lm.peakConcurrentUsers) {
    return { profile: { protocol: proto, executor: "ramping-vus", startVus: 0, stages: deriveDefaultStages(lm.peakConcurrentUsers) } };
  }

  if (lm.peakMps) {
    return { gaps: [{ field: "loadModel.peakMps", reason: "message-rate (kafka) load is not derivable in v1" }] };
  }
  return { gaps: [{ field: "loadModel", reason: "no peak load (users/tps) or explicit stages to derive from" }] };
}

export function deriveTestPlan(rd: RequirementsDocumentInput): DeriveResult {
  const gaps: DerivationGap[] = [];

  const weightGaps = validateWorkflowWeights(rd.loadModel?.trafficMix, rd.slaTargets);
  gaps.push(...weightGaps);

  const profileResult = selectLoadProfile(rd);
  if ("gaps" in profileResult) gaps.push(...profileResult.gaps);

  if (gaps.length > 0 || "gaps" in profileResult) return { gaps };

  return {
    plan: {
      name: `${rd.appName ?? "app"} — derived plan`,
      engines: ["k6"],
      requirementsDocumentId: rd.id,
      executionModel: selectExecutionModel(rd.slaTargets),
      loadProfile: profileResult.profile,
    },
  };
}
