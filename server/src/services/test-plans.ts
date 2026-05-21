import { eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { testPlans, type LoadProfile } from "@sentinel/db";

export type CreateTestPlanInput = {
  name: string;
  requirementId?: string;
  engines: string[];
  filePatterns?: string[];
  loadProfile?: LoadProfile;
  apmProvider?: string;
  apmServiceId?: string;
  schedule?: string;
};

export function testPlanService(db: Db) {
  return {
    async create(companyId: string, data: CreateTestPlanInput) {
      const [row] = await db
        .insert(testPlans)
        .values({
          companyId,
          name: data.name,
          requirementId: data.requirementId ?? null,
          engines: data.engines,
          filePatterns: data.filePatterns ?? [],
          loadProfile: data.loadProfile ?? null as LoadProfile | null,
          apmProvider: data.apmProvider ?? null,
          apmServiceId: data.apmServiceId ?? null,
          schedule: data.schedule ?? null,
        })
        .returning();
      return row!;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(testPlans)
        .where(eq(testPlans.id, id))
        .limit(1);
      return row ?? null;
    },

    async list(companyId: string) {
      return db
        .select()
        .from(testPlans)
        .where(eq(testPlans.companyId, companyId));
    },
  };
}
