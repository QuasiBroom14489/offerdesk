# OfferDesk

[![CI](https://github.com/QuasiBroom14489/offerdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/QuasiBroom14489/offerdesk/actions/workflows/ci.yml)

A keyboard-first internship application tracker. It keeps every application,
recruiter conversation and resume version in one place, tells you who to
follow up with, and tailors a one-page resume to each posting with Claude.

> 🚧 Under active development — see the roadmap below.

## Why

Recruiting season scatters information across a spreadsheet, an inbox, LinkedIn
and a folder of `resume_final_v3.pdf` files. The questions that matter — *who
went quiet? what is my response rate? which resume did I send them?* — are
questions about **history**, so OfferDesk stores history: every action is an
event in an append-only log, and the dashboard is a set of pure folds over it.

## Architecture

```
apps/web     React dashboard ─┐
apps/server  Fastify REST API ├──▶ packages/core ──▶ SQLite / Turso (append-only events)
apps/mcp     MCP server ──────┘        │
                                       ├──▶ Obsidian vault (one-way mirror)
                                       └──▶ Claude + headless Chrome (resume PDFs)
packages/shared   zod schemas shared by every layer
```

- **Event-sourced core.** Status, follow-ups and stats are derived from the log,
  never stored ([ADR 0001](docs/decisions/0001-sqlite-and-an-event-log.md)).
- **Thin shells.** The API, MCP server and UI hold no business logic, so an AI
  assistant gets exactly the same capabilities as the dashboard
  ([ADR 0003](docs/decisions/0003-mcp-first-integration.md)).
- **Local-first, service-ready.** Every row belongs to a workspace, connectors
  sit behind an interface, and secrets live in the Keychain, never the database
  ([ADR 0002](docs/decisions/0002-local-first-service-ready.md)).
- **Build your own tables.** Pick columns (including derived ones like days
  waiting and response time), filter, sort and save the view. CSV and Excel
  downloads render the same report as the screen, so they always match
  ([ADR 0004](docs/decisions/0004-table-views-and-exports.md)).

## Use it from an AI assistant

OfferDesk ships an MCP server. Register it with Claude Code:

```sh
claude mcp add offerdesk -- node "$PWD/apps/mcp/dist/index.js"
```

Then, looking at a job posting: *"add this to my tracker"*. The assistant reads
the page and calls `capture_posting`, and the posting lands on Home under
**Get started**, deduplicated by URL or company and role. Other tools include
`dashboard`, `follow_ups`, `deadlines`, `list_applications`, `set_status`, and
`run_view` / `export_view` for saved tables (*"who haven't I heard back from?"*).

## Quickstart

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm build

# Try it with fictional data
pnpm seed:demo
pnpm start:demo      # http://localhost:4417

# Or use your own (data/offerdesk.db, gitignored)
pnpm start
```

For UI work, `pnpm dev` runs Vite on :5417 with hot reload, proxying the API.

Press `⌘K` for the command palette, `N` to add an application, and `G` then
`H`/`B`/`A`/`P` to move between pages. The full keyboard map and design notes
are in [docs/design.md](docs/design.md).

## Hosted

The same code runs on Vercel with a hosted Turso database and Clerk sign-in:
each signed-in user is their own workspace. Locally, with none of that
configured, it stays a single-user app with no account
([ADR 0005](docs/decisions/0005-hosted-on-vercel.md)).

```sh
vercel link && vercel integration add turso && vercel integration add clerk
node --env-file=.env.local apps/server/dist/cli.js migrate
vercel deploy
```

## Development

```sh
pnpm test        # vitest: derivations, service, API and MCP tests
pnpm typecheck
pnpm lint        # biome
```

## Roadmap

- [x] Event-sourced core: applications, contacts, outreach, follow-ups, stats
- [x] REST API + dashboard: home, board, table, application and person pages
- [x] Minimal light UI with traffic-light signals
- [x] Workspaces, connections and credential stores (service-ready seams)
- [x] MCP server; capture a posting from the screen, flagged "get started"
- [x] Table builder, saved views, CSV / Excel export
- [ ] Google Sheets push (with the Google connector)
- [ ] Documents library and Google Drive connector
- [ ] Resume studio: bullet bank, Claude tailoring, one-page PDF check
- [ ] Obsidian vault mirror and importer
- [ ] Gmail connector: suggested replies to confirm
- [ ] Demo GIF, end-to-end tests

## License

MIT
