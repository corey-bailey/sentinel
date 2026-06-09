// server/src/services/requirements-documents.ts
// Stage 1 DISCOVERY artifact lifecycle. Status gating (spec §4):
//   in_progress → complete → approved
// Creation requires a CONFIRMED pipeline_request; edits are allowed only while in_progress;
// approval requires every required SLA target to be human-approved.
import { and, desc, eq } from "drizzle-orm";
import { pipelineRequests, requirementsDocuments, type Db, type SlaTarget, type LoadModel } from "@sentinel/db";
import { assignSlaTargetIds, canApprove, completenessGaps } from "./requirements-document-validation.js";

export class RequirementsDocumentStateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RequirementsDocumentStateError";
  }
}

export type CreateRequirementsDocumentInput = {
  pipelineRequestId?: string | null;
  appName?: string | null;
  appDescription?: string | null;
  ownerUserId?: string | null;
  protocol?: string | string[] | null;
  syncModel?: string | null;
  asyncDetails?: { measurementPoint?: string; sagaDescription?: string } | null;
  slaTargets?: Omit<SlaTarget, "id">[];
  loadModel?: LoadModel | null;
  authentication?: Record<string, unknown> | null;
  testData?: Record<string, unknown> | null;
  existingArtifacts?: Record<string, unknown> | null;
  targetEnvironment?: Record<string, unknown> | null;
  dynatrace?: Record<string, unknown> | null;
  minSampleCount?: number;
  testIntent?: string;
};

export type UpdateRequirementsDocumentInput = Partial<CreateRequirementsDocumentInput>;

export function requirementsDocumentService(db: Db) {
  async function getById(id: string) {
    const [row] = await db.select().from(requirementsDocuments).where(eq(requirementsDocuments.id, id));
    return row ?? null;
  }

  async function list(companyId: string, filters: { status?: string } = {}) {
    const conditions = [eq(requirementsDocuments.companyId, companyId)];
    if (filters.status) conditions.push(eq(requirementsDocuments.status, filters.status));
    return db
      .select()
      .from(requirementsDocuments)
      .where(and(...conditions))
      .orderBy(desc(requirementsDocuments.createdAt));
  }

  async function create(companyId: string, input: CreateRequirementsDocumentInput) {
    if (input.pipelineRequestId) {
      const [request] = await db
        .select()
        .from(pipelineRequests)
        .where(and(eq(pipelineRequests.id, input.pipelineRequestId), eq(pipelineRequests.companyId, companyId)));
      if (!request) throw new RequirementsDocumentStateError(`pipeline_request ${input.pipelineRequestId} not found`);
      if (request.status !== "confirmed") {
        throw new RequirementsDocumentStateError(
          `pipeline_request must be confirmed before discovery (status: ${request.status})`,
        );
      }
    }

    const [row] = await db
      .insert(requirementsDocuments)
      .values({
        companyId,
        pipelineRequestId: input.pipelineRequestId ?? null,
        appName: input.appName ?? null,
        appDescription: input.appDescription ?? null,
        ownerUserId: input.ownerUserId ?? null,
        protocol: input.protocol ?? null,
        syncModel: input.syncModel ?? null,
        asyncDetails: input.asyncDetails ?? null,
        slaTargets: assignSlaTargetIds(input.slaTargets ?? []),
        loadModel: input.loadModel ?? null,
        authentication: input.authentication ?? null,
        testData: input.testData ?? null,
        existingArtifacts: input.existingArtifacts ?? null,
        targetEnvironment: input.targetEnvironment ?? null,
        dynatrace: input.dynatrace ?? null,
        minSampleCount: input.minSampleCount ?? 200,
        testIntent: input.testIntent ?? "conformance",
        status: "in_progress",
      })
      .returning();
    return row!;
  }

  async function update(id: string, input: UpdateRequirementsDocumentInput) {
    const existing = await getById(id);
    if (!existing) return null;
    if (existing.status !== "in_progress") {
      throw new RequirementsDocumentStateError(`document is ${existing.status}; only in_progress documents are editable`);
    }
    const patch: Record<string, unknown> = { ...input, updatedAt: new Date() };
    if (input.slaTargets) patch.slaTargets = assignSlaTargetIds(input.slaTargets);
    delete patch.pipelineRequestId; // the originating request never changes
    const [row] = await db.update(requirementsDocuments).set(patch).where(eq(requirementsDocuments.id, id)).returning();
    return row!;
  }

  // in_progress → complete: the document must be runnable (no completeness gaps).
  async function markComplete(id: string) {
    const existing = await getById(id);
    if (!existing) return null;
    if (existing.status !== "in_progress") {
      throw new RequirementsDocumentStateError(`document is ${existing.status}; only in_progress documents can be completed`);
    }
    const gaps = completenessGaps({
      protocol: existing.protocol,
      syncModel: existing.syncModel,
      slaTargets: (existing.slaTargets ?? []) as SlaTarget[],
      loadModel: existing.loadModel,
      testData: existing.testData,
      targetEnvironment: existing.targetEnvironment,
      testIntent: existing.testIntent,
    });
    if (gaps.length > 0) {
      throw new RequirementsDocumentStateError(
        `document is incomplete: ${gaps.map((g) => `${g.field} (${g.reason})`).join("; ")}`,
      );
    }
    const [row] = await db
      .update(requirementsDocuments)
      .set({ status: "complete", updatedAt: new Date() })
      .where(eq(requirementsDocuments.id, id))
      .returning();
    return row!;
  }

  // complete → approved: every required SLA target needs a human approver.
  async function approve(id: string, approvedByUserId: string) {
    const existing = await getById(id);
    if (!existing) return null;
    if (existing.status !== "complete") {
      throw new RequirementsDocumentStateError(`document is ${existing.status}; only complete documents can be approved`);
    }
    if (!canApprove({ slaTargets: (existing.slaTargets ?? []) as SlaTarget[] })) {
      throw new RequirementsDocumentStateError("every required SLA target must be approved before the document is approved");
    }
    const [row] = await db
      .update(requirementsDocuments)
      .set({ status: "approved", approvedByUserId, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(requirementsDocuments.id, id))
      .returning();
    return row!;
  }

  return { create, update, markComplete, approve, getById, list };
}
