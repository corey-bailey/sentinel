import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { requirementService } from "../services/requirements.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const VALID_SOURCES = new Set(["k6", "playwright", "pytest", "mocha", "apm:dynatrace"]);
const VALID_OPERATORS = new Set(["lt", "lte", "gt", "gte"]);

const slaTargetSchema = z.object({
  metric: z.string().min(1),
  operator: z.string().refine((v) => VALID_OPERATORS.has(v), {
    message: "operator must be one of: lt, lte, gt, gte",
  }),
  threshold: z.number(),
  source: z.string().refine((v) => VALID_SOURCES.has(v), {
    message: "source must be one of: k6, playwright, pytest, mocha, apm:dynatrace",
  }),
});

const createRequirementSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  slaTargets: z.array(slaTargetSchema).min(0),
  jiraIssueId: z.string().optional(),
});

const updateRequirementSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  slaTargets: z.array(slaTargetSchema).optional(),
  jiraIssueId: z.string().optional(),
});

export function requirementRoutes(db: Db) {
  const router = Router();
  const svc = requirementService(db);

  router.get("/companies/:companyId/requirements", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/requirements", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = createRequirementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const actor = getActorInfo(req);
    const source = actor.actorType === "agent" ? "agent" : "human";

    const requirement = await svc.create(companyId, {
      name: parsed.data.name,
      description: parsed.data.description,
      slaTargets: parsed.data.slaTargets as any,
      source,
      jiraIssueId: parsed.data.jiraIssueId,
    });

    res.status(201).json(requirement);
  });

  router.get("/requirements/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const requirement = await svc.getById(id);
    if (!requirement) {
      res.status(404).json({ error: "Requirement not found" });
      return;
    }
    assertCompanyAccess(req, requirement.companyId);
    res.json(requirement);
  });

  router.patch("/requirements/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Requirement not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const parsed = updateRequirementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const updated = await svc.update(id, parsed.data as any);
    if (!updated) {
      res.status(404).json({ error: "Requirement not found" });
      return;
    }
    res.json(updated);
  });

  return router;
}
