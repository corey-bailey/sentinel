import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { triggerService } from "../services/triggers.js";
import { assertCompanyAccess } from "./authz.js";

const deployWebhookSchema = z.object({
  repo: z.string().min(1),
  commit: z.string().min(1),
  changedFiles: z.array(z.string()),
});

export function triggerRoutes(db: Db) {
  const router = Router();
  const svc = triggerService(db);

  router.post("/companies/:companyId/triggers/deploy", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = deployWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const result = await svc.deployWebhook(companyId, parsed.data);
    res.json(result);
  });

  return router;
}
