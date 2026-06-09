import { Router } from "express";
import { z } from "zod";
import type { Db } from "@sentinel/db";
import { baselineService } from "../services/baselines.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

const createBaselineSchema = z.object({
  testPlanId: z.string().min(1),
  sourceRunId: z.string().min(1),
  metric: z.string().min(1),
  baselineValue: z.number(),
  tolerancePct: z.number().optional(),
});

export function baselineRoutes(db: Db) {
  const router = Router();
  const svc = baselineService(db);

  router.post("/companies/:companyId/baselines", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = createBaselineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.message });
      return;
    }

    const baseline = await svc.create({ companyId, ...parsed.data });
    res.status(201).json(baseline);
  });

  router.get("/companies/:companyId/baselines", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const testPlanId = req.query.testPlanId as string | undefined;
    const result = await svc.list(companyId, { testPlanId });
    res.json(result);
  });

  router.post("/baselines/:id/approve", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params as { id: string };
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Baseline not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const actor = getActorInfo(req);
    const updated = await svc.approve(id, actor.actorId);
    res.json(updated);
  });

  // Rejecting a proposal retires the whole pending set (validUntil stamp) — the next
  // characterization run proposes a fresh set.
  router.post("/baselines/:id/reject", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params as { id: string };
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Baseline not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (existing.isActive) {
      res.status(409).json({ error: "Cannot reject an active baseline" });
      return;
    }

    const actor = getActorInfo(req);
    const updated = await svc.reject(id, actor.actorId);
    res.json(updated);
  });

  return router;
}
