# 0011 — Companies: a target list with research

Status: accepted (2026-11-13)

## Context

Applying well means knowing, per company, why it's a good bet for *you* and what
to say. That knowledge lived in scattered notes (a "target companies" list in
the owner's vault that never got filled), so each application started from
scratch. The best chances are the fields where the applicant already has
experience, so relevance has to be judged against their own work, not the
company's prestige.

## Decision

- The existing `companies` row (created by name when an application or contact
  is added) gains research columns (migration v10): `target`, `fit`
  (`strong` = best chance, `good`, `stretch`, shown as green/yellow/red with a
  word), `fields` (the profile's description variants: Software Engineering,
  Data Analytics, Finance / Business, Product Management), `industry`,
  `careers_url`, `why` (relevance tied to the applicant's experience), `angle`
  (how to pitch, which variant to use), `highlights` (projects or roles to cite,
  by name), `context` (business, team, programs, timeline, interview process)
  and `updated_at`.
- These are mutable notes, like contact details, so they are columns, not
  events. Nothing about an application's history changes; progress at a company
  (`applicationCount`, `openCount`, `bestStatus`, `contactCount`,
  `lastActivityAt`) is derived from the existing applications and people.
- A company is on the **target list** only when the user (or an assistant on
  their behalf) saves it there. Companies known only from an application are
  listed under "Everyone".
- **Highlights resolve against the reviewed profile (ADR 0010)**: by exact name,
  then by containment. The description shown is the variant for the company's
  first field, else General, else the entry's Description. No model writes it.
- Interfaces: `GET/POST /api/companies`, `GET/PATCH /api/companies/:id` (id or
  name); MCP `list_companies` and `company_context` (read-only, auto-approvable)
  and `save_company` (changes data, so it asks). The dashboard gets a Companies
  page, a company page with inline editing, and a "Why <company>" card on every
  application.

## Consequences

- An assistant drafting a cover letter or an answer for a company reads one
  tool and gets the reasons, the pitch and the exact project text.
- Research isn't versioned; an overwrite loses the old text. Acceptable for
  notes; revisit if research ever needs an audit trail.
- Company names stay unique per workspace without case, so "Acme" and "acme"
  are one company everywhere.
