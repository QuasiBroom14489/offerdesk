# 0001 — SQLite with an append-only event log

**Status:** accepted · 2026-09-29

## Context

A recruiting season is a sequence of things that *happen*: I saved a posting,
applied, messaged a recruiter, heard back, got an OA. The questions worth asking
are about that sequence — what is my response rate, who went quiet, how long do
companies take to reply — not just "what is the status right now".

A status column answers only the last question and destroys the history needed
for the others.

## Decision

- **SQLite** (Node's built-in `node:sqlite`) is the single source of truth. It is
  one file, needs no server, and is fast enough to fold every event on each read
  at the scale of one person's job search.
- **Events are append-only.** Triggers in the schema abort any `UPDATE` or
  `DELETE` on `events`. New facts get new event kinds; an existing kind's
  meaning never changes.
- **Status is derived, never stored.** `foldApplication` in
  `packages/core/src/derive.ts` replays an application's events. Follow-ups and
  pipeline stats are folds too, and are pure functions tested without a database.
- **Entity tables stay mutable** for descriptive fields (role title, location,
  a contact's email). Fixing a typo is not an event worth keeping.

## Consequences

- The dashboard can add new metrics later without a migration — the history is
  already there.
- A mistaken status change is corrected by appending another change, so the
  timeline shows it. That is the intended behaviour.
- If folding every event on each read ever becomes slow, add a derived cache
  table that can be rebuilt from `events`; the log remains the truth.

## Amendment · 2026-09-29: libSQL instead of `node:sqlite`

To host the tracker (ADR 0005), the engine moved from `node:sqlite` to the
libSQL client (`@libsql/client`). It speaks the same SQLite dialect and opens a
local file, `:memory:`, or a hosted Turso database, so there is one code path
for laptop and cloud. The schema, the append-only triggers, and everything
above are unchanged. What changed:

- Database calls are async, so `Offerdesk` and its shells are async. Reads load
  a workspace's events, applications and contacts once per call and fold in
  memory, which keeps the number of round trips to a hosted database fixed.
- Applied migrations are rows in `schema_migrations`. Hosted SQLite can read
  `PRAGMA user_version` but not set it. A database from before this change has
  its `user_version` carried over the first time it is opened.
