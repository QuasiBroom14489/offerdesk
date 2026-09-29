import { randomUUID } from 'node:crypto';
import {
  type AnyEvent,
  type Application,
  type ApplicationDetail,
  ApplicationPatch,
  CapturePosting,
  type Contact,
  type ContactDetail,
  type Dashboard,
  type EventPayload,
  type EventSource,
  type Flag,
  type FollowUp,
  NewApplication,
  NewContact,
  type Report,
  type Status,
  ViewSpec,
  type ViewSpecInput,
} from '@offerdesk/shared';
import { Connections } from './connectors/connections.js';
import { isoDate } from './dates.js';
import { type Db, openDb, transaction } from './db.js';
import { foldApplication, followUpsDue, groupBy, pipelineStats } from './derive.js';
import { NotFoundError } from './errors.js';
import { EventLog } from './events.js';
import { type RowFacts, rowFacts } from './reports/columns.js';
import { toCsv, toXlsx } from './reports/export.js';
import { DEFAULT_VIEW_ID } from './reports/presets.js';
import { runView } from './reports/run.js';
import { Views } from './reports/views.js';

interface ApplicationRow {
  id: string;
  company_id: string;
  company_name: string;
  role: string;
  posting_url: string | null;
  location: string | null;
  season: string | null;
  deadline: string | null;
  source: string | null;
  created_at: number;
}

interface ContactRow {
  id: string;
  company_id: string | null;
  company_name: string | null;
  name: string;
  title: string | null;
  email: string | null;
  linkedin: string | null;
  how_met: string | null;
  created_at: number;
}

export interface OfferdeskOptions {
  /** Days of silence before something shows up as a follow-up. */
  followUpAfterDays?: number;
  /** Injectable clock, for tests and demo seeding. */
  now?: () => number;
  /** Tenant boundary. A local install is the single workspace 'local' (ADR 0002). */
  workspaceId?: string;
}

/** A saved view by id, an ad-hoc spec, or both (the spec wins; the view names the export). */
export interface ReportInput {
  viewId?: string;
  spec?: ViewSpecInput;
}

/**
 * The application service. The HTTP server, the MCP server and the CLI are all
 * thin shells over this class — nothing that decides or remembers lives in them.
 */
export class Offerdesk {
  readonly events: EventLog;
  readonly connections: Connections;
  readonly views: Views;
  readonly workspaceId: string;
  private readonly followUpAfterDays: number;
  private readonly now: () => number;

  constructor(
    readonly db: Db,
    opts: OfferdeskOptions = {},
  ) {
    this.workspaceId = opts.workspaceId ?? 'local';
    this.followUpAfterDays = opts.followUpAfterDays ?? 7;
    this.now = opts.now ?? Date.now;
    this.events = new EventLog(db, this.workspaceId);
    this.connections = new Connections(db, this.workspaceId, this.now);
    this.views = new Views(db, this.workspaceId, this.now);
  }

  static open(path: string, opts?: OfferdeskOptions): Offerdesk {
    return new Offerdesk(openDb(path), opts);
  }

  close(): void {
    this.db.close();
  }

  // ── companies ────────────────────────────────────────────────────────────

  /** Find a company by name (case-insensitive) or create it. */
  private companyId(name: string, at: number): string {
    const trimmed = name.trim();
    const existing = this.db
      .prepare('SELECT id FROM companies WHERE workspace_id = ? AND name = ?')
      .get(this.workspaceId, trimmed) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO companies (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, this.workspaceId, trimmed, at);
    return id;
  }

  // ── applications ─────────────────────────────────────────────────────────

