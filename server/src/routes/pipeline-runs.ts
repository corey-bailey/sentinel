import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { testRunArtifacts, type Db } from "@sentinel/db";
import { eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { pipelineRunService } from "../services/pipeline-run.js";
import { createExecFileSpawn } from "../services/test-adapters/spawn.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";

const triggerSchema = z.object({
  type: z.enum(["manual_intake", "jira", "ci", "scheduled", "manual_rerun"]),
  source: z.string().min(1),
  ref: z.string().optional(),
});
const bodySchema = z.object({
  testPlanId: z.string().uuid(),
  requirementsDocumentId: z.string().uuid(),
  trigger: triggerSchema,
  // CI/sync callers can block for the full run; UI defaults to fire-and-poll.
  wait: z.boolean().optional(),
});

export function pipelineRunsRoutes(db: Db, storageService?: StorageService) {
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

    if (parsed.data.wait) {
      const result = await svc.runExecutionTrigger(run.id, { spawnFn: createExecFileSpawn(), storage: storageService });
      res.status(201).json({ pipelineRunId: run.id, verdict: result.verdict, ciSignal: result.ciSignal });
      return;
    }

    // Fire-and-poll: runExecutionTrigger records verdict='error' on throw, so a rejection here
    // only needs logging — the run row is the source of truth the UI polls.
    svc.runExecutionTrigger(run.id, { spawnFn: createExecFileSpawn(), storage: storageService }).catch((err) => {
      logger.error({ err, pipelineRunId: run.id }, "background pipeline run failed");
    });
    res.status(201).json({ pipelineRunId: run.id, verdict: "running", ciSignal: null });
  });

  router.get("/companies/:companyId/pipeline-runs", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const testPlanId = typeof req.query.testPlanId === "string" ? req.query.testPlanId : undefined;
    const runs = await svc.list(companyId, { testPlanId });
    res.json(runs);
  });

  router.get("/pipeline-runs/:id", async (req, res) => {
    const { id } = req.params;
    const detail = await svc.getDetail(id);
    if (!detail) { res.status(404).json({ error: "Pipeline run not found" }); return; }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.get("/artifacts/:artifactId/content", async (req, res) => {
    const { artifactId } = req.params;
    const [artifact] = await db.select().from(testRunArtifacts).where(eq(testRunArtifacts.id, artifactId));
    if (!artifact) { res.status(404).json({ error: "Artifact not found" }); return; }
    assertCompanyAccess(req, artifact.companyId);

    const contentType = artifact.contentType ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The k6 HTML report executes inline JS; sandbox it away from the app origin.
    if (contentType.includes("text/html")) res.setHeader("Content-Security-Policy", "sandbox allow-scripts");

    if (artifact.storageRef.startsWith("/")) {
      // Legacy temp-dir path (pre durable storage): gone once the workspace is cleaned.
      try {
        await fs.promises.access(artifact.storageRef);
      } catch {
        res.removeHeader("Content-Security-Policy");
        res.status(410).type("application/json").json({ error: "Artifact content expired (stored in a temporary workspace)" });
        return;
      }
      fs.createReadStream(artifact.storageRef).pipe(res);
      return;
    }

    if (!storageService) {
      res.removeHeader("Content-Security-Policy");
      res.status(503).type("application/json").json({ error: "Artifact storage not configured" });
      return;
    }
    try {
      const obj = await storageService.getObject(artifact.companyId, artifact.storageRef);
      if (obj.contentLength != null) res.setHeader("Content-Length", String(obj.contentLength));
      obj.stream.pipe(res);
    } catch {
      res.removeHeader("Content-Security-Policy");
      res.status(410).type("application/json").json({ error: "Artifact content not found in storage" });
    }
  });

  return router;
}
