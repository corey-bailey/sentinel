// server/src/services/requirements-document-validation.ts
// Pure Stage-1 validation: SLA target identity, approval gating, and the
// "could you actually run a test from this document?" completeness check.
import { randomUUID } from "node:crypto";
import type { SlaTarget, LoadModel } from "@sentinel/db";

export type RequirementsDocumentLike = {
  protocol?: string | string[] | null;
  syncModel?: string | null;
  slaTargets: SlaTarget[];
  loadModel?: LoadModel | null;
  testData?: Record<string, unknown> | null;
  targetEnvironment?: Record<string, unknown> | null;
  testIntent: string;
};

// Stable ids for new SLA targets — sla_verdicts.slaTargetId and test_plans join on these,
// so an id must never change once assigned. Existing ids are preserved.
export function assignSlaTargetIds(targets: Omit<SlaTarget, "id">[] | SlaTarget[]): SlaTarget[] {
  return targets.map((t) => {
    const id = "id" in t && typeof (t as SlaTarget).id === "string" && (t as SlaTarget).id.length > 0
      ? (t as SlaTarget).id
      : randomUUID();
    return { ...t, id } as SlaTarget;
  });
}

// A document is approvable only when every REQUIRED target has been human-approved.
export function canApprove(rd: Pick<RequirementsDocumentLike, "slaTargets">): boolean {
  return rd.slaTargets.filter((t) => t.required).every((t) => Boolean(t.approvedByUserId));
}

export type CompletenessGap = { field: string; reason: string };

// "Couldn't run a test from this" gaps. Baseline/exploratory intents relax the SLA/load
// requirement (a characterization run needs no targets), nothing else.
export function completenessGaps(rd: RequirementsDocumentLike): CompletenessGap[] {
  const gaps: CompletenessGap[] = [];
  const characterization = rd.testIntent === "baseline" || rd.testIntent === "exploratory";

  const protocols = Array.isArray(rd.protocol) ? rd.protocol : rd.protocol ? [rd.protocol] : [];
  if (protocols.length === 0) gaps.push({ field: "protocol", reason: "no protocol declared" });
  if (!rd.syncModel) gaps.push({ field: "syncModel", reason: "sync/async model not declared" });

  const baseUrl = (rd.targetEnvironment as { baseUrl?: unknown } | null | undefined)?.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    gaps.push({ field: "targetEnvironment.baseUrl", reason: "no target base URL" });
  }

  if (!characterization) {
    if (rd.slaTargets.length === 0) gaps.push({ field: "slaTargets", reason: "conformance intent declares no SLA targets" });
    const lm = rd.loadModel;
    const hasPeak = Boolean(lm && (lm.peakConcurrentUsers || lm.peakTps || lm.peakMps || lm.loadProfile?.stages?.length));
    if (!hasPeak) gaps.push({ field: "loadModel", reason: "no peak load (users/tps/mps) or explicit stages" });
  }

  return gaps;
}
