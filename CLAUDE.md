# OfferDesk — house rules

- **Business logic lives in `packages/core`.** `apps/server`, `apps/mcp` and
  `apps/web` are shells: they validate input, call `Offerdesk`, render output.
- **Events are append-only** (enforced by triggers). Never add an UPDATE/DELETE
  on `events`; never change an existing event kind's meaning — add a new kind.
- **Status is derived** by `foldApplication`. Don't add a status column.
- **Column ids in `REPORT_COLUMNS` are permanent** (saved views refer to them):
  relabel freely, never rename or remove (ADR 0004).
- **Every table carries `workspace_id` and every query filters on it** (ADR
  0002). Add new migrations to the end of `MIGRATIONS` in `db.ts`; never edit a
  shipped one.
- **Vendor SDKs only inside `packages/core/src/connectors/<provider>`.** Secrets
  go through a `CredentialStore`, never the database, config or logs.
- **Connectors suggest, users confirm.** Anything inferred (e.g. a Gmail reply)
  becomes a suggestion, not an event, until the user accepts it.
- **No personal data in the repo.** `data/`, `config.toml`, `.env*` and PDFs are
  gitignored. Screenshots and fixtures use `pnpm seed:demo` fictional data only.
- Secrets come from the environment (`ANTHROPIC_API_KEY`), never from config.
- The database is the libSQL client (`@libsql/client`) behind `Db` in `db.ts`:
  no ORM, no other driver. Every call is async (ADR 0001 amendment).
- Tests run against `src/` via vitest aliases; `pnpm build` before `pnpm typecheck`.
- Conventional commits. Record structural decisions as ADRs in `docs/decisions/`.
