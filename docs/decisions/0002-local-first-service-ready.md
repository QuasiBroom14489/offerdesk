# 0002 — Local-first, service-ready

**Status:** accepted · 2026-09-29

## Context

OfferDesk starts as one person's tracker running on a laptop, but it may grow
into a hosted service where anyone connects their Google Drive, Gmail, Obsidian
vault or Dropbox. Building the service now would delay every feature that
matters today; ignoring it would bake single-user assumptions into every query.

## Decision

Build for one user, but put the seams where a service would need them.

- **Every row belongs to a workspace.** `companies`, `applications`,
  `contacts`, `events` and `connections` carry `workspace_id` (migration 2).
  `Offerdesk` and `EventLog` take a `workspaceId` and every query filters on it;
  a local install is the single workspace `'local'`. Company names are unique
  per workspace, not globally.
- **Events carry provenance.** `events.source` records who or what wrote the
  fact: `manual`, `vesper`, `gmail`, `obsidian`, `drive`, `demo`. Provenance is
  metadata, so it is a column rather than a payload field, and existing event
  kinds keep their meaning.
- **Connectors are adapters.** Each provider implements `Connector`
  (`check`, `sync`) in `packages/core/src/connectors/`. The core never imports
  a vendor SDK outside a connector.
- **Connections are configuration, not history.** The `connections` table holds
  one row per provider per workspace: status, non-secret config, last sync, last
  error. It is mutable, like entity tables.
- **Secrets never touch the database or git.** A `CredentialStore` holds tokens:
  the macOS Keychain locally (commands piped to `security -i`, so secrets never
  appear in the process list), a `0600` JSON file elsewhere, an in-memory store
  in tests.
- **Suggestions before writes.** A connector that infers facts (Gmail spotting
  a recruiter reply) returns suggestions for the user to confirm; it does not
  append events on its own.

## What a hosted service would add

These are deliberately *not* built yet:

1. A Postgres adapter behind the same queries (SQLite stays the local default).
2. Authentication mapping a signed-in user to a `workspace_id`.
3. An encrypted, server-side `CredentialStore`.
4. A job queue for connector syncs instead of on-demand runs.
5. Google OAuth app verification. `drive.file` is non-sensitive, but
   `drive.readonly` is sensitive and `gmail.readonly` is restricted, which
   requires Google's annual CASA security assessment before public launch.
6. An Obsidian bridge — a vault is a local folder, so a hosted service needs a
   small local sync helper or an Obsidian plugin.

## Consequences

- Isolation is tested: two workspaces in one database never see each other's
  rows (`packages/core/test/workspaces.test.ts`).
- Upgrading an existing v1 database is tested, including the table rebuild that
  changes company uniqueness, with foreign keys verified afterwards.
- Every new table must carry `workspace_id`, and every new query must filter on
  it. This is a house rule in `CLAUDE.md`.
