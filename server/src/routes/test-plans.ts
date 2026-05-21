import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { testPlanService } from "../services/test-plans.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";

const stageSchema = z.object({
  duration: z.string(),
  target: z.number(),
});

const loadProfileSchema = z.object({
  vus: z.number(),
  stages: z.array(stageSchema),
});

const createTestPlanSchema = z.object({
  name: z.string().min(1),
  requirementId: z.string().optional(),
  engines: z.array(z.string()).min(1),
  filePatterns: z.array(z.string()).optional(),
  loadProfile: loadProfileSchema.optional(),
  apmProvider: z.string().optional(),
  apmServiceId: z.string().optional(),
  schedule: z.string().optional(),
});

export function testPlanRoutes(db: Db) {
  const router = Router();
  const svc = testPlanService(db);

  router.post("/companies/:companyId/test-plans", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = createTestPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const plan = await svc.create(companyId, parsed.data);
    res.status(201).json(plan);
  });

  router.get("/companies/:companyId/test-plans", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const plans = await svc.list(companyId);
    res.json(plans);
  });

  router.get("/test-plans/:id", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params as { id: string };
    const plan = await svc.getById(id);
    if (!plan) {
      res.status(404).json({ error: "Test plan not found" });
      return;
    }
    assertCompanyAccess(req, plan.companyId);
    res.json(plan);
  });

  return router;
}
