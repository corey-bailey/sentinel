import { eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { requirements, type SLATargetRecord } from "@sentinel/db";

export type CreateRequirementInput = {
  name: string;
  description?: string;
  slaTargets: SLATargetRecord[];
  source: "human" | "agent";
  jiraIssueId?: string;
};

export type UpdateRequirementInput = {
  name?: string;
  description?: string;
  slaTargets?: SLATargetRecord[];
  jiraIssueId?: string;
};

export function requirementService(db: Db) {
  return {
    async create(companyId: string, data: CreateRequirementInput) {
      const [row] = await db
        .insert(requirements)
        .values({
          companyId,
          name: data.name,
          description: data.description,
          slaTargets: data.slaTargets,
          source: data.source,
          jiraIssueId: data.jiraIssueId ?? null,
          coverageStatus: "pending",
        })
        .returning();
      return row!;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, id))
        .limit(1);
      return row ?? null;
    },

    async update(id: string, data: UpdateRequirementInput) {
      const [row] = await db
        .update(requirements)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.slaTargets !== undefined && { slaTargets: data.slaTargets }),
          ...(data.jiraIssueId !== undefined && { jiraIssueId: data.jiraIssueId }),
          updatedAt: new Date(),
        })
        .where(eq(requirements.id, id))
        .returning();
      return row ?? null;
    },

    async list(companyId: string) {
      return db
        .select()
        .from(requirements)
        .where(eq(requirements.companyId, companyId));
    },
  };
}
