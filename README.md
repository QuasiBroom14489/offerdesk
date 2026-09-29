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
apps/server  Fastify REST API ├──▶ packages/core ──▶ SQLite (append-only events)
apps/mcp     MCP server ──────┘        │
                                       ├──▶ Obsidian vault (one-way mirror)
                                       └──▶ Claude + headless Chrome (resume PDFs)
packages/shared   zod schemas shared by every layer
```

- **Event-sourced core.** Status, follow-ups and stats are derived from the log,
  never stored ([ADR 0001](docs/decisions/0001-sqlite-and-an-event-log.md)).
- **Thin shells.** The API, MCP server and UI hold no business logic, so an AI
  assistant gets exactly the same capabilities as the dashboard.

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

## Development

```sh
pnpm test        # vitest: pure derivations, service, and API tests
pnpm typecheck
pnpm lint        # biome
```

## Roadmap

- [x] Event-sourced core: applications, contacts, outreach, follow-ups, stats
- [x] REST API + dashboard: home, board, table, application and person pages
- [ ] Documents library
- [ ] Resume studio: bullet bank, Claude tailoring, one-page PDF check
- [ ] Obsidian vault mirror and importer
- [ ] MCP server for Claude Code and other assistants
- [ ] Demo GIF, end-to-end tests

## License

MIT
