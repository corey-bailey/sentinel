import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { baselines } from "@sentinel/db";

export type ListBaselinesFilters = {
  testPlanId?: string;
  activeOnly?: boolean;
  includeInvalidated?: boolean;
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
      // rejected/retired rows carry a validUntil stamp; hide them by default
      if (!filters.includeInvalidated) {
        conditions.push(isNull(baselines.validUntil));
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

    // Set-aware promotion: approving ANY row of a baselineSetId activates the whole set
    // atomically and retires the previously-active set for the plan (a baseline is only
    // coherent as a set — per-metric mixing across runs is meaningless).
    async approve(id: string, approvedByUserId: string) {
      const existing = await this.getById(id);
      if (!existing) return null;
      const now = new Date();

      // retire the currently-active rows for this plan (whole prior set)
      await db
        .update(baselines)
        .set({ isActive: false, validUntil: now, updatedAt: now })
        .where(
          and(
            eq(baselines.testPlanId, existing.testPlanId),
            eq(baselines.isActive, true),
          ),
        );

      const activate = { isActive: true, approvedByUserId, approvedAt: now, validFrom: now, updatedAt: now };
      if (existing.baselineSetId) {
        await db
          .update(baselines)
          .set(activate)
          .where(and(
            eq(baselines.baselineSetId, existing.baselineSetId),
            eq(baselines.companyId, existing.companyId),
            isNull(baselines.validUntil),
          ));
        return this.getById(id);
      }
      // pre-set legacy rows: per-row activation
      const [row] = await db.update(baselines).set(activate).where(eq(baselines.id, id)).returning();
      return row ?? null;
    },

    // Rejecting a proposal retires the whole pending set (validUntil stamp, never deleted).
    async reject(id: string, rejectedByUserId: string) {
      const existing = await this.getById(id);
      if (!existing) return null;
      const now = new Date();
      const retire = { validUntil: now, approvedByUserId: rejectedByUserId, updatedAt: now };
      if (existing.baselineSetId) {
        await db
          .update(baselines)
          .set(retire)
          .where(and(
            eq(baselines.baselineSetId, existing.baselineSetId),
            eq(baselines.companyId, existing.companyId),
            eq(baselines.isActive, false),
            isNull(baselines.validUntil),
          ));
        return this.getById(id);
      }
      const [row] = await db.update(baselines).set(retire).where(eq(baselines.id, id)).returning();
      return row ?? null;
    },

    async create(data: {
      companyId: string;
      testPlanId: string;
      sourceRunId: string;
      metric: string;
      baselineValue: number;
      tolerancePct?: number;
      baselineSetId?: string | null;
      median?: number | null;
      stddev?: number | null;
      sampleN?: number | null;
      direction?: string | null;
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
          baselineSetId: data.baselineSetId ?? null,
          median: data.median ?? data.baselineValue,
          stddev: data.stddev ?? null,
          sampleN: data.sampleN ?? null,
          direction: data.direction ?? null,
          isActive: false,
        })
        .returning();
      return row!;
    },
  };
}
