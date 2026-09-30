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
- **A pushed view is a full rewrite, on demand.** The first push creates a
  spreadsheet in an `OfferDesk/` Drive folder; later pushes rewrite its
  `OfferDesk` tab in one `batchUpdate`: the grid is resized to fit, cleared,
  and written with typed cells (real dates and numbers, links, status tints
  matching the Excel export). Text always goes in as a literal string, never a
  formula. Other tabs are the user's and are never touched. A trashed or
  deleted sheet is recreated on the next push.
- **No auto-push** *(amended 2026-09-30, before shipping)*. The plan was to
  rewrite every pushed view a few seconds after each change. Instead a sheet is
  a snapshot: the export menu shows "updated 3 h ago · 4 changes since" (events
  since the push) and an "Update now" button, and the MCP tool
  `push_view_to_sheet` does the same for Vesper. That means no background
  work, no Google API calls per edit, and nothing to debounce on serverless.
- **`view_sheets` (migration 6)** links a view id to its spreadsheet, so
  presets, which have no `views` row, can be pushed. The `views.sheet_id`
  column reserved in migration 3 stays unused. Deleting a saved view drops the
  link; the spreadsheet stays in Drive.
- **Drive files are snapshotted.** A picked file is downloaded server side
  (Google Docs, Sheets and Slides export as PDF) and becomes a document
  version, keeping ADR 0006's immutable versions. Migration 7 adds `source`
  (`upload` or `drive`) and `source_ref` (the Drive file id) to versions, so
  importing the same file again adds a version only if its bytes changed, and
  says "unchanged" otherwise. The kind is guessed from the name ("…Resume…"
  becomes a resume) and can be changed. The 4 MB library limit still applies.
- **Save to Drive is idempotent.** A version is uploaded into `OfferDesk/`
  tagged with a Drive `appProperties` entry, `offerdeskVersion = <version id>`.
  Saving again finds that copy instead of making a duplicate, with no table to
  keep in sync.
- **The Picker runs in the browser** with a short-lived access token from
  `/api/connections/google/picker`, the referrer-restricted API key, and the
  project number as app id, which is what grants the picked files to this app.
- Every Google action is started by the user, so the suggestion inbox isn't
  involved.

## Consequences

- Losing `OFFERDESK_CREDENTIALS_KEY` makes stored tokens unreadable. The fix is
  reconnecting Google, and the error says so without echoing the row.
- Anyone with the database and the key has the tokens, but they only reach files
  OfferDesk created or the user picked.
- A public launch keeps these scopes with no security assessment. Gmail
  (restricted) is the connector that will need CASA.
- Google works on the production domain and on `localhost` (ports 4417 and
  5417), the redirect URIs registered on the OAuth client. Preview deployments
  get their own URLs, so Google is unavailable there by design.
- `OFFERDESK_PUBLIC_URL` pins the origin used for redirect URIs; otherwise it
  comes from the forwarded host (Vercel) or the Host header (local).
- One Google Cloud project and a Picker API key (restricted by HTTP referrer)
  are one-time setup, documented in the README.
