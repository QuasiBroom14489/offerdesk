# 0007 — Google connector (Drive + Sheets)

**Status:** accepted · 2026-09-30

## Context

Saved views should live as Google Sheets that stay current, and resumes and
cover letters already sit in Google Drive. The original plan (ADR 0002) assumed
a laptop: a loopback OAuth flow for an installed app, with tokens in the macOS
Keychain. The real tracker is now hosted on Vercel (ADR 0005), where there is
no Keychain and no loopback, and the MCP server on a laptop reads the same
hosted database. Both need the same Google tokens.

## Decision

- **Web-server OAuth** (authorization code + PKCE, `access_type=offline`) run
  by the `/api` server, so one flow serves the hosted app and local mode
  (`localhost` redirect URIs). The client ID and secret come from the
  environment (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), never config. The
  OAuth `state` is signed and names the workspace that started the flow; the
  callback rejects a state from any other signed-in workspace.
- **`drive.file` only.** It covers the spreadsheets and folder the app creates,
  and files the user picks in the **Google Picker**, which grants access one
  file at a time. It is a non-sensitive scope, so the OAuth app is published
  without Google verification, and refresh tokens don't expire after 7 days as
  they do for apps left in testing. `drive.readonly` (sensitive, broad) is
  deliberately not requested.
- **Encrypted credentials in the database, key in the environment.** This
  amends ADR 0002's "secrets never touch the database". Migration 5 adds a
  `credentials` table holding AES-256-GCM ciphertext, a fresh IV per write,
  and the workspace and provider as associated data, so a row moved to another
  tenant fails to decrypt. The 32-byte key is `OFFERDESK_CREDENTIALS_KEY`, set
  in Vercel (Production and Preview share one database, so they share one key)
  and in `.env.mcp`. `credentialStoreFromEnv` uses it beside a hosted database;
  beside a local database the Keychain or `0600` file remains the store.
- **No Google SDK.** `googleapis` is tens of megabytes in a serverless bundle
  for a handful of REST calls. The connector calls Drive v3, Sheets v4 and the
  token endpoint with `fetch`, injected so tests fake Google entirely. It lives
  in `packages/core/src/connectors/google/`.
- **A pushed view is a full rewrite.** The first push creates a spreadsheet in
  an `OfferDesk/` Drive folder and stores its id in `views.sheet_id`; later
  pushes clear and rewrite the tab. There's no diffing and no drift, and the
  sheet is a projection like every other view. After any change the workspace's
  pushed views are rewritten a few seconds later (`waitUntil` on Vercel), and
  "Push now" is always available.
- **Drive files are snapshotted.** A picked file becomes a new document version
  (source `drive`, with its Drive file id), keeping ADR 0006's immutable
  versions; "Save to Drive" copies a version out.
- Every Google action is started by the user, so the suggestion inbox isn't
  involved.

## Consequences

- Losing `OFFERDESK_CREDENTIALS_KEY` makes stored tokens unreadable. The fix is
  reconnecting Google, and the error says so without echoing the row.
- Anyone with the database and the key has the tokens, but they only reach files
  OfferDesk created or the user picked.
- A public launch keeps these scopes with no security assessment. Gmail
  (restricted) is the connector that will need CASA.
- One Google Cloud project and a Picker API key (restricted by HTTP referrer)
  are one-time setup, documented in the README.
