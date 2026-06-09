import { Router } from "express";
import { z } from "zod";
import { type Db, type SlaTarget } from "@sentinel/db";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  requirementsDocumentService,
  RequirementsDocumentStateError,
} from "../services/requirements-documents.js";
import { deriveTestPlan } from "../services/test-plan-generator.js";
import { testPlanService } from "../services/test-plans.js";

const slaTargetSchema = z.object({
  id: z.string().optional(),
  source: z.string().min(1),
  metric: z.string().min(1),
  operator: z.enum(["lt", "lte", "gt", "gte"]),
  threshold: z.number(),
  required: z.boolean(),
  workflowScope: z.string().optional(),
  approvedByUserId: z.string().optional(),
});

const documentBodySchema = z.object({
  pipelineRequestId: z.string().uuid().optional(),
  appName: z.string().optional(),
  appDescription: z.string().optional(),
  protocol: z.union([z.string(), z.array(z.string())]).optional(),
  syncModel: z.enum(["sync", "async", "hybrid"]).optional(),
  asyncDetails: z.object({ measurementPoint: z.string().optional(), sagaDescription: z.string().optional() }).optional(),
  slaTargets: z.array(slaTargetSchema).optional(),
  loadModel: z.record(z.unknown()).optional(),
  authentication: z.record(z.unknown()).optional(),
  testData: z.record(z.unknown()).optional(),
  existingArtifacts: z.record(z.unknown()).optional(),
  targetEnvironment: z.record(z.unknown()).optional(),
  dynatrace: z.record(z.unknown()).optional(),
  minSampleCount: z.number().int().positive().optional(),
  testIntent: z.enum(["conformance", "baseline", "exploratory"]).optional(),
});

function stateErrorTo409(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): boolean {
  if (err instanceof RequirementsDocumentStateError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

// Spec-aligned requirements_documents (Stage 1) — distinct from the legacy /requirements
// routes, which serve the deprecated `requirements` table that the old UI page still reads.
export function requirementsDocumentRoutes(db: Db) {
  const router = Router();
  const svc = requirementsDocumentService(db);

  router.get("/companies/:companyId/requirements-documents", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    res.json(
      rows.map((rd) => {
        const targetEnv = (rd.targetEnvironment ?? {}) as { baseUrl?: unknown };
        return {
          id: rd.id,
          appName: rd.appName,
          status: rd.status,
          testIntent: rd.testIntent,
          baseUrl: typeof targetEnv.baseUrl === "string" ? targetEnv.baseUrl : null,
          slaTargetCount: (rd.slaTargets ?? []).length,
          createdAt: rd.createdAt,
        };
      }),
    );
  });

  router.get("/requirements-documents/:id", async (req, res) => {
    const { id } = req.params;
    const rd = await svc.getById(id);
    if (!rd) {
      res.status(404).json({ error: "Requirements document not found" });
      return;
    }
    assertCompanyAccess(req, rd.companyId);
    res.json(rd);
  });

  router.post("/companies/:companyId/requirements-documents", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const parsed = documentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }
    try {
      const row = await svc.create(companyId, parsed.data as never);
      res.status(201).json(row);
    } catch (err) {
      if (stateErrorTo409(res, err)) return;
      throw err;
    }
  });

  router.patch("/requirements-documents/:id", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Requirements document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const parsed = documentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }
    try {
      res.json(await svc.update(id, parsed.data as never));
    } catch (err) {
      if (stateErrorTo409(res, err)) return;
      throw err;
    }
  });

  router.post("/requirements-documents/:id/complete", async (req, res) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Requirements document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    try {
      res.json(await svc.markComplete(id));
    } catch (err) {
      if (stateErrorTo409(res, err)) return;
      throw err;
    }
  });

  router.post("/requirements-documents/:id/approve", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Requirements document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    try {
      res.json(await svc.approve(id, actor.actorId));
    } catch (err) {
      if (stateErrorTo409(res, err)) return;
      throw err;
    }
  });

  // Stage 2: mechanical plan derivation. 422 with gaps → resume discovery.
  router.post("/requirements-documents/:id/derive-test-plan", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params;
    const rd = await svc.getById(id);
    if (!rd) {
      res.status(404).json({ error: "Requirements document not found" });
      return;
    }
    assertCompanyAccess(req, rd.companyId);
    if (rd.status !== "approved") {
      res.status(409).json({ error: `document must be approved before plan derivation (status: ${rd.status})` });
      return;
    }

    const result = deriveTestPlan({
      id: rd.id,
      appName: rd.appName,
      protocol: rd.protocol,
      slaTargets: (rd.slaTargets ?? []) as SlaTarget[],
      loadModel: rd.loadModel,
      minSampleCount: rd.minSampleCount,
      testIntent: rd.testIntent,
    });
    if ("gaps" in result) {
      res.status(422).json({ error: "requirements document has derivation gaps — resume discovery", gaps: result.gaps });
      return;
    }
    const plan = await testPlanService(db).createDerived(rd.companyId, result.plan);
    res.status(201).json(plan);
  });

  return router;
}
