# 0006 — Documents library

**Status:** accepted · 2026-09-30

## Context

Resumes, cover letters, transcripts and writing samples get revised all
season, and each application went out with one particular revision. The
original plan kept files under `data/files/<sha256>`, but the real tracker is
now hosted (ADR 0005), and a Vercel function has no disk that outlives the
request. Files need a home that works on a laptop and on Vercel, and that the
later Google Drive import and the resume studio can both write into.

Options considered for hosted bytes:

- **Blobs in Turso.** One store and one backup, but every document read pulls
  megabytes through the database, and file bytes crowd the rows that every
  dashboard read scans.
- **Google Drive.** Where many files already live, but it would make a Google
  account a prerequisite for uploading anything, and Drive is a connector
  (sync, suggest), not the system of record.
- **Vercel Blob, private store.** First-party on the platform the app already
  runs on, provisioned from the dashboard, authenticated with the project's
  OIDC credentials (no long-lived token to manage), and private: bytes are
  only reachable through our own authenticated route.

## Decision

- **Metadata in the database, bytes in a `FileStore`.** `documents` holds a
  named document (e.g. "Resume — data science") and its kind; `document_versions`
  holds each upload: number, filename, content type, size and SHA-256 (migration 4).
  Both tables carry `workspace_id`. Versions are immutable and enforced by
  triggers like the event log; a new upload adds version *n + 1*.
- **Content-addressed storage.** The store key is `<workspace>/<sha256>`, so
  uploading identical bytes twice stores them once, and a key never changes
  meaning. The workspace prefix keeps one tenant's hash lookups from ever
  confirming another tenant's file.
- **Three stores behind one interface**: `DiskFileStore` (`data/files/`,
  local default), `MemoryFileStore` (tests), and `VercelBlobFileStore`
  (`connectors/vercel-blob`, private access), chosen when `BLOB_STORE_ID` or
  `BLOB_READ_WRITE_TOKEN` is set. Disk is used only beside a local database:
  on Vercel, or on a laptop pointed at the hosted database (the MCP server),
  there is no store without Blob, and the documents API answers 503 rather
  than writing bytes the other side can't read.
- **Attaching is an event.** `document.attached` already existed; it gains an
  optional `versionId`, pinning which revision went to which application
  (adding an optional field keeps every existing event's meaning). Unlinking is
  a new kind, `document.detached`. Which documents an application has is folded
  from these, like status.
- **Uploads go through the API**, capped at 4 MB. Vercel functions accept
  bodies up to 4.5 MB; resumes and cover letters are well under that. Larger
  files would need client uploads straight to Blob, deliberately not built yet.
- **Documents are archived, not deleted.** An archived document leaves the
  library list but keeps its versions, because past events still point at them.

## Consequences

- `@vercel/blob` is the one vendor SDK in core that isn't a sync connector; it
  still lives under `connectors/`, per the house rule.
- Provisioning a private Blob store and connecting it to the project is a
  one-time dashboard step before documents work on the hosted app.
- Local and hosted files are separate worlds, like local and hosted databases.
- The resume studio will write generated PDFs as new versions of a document,
  and the Drive connector will import files the same way (source `drive`).
