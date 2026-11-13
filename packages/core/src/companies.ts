import { randomUUID } from 'node:crypto';
import {
  ACTIVE_STATUSES,
  type Application,
  type CompanyContext,
  type CompanyDetail,
  type CompanyField,
  type CompanyHighlight,
  CompanyProfilePatch,
  type CompanySummary,
  type Contact,
  type Fit,
  NewCompany,
  type ProfileEntry,
  STATUSES,
  type Status,
} from '@offerdesk/shared';
import type { Db } from './db.js';
import { NotFoundError } from './errors.js';

interface CompanyRow {
  id: string;
  name: string;
  website: string | null;
  created_at: number;
  target: number;
  fit: string | null;
  fields: string;
  industry: string | null;
  careers_url: string | null;
  why: string | null;
  angle: string | null;
  highlights: string;
  context: string | null;
  updated_at: number | null;
}

/** What `Companies` needs from the rest of the app: the derived applications and people. */
export interface CompanyFacts {
  applications: Application[];
  contacts: Contact[];
}

/**
 * Companies and the research on them (ADR 0011). A company row is shared with
 * applications and contacts, which create it by name; the research columns are
 * mutable notes, edited here only.
 */
export class Companies {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly now: () => number,
  ) {}

  /** Find a company by name (case-insensitive) or create it. */
  async idFor(name: string, at: number): Promise<string> {
    const trimmed = name.trim();
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM companies WHERE workspace_id = ? AND name = ?',
      this.workspaceId,
      trimmed,
    );
    if (existing) return existing.id;
    const id = randomUUID();
    await this.db.run(
      'INSERT INTO companies (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)',
      id,
      this.workspaceId,
      trimmed,
      at,
    );
    return id;
  }

  async list(facts: CompanyFacts): Promise<CompanySummary[]> {
    const rows = await this.db.all<CompanyRow>(
      'SELECT * FROM companies WHERE workspace_id = ? ORDER BY name',
      this.workspaceId,
    );
    return rows.map((r) => summarize(r, facts));
  }

  async get(idOrName: string, facts: CompanyFacts): Promise<CompanyDetail> {
    const row = await this.row(idOrName);
    return {
      ...summarize(row, facts),
      applications: facts.applications.filter((a) => a.companyId === row.id),
      contacts: facts.contacts.filter((c) => c.companyId === row.id),
    };
  }

  /** Add a company to the target list, or update the one with that name. */
  async add(input: NewCompany): Promise<string> {
    const { name, ...patch } = NewCompany.parse(input);
    const id = await this.idFor(name, this.now());
    await this.update(id, { target: true, ...patch });
    return id;
  }

  async update(idOrName: string, input: CompanyProfilePatch): Promise<string> {
    const row = await this.row(idOrName);
    const patch = CompanyProfilePatch.parse(input);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
    if (patch.target !== undefined) set('target', patch.target ? 1 : 0);
    if (patch.fit !== undefined) set('fit', patch.fit ?? null);
    if (patch.fields !== undefined) set('fields', JSON.stringify([...new Set(patch.fields)]));
    if (patch.industry !== undefined) set('industry', blank(patch.industry));
    if (patch.website !== undefined) set('website', blank(patch.website));
    if (patch.careersUrl !== undefined) set('careers_url', blank(patch.careersUrl));
    if (patch.why !== undefined) set('why', blank(patch.why));
    if (patch.angle !== undefined) set('angle', blank(patch.angle));
    if (patch.highlights !== undefined)
      set('highlights', JSON.stringify([...new Set(patch.highlights)]));
    if (patch.context !== undefined) set('context', blank(patch.context));
    if (sets.length > 0) {
      set('updated_at', this.now());
      await this.db.run(
        `UPDATE companies SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
        ...values,
        row.id,
        this.workspaceId,
      );
    }
    return row.id;
  }

  /** The detail plus each highlight resolved against the profile, for applying in one read. */
  async context(
    idOrName: string,
    facts: CompanyFacts,
    entries: ProfileEntry[],
  ): Promise<CompanyContext> {
    const detail = await this.get(idOrName, facts);
    const variant = detail.fields[0];
    return {
      ...detail,
      highlightDetails: detail.highlights.map((h) => resolveHighlight(h, entries, variant)),
    };
  }

  /** By id, else by name without case. */
  private async row(idOrName: string): Promise<CompanyRow> {
    const row =
      (await this.db.get<CompanyRow>(
        'SELECT * FROM companies WHERE workspace_id = ? AND id = ?',
        this.workspaceId,
        idOrName,
      )) ??
      (await this.db.get<CompanyRow>(
        'SELECT * FROM companies WHERE workspace_id = ? AND name = ?',
        this.workspaceId,
        idOrName.trim(),
      ));
    if (!row) throw new NotFoundError('company', idOrName);
    return row;
  }
}

function summarize(row: CompanyRow, { applications, contacts }: CompanyFacts): CompanySummary {
  const apps = applications.filter((a) => a.companyId === row.id);
  const people = contacts.filter((c) => c.companyId === row.id);
  const open = apps.filter((a) => (ACTIVE_STATUSES as readonly Status[]).includes(a.status));
  const touched = [
    ...apps.map((a) => a.lastActivityAt),
    ...people.map((c) => c.lastTouchedAt).filter((t): t is number => t !== null),
  ];
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    target: row.target === 1,
    fit: (row.fit as Fit | null) ?? null,
    fields: parseList(row.fields) as CompanyField[],
    industry: row.industry,
    website: row.website,
    careersUrl: row.careers_url,
    why: row.why,
    angle: row.angle,
    highlights: parseList(row.highlights),
    context: row.context,
    updatedAt: row.updated_at,
    applicationCount: apps.length,
    openCount: open.length,
    bestStatus: bestStatus(apps),
    contactCount: people.length,
    lastActivityAt: touched.length ? Math.max(...touched) : null,
  };
}

/** Furthest open stage wins; with nothing open, the latest closed outcome. */
function bestStatus(apps: Application[]): Status | null {
  if (apps.length === 0) return null;
  const open = apps.filter((a) => (ACTIVE_STATUSES as readonly Status[]).includes(a.status));
  if (open.length > 0)
    return open.reduce((b, a) => (STATUSES.indexOf(a.status) > STATUSES.indexOf(b.status) ? a : b))
      .status;
  return apps.reduce((b, a) => (a.lastActivityAt > b.lastActivityAt ? a : b)).status;
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** "Nudge study" finds the profile entry named "Nudge study" or "Nudge study (Vesper)". */
function resolveHighlight(
  name: string,
  entries: ProfileEntry[],
  variant: CompanyField | undefined,
): CompanyHighlight {
  const n = name.toLowerCase();
  const entry =
    entries.find((e) => e.name.toLowerCase() === n) ??
    entries.find(
      (e) =>
        e.name.toLowerCase().includes(n) ||
        (e.name.length >= 4 && n.includes(e.name.toLowerCase())),
    );
  if (!entry) return { name, entryId: null, category: null, description: null };
  const description =
    (variant && entry.variants[variant]) ||
    entry.variants.General ||
    entry.fields.Description ||
    null;
  return {
    name,
    entryId: entry.id,
    category: entry.category,
    description: description?.trim() || null,
  };
}
