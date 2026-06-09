import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { regressionService } from "../services/regressions.js";
import { pipelineRunService } from "../services/pipeline-run.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

const patchRegressionSchema = z.object({
  action: z.enum(["approve", "reject"]),
});

export function regressionRoutes(db: Db) {
  const router = Router();
  const svc = regressionService(db);

  router.get("/companies/:companyId/regressions", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const testRunId = req.query.testRunId as string | undefined;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, { testRunId, status });
    res.json(result);
  });

  router.patch("/regressions/:id", async (req, res) => {
    assertAuthenticated(req);
    const { id } = req.params as { id: string };
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Regression not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (existing.status !== "open") {
      res.status(409).json({ error: `Regression already resolved (status: ${existing.status})` });
      return;
    }

    const parsed = patchRegressionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const actor = getActorInfo(req);
    const updated =
      parsed.data.action === "approve"
        ? await svc.approve(id, actor.actorId)
        : await svc.reject(id, actor.actorId);

    // Stage-7 gate: approving waives the regression (run passes); rejecting confirms it (run
    // fails). Terminalizes the blocked_on_human pipeline run with a human gate_resolutions row.
    if (existing.pipelineRunId) {
      const action = parsed.data.action === "approve" ? "regression_approved" : "regression_rejected";
      await pipelineRunService(db).applyHumanResolution(existing.pipelineRunId, action, actor.actorId);
    }

    res.json(updated);
  });

  return router;
}
