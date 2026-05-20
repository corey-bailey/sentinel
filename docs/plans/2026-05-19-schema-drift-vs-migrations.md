# Schema Drift Between `packages/db/src/schema/*` and Applied Migrations

Status: Draft
Owner: Backend / DB
Date: 2026-05-19
Surfaced by: `db02efcb` (`fix(heartbeat): break upstream rate-limit retry storms`)

## Summary

`drizzle-kit generate` produced a single migration containing **schema changes
spanning ~10 unrelated tables** when run for the first time since migration
`0084`. The schema files at HEAD have evolved without corresponding migrations
being generated, so the latest migration `0084` no longer reflects HEAD schema.

This forces any future migration author to either:

1. Couple their narrow change to a giant catch-up migration that touches
   unrelated tables — which is what happened to me; I rejected this and
   hand-wrote a scoped `0085_upstream_health_state.sql`, but the auto-generated
   snapshot `meta/0085_snapshot.json` still encodes the drift.
2. Generate cleanly only after the drift is reconciled — which requires
   walking through every drifted table and confirming the schema files are
   the intended source of truth.

The longer this goes unaddressed, the larger and harder the eventual
reconciliation becomes, and every new migration author hits the same
fork-in-the-road.

## Evidence (from the `db02efcb` generate run)

The drizzle-generate run on top of `0084` produced SQL containing changes
to (in addition to the intended `upstream_health_state`):

- `company_secret_bindings` — full new table
- `company_secret_provider_configs` — full new table
- `issue_recovery_actions` — full new table (note: 0084 already creates this — appears in the diff anyway)
- `secret_access_events` — full new table
- `company_secret_versions` — 4 new columns (`provider_version_ref`,
  `status`, `fingerprint_sha256` NOT NULL, `rotation_job_id`)
- `company_secrets` — 8 new columns (`key` NOT NULL, `status`, `managed_mode`,
  `provider_config_id`, `provider_metadata`, `last_resolved_at`,
  `last_rotated_at`, `deleted_at`)
- New indexes on `documents` (`documents_title_search_idx`,
  `documents_latest_body_search_idx`) using `gin_trgm_ops`

That a `company_secrets.key NOT NULL` column got added without a
corresponding migration is the load-bearing signal — production rows would
fail that constraint if applied as-is. There is no backfill in the implied
migration.

## Why this is dangerous

1. **The drift hides incompatibilities.** A `NOT NULL` column added to a
   schema file with no migration looks fine at TypeScript level but is a
   runtime ticking bomb. A fresh database created from drizzle-kit will
   match the schema; an upgraded production database will reject inserts
   on the missing column or fail the constraint.
2. **Snapshots compound the lie.** Each generate baselines the *current*
   schema. My `0085_snapshot.json` now encodes all the drift as "already
   applied" — even though no migration applies it. The next generate run
   will diff against my snapshot and produce a *different* (smaller) diff,
   missing the drift entirely. The drift becomes invisible.
3. **Onboarding noise.** Any new contributor running generate hits the
   same surprise I did, and may resolve it by committing the giant diff —
   shipping a migration with constraint changes nobody reviewed for
   backfill behavior.

## Proposed Resolution

The right answer is **walk each drifted table, decide canonical intent,
emit the missing migration with backfill where needed**. Concretely:

1. **Audit each drifted table** by diffing `packages/db/src/schema/<table>.ts`
   against the latest migration that defines or alters it. Produce a
   table-by-table report.
2. **For each drifted change, choose one:**
   - **Land a real migration** (with `ALTER TABLE … ADD COLUMN`, backfill
     `UPDATE` if `NOT NULL` is added to a non-empty table, follow with
     `SET NOT NULL`).
   - **Revert the schema file change** if the schema-level addition was
     premature / abandoned.
3. **Write a guard in `db:generate`**: fail with a clear error if running
   the command produces a diff that includes tables outside the active
   migration's intended scope. (Or at least, surface the unrelated diff
   to the developer explicitly.)
4. **Update `packages/db/src/migrations/meta/0085_snapshot.json`** to
   accurately reflect the post-reconciliation schema — or accept the
   current state as the baseline going forward (riskier — see #2 above).

## Scope estimate

- **Audit**: half a day to walk every drifted table and produce the report.
- **Per-table migrations**: depends on data. For tables with no `NOT NULL`
  constraint changes, trivial. For `company_secrets.key NOT NULL` and
  similar, requires a real backfill — could be a day each on busy tables.
- **Generate guard**: small. ~30 lines in the existing `check:migrations`
  script.

Total: 1–3 days depending on what the audit turns up.

## Non-goals for this issue

- Reorganizing the schema directory.
- Changing the drizzle-kit configuration.
- Migrating any data shape *intentionally*.

This issue is strictly about reconciling the gap between
`packages/db/src/schema/` and `packages/db/src/migrations/` so that future
migration authors don't hit a giant diff every time they touch the schema.
