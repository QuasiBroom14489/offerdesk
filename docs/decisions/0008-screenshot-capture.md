# 0008 — Capture a posting from screenshots

**Status:** accepted · 2026-10-15

## Context

The only way to add a posting without typing it in was asking an assistant
(Vesper or Claude Code) to read the screen and call `capture_posting` over MCP
(ADR 0003). That needs the assistant running on the same machine. The web
dashboard, including the hosted one (ADR 0005), should be able to do the same
from a screenshot: paste it, check the fields, add it.

## Decision

- **Read on the server with Claude.** `POST /api/capture/screenshots` takes 1–5
  images (base64 JSON) and returns a `PostingDraft` plus `duplicateOf`, the
  application it already matches. It **writes nothing**. The dialog fills its
  fields from the draft, and the user saves with the existing `/api/capture`
  (`capturedBy: 'manual'`, since a person confirmed every field). This is
  "connectors suggest, users confirm".
- **On the Claude subscription, not an API key.** `ClaudeCodePostingReader`
  (in `connectors/anthropic`, the only place the Claude Agent SDK is imported)
  runs a one-shot Agent SDK query signed in with the Claude Code login already
  on the machine. It has no tools, loads no settings, MCP servers or
  CLAUDE.md, and keeps no transcript. Any `ANTHROPIC_API_KEY` is removed from
  the child's environment so it can't silently switch billing to the API. The
  query sends all images at once, with today's date so a yearless deadline
  resolves, and asks for a JSON-schema output so the reply is always the
  expected shape. Fields that fail the tracker's own validation (a bad date or
  URL) are dropped, not guessed. Tests inject a fake `PostingReader`.
- **Local only.** The SDK runs a native Claude Code binary (about 240 MB),
  which doesn't fit a Vercel function, and a personal subscription belongs on
  the user's own computer. The reader is on unless `VERCEL` is set or
  `OFFERDESK_SCREENSHOTS=off`. Without it, `/api/health` reports
  `screenshots: false`, the drop zone is hidden and the route answers 503, as
  with file storage (ADR 0006). `pnpm start:hosted` serves the dashboard
  locally against the hosted database (the MCP's `.env.mcp`), so a local
  capture lands in the real tracker. The SDK is imported on first use, so
  the hosted function never loads it.
- **Shrink in the browser.** Screenshots are re-encoded as JPEG, at most 1568px
  wide and 4000px tall, with the quality stepped down until the set is under
  4 MB of base64. That keeps them under Vercel's 4.5 MB request limit without
  a Blob round trip.
- **Screenshots are not kept.** The posting text is what later resume tailoring
  needs, and it's stored in the `posting.captured` event as before.

## Consequences

- Each read uses the subscription's usage, not API credits, and takes about
  5 seconds.
- The hosted dashboard can't read screenshots. If that matters later: an API
  key reader behind the same interface, or a local worker that reads queued
  screenshots.
- Posting content is sent to Anthropic. It's what a public posting says, not
  the user's own data.
- The MCP path is unchanged. Both paths end in `capturePosting` and share its
  duplicate check.
