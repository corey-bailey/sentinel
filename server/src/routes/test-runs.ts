import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { testRunService } from "../services/test-runs.js";
import { testPlanService } from "../services/test-plans.js";
import { assertCompanyAccess } from "./authz.js";

const createTestRunSchema = z.object({
  testPlanId: z.string().min(1),
  triggerContext: z.record(z.unknown()).optional(),
});

export function testRunRoutes(db: Db) {
  const router = Router();
  const svc = testRunService(db);
  const planSvc = testPlanService(db);

  router.post("/companies/:companyId/test-runs", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = createTestRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const plan = await planSvc.getById(parsed.data.testPlanId);
    if (!plan || plan.companyId !== companyId) {
      res.status(422).json({ error: "Test plan not found in this company" });
      return;
    }

    const run = await svc.create(companyId, {
      testPlanId: parsed.data.testPlanId,
      triggerType: "manual",
      triggerContext: parsed.data.triggerContext,
    });

    res.status(201).json(run);
  });

  router.get("/companies/:companyId/test-runs", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const testPlanId = req.query.testPlanId as string | undefined;
    const runs = await svc.list(companyId, { testPlanId });
    res.json(runs);
  });

  router.get("/test-runs/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const run = await svc.getById(id);
    if (!run) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    res.json(run);
  });

  return router;
}
