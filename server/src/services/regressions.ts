import { and, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { regressions } from "@sentinel/db";

export function regressionService(db: Db) {
  return {
    async list(companyId: string, filters: { testRunId?: string; status?: string } = {}) {
      const conditions = [eq(regressions.companyId, companyId)];
      if (filters.testRunId) {
        conditions.push(eq(regressions.testRunId, filters.testRunId));
      }
      if (filters.status) {
        conditions.push(eq(regressions.status, filters.status as any));
      }
      return db
        .select()
        .from(regressions)
        .where(and(...conditions));
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(regressions)
        .where(eq(regressions.id, id))
        .limit(1);
      return row ?? null;
    },

    async approve(id: string, resolvedByUserId: string) {
      const [row] = await db
        .update(regressions)
        .set({ status: "approved", resolvedByUserId, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(regressions.id, id))
        .returning();
      return row ?? null;
    },

    async reject(id: string, resolvedByUserId: string) {
      const [row] = await db
        .update(regressions)
        .set({ status: "rejected", resolvedByUserId, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(regressions.id, id))
        .returning();
      return row ?? null;
    },

    async create(data: {
      companyId: string;
      testRunId: string;
      metric: string;
      baselineValue: number;
      actualValue: number;
      deviationPct: number;
      regressionType: string;
      executionIssueId?: string;
    }) {
      const [row] = await db
        .insert(regressions)
        .values({
          companyId: data.companyId,
          testRunId: data.testRunId,
          metric: data.metric,
          baselineValue: data.baselineValue,
          actualValue: data.actualValue,
          deviationPct: data.deviationPct,
          regressionType: data.regressionType as any,
          status: "open",
          executionIssueId: data.executionIssueId ?? null,
        })
        .returning();
      return row!;
    },
  };
}
