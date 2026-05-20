-- Prevent duplicate enabled schedule triggers on the same routine.
-- Step 1: auto-disable existing duplicates (keep oldest of each cluster).
-- This is idempotent — re-running finds no duplicates the second time.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY routine_id, kind, cron_expression, timezone
           ORDER BY created_at, id
         ) AS rn
  FROM routine_triggers
  WHERE enabled = true AND kind = 'schedule'
)
UPDATE routine_triggers t
   SET enabled = false,
       updated_at = now()
  FROM ranked r
 WHERE t.id = r.id AND r.rn > 1;

-- Step 2: enforce no future duplicates via partial unique index.
-- Scoped to enabled schedule triggers — disabled ones (including the ones we
-- just deduped) and webhook/api triggers are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "routine_triggers_schedule_dedupe_uq"
  ON "routine_triggers" ("routine_id", "kind", "cron_expression", "timezone")
  WHERE enabled = true AND kind = 'schedule';
