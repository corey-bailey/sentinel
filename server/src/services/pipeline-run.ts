// server/src/services/pipeline-run.ts
import { pipelineRuns, type Db, type PipelineTrigger, type StageRecordMap, type StageRecord } from "@sentinel/db";
import { eq } from "drizzle-orm";

export class UnsupportedTriggerPathError extends Error {
  constructor(path: string) { super(`Unsupported pipeline trigger path (v1 = execution-trigger only): ${path}`); this.name = "UnsupportedTriggerPathError"; }
}

const STAGE_ORDER = ["intake", "discovery", "plan", "generate", "validate", "execute", "analysis", "report"] as const;
export type StageName = (typeof STAGE_ORDER)[number];

function executionTriggerStages(): StageRecordMap {
  const skipped = (reason: string): StageRecord => ({ status: "skipped", skippedReason: reason });
  const pending = (): StageRecord => ({ status: "pending" });
  return {
    intake: skipped("execution-trigger: no new request"),
    discovery: skipped("execution-trigger: RequirementsDocument exists"),
    plan: skipped("execution-trigger: TestPlan exists"),
    generate: skipped("execution-trigger: assets exist"),
    validate: pending(),
    execute: pending(),
    analysis: pending(),
    report: pending(),
  };
}

export type CreatePipelineRunInput = {
  path: "execution-trigger";
  trigger: PipelineTrigger;
  testPlanId?: string | null;
  requirementsDocumentId?: string | null;
  pipelineRequestId?: string | null;
};

export function pipelineRunService(db: Db) {
  async function create(companyId: string, input: CreatePipelineRunInput) {
    if (input.path !== "execution-trigger") throw new UnsupportedTriggerPathError(String(input.path));
    const [row] = await db
      .insert(pipelineRuns)
      .values({
        companyId,
        testPlanId: input.testPlanId ?? null,
        requirementsDocumentId: input.requirementsDocumentId ?? null,
        pipelineRequestId: input.pipelineRequestId ?? null,
        trigger: input.trigger,
        stages: executionTriggerStages(),
      })
      .returning();
    return row!;
  }

  // --- internal: immutable read-modify-write of one stage's record ---
  async function patchStage(id: string, stage: StageName, patch: Partial<StageRecord>) {
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    if (!row) throw new Error(`pipeline_run not found: ${id}`);
    const stages = row.stages as StageRecordMap;
    const next: StageRecordMap = { ...stages, [stage]: { ...stages[stage], ...patch } };
    const [updated] = await db.update(pipelineRuns).set({ stages: next, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return updated!;
  }

  async function markStageRunning(id: string, stage: StageName) {
    return patchStage(id, stage, { status: "running", startedAt: new Date().toISOString() });
  }
  async function markStageComplete(id: string, stage: StageName, patch: Partial<StageRecord> = {}) {
    return patchStage(id, stage, { status: "complete", completedAt: new Date().toISOString(), ...patch });
  }
  async function markStageSkipped(id: string, stage: StageName, skippedReason: string) {
    return patchStage(id, stage, { status: "skipped", skippedReason });
  }
  async function markStageFailed(id: string, stage: StageName, error: string) {
    return patchStage(id, stage, { status: "failed", completedAt: new Date().toISOString(), error });
  }
  async function setVerdict(id: string, verdict: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setCiSignal(id: string, ciSignal: string) {
    const [r] = await db.update(pipelineRuns).set({ ciSignal, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function setResolvedExecution(id: string, resolvedExecution: unknown) {
    const [r] = await db.update(pipelineRuns).set({ resolvedExecution: resolvedExecution as never, updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markStarted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ verdict: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }
  async function markCompleted(id: string) {
    const [r] = await db.update(pipelineRuns).set({ completedAt: new Date(), updatedAt: new Date() }).where(eq(pipelineRuns.id, id)).returning();
    return r!;
  }

  return { create, markStageRunning, markStageComplete, markStageSkipped, markStageFailed, setVerdict, setCiSignal, setResolvedExecution, markStarted, markCompleted };
}