  addApplication(input: NewApplication, opts: { source?: EventSource } = {}): Application {
    const a = NewApplication.parse(input);
    const at = a.at ?? this.now();
    const id = randomUUID();
    transaction(this.db, () => {
      const companyId = this.companyId(a.company, at);
      this.db
        .prepare(
          `INSERT INTO applications
             (id, workspace_id, company_id, role, posting_url, location, season, deadline, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.workspaceId,
          companyId,
          a.role,
          a.postingUrl ?? null,
          a.location ?? null,
          a.season ?? null,
          a.deadline ?? null,
          a.source ?? null,
          at,
        );
      this.events.append({
        kind: 'application.created',
        applicationId: id,
        payload: { status: a.status },
        ts: at,
        source: opts.source,
      });
    });
    return this.getApplication(id);
  }

  /**
   * Add a posting read off a page — by Vesper looking at the screen, or any
   * other capture. Returns the existing application instead of a duplicate
   * when the posting URL, or the company and role, are already tracked.
   */
  capturePosting(input: CapturePosting): { application: Application; duplicate: boolean } {
    const c = CapturePosting.parse(input);
    const existing = this.findExisting(c.company, c.role, c.postingUrl ?? null);
    if (existing) return { application: existing, duplicate: true };

    const at = this.now();
    const application = transaction(this.db, () => {
      const app = this.addApplication(
        {
          company: c.company,
          role: c.role,
          location: c.location,
          deadline: c.deadline,
          postingUrl: c.postingUrl,
          source: c.source,
          season: c.season,
          at,
        },
        { source: c.capturedBy },
      );
      if (c.postingText || c.pay || c.postingUrl) {
        this.events.append({
          kind: 'posting.captured',
          applicationId: app.id,
          payload: {
            text: c.postingText ?? undefined,
            url: c.postingUrl ?? undefined,
            pay: c.pay ?? undefined,
          },
          ts: at,
          source: c.capturedBy,
        });
      }
      if (c.flagToStart) {
        this.events.append({
          kind: 'application.flagged',
          applicationId: app.id,
          payload: { flag: 'start', reason: c.source ? `Captured from ${c.source}` : undefined },
          ts: at,
          source: c.capturedBy,
        });
      }
      return app;
    });
    return { application: this.getApplication(application.id), duplicate: false };
  }

  flag(id: string, flag: Flag, reason?: string): Application {
    const app = this.getApplication(id);
    if (!app.flags.includes(flag)) {
      this.events.append({
        kind: 'application.flagged',
        applicationId: id,
        payload: { flag, reason },
        ts: this.now(),
      });
    }
    return this.getApplication(id);
  }

  unflag(id: string, flag: Flag): Application {
    const app = this.getApplication(id);
    if (app.flags.includes(flag)) {
      this.events.append({
        kind: 'application.unflagged',
        applicationId: id,
        payload: { flag },
        ts: this.now(),
      });
    }
    return this.getApplication(id);
  }

  /** Flagged "get started": soonest deadline first, undated ones after, newest first. */
  toStart(): Application[] {
    return this.listApplications()
      .filter((a) => a.flags.includes('start'))
      .sort((a, b) => {
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return b.createdAt - a.createdAt;
      });
  }

  private findExisting(company: string, role: string, url: string | null): Application | null {
    const apps = this.listApplications();
    if (url) {
      const key = normalizeUrl(url);
      const byUrl = apps.find((a) => a.postingUrl && normalizeUrl(a.postingUrl) === key);
      if (byUrl) return byUrl;
    }
    const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
    return apps.find((a) => same(a.companyName, company) && same(a.role, role)) ?? null;
  }

  updateApplication(id: string, patch: ApplicationPatch): Application {
    const p = ApplicationPatch.parse(patch);
    const columns: Record<keyof typeof p, string> = {
      role: 'role',
      postingUrl: 'posting_url',
      location: 'location',
      season: 'season',
      deadline: 'deadline',
      source: 'source',
    };
    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, col] of Object.entries(columns) as [keyof typeof p, string][]) {
      if (p[key] === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(p[key] ?? null);
    }
    this.requireApplication(id);
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`)
        .run(...values, id, this.workspaceId);
    }
    return this.getApplication(id);
  }

  listApplications(): Application[] {
    const rows = this.db
      .prepare(`${APPLICATION_SELECT} ORDER BY a.created_at DESC`)
      .all(this.workspaceId) as unknown as ApplicationRow[];
    const byApp = groupBy(this.events.all(), (e) => e.applicationId);
    return rows.map((row) => toApplication(row, byApp.get(row.id) ?? []));
  }

  getApplication(id: string): Application {
    const row = this.requireApplication(id);
    return toApplication(row, this.events.forApplication(id));
  }

  getApplicationDetail(id: string): ApplicationDetail {
    const row = this.requireApplication(id);
    const timeline = this.events.forApplication(id);
    const contactIds = new Set(timeline.map((e) => e.contactId).filter((c): c is string => !!c));
    const companyContacts = this.listContacts().filter(
      (c) => c.companyId === row.company_id || contactIds.has(c.id),
    );
    return { ...toApplication(row, timeline), timeline, contacts: companyContacts };
  }

  setStatus(id: string, to: Status, at?: number): Application {
    const current = this.getApplication(id);
    if (current.status !== to) {
      this.events.append({
        kind: 'status.changed',
        applicationId: id,
        payload: { from: current.status, to },
        ts: at ?? this.now(),
      });
    }
    return this.getApplication(id);
  }

  addNote(applicationId: string, text: string, at?: number): AnyEvent {
    this.requireApplication(applicationId);
    return this.events.append({
      kind: 'note.added',
      applicationId,
      payload: { text },
      ts: at ?? this.now(),
    }) as AnyEvent;
  }

  scheduleInterview(
    applicationId: string,
    payload: EventPayload<'interview.scheduled'>,
    at?: number,
  ): AnyEvent {
    this.requireApplication(applicationId);
    return this.events.append({
      kind: 'interview.scheduled',
      applicationId,
      payload,
      ts: at ?? this.now(),
    }) as AnyEvent;
  }

  /** Applications with a deadline in the next `days` days that are still only saved. */
  upcomingDeadlines(days = 14): Application[] {
    const today = isoDate(this.now());
    const until = isoDate(this.now() + days * 86_400_000);
    return this.listApplications()
      .filter(
        (a) => a.deadline && a.deadline >= today && a.deadline <= until && a.status === 'saved',
      )
      .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
  }

  // ── contacts & outreach ──────────────────────────────────────────────────

  addContact(input: NewContact): Contact {
    const c = NewContact.parse(input);
    const at = this.now();
    const id = randomUUID();
    transaction(this.db, () => {
      const companyId = c.company ? this.companyId(c.company, at) : null;
      this.db
        .prepare(
          `INSERT INTO contacts
             (id, workspace_id, company_id, name, title, email, linkedin, how_met, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.workspaceId,
          companyId,
          c.name,
          c.title ?? null,
          c.email ?? null,
          c.linkedin ?? null,
          c.howMet ?? null,
          at,
        );
    });
    return this.getContact(id);
  }

  listContacts(): Contact[] {
    const rows = this.db
      .prepare(`${CONTACT_SELECT} ORDER BY c.name`)
      .all(this.workspaceId) as unknown as ContactRow[];
    const byContact = groupBy(this.events.all(), (e) => e.contactId);
    return rows.map((row) => toContact(row, byContact.get(row.id) ?? []));
  }

  getContactDetail(id: string): ContactDetail {
    return { ...this.getContact(id), timeline: this.events.forContact(id) };
  }

  getContact(id: string): Contact {
    const row = this.db.prepare(`${CONTACT_SELECT} AND c.id = ?`).get(this.workspaceId, id) as
      | ContactRow
      | undefined;
    if (!row) throw new NotFoundError('contact', id);
    return toContact(row, this.events.forContact(id));
  }

  logOutreach(input: {
    contactId?: string | null;
    applicationId?: string | null;
    channel: EventPayload<'outreach.sent'>['channel'];
    summary?: string;
    at?: number;
  }): AnyEvent {
    this.assertTarget(input);
    return this.events.append({
      kind: 'outreach.sent',
      contactId: input.contactId ?? null,
      applicationId: input.applicationId ?? null,
      payload: { channel: input.channel, summary: input.summary },
      ts: input.at ?? this.now(),
    }) as AnyEvent;
  }

  logResponse(input: {
    contactId?: string | null;
    applicationId?: string | null;
    channel: EventPayload<'response.received'>['channel'];
    summary?: string;
    at?: number;
  }): AnyEvent {
    this.assertTarget(input);
    return this.events.append({
      kind: 'response.received',
      contactId: input.contactId ?? null,
      applicationId: input.applicationId ?? null,
      payload: { channel: input.channel, summary: input.summary },
      ts: input.at ?? this.now(),
    }) as AnyEvent;
  }

  // ── dashboard reads ──────────────────────────────────────────────────────

  followUps(): FollowUp[] {
    return followUpsDue(this.events.all(), { now: this.now(), afterDays: this.followUpAfterDays });
  }

  stats() {
    const byApp = groupBy(this.events.all(), (e) => e.applicationId);
    return pipelineStats([...byApp.values()].map(foldApplication));
  }

  recentActivity(limit = 20): AnyEvent[] {
    return this.events.recent(limit);
  }

  /** Everything the home screen needs, resolved to display names in one call. */
  dashboard(opts: { deadlineDays?: number; recentLimit?: number } = {}): Dashboard {
    const apps = new Map(this.listApplications().map((a) => [a.id, a]));
    const contacts = new Map(this.listContacts().map((c) => [c.id, c]));
    const appRef = (id: string | null) => {
      const a = id ? apps.get(id) : undefined;
      return a ? { id: a.id, label: `${a.companyName} — ${a.role}` } : null;
    };
    const contactRef = (id: string | null) => {
      const c = id ? contacts.get(id) : undefined;
      return c ? { id: c.id, name: c.name, companyName: c.companyName } : null;
    };
    const toStart = this.toStart();
    const flagged = new Set(toStart.map((a) => a.id));
    return {
      stats: this.stats(),
      toStart,
      followUps: this.followUps().map((f) => ({
        ...f,
        application: appRef(f.applicationId),
        contact: contactRef(f.contactId),
      })),
      // Flagged postings already show their deadline under "Get started".
      deadlines: this.upcomingDeadlines(opts.deadlineDays ?? 14).filter((a) => !flagged.has(a.id)),
      recent: this.recentActivity((opts.recentLimit ?? 15) + 10)
        .filter((e, _i, all) => !isCaptureDetail(e, all))
        .slice(0, opts.recentLimit ?? 15)
        .map((event) => {
          const c = contactRef(event.contactId);
          return {
            event,
            application: appRef(event.applicationId),
            contact: c ? { id: c.id, name: c.name } : null,
          };
        }),
    };
  }

  // ── reports & exports ────────────────────────────────────────────────────

  /** Rows for a table view. Exports render this same object, so they match the screen. */
  report(input: ReportInput = {}): Report {
    const view =
      input.viewId || !input.spec ? this.views.get(input.viewId ?? DEFAULT_VIEW_ID) : null;
    const spec = input.spec ? ViewSpec.parse(input.spec) : (view as NonNullable<typeof view>).spec;
    const now = this.now();
    const { columns, rows } = runView(spec, this.reportFacts(now), now);
    return {
      view: view ? { id: view.id, name: view.name, builtIn: view.builtIn } : null,
      spec,
      columns,
      rows,
      generatedAt: now,
    };
  }

  exportCsv(input: ReportInput = {}): string {
    return toCsv(this.report(input));
  }

  exportXlsx(input: ReportInput = {}): Promise<Buffer> {
    return toXlsx(this.report(input));
  }

  private reportFacts(now: number): RowFacts[] {
    const events = this.events.all();
    const byApp = groupBy(events, (e) => e.applicationId);
    const byContact = groupBy(events, (e) => e.contactId);
    const contacts = this.listContacts();
    return this.listApplications().map((app) => {
      const evs = byApp.get(app.id) ?? [];
      // Same people as the application page: everyone at the company, plus anyone it mentions.
      const linked = new Set(evs.map((e) => e.contactId));
      const people = contacts.filter((c) => c.companyId === app.companyId || linked.has(c.id));
      const peopleEvents = people.flatMap((p) => byContact.get(p.id) ?? []);
      return rowFacts(app, evs, people, peopleEvents, now);
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private requireApplication(id: string): ApplicationRow {
    const row = this.db.prepare(`${APPLICATION_SELECT} AND a.id = ?`).get(this.workspaceId, id) as
      | ApplicationRow
      | undefined;
    if (!row) throw new NotFoundError('application', id);
    return row;
  }

  private assertTarget(input: { contactId?: string | null; applicationId?: string | null }): void {
    if (!input.contactId && !input.applicationId) {
      throw new Error('outreach and responses need a contactId, an applicationId, or both');
    }
    if (input.contactId) this.getContact(input.contactId);
    if (input.applicationId) this.requireApplication(input.applicationId);
  }
}

const APPLICATION_SELECT = `
  SELECT a.*, co.name AS company_name
  FROM applications a JOIN companies co ON co.id = a.company_id
  WHERE a.workspace_id = ?`;

const CONTACT_SELECT = `
  SELECT c.*, co.name AS company_name
  FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
  WHERE c.workspace_id = ?`;

function toApplication(row: ApplicationRow, events: readonly AnyEvent[]): Application {
  const h = foldApplication(events);
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    role: row.role,
    postingUrl: row.posting_url,
    location: row.location,
    season: row.season,
    deadline: row.deadline,
    source: row.source,
    createdAt: row.created_at,
    status: h.status,
    lastActivityAt: Math.max(h.lastActivityAt, row.created_at),
    flags: [...h.flags],
    addedBy: h.addedBy,
  };
}

function toContact(row: ContactRow, events: readonly AnyEvent[]): Contact {
  const touches = events.filter(
    (e) => e.kind === 'outreach.sent' || e.kind === 'response.received',
  );
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    name: row.name,
    title: row.title,
    email: row.email,
    linkedin: row.linkedin,
    howMet: row.how_met,
    createdAt: row.created_at,
    lastTouchedAt: touches.length ? Math.max(...touches.map((e) => e.ts)) : null,
  };
}

/**
 * A capture writes created + posting.captured + flagged at one instant. The
 * feed shows it once; the timeline on the application page keeps all three.
 */
function isCaptureDetail(e: AnyEvent, all: readonly AnyEvent[]): boolean {
  if (e.kind !== 'posting.captured' && e.kind !== 'application.flagged') return false;
  return all.some(
    (o) => o.kind === 'application.created' && o.applicationId === e.applicationId && o.ts === e.ts,
  );
}

/** Compare posting links without tracking parameters, fragments or trailing slashes. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
