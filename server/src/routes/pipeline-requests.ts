import { Router } from "express";
import { z } from "zod";
import type { Db } from "@sentinel/db";
import { pipelineRequestService, DuplicateIntakeError } from "../services/pipeline-requests.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

const createSchema = z.object({
  source: z.enum(["manual_intake", "jira"]),
  rawDescription: z.string().optional(),
  jiraIssueKey: z.string().optional(),
  jiraIssueUrl: z.string().optional(),
  artifacts: z.record(z.unknown()).optional(),
  extractedContext: z.record(z.unknown()).optional(),
  requestedBy: z.string().optional(),
});

export function pipelineRequestRoutes(db: Db) {
  const router = Router();
  const svc = pipelineRequestService(db);

  router.post("/companies/:companyId/pipeline-requests", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }
    const actor = getActorInfo(req);
    try {
      const row = await svc.create(companyId, { ...parsed.data, ownerUserId: actor.actorId } as never);
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof DuplicateIntakeError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/companies/:companyId/pipeline-requests", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await svc.list(companyId, { status }));
  });

  for (const action of ["confirm", "reject"] as const) {
    router.post(`/pipeline-requests/:id/${action}`, async (req, res) => {
      assertAuthenticated(req);
      const { id } = req.params;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Pipeline request not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      const updated = await svc[action](id);
      if (!updated) {
        res.status(409).json({ error: `Request is not pending confirmation (status: ${existing.status})` });
        return;
      }
      res.json(updated);
    });
  }

  return router;
}
