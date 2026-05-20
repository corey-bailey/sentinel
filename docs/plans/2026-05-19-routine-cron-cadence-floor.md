# Routine Cron Cadence Floor + Cascade Cap

Status: Draft
Owner: Backend / Routines
Date: 2026-05-19
Surfaced by: a 286-heartbeat, ~$50 retry storm captured in the heartbeat
audit on 2026-05-19. The cause is fixed by `db02efcb` (circuit breaker);
this issue addresses the *cause* of that breaker getting tripped in the
first place.

## Summary

The routine scheduler accepts cron expressions as-given. An agent
autonomously created two `*/5 * * * *` "continuous-monitor" routines
(12 fires/hr each, 24/hr combined) plus several daily/weekly routines. In
combination with the CEO orchestration cascade — each fire spawning 5–10
issues, each assignment auto-triggering a heartbeat — the system entered a
90-parallel-chain retry storm against a rate-limited upstream.

Even with a circuit breaker in place (`db02efcb`), nothing prevents an
agent or board user from creating a `* * * * *` cron tomorrow that spawns
60+ heartbeats per hour. That's still wasteful even when those heartbeats
short-circuit at the breaker — and on a working upstream, it would just
mean 60 LLM invocations per hour with no rate-limit gate to bound them.

This proposes two complementary guardrails: a **cadence floor on
schedule triggers** and a **cap on issues spawned per heartbeat run**.

## Evidence (from the 2026-05-19 storm)

- 21 routines active by the end of the session, including:
  - `polymarket-copy.continuous-monitor` — `*/5 * * * *`
  - `crypto-kalshi.continuous-monitor` — `*/5 * * * *`
  - duplicate `polymarket-copy.pnl-attribution` (identical title, same agent)
  - `CEO board orchestration — groom and advance` — `*/30 * * * *`
- 286 heartbeats in 3.5 hours (peak 179 in one hour).
- The CEO heartbeat spawned 21+ issues in one fire — each assignment
  triggered a heartbeat in the assigned agent via the documented
  "assigning triggers a heartbeat" behavior.
- Total token consumption tracked in `cost_events`: 6.9M input + 950k
  output + 154M cached input — equivalent to ~$35–80 at API rates,
  charged against the owner's subscription quota.

## Proposed Changes

### 1. Cron cadence floor on routine `schedule` triggers

Reject cron expressions with an interval shorter than **15 minutes** at
trigger create/update time, with a clear error message and a hint at
alternatives.

**Rationale**: a routine that spawns a heartbeat is fundamentally a
human-scale operation. The heartbeat boots an LLM session with a full
context payload. Anything finer than 15 minutes is almost certainly
either a misuse (a script masquerading as a routine) or an honest
mistake. Genuinely real-time monitoring belongs in a long-running
process, not a routine.

Implementation:

- In the routine-trigger create handler (`POST /api/routines/:id/triggers`
  and `PATCH /api/routine-triggers/:id`), parse the cron expression with
  `cron-parser` (already a dependency, I'd assume) and compute the
  smallest interval between consecutive fires across a day. Reject if
  that interval is < 15 minutes.
- Surface the floor as an instance setting so a deployment with genuine
  high-cadence needs can raise it (default `15m`, configurable).
- Error message should point at the alternative: a long-running service
  or webhook-driven routine instead.

Edge cases:
- `0 9,10,11 * * 1-5` — fires at 9, 10, 11 weekdays. 1-hour interval. OK.
- `*/5 9-17 * * 1-5` — fires every 5 minutes during business hours. **Reject.**
- `0 0,12 * * *` — twice daily, 12-hour interval. OK.

### 2. Cap on issues spawned per heartbeat run

Add a per-heartbeat-run counter that tracks how many new issues the
agent has created via `POST /api/companies/:companyId/issues` during
that single heartbeat. When the counter exceeds a threshold (default
**5 new issues**), subsequent issue creates from that heartbeat return
a 429 with a message instructing the agent to surface follow-up work as
a comment or a single parent issue, not as a flood of children.

**Rationale**: the CEO heartbeat that spawned CIT-73–CIT-81 (9 issues in
one fire) is a clear example of agents reading a roadmap and trying to
implement everything at once. Each child assignment triggered a
heartbeat. That cascade is what made the storm — even with sane cron
cadences, one CEO heartbeat fanning out to 9 worker heartbeats
multiplies the load 10×.

A 5-issue cap is generous for any single grooming sweep. Agents that
need to spawn larger work units can do it across multiple heartbeats —
the routine fires again in 30 minutes.

Implementation:

- The existing `X-Paperclip-Run-Id` header already scopes a request to a
  heartbeat run. Increment a counter on the heartbeat run row
  (`issues_created_count` column on `heartbeat_runs`).
- Issue create endpoint reads + increments transactionally.
- Above threshold: return 429 with `Retry-After` hint pointing at the
  next routine fire (or just "next heartbeat") and a structured error.
- Configurable via instance settings; default 5.

### 3. Routine duplicate detection (nice-to-have)

When creating a routine, warn (don't reject) if an active routine with
the same `(assigneeAgentId, projectId, title)` already exists. The
storm session created a duplicate `polymarket-copy.pnl-attribution` —
clearly an agent-side mistake that the platform could catch.

## Why this is additive to the circuit breaker

The circuit breaker (`db02efcb`) protects against the *consequence* of
the storm — token-burning retry loops against a rate-limited endpoint.
These guardrails protect against the *cause* — too many heartbeats
firing too fast in the first place.

Both layers are needed:

- Without the breaker, a single rate-limit event becomes a token storm.
- Without the cadence floor + cascade cap, the system burns tokens on
  upstream-healthy heartbeats just as fast — the breaker only fires when
  upstream is *unhealthy*. A working upstream + a `*/1 * * * *` routine =
  60 LLM sessions per hour, breaker silent.

## Open questions

- **What about webhook and api triggers?** Webhooks are externally
  driven, so the floor doesn't apply per se — but they should respect
  the per-heartbeat cascade cap. API triggers (manual fire) are
  intentionally one-shot; no floor needed.
- **Should the cap differ by agent role?** A CEO agent might
  legitimately need to spawn more than 5 issues in a sweep. Could be
  per-role config, but starting with a flat default is simpler.
- **Existing routines violating the floor?** Grandfather them (don't
  retroactively pause), but show a warning on the routine detail page
  and require an explicit acknowledgement before next save.

## Scope estimate

- Cadence floor: ~2 hours including tests.
- Cascade cap: ~half a day (schema column + transactional increment +
  endpoint behavior + tests).
- Duplicate detection: ~1 hour.

Total: 1 day of work.
