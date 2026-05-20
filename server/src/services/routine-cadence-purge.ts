import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineTriggers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { minCadenceMinutes } from "./cron.js";

const log = logger.child({ service: "routine-cadence-purge" });

export interface PurgeResult {
  scanned: number;
  disabled: Array<{
    triggerId: string;
    routineId: string;
    companyId: string;
    cronExpression: string;
    cadenceMinutes: number;
  }>;
}

/**
 * One-shot boot-time sweep that disables any enabled schedule triggers whose
 * cron cadence is below the configured floor. Grandfathered violators created
 * before the floor existed get caught here; routines created after Phase 1
 * cannot reach this state.
 *
 * Idempotent — safe to run on every boot. Returns the list of disabled
 * triggers for caller-side logging.
 */
export async function purgeBelowFloorScheduleTriggers(db: Db): Promise<PurgeResult> {
  const floor = (await instanceSettingsService(db).getGeneral()).minCronCadenceMinutes;
  if (!Number.isFinite(floor) || floor <= 0) {
    return { scanned: 0, disabled: [] };
  }

  const rows = await db
    .select({
      id: routineTriggers.id,
      routineId: routineTriggers.routineId,
      companyId: routineTriggers.companyId,
      cronExpression: routineTriggers.cronExpression,
    })
    .from(routineTriggers)
    .where(and(eq(routineTriggers.kind, "schedule"), eq(routineTriggers.enabled, true)));

  const disabled: PurgeResult["disabled"] = [];

  for (const row of rows) {
    if (!row.cronExpression) continue;
    let cadence: number;
    try {
      cadence = minCadenceMinutes(row.cronExpression);
    } catch (err) {
      log.warn(
        { triggerId: row.id, cronExpression: row.cronExpression, err: (err as Error).message },
        "skipping trigger with unparseable cron expression",
      );
      continue;
    }
    if (cadence >= floor) continue;

    await db
      .update(routineTriggers)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(routineTriggers.id, row.id));

    log.warn(
      {
        triggerId: row.id,
        routineId: row.routineId,
        companyId: row.companyId,
        cronExpression: row.cronExpression,
        cadenceMinutes: cadence,
        floorMinutes: floor,
        event: "grandfathered_trigger_disabled",
      },
      `disabled grandfathered schedule trigger (cadence ${cadence}m < floor ${floor}m)`,
    );

    disabled.push({
      triggerId: row.id,
      routineId: row.routineId,
      companyId: row.companyId,
      cronExpression: row.cronExpression,
      cadenceMinutes: cadence,
    });
  }

  return { scanned: rows.length, disabled };
}
