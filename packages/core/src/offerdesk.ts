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
  type PipelineStats,
  type Report,
  type Status,
  ViewSpec,
  type ViewSpecInput,
} from '@offerdesk/shared';
import type { OfferdeskConfig } from './config.js';
import { Connections } from './connectors/connections.js';
import { credentialStoreFromEnv } from './connectors/credentials.js';
import {
  type Fetch,
  type GoogleConfig,
  GoogleService,
  googleConfigFromEnv,
} from './connectors/google/index.js';
import type { CredentialStore } from './connectors/types.js';
import { isoDate } from './dates.js';
import { type Db, openDb } from './db.js';
import { foldApplication, followUpsDue, groupBy, pipelineStats } from './derive.js';
import { Documents, foldAttachments } from './documents.js';
import { NotFoundError } from './errors.js';
import { EventLog } from './events.js';
import { fileStoreFromEnv } from './files/index.js';
import type { FileStore } from './files/store.js';
import { type RowFacts, rowFacts } from './reports/columns.js';
import { toCsv, toXlsx } from './reports/export.js';
import { DEFAULT_VIEW_ID } from './reports/presets.js';
import { runView } from './reports/run.js';
import { type ViewSheet, ViewSheets } from './reports/view-sheets.js';
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
  /** Where document bytes live (ADR 0006). Without one, the library is read-only metadata. */
  files?: FileStore | null;
  /** Where connector secrets live (ADR 0007). Without one, no connector can connect. */
  credentials?: CredentialStore | null;
  /** The Google OAuth client (ADR 0007). Without one, Google is unavailable. */
  google?: GoogleConfig | null;
  /** HTTP for connectors; tests pass a fake. */
  fetch?: Fetch;
}

/** A saved view by id, an ad-hoc spec, or both (the spec wins; the view names the export). */
export interface ReportInput {
  viewId?: string;
  spec?: ViewSpecInput;
}

/**
 * One workspace's whole state, read in three queries. Every read model is
 * derived from this in memory, so a request costs a fixed number of round
 * trips however many applications there are (it matters against a hosted
 * database, ADR 0005).
 */
interface Snapshot {
  events: AnyEvent[];
  applications: Application[];
  contacts: Contact[];
}

/**
 * The application service. The HTTP server, the MCP server and the CLI are all
 * thin shells over this class — nothing that decides or remembers lives in them.
 */
export class Offerdesk {
  readonly events: EventLog;
  readonly connections: Connections;
  readonly views: Views;
  readonly documents: Documents;
  readonly google: GoogleService;
  readonly viewSheets: ViewSheets;
  readonly workspaceId: string;
  private readonly followUpAfterDays: number;
  private readonly now: () => number;

  constructor(
    readonly db: Db,
    private readonly opts: OfferdeskOptions = {},
  ) {
    this.workspaceId = opts.workspaceId ?? 'local';
    this.followUpAfterDays = opts.followUpAfterDays ?? 7;
    this.now = opts.now ?? Date.now;
    this.events = new EventLog(db, this.workspaceId);
    this.connections = new Connections(db, this.workspaceId, this.now);
    this.views = new Views(db, this.workspaceId, this.now);
    this.documents = new Documents(db, this.workspaceId, this.events, opts.files ?? null, this.now);
    this.viewSheets = new ViewSheets(db, this.workspaceId);
    this.google = new GoogleService(
      opts.google ?? null,
      opts.credentials ?? null,
      this.connections,
      this.workspaceId,
      opts.fetch ?? ((...args) => fetch(...args)),
      this.now,
    );
  }

  /** Open a file path, `:memory:`, or a `libsql://` URL (with its token). */
  static async open(
    location: string,
    opts?: OfferdeskOptions & { authToken?: string },
  ): Promise<Offerdesk> {
    return new Offerdesk(await openDb(location, opts?.authToken), opts);
  }

