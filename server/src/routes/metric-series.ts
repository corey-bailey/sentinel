import { Router } from "express";
import type { Db } from "@sentinel/db";
import { z } from "zod";
import { metricSeriesService } from "../services/metric-series.js";
import { METRIC_PHASES } from "../services/metric-phases.js";
import { assertCompanyAccess } from "./authz.js";

const seriesEntrySchema = z.object({
  metric: z.string().min(1),
  workflowName: z.string().nullish(),
  phase: z.enum(METRIC_PHASES).nullish(),
  value: z.number(),
  sampleCount: z.number().int().nonnegative().nullish(),
  rawValues: z.array(z.number()).nullish(),
  digest: z.record(z.unknown()).nullish(),
});

const ingestSchema = z.object({
  testRunId: z.string().uuid(),
  executionRunId: z.string().uuid().nullish(),
  source: z.string().min(1),
  series: z.array(seriesEntrySchema).min(1),
});

export function metricSeriesRoutes(db: Db) {
  const router = Router();
  const svc = metricSeriesService(db);

  router.post("/companies/:companyId/metric-series", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);

    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
      return;
    }

    const created = await svc.ingest(companyId, parsed.data);
    res.status(201).json(created);
  });

  return router;
}
