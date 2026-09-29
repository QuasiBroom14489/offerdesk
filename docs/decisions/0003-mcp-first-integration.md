# 0003 — Assistants integrate through MCP

**Status:** accepted · 2026-09-29

## Context

OfferDesk should be usable from an AI assistant as naturally as from the
dashboard: "add this posting to my tracker", "who do I need to follow up with?".
The first client is Vesper, a personal assistant daemon that already runs the
Claude Agent SDK, can see the screen, and loads MCP servers from config. Claude
Code is the second.

## Decision

- `apps/mcp` is a stdio MCP server over the same `Offerdesk` service as the
  HTTP API. Like the API it is a shell: parse, call core, format. Both
  processes open the same SQLite file (WAL plus a 5 s busy timeout).
- Tool names are snake_case (`capture_posting`), because Claude tool names allow
  only `[a-zA-Z0-9_-]`. Clients namespace them, e.g.
  `mcp__offerdesk__capture_posting`.
- Every result leads with one plain sentence a voice assistant can read aloud,
  followed by JSON. Failures are tool errors (`isError`), never exceptions, so
  the model can recover and tell the user what went wrong.
- Tools carry MCP annotations. `AUTO_APPROVABLE_TOOLS` names the ones that only
  read or only add (`dashboard`, `list_applications`, `get_application`,
  `follow_ups`, `deadlines`, `capture_posting`); clients may run those without
  asking. Status changes, flags, notes and outreach are left to the client's
  approval policy.
- **Screen capture is the client's job, not OfferDesk's.** Vesper looks at the
  screen and extracts the posting; OfferDesk only receives structured fields.
  `capture_posting` requires company and role, tells the model to leave the rest
  out rather than guess, dedupes by URL or company+role, and flags the result
  "get started". This keeps OfferDesk free of screenshots and vision models, and
  lets any client (a browser extension, a phone share sheet) capture the same way.

## Consequences

- Anything the dashboard can do, an assistant can do, with the same validation.
- A capture from Vesper is visible as such: `events.source = 'vesper'`, shown as
  "added by Vesper" on Home.
