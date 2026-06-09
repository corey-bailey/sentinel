import { eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { testPlans, type LoadProfile } from "@sentinel/db";
import type { DerivedTestPlan } from "./test-plan-generator.js";

// The v1 CRUD create API accepts the legacy simple load profile only (validated
// by the route's Zod schema). The protocol-tagged discriminated `LoadProfile`
// union in @sentinel/db is produced by the pipeline's Stage-2 generator, not by
// this hand-authored CRUD path. The `load_profile` column is jsonb, so a legacy
// profile stores cleanly and remains a valid member of the widened union at rest.
export type LegacyLoadProfile = {
  vus: number;
  stages: Array<{ duration: string; target: number }>;
};

export type CreateTestPlanInput = {
  name: string;
  requirementId?: string;
  engines: string[];
  filePatterns?: string[];
  loadProfile?: LegacyLoadProfile;
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
          // jsonb column; legacy profile is valid at rest within the widened union.
          loadProfile: (data.loadProfile ?? null) as LoadProfile | null,
          apmProvider: data.apmProvider ?? null,
          apmServiceId: data.apmServiceId ?? null,
          schedule: data.schedule ?? null,
        })
        .returning();
      return row!;
    },

    // Persists a Stage-2 derived plan (union LoadProfile + executionModel + the
    // requirements_documents FK that SLA targets are read through).
    async createDerived(companyId: string, derived: DerivedTestPlan) {
      const [row] = await db
        .insert(testPlans)
        .values({
          companyId,
          name: derived.name,
          requirementsDocumentId: derived.requirementsDocumentId,
          engines: derived.engines,
          executionModel: derived.executionModel,
          loadProfile: derived.loadProfile as LoadProfile,
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
