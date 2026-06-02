import { Router } from "express";
import { z } from "zod";
import type { Db } from "@sentinel/db";
import { assertCompanyAccess } from "./authz.js";
import { pipelineRunService } from "../services/pipeline-run.js";
import { createExecFileSpawn } from "../services/test-adapters/spawn.js";

const triggerSchema = z.object({
  type: z.enum(["manual_intake", "jira", "ci", "scheduled", "manual_rerun"]),
  source: z.string().min(1),
  ref: z.string().optional(),
});
const bodySchema = z.object({
  testPlanId: z.string().uuid(),
  requirementsDocumentId: z.string().uuid(),
  trigger: triggerSchema,
});

export function pipelineRunsRoutes(db: Db) {
  const router = Router();
  const svc = pipelineRunService(db);

  router.post("/companies/:companyId/pipeline-runs", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(422).json({ error: parsed.error.issues[0]?.message }); return; }

    const run = await svc.create(companyId, {
      path: "execution-trigger",
      trigger: parsed.data.trigger,
      testPlanId: parsed.data.testPlanId,
      requirementsDocumentId: parsed.data.requirementsDocumentId,
    });
    const result = await svc.runExecutionTrigger(run.id, { spawnFn: createExecFileSpawn() });
    res.status(201).json({ pipelineRunId: run.id, verdict: result.verdict, ciSignal: result.ciSignal });
  });

  return router;
}
