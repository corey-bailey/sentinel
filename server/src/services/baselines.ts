import { and, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { baselines } from "@sentinel/db";

export type ListBaselinesFilters = {
  testPlanId?: string;
  activeOnly?: boolean;
};

export function baselineService(db: Db) {
  return {
    async list(companyId: string, filters: ListBaselinesFilters = {}) {
      const conditions = [eq(baselines.companyId, companyId)];
      if (filters.testPlanId) {
        conditions.push(eq(baselines.testPlanId, filters.testPlanId));
      }
      if (filters.activeOnly) {
        conditions.push(eq(baselines.isActive, true));
      }
      return db
        .select()
        .from(baselines)
        .where(and(...conditions));
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(baselines)
        .where(eq(baselines.id, id))
        .limit(1);
      return row ?? null;
    },

    async approve(id: string, approvedByUserId: string) {
      const existing = await this.getById(id);
      if (!existing) return null;

      // Deactivate previous active baseline for same plan+metric
      await db
        .update(baselines)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(baselines.testPlanId, existing.testPlanId),
            eq(baselines.metric, existing.metric),
            eq(baselines.isActive, true),
          ),
        );

      const [row] = await db
        .update(baselines)
        .set({
          isActive: true,
          approvedByUserId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(baselines.id, id))
        .returning();
      return row ?? null;
    },

    async create(data: {
      companyId: string;
      testPlanId: string;
      sourceRunId: string;
      metric: string;
      baselineValue: number;
      tolerancePct?: number;
    }) {
      const [row] = await db
        .insert(baselines)
        .values({
          companyId: data.companyId,
          testPlanId: data.testPlanId,
          sourceRunId: data.sourceRunId,
          metric: data.metric,
          baselineValue: data.baselineValue,
          tolerancePct: data.tolerancePct ?? 10,
          isActive: false,
        })
        .returning();
      return row!;
    },
  };
}
