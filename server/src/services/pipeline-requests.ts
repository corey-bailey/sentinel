// server/src/services/pipeline-requests.ts
// Stage 0 INTAKE: normalizes a trigger (manual or Jira) into a pipeline_requests row.
// Manual intakes are confirmed immediately (the requester IS the confirmer); Jira intakes
// wait for human confirmation before discovery may begin.
import { and, eq, inArray } from "drizzle-orm";
import { pipelineRequests, type Db } from "@sentinel/db";
import type { PipelineRequestArtifacts, PipelineRequestExtractedContext } from "@sentinel/db";

export class DuplicateIntakeError extends Error {
  constructor(jiraIssueKey: string) {
    super(`An active pipeline request already exists for Jira issue ${jiraIssueKey}`);
    this.name = "DuplicateIntakeError";
  }
}

export type CreatePipelineRequestInput = {
  source: "manual_intake" | "jira";
  rawDescription?: string | null;
  jiraIssueKey?: string | null;
  jiraIssueUrl?: string | null;
  artifacts?: PipelineRequestArtifacts;
  extractedContext?: PipelineRequestExtractedContext;
  requestedBy?: string | null;
  ownerUserId: string;
};

export function pipelineRequestService(db: Db) {
  async function create(companyId: string, input: CreatePipelineRequestInput) {
    if (input.source === "jira" && input.jiraIssueKey) {
      const existing = await db
        .select({ id: pipelineRequests.id })
        .from(pipelineRequests)
        .where(and(
          eq(pipelineRequests.companyId, companyId),
          eq(pipelineRequests.jiraIssueKey, input.jiraIssueKey),
          inArray(pipelineRequests.status, ["pending_confirmation", "confirmed"]),
        ));
      if (existing.length > 0) throw new DuplicateIntakeError(input.jiraIssueKey);
    }

    const [row] = await db
      .insert(pipelineRequests)
      .values({
        companyId,
        source: input.source,
        rawDescription: input.rawDescription ?? null,
        jiraIssueKey: input.jiraIssueKey ?? null,
        jiraIssueUrl: input.jiraIssueUrl ?? null,
        artifacts: input.artifacts ?? {},
        extractedContext: input.extractedContext ?? {},
        requestedBy: input.requestedBy ?? null,
        ownerUserId: input.ownerUserId,
        status: input.source === "manual_intake" ? "confirmed" : "pending_confirmation",
      })
      .returning();
    return row!;
  }

  async function getById(id: string) {
    const [row] = await db.select().from(pipelineRequests).where(eq(pipelineRequests.id, id));
    return row ?? null;
  }

  async function list(companyId: string, filters: { status?: string } = {}) {
    const conditions = [eq(pipelineRequests.companyId, companyId)];
    if (filters.status) conditions.push(eq(pipelineRequests.status, filters.status));
    return db.select().from(pipelineRequests).where(and(...conditions));
  }

  async function setStatus(id: string, from: string, to: string) {
    const [row] = await db
      .update(pipelineRequests)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(pipelineRequests.id, id), eq(pipelineRequests.status, from)))
      .returning();
    return row ?? null; // null = not found OR not in the expected from-status
  }

  return {
    create,
    getById,
    list,
    confirm: (id: string) => setStatus(id, "pending_confirmation", "confirmed"),
    reject: (id: string) => setStatus(id, "pending_confirmation", "rejected"),
  };
}
