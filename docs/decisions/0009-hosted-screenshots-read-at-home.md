# 0009 — Hosted screenshots, read on the owner's computer

**Status:** accepted · 2026-10-15 · amends 0008

## Context

ADR 0008 reads screenshots with the Claude Agent SDK on the user's Claude
subscription, which only works where the server runs on a computer signed in
to Claude Code. The hosted dashboard (ADR 0005) is where the tracker actually
lives, and it couldn't read screenshots at all. Reading them on Vercel would
need an API key, which means paying per read on top of the subscription.

## Decision

- **The hosted app queues; the owner's computer reads.** With a file store
  and no reader in the process (Vercel), `POST /api/capture/screenshots`
  stores the images in the FileStore (`<workspace>/screenshots/<id>-<n>`,
  in the private Blob store) and a `screenshot_reads` row (migration 8), and
  answers **202** with the reading's id. The dashboard polls
  `GET /api/capture/screenshots/:id` until it's `done` or `failed`, then
  fills in the form as before. A server that can read (`here`) still answers
  200 with the result in the same `ScreenshotRead` shape.
- **The reader is a CLI loop, not a server.** `offerdesk read-screenshots`
  (`pnpm reader`) opens the hosted database with the MCP's `.env.mcp`, so it
  works on the owner's workspace and nobody else's. Every 2 seconds it claims
  the oldest waiting reading, reads it with `ClaudeCodePostingReader` and
  records the draft. It reaches out to Turso and Blob; nothing has to reach
  in, so there's no port, tunnel or webhook. `scripts/install-reader.sh`
  makes it a launchd agent that starts at login.
- **Claims are safe and self-healing.** A claim is a conditional update, so
  two readers can't take the same reading. A claim older than 2 minutes is
  presumed dead and taken again; the second time, the reading fails instead
  of wedging the queue.
- **The queue is not history.** Rows change status and are purged a day after
  they're created; images are deleted as soon as a reading finishes or is
  cancelled (closing the dialog cancels). What's kept is what was kept
  before: the `posting.captured` event when the user saves.
- **The dashboard says whether the reader is running.** The reader checks in
  every 30 seconds (`screenshot_readers`); a waiting reading reports when it
  last did, so the dialog can say "start `pnpm reader`" instead of spinning.
- `/api/health`'s `screenshots` changes from a boolean to `'here' | 'queue' |
  null`. `OFFERDESK_SCREENSHOTS=off` now means "don't read in this process":
  with a file store, readings queue.

## Consequences

- Hosted reads stay on the subscription, at no API cost, but only while the
  owner's computer is awake and the reader is running. Otherwise they wait,
  for up to a day.
- A reading takes the reader's ~5 seconds plus up to 2 seconds of polling on
  each side.
- An idle reader polls Turso every 2 seconds: about 43,000 small indexed
  reads a day, well inside the free tier.
- For a multi-user service each user would run their own reader, or the
  service would add an API-key `PostingReader` behind the same interface.
