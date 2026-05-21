import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { testAssetService } from "../services/test-assets.js";
import { assertCompanyAccess } from "./authz.js";

const VALID_ENGINES = ["k6", "playwright", "pytest", "mocha"] as const;
const VALID_ASSET_TYPES = ["human_authored", "generated", "approved_generated"] as const;

const createTestAssetSchema = z.object({
  testPlanId: z.string().min(1),
  engine: z.enum(VALID_ENGINES),
  scriptContent: z.string().optional(),
  scriptPath: z.string().optional(),
  assetType: z.enum(VALID_ASSET_TYPES).optional(),
});

export function testAssetRoutes(db: Db) {
  const router = Router();
  const svc = testAssetService(db);

  router.post("/companies/:companyId/test-assets", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = createTestAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const asset = await svc.create(companyId, {
      testPlanId: parsed.data.testPlanId,
      engine: parsed.data.engine,
      scriptContent: parsed.data.scriptContent,
      scriptPath: parsed.data.scriptPath,
      assetType: parsed.data.assetType ?? "human_authored",
    });

    res.status(201).json(asset);
  });

  router.get("/companies/:companyId/test-assets", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const coverage = req.query.coverage as string | undefined;
    if (coverage) {
      const coverageMap = await svc.getCoverageMap(companyId, coverage);
      res.json(coverageMap);
      return;
    }

    const testPlanId = req.query.testPlanId as string | undefined;
    const assets = await svc.list(companyId, { testPlanId });
    res.json(assets);
  });

  router.get("/test-assets/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const asset = await svc.getById(id);
    if (!asset) {
      res.status(404).json({ error: "Test asset not found" });
      return;
    }
    assertCompanyAccess(req, asset.companyId);
    res.json(asset);
  });

  return router;
}
