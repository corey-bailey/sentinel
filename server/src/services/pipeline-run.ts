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

  return { create };
}
