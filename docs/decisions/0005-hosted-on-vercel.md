# 0005 — Hosted on Vercel with Turso and Clerk

**Status:** accepted · 2026-09-29

## Context

OfferDesk was a laptop app. Its owner wants the real tracker available from
any device, with the hosted copy as the one source of truth, and Vesper's
screen captures landing in it too. ADR 0002 listed what hosting would add; this
records how it was done.

## Decision

- **Turso (hosted SQLite) instead of Postgres.** The schema, migrations and
  append-only triggers carry over unchanged, and one libSQL code path serves a
  local file, `:memory:` tests, and the hosted database (ADR 0001 amendment).
  A hosted URL uses libSQL's fetch-only client; the native SQLite binding is
  loaded only for local files.
- **Clerk user = workspace.** The API resolves the caller's workspace once per
  request and scopes the service to it (`Offerdesk.forWorkspace`). Everything
  but `/api/health` needs a session. Sign-ups are restricted in the Clerk
  dashboard. With no Clerk keys, the app is the single local workspace with no
  sign-in, so a fresh clone still runs with no accounts.
- **Vercel Services, one project.** `web` is the Vite build (SPA fallback to
  `index.html`); `api` is the Fastify app behind a plain Node handler
  (`apps/server/src/server.ts`), routed at `/api/*`. They deploy and roll back
  together.
- **Config comes from the Marketplace integrations**, never from files:
  `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CLERK_SECRET_KEY`, and the
  publishable key (which the Clerk integration names
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; both the server and the Vite build fall
  back to that name).
- **Schema changes are applied deliberately** with `offerdesk migrate` against
  the hosted URL before deploying code that needs them. Opening the database
  also migrates, as a backstop.

## Consequences

- Preview and production deployments share one database. Fine for one person;
  a real service would give previews their own branch database.
- The Clerk instance is a development instance, since a production instance
  needs a custom domain. Moving to one is a key swap, not a code change.
- Still local-only: the Obsidian mirror (a vault is a local folder) and the
  Keychain credential store. A hosted credential store arrives with the Google
  connector.
- Vesper reaches the hosted database directly with its own token and the
  owner's workspace id. A public service would instead expose a remote MCP
  endpoint behind OAuth.

## Deployment notes (learned the hard way)

- Don't override `installCommand` for a service in this pnpm workspace: Vercel
  installs the workspace correctly from the service root, and a `cd ../..`
  install left the function unable to start (`INTERNAL_FUNCTION_INVOCATION_FAILED`
  after 60 s, no logs).
- Build only the workspace packages a service depends on
  (`pnpm --filter <service>^... build`); Vercel bundles the service's own
  TypeScript.
- `.vercelignore` keeps local `dist/`, databases and `.env*` out of uploads.
