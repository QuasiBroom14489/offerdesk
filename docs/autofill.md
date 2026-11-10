# Application Autofill Library

Open **Autofill** in the main navigation (G, then F). The library provides searchable, expandable records, individual field copies, Copy Description, Copy All, favorites, recent use and manual ordering. Edit supports all five description categories. Generate missing variants selects sentences from canonical descriptions without introducing claims; existing variants remain intact. Compare canonical and imported descriptions before reusing a tailored answer.

Professional Profile shows canonical fields with per-field source attribution. Source Management accepts selected `.md`, `.pdf`, or selected-source `.json` packages. Inspect the file list before Sync Sources. Accept, reject, or edit each suggestion; choose an explicit merge target for duplicates or create a separate entry for another role/stint. Imported empty fields do not erase confirmed values. Resume evidence is preferred for titles/dates/education, while disagreements remain visible for review. Unknown dates must stay empty; no first/last day of a month is inferred.

## Local read-only import

Build first (`pnpm build`). Configure an explicit professional-note allowlist:

```sh
node scripts/profile-import.mjs \
  --vault '/path/to/your/vault' \
  --resume '/path/to/current-resume.pdf' \
  --note 'Career/Resume bullets.md' \
  --note 'Projects/Project history.md'
```

The adapter saves its selection in gitignored `data/profile-sources.json`. Run `node scripts/profile-import.mjs` again after updates. It uses local `data/offerdesk.db`, independent of hosted environment credentials. The local database workspace is `local`. Use `--db` for another local database or `--config` for another private configuration. Only explicitly named notes are read; nested relative paths work. Symlinks, hidden paths and directory traversal are rejected. Output paths cannot be inside the vault or overwrite the resume. Source files are never modified.

For hosted OfferDesk, add `--export data/profile-import.json` and select that private package in Source Management while signed in. The local script does not transmit anything. The package contains only selected source documents; inspect the selection first. Requests are limited to 4 MB in the web client; split large selections. Do not commit personal files or exports. No external AI API receives this content. References to source files are logical relative paths, not server filesystem links.

## Extraction and synchronization

Markdown supports YAML frontmatter, headings, nested source paths and text normalization of wiki links. It strips code fences, comments and embeds and does not follow links. `private: true` or `autofill: false` opts out. Prose extraction is conservative and selects completed-work assertions in professional sections. Plans, checklists, contact lists and private source categories should not be selected. To import exact structured fields, use this optional frontmatter:

```yaml
application_profile:
  category: Work Experience
  name: Example Company
  fields:
    Company: Example Company
    Job Title: Intern
    Location: ""
    Start Date: ""
    End Date: ""
    Currently Employed: ""
    Description: Built a reporting dashboard.
```

PDFs need an embedded text layer; OCR is outside this version. File hashes and extractor versions skip unchanged work. A changed file supersedes stale pending suggestions and preserves unchanged facts, reviewed history, canonical content and manual variants. Removed source files do not erase history. Facts still need review even when parsing succeeds. Combined employer entries remain separate with shared ambiguous titles, dates and responsibilities withheld until confirmed.

## Implementation map

- `packages/shared/src/profile.ts`: validation, data contracts, copying and extractive variants.
- `packages/core/src/profile/extract.ts`: Markdown/YAML/PDF parsing and normalization.
- `packages/core/src/profile/service.ts`: workspace-scoped persistence, provenance, sync, conflicts and review.
- `packages/core/src/db.ts`: appended migration for source, fact and canonical-entry tables.
- `packages/core/src/offerdesk.ts`, `packages/core/src/index.ts`, `packages/shared/src/index.ts`: service wiring and exports.
- `apps/server/src/app.ts`: authenticated profile endpoints; redacted parser failures.
- `apps/web/src/pages/Autofill.tsx`, `apps/web/src/api.ts`, `apps/web/src/App.tsx`: library, profile, source review, API hooks and navigation.
- `scripts/profile-import.mjs`: configurable local allowlist and private export adapter.
- `packages/core/test/profile.test.ts`, `apps/server/test/profile.test.ts`: extraction, sync, deduplication, conflicts, review, copying and access-control coverage.
- `packages/core/package.json`, `pnpm-lock.yaml`: YAML and PDF parser dependencies.
- `biome.json`: excludes private local data from lint output.
- `docs/decisions/0010-professional-profile.md`: architectural decision and limitations.

Automatic browser form filling, application submission and background synchronization are intentionally outside this version.
