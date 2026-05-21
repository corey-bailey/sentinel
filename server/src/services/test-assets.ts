import { and, eq } from "drizzle-orm";
import type { Db } from "@sentinel/db";
import { testAssets } from "@sentinel/db";

export type AssetType = "human_authored" | "generated" | "approved_generated";
export type Engine = "k6" | "playwright" | "pytest" | "mocha";

export type CreateTestAssetInput = {
  testPlanId: string;
  name?: string;
  engine: Engine;
  scriptContent?: string;
  scriptPath?: string;
  assetType?: AssetType;
};

export type CoverageEntry = {
  covered: boolean;
  assetType: AssetType | null;
};

export type CoverageMap = Record<Engine, CoverageEntry>;

const ALL_ENGINES: Engine[] = ["k6", "playwright", "pytest", "mocha"];

export function testAssetService(db: Db) {
  return {
    async create(companyId: string, data: CreateTestAssetInput) {
      const existing = await db
        .select()
        .from(testAssets)
        .where(
          and(
            eq(testAssets.companyId, companyId),
            eq(testAssets.testPlanId, data.testPlanId),
            eq(testAssets.engine, data.engine),
          ),
        )
        .limit(1);

      const version = existing.length > 0 ? (existing[0]!.version ?? 1) + 1 : 1;

      const [row] = await db
        .insert(testAssets)
        .values({
          companyId,
          testPlanId: data.testPlanId,
          name: data.name ?? `${data.engine}-script`,
          engine: data.engine,
          scriptContent: data.scriptContent ?? null,
          scriptPath: data.scriptPath ?? null,
          assetType: data.assetType ?? "human_authored",
          version,
        })
        .returning();
      return row!;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(testAssets)
        .where(eq(testAssets.id, id))
        .limit(1);
      return row ?? null;
    },

    async list(companyId: string, filters: { testPlanId?: string } = {}) {
      const conditions = [eq(testAssets.companyId, companyId)];
      if (filters.testPlanId) {
        conditions.push(eq(testAssets.testPlanId, filters.testPlanId));
      }
      return db
        .select()
        .from(testAssets)
        .where(and(...conditions));
    },

    async getCoverageMap(companyId: string, testPlanId: string): Promise<CoverageMap> {
      const assets = await db
        .select()
        .from(testAssets)
        .where(
          and(
            eq(testAssets.companyId, companyId),
            eq(testAssets.testPlanId, testPlanId),
          ),
        );

      const map = {} as CoverageMap;
      for (const engine of ALL_ENGINES) {
        const asset = assets.find((a) => a.engine === engine);
        if (!asset) {
          map[engine] = { covered: false, assetType: null };
        } else {
          const assetType = asset.assetType as AssetType;
          const covered = assetType === "human_authored" || assetType === "approved_generated";
          map[engine] = { covered, assetType };
        }
      }
      return map;
    },
  };
}