  /**
   * Open what the config and environment describe: the database, file storage
   * (ADR 0006), the credential store and the Google client (ADR 0007). The
   * one place the servers and CLI turn environment into wiring.
   */
  static async fromConfig(
    cfg: OfferdeskConfig,
    opts: OfferdeskOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Offerdesk> {
    const db = await openDb(cfg.dbUrl, cfg.dbAuthToken);
    return new Offerdesk(db, {
      followUpAfterDays: cfg.followUpAfterDays,
      files: fileStoreFromEnv(cfg, env),
      credentials: credentialStoreFromEnv(db, cfg, env),
      google: googleConfigFromEnv(env),
      ...opts,
    });
  }

  /**
   * The same service scoped to another workspace, sharing the connection. A
   * hosted server makes one per request from the signed-in user (ADR 0005).
   */
  forWorkspace(workspaceId: string): Offerdesk {
    return new Offerdesk(this.db, { ...this.opts, workspaceId });
  }

  close(): void {
    this.db.close();
  }

  // ── companies ────────────────────────────────────────────────────────────

  /** Find a company by name (case-insensitive) or create it. */
  private async companyId(name: string, at: number): Promise<string> {
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

  // ── applications ─────────────────────────────────────────────────────────

  async addApplication(
    input: NewApplication,
    opts: { source?: EventSource } = {},
  ): Promise<Application> {
    const a = NewApplication.parse(input);
    const at = a.at ?? this.now();
    const id = randomUUID();
    await this.db.transaction(async () => {
      const companyId = await this.companyId(a.company, at);
      await this.db.run(
        `INSERT INTO applications
           (id, workspace_id, company_id, role, posting_url, location, season, deadline, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      await this.events.append({
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
  async capturePosting(
    input: CapturePosting,
  ): Promise<{ application: Application; duplicate: boolean }> {
    const c = CapturePosting.parse(input);
    return this.db.transaction(async () => {
      const existing = await this.findExisting(c.company, c.role, c.postingUrl ?? null);
      if (existing) return { application: existing, duplicate: true };

      const at = this.now();
      const app = await this.addApplication(
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
        await this.events.append({
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
        await this.events.append({
          kind: 'application.flagged',
          applicationId: app.id,
          payload: { flag: 'start', reason: c.source ? `Captured from ${c.source}` : undefined },
          ts: at,
          source: c.capturedBy,
        });
      }
      return { application: await this.getApplication(app.id), duplicate: false };
    });
  }

  async flag(id: string, flag: Flag, reason?: string): Promise<Application> {
    const app = await this.getApplication(id);
    if (!app.flags.includes(flag)) {
      await this.events.append({
        kind: 'application.flagged',
        applicationId: id,
        payload: { flag, reason },
        ts: this.now(),
      });
    }
    return this.getApplication(id);
  }

  async unflag(id: string, flag: Flag): Promise<Application> {
    const app = await this.getApplication(id);
    if (app.flags.includes(flag)) {
      await this.events.append({
        kind: 'application.unflagged',
        applicationId: id,
        payload: { flag },
        ts: this.now(),
      });
    }
    return this.getApplication(id);
  }

  /** Flagged "get started": soonest deadline first, undated ones after, newest first. */
  async toStart(): Promise<Application[]> {
    return toStartOf(await this.listApplications());
  }

  private async findExisting(
    company: string,
    role: string,
    url: string | null,
  ): Promise<Application | null> {
    const apps = await this.listApplications();
    if (url) {
      const key = normalizeUrl(url);
      const byUrl = apps.find((a) => a.postingUrl && normalizeUrl(a.postingUrl) === key);
      if (byUrl) return byUrl;
    }
    const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
    return apps.find((a) => same(a.companyName, company) && same(a.role, role)) ?? null;
  }

  async updateApplication(id: string, patch: ApplicationPatch): Promise<Application> {
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
    await this.requireApplication(id);
    if (sets.length > 0) {
      await this.db.run(
        `UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
        ...values,
        id,
        this.workspaceId,
      );
    }
    return this.getApplication(id);
  }

  async listApplications(): Promise<Application[]> {
    return (await this.snapshot()).applications;
  }

  async getApplication(id: string): Promise<Application> {
    const row = await this.requireApplication(id);
    return toApplication(row, await this.events.forApplication(id));
  }

  async getApplicationDetail(id: string): Promise<ApplicationDetail> {
    const row = await this.requireApplication(id);
    const timeline = await this.events.forApplication(id);
    const contactIds = new Set(timeline.map((e) => e.contactId).filter((c): c is string => !!c));
    const companyContacts = (await this.listContacts()).filter(
      (c) => c.companyId === row.company_id || contactIds.has(c.id),
    );
    return {
      ...toApplication(row, timeline),
      timeline,
      contacts: companyContacts,
      documents: await this.documents.attachedTo(id, timeline),
    };
  }

  async setStatus(id: string, to: Status, at?: number): Promise<Application> {
    const current = await this.getApplication(id);
    if (current.status !== to) {
      await this.events.append({
        kind: 'status.changed',
        applicationId: id,
        payload: { from: current.status, to },
        ts: at ?? this.now(),
      });
    }
    return this.getApplication(id);
  }

  async addNote(applicationId: string, text: string, at?: number): Promise<AnyEvent> {
    await this.requireApplication(applicationId);
    return (await this.events.append({
      kind: 'note.added',
      applicationId,
      payload: { text },
      ts: at ?? this.now(),
    })) as AnyEvent;
  }

  async scheduleInterview(
    applicationId: string,
    payload: EventPayload<'interview.scheduled'>,
    at?: number,
  ): Promise<AnyEvent> {
    await this.requireApplication(applicationId);
    return (await this.events.append({
      kind: 'interview.scheduled',
      applicationId,
      payload,
      ts: at ?? this.now(),
    })) as AnyEvent;
  }

  /** Applications with a deadline in the next `days` days that are still only saved. */
  async upcomingDeadlines(days = 14): Promise<Application[]> {
    return this.deadlinesOf(await this.listApplications(), days);
  }

  // ── documents ────────────────────────────────────────────────────────────

  /**
   * Attach a document to an application, pinned to a version (the latest by
   * default). Attaching the same version again is a no-op; another version
   * re-pins it.
   */
  async attachDocument(
    applicationId: string,
    documentId: string,
    opts: { versionId?: string; source?: EventSource } = {},
  ): Promise<Application> {
    await this.requireApplication(applicationId);
    const doc = await this.documents.get(documentId);
    const version = opts.versionId
      ? doc.versions.find((v) => v.id === opts.versionId)
      : doc.versions[0];
    if (!version) throw new NotFoundError('document version', opts.versionId ?? documentId);
    const current = foldAttachments(await this.events.forApplication(applicationId))
      .get(applicationId)
      ?.get(documentId);
    if (current?.versionId !== version.id) {
      await this.events.append({
        kind: 'document.attached',
        applicationId,
        payload: { documentId, kind: doc.kind, versionId: version.id },
        ts: this.now(),
        source: opts.source,
      });
    }
    return this.getApplication(applicationId);
  }

  async detachDocument(applicationId: string, documentId: string): Promise<Application> {
    const timeline = await this.events.forApplication(applicationId);
    await this.requireApplication(applicationId);
    if (foldAttachments(timeline).get(applicationId)?.has(documentId)) {
      await this.events.append({
        kind: 'document.detached',
        applicationId,
        payload: { documentId },
        ts: this.now(),
      });
    }
    return this.getApplication(applicationId);
  }

  // ── contacts & outreach ──────────────────────────────────────────────────

  async addContact(input: NewContact): Promise<Contact> {
    const c = NewContact.parse(input);
    const at = this.now();
    const id = randomUUID();
    await this.db.transaction(async () => {
      const companyId = c.company ? await this.companyId(c.company, at) : null;
      await this.db.run(
        `INSERT INTO contacts
           (id, workspace_id, company_id, name, title, email, linkedin, how_met, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async listContacts(): Promise<Contact[]> {
    return (await this.snapshot()).contacts;
  }

  async getContactDetail(id: string): Promise<ContactDetail> {
    return { ...(await this.getContact(id)), timeline: await this.events.forContact(id) };
  }

  async getContact(id: string): Promise<Contact> {
    const row = await this.db.get<ContactRow>(
      `${CONTACT_SELECT} AND c.id = ?`,
      this.workspaceId,
      id,
    );
    if (!row) throw new NotFoundError('contact', id);
    return toContact(row, await this.events.forContact(id));
  }

  async logOutreach(input: {
    contactId?: string | null;
    applicationId?: string | null;
    channel: EventPayload<'outreach.sent'>['channel'];
    summary?: string;
    at?: number;
  }): Promise<AnyEvent> {
    await this.assertTarget(input);
    return (await this.events.append({
      kind: 'outreach.sent',
      contactId: input.contactId ?? null,
      applicationId: input.applicationId ?? null,
      payload: { channel: input.channel, summary: input.summary },
      ts: input.at ?? this.now(),
    })) as AnyEvent;
  }

  async logResponse(input: {
    contactId?: string | null;
    applicationId?: string | null;
    channel: EventPayload<'response.received'>['channel'];
    summary?: string;
    at?: number;
  }): Promise<AnyEvent> {
    await this.assertTarget(input);
    return (await this.events.append({
      kind: 'response.received',
      contactId: input.contactId ?? null,
      applicationId: input.applicationId ?? null,
      payload: { channel: input.channel, summary: input.summary },
      ts: input.at ?? this.now(),
    })) as AnyEvent;
  }

  // ── dashboard reads ──────────────────────────────────────────────────────

  async followUps(): Promise<FollowUp[]> {
    return this.followUpsOf(await this.events.all());
  }

  async stats(): Promise<PipelineStats> {
    return statsOf(await this.events.all());
  }

  recentActivity(limit = 20): Promise<AnyEvent[]> {
    return this.events.recent(limit);
  }

  /** Everything the home screen needs, resolved to display names, from one snapshot. */
  async dashboard(opts: { deadlineDays?: number; recentLimit?: number } = {}): Promise<Dashboard> {
    const { events, applications, contacts } = await this.snapshot();
    const apps = new Map(applications.map((a) => [a.id, a]));
    const people = new Map(contacts.map((c) => [c.id, c]));
    const appRef = (id: string | null) => {
      const a = id ? apps.get(id) : undefined;
      return a ? { id: a.id, label: `${a.companyName} — ${a.role}` } : null;
    };
    const contactRef = (id: string | null) => {
      const c = id ? people.get(id) : undefined;
      return c ? { id: c.id, name: c.name, companyName: c.companyName } : null;
    };
    const toStart = toStartOf(applications);
    const flagged = new Set(toStart.map((a) => a.id));
    const recentLimit = opts.recentLimit ?? 15;
    // Newest first, the same order as EventLog.recent().
    const recent = [...events].sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    return {
      stats: statsOf(events),
      toStart,
      followUps: this.followUpsOf(events).map((f) => ({
        ...f,
        application: appRef(f.applicationId),
        contact: contactRef(f.contactId),
      })),
      // Flagged postings already show their deadline under "Get started".
      deadlines: this.deadlinesOf(applications, opts.deadlineDays ?? 14).filter(
        (a) => !flagged.has(a.id),
      ),
      recent: recent
        .slice(0, recentLimit + 10)
        .filter((e, _i, all) => !isCaptureDetail(e, all))
        .slice(0, recentLimit)
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
  async report(input: ReportInput = {}): Promise<Report> {
    const view =
      input.viewId || !input.spec ? await this.views.get(input.viewId ?? DEFAULT_VIEW_ID) : null;
    const spec = input.spec ? ViewSpec.parse(input.spec) : (view as NonNullable<typeof view>).spec;
    const now = this.now();
    const { columns, rows } = runView(spec, reportFacts(await this.snapshot(), now), now);
    return {
      view: view ? { id: view.id, name: view.name, builtIn: view.builtIn } : null,
      spec,
      columns,
      rows,
      generatedAt: now,
    };
  }

  async exportCsv(input: ReportInput = {}): Promise<string> {
    return toCsv(await this.report(input));
  }

  async exportXlsx(input: ReportInput = {}): Promise<Buffer> {
    return toXlsx(await this.report(input));
  }

  /** A view's Google Sheet and how stale it is, or null if it was never pushed. */
  async viewSheet(viewId: string): Promise<ViewSheet | null> {
    await this.views.get(viewId);
    return this.viewSheets.get(viewId);
  }

  /**
   * Push a saved view (or preset) to its Google Sheet, creating the sheet in
   * the `OfferDesk` Drive folder the first time, or again if it was deleted.
   * On demand only: a sheet is a snapshot with a "changes since" count
   * (ADR 0007 amendment).
   */
  async pushViewToSheet(viewId: string): Promise<ViewSheet & { rows: number; created: boolean }> {
    const view = await this.views.get(viewId);
    const sheets = this.google.sheets();
    // Read the seq before the rows, so a change landing mid-push counts as "since".
    const seq = await this.viewSheets.latestSeq();
    const report = await this.report({ viewId });
    const linked = await this.viewSheets.get(viewId);
    const existing = linked ? await sheets.find(linked.spreadsheetId) : null;
    const target = existing ?? (await sheets.create(`OfferDesk · ${view.name}`));
    await sheets.write(target.spreadsheetId, report);
    await this.viewSheets.save(viewId, target, this.now(), seq);
    const saved = (await this.viewSheets.get(viewId)) as ViewSheet;
    return { ...saved, rows: report.rows.length, created: existing === null };
  }

  /** Stop pushing a view. The spreadsheet stays in Drive. */
  async unlinkViewSheet(viewId: string): Promise<void> {
    await this.views.get(viewId);
    await this.viewSheets.remove(viewId);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async snapshot(): Promise<Snapshot> {
    const [appRows, contactRows, events] = await Promise.all([
      this.db.all<ApplicationRow>(
        `${APPLICATION_SELECT} ORDER BY a.created_at DESC`,
        this.workspaceId,
      ),
      this.db.all<ContactRow>(`${CONTACT_SELECT} ORDER BY c.name`, this.workspaceId),
      this.events.all(),
    ]);
    const byApp = groupBy(events, (e) => e.applicationId);
    const byContact = groupBy(events, (e) => e.contactId);
    return {
      events,
      applications: appRows.map((row) => toApplication(row, byApp.get(row.id) ?? [])),
      contacts: contactRows.map((row) => toContact(row, byContact.get(row.id) ?? [])),
    };
  }

  private followUpsOf(events: readonly AnyEvent[]): FollowUp[] {
    return followUpsDue(events, { now: this.now(), afterDays: this.followUpAfterDays });
  }

  private deadlinesOf(apps: readonly Application[], days: number): Application[] {
    const today = isoDate(this.now());
    const until = isoDate(this.now() + days * 86_400_000);
    return apps
      .filter(
        (a) => a.deadline && a.deadline >= today && a.deadline <= until && a.status === 'saved',
      )
      .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
  }

  private async requireApplication(id: string): Promise<ApplicationRow> {
    const row = await this.db.get<ApplicationRow>(
      `${APPLICATION_SELECT} AND a.id = ?`,
      this.workspaceId,
      id,
    );
    if (!row) throw new NotFoundError('application', id);
    return row;
  }

  private async assertTarget(input: {
    contactId?: string | null;
    applicationId?: string | null;
  }): Promise<void> {
    if (!input.contactId && !input.applicationId) {
      throw new Error('outreach and responses need a contactId, an applicationId, or both');
    }
    if (input.contactId) await this.getContact(input.contactId);
    if (input.applicationId) await this.requireApplication(input.applicationId);
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

function statsOf(events: readonly AnyEvent[]): PipelineStats {
  const byApp = groupBy(events, (e) => e.applicationId);
  return pipelineStats([...byApp.values()].map(foldApplication));
}

function toStartOf(apps: readonly Application[]): Application[] {
  return apps
    .filter((a) => a.flags.includes('start'))
    .sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return b.createdAt - a.createdAt;
    });
}

function reportFacts({ events, applications, contacts }: Snapshot, now: number): RowFacts[] {
  const byApp = groupBy(events, (e) => e.applicationId);
  const byContact = groupBy(events, (e) => e.contactId);
  return applications.map((app) => {
    const evs = byApp.get(app.id) ?? [];
    // Same people as the application page: everyone at the company, plus anyone it mentions.
    const linked = new Set(evs.map((e) => e.contactId));
    const people = contacts.filter((c) => c.companyId === app.companyId || linked.has(c.id));
    const peopleEvents = people.flatMap((p) => byContact.get(p.id) ?? []);
    return rowFacts(app, evs, people, peopleEvents, now);
  });
}

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
