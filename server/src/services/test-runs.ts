import { and, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { testRuns } from "@sentinel/db";

export type CreateTestRunInput = {
  testPlanId: string;
  triggerType: "manual" | "ci" | "scheduled";
  triggerContext?: Record<string, unknown>;
};

export type ListTestRunsFilters = {
  testPlanId?: string;
};

export function testRunService(db: Db) {
  return {
    async create(companyId: string, data: CreateTestRunInput) {
      const [row] = await db
        .insert(testRuns)
        .values({
          companyId,
          testPlanId: data.testPlanId,
          triggerType: data.triggerType,
          triggerContext: data.triggerContext ?? null,
          status: "queued",
        })
        .returning();
      return row!;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, id))
        .limit(1);
      return row ?? null;
    },

    async list(companyId: string, filters: ListTestRunsFilters = {}) {
      const conditions = [eq(testRuns.companyId, companyId)];
      if (filters.testPlanId) {
        conditions.push(eq(testRuns.testPlanId, filters.testPlanId));
      }
      return db
        .select()
        .from(testRuns)
        .where(and(...conditions));
    },
  };
}
