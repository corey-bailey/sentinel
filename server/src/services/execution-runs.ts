// server/src/services/execution-runs.ts
import { eq } from "drizzle-orm";
import { executionRuns, type Db } from "@sentinel/db";

export type CreateExecutionRunInput = {
  pipelineRunId: string;
  testRunId?: string | null;
  testAssetId?: string | null;
  engine: string;
  binaryProfile?: string | null;
  workspaceRef?: string | null;
};

export type CompleteExecutionRunInput = {
  status: "completed" | "failed" | "aborted";
  exitCode?: number | null;
  peakVus?: number | null;
  totalRequests?: number | null;
  totalIterations?: number | null;
};

export function executionRunService(db: Db) {
  async function create(companyId: string, data: CreateExecutionRunInput) {
    const [row] = await db
      .insert(executionRuns)
      .values({
        companyId,
        pipelineRunId: data.pipelineRunId,
        testRunId: data.testRunId ?? null,
        testAssetId: data.testAssetId ?? null,
        engine: data.engine,
        binaryProfile: data.binaryProfile ?? null,
        workspaceRef: data.workspaceRef ?? null,
        status: "queued",
      })
      .returning();
    return row!;
  }

  async function markRunning(id: string) {
    const [row] = await db
      .update(executionRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(executionRuns.id, id))
      .returning();
    return row!;
  }

  async function complete(id: string, data: CompleteExecutionRunInput) {
    const [row] = await db
      .update(executionRuns)
      .set({
        status: data.status,
        exitCode: data.exitCode ?? null,
        peakVus: data.peakVus ?? null,
        totalRequests: data.totalRequests ?? null,
        totalIterations: data.totalIterations ?? null,
        completedAt: new Date(),
      })
      .where(eq(executionRuns.id, id))
      .returning();
    return row!;
  }

  return { create, markRunning, complete };
}
