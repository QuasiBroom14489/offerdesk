# 0004 — Table views are data; exports render the same report

**Status:** accepted · 2026-09-29

## Context

Recruiting questions are usually table-shaped: *who haven't I heard back
from, and for how long? how fast do companies reply?* People answer them in a
spreadsheet. OfferDesk should let you build that table in a few clicks, keep
it, and take it elsewhere (CSV, Excel, and later a live Google Sheet) without
the copy ever disagreeing with the dashboard.

## Decision

- **A view is a `ViewSpec`: columns, filters, sort and an optional search.** It
  is plain JSON validated by zod in `packages/shared`, so the API, MCP server
  and UI all accept the same thing, and bad filters (e.g. "Status is more than")
  are rejected with a 400 instead of silently returning nothing.
- **Column metadata is shared; column logic is core.** `REPORT_COLUMNS` (id,
  label, type, unit) lives in shared so every client can draw the pickers.
  How a value is computed lives in `core/src/reports/columns.ts`. Derived
  columns (days waiting, response time, last contact, next interview) are folds
  over the event log, like status. Nothing new is stored.
- **Column ids are permanent**, like event kinds. Saved specs refer to them, so
  a column can be relabeled but never removed or renamed.
- **Saved views are configuration, not history.** They sit in a mutable `views`
  table (migration 3) scoped by `workspace_id`, like `connections`, not in the
  event log. Presets ("Everything", "Waiting to hear", "Response times", "Due
  this month") ship in code with stable ids, so they improve with the app and
  cannot be edited or deleted. Saving a changed preset makes a copy.
- **Date filters can be relative** (`today`, `today+30`), resolved when the view
  runs, so a saved "due this month" view stays current.
- **One report, many renderings.** `Offerdesk.report()` produces rows and column
  metadata; the table, the CSV writer, the `.xlsx` writer and the MCP
  `run_view`/`export_view` tools all render that one object. A download
  therefore matches the screen row for row, and tests assert it.
- **Exports:** CSV is RFC 4180 with a UTF-8 BOM (for Excel), and text cells that
  start with `= + - @` are prefixed with `'` so captured text can't run as a
  formula. `.xlsx` uses `exceljs`, with real date and number cells, a frozen
  header with filters, hyperlinks, and status cells tinted with the dashboard's
  signal colors.
- **Google Sheets push comes with the Google connector.** `views.sheet_id` is
  reserved for it: a view creates its sheet once, then rewrites it on demand.

## Consequences

- Adding a column is two edits: its metadata in shared and its getter in core.
  The UI, exports and MCP pick it up with no other change.
- Reports fold the whole log for each request. That's fine for one person's
  hundreds of applications. A hosted service would cache per workspace or
  project the derived columns into a read table.
