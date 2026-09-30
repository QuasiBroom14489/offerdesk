import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ConflictError,
  isoDate,
  NotFoundError,
  type Offerdesk,
  toCsv,
  toXlsx,
} from '@offerdesk/core';
import {
  type Application,
  cellText,
  DOCUMENT_KIND_LABELS,
  FLAGS,
  type Report,
  type SavedView,
  STATUS_LABELS,
  STATUSES,
} from '@offerdesk/shared';
import { ZodError, z } from 'zod';

/**
 * OfferDesk as MCP tools, for Vesper and Claude Code. Like the HTTP server this
 * is a shell: every tool parses input, calls `Offerdesk`, and formats output.
 *
 * Tool names are snake_case because Claude tool names cannot contain dots; a
 * client sees them namespaced, e.g. `mcp__offerdesk__capture_posting`.
 */

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const ADD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const CHANGE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A human line first (what a voice assistant would say), then the data. */
function reply(summary: string, data?: unknown): Content {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): Content {
  const message =
    err instanceof ZodError
      ? `Invalid input: ${err.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`
      : err instanceof NotFoundError || err instanceof ConflictError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function safe<A>(fn: (args: A) => Promise<Content>): (args: A) => Promise<Content> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function line(a: Application): string {
  const bits = [STATUS_LABELS[a.status]];
  if (a.deadline) bits.push(`due ${a.deadline}`);
  if (a.flags.includes('start')) bits.push('flagged to get started');
  return `${a.companyName} — ${a.role} (${bits.join(', ')}) [id ${a.id}]`;
}

/** Rows as `a | b | c` lines under a header: easy for a model to read back. */
function asText(report: Report, limit = 200): string {
  const lines = [report.columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label))];
  for (const r of report.rows.slice(0, limit)) {
    lines.push(report.columns.map((c, i) => cellText(c, r.cells[i] ?? null) || '—'));
  }
  const more = report.rows.length > limit ? `\n…and ${report.rows.length - limit} more` : '';
  return lines.map((l) => l.join(' | ')).join('\n') + more;
}

/** Find a view by id or by name, case-insensitively. */
async function findView(desk: Offerdesk, ref: string): Promise<SavedView> {
  const key = ref.trim().toLowerCase();
  const views = await desk.views.list();
  const found = views.find((v) => v.id === ref || v.name.toLowerCase() === key);
  if (!found) {
    const names = views.map((v) => `"${v.name}"`);
    throw new NotFoundError('view', `${ref} (try ${names.join(', ')})`);
  }
  return found;
}

const Status = z.enum(STATUSES);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export function createServer(desk: Offerdesk): McpServer {
  const server = new McpServer({ name: 'offerdesk', version: '0.1.0' });

  // ── reads ───────────────────────────────────────────────────────────────
  server.registerTool(
    'dashboard',
    {
      title: 'Recruiting dashboard',
      description:
        'Overview of the internship search: pipeline counts, response rate, postings flagged to get started, follow-ups due, and deadlines in the next two weeks. Use for "how is my search going" or "what should I do today".',
      annotations: READ,
    },
    safe(async () => {
      const d = await desk.dashboard();
      const s = d.stats;
      const summary = [
        `${s.total} tracked, ${s.submitted} submitted, ${s.responseRate === null ? 'no' : `${Math.round(s.responseRate * 100)}%`} response rate, ${plural(s.interviews, 'interview')}, ${plural(s.offers, 'offer')}.`,
        `${d.toStart.length} to get started, ${d.followUps.length} follow-ups due, ${d.deadlines.length} other deadlines in two weeks.`,
      ].join(' ');
      return reply(summary, {
        stats: s,
        toStart: d.toStart.map(line),
        followUps: d.followUps.map((f) => ({
          who: f.contact?.name ?? f.application?.label,
          about: f.application?.label,
          daysWaiting: f.daysWaiting,
        })),
        deadlines: d.deadlines.map(line),
      });
    }),
  );

  server.registerTool(
    'list_applications',
    {
      title: 'List applications',
      description:
        'List tracked applications, optionally filtered by status, by the get-started flag, or by a text query matched against company and role. Use this to find an application id before changing it.',
      inputSchema: {
        status: Status.optional(),
        flagged: z.boolean().optional().describe('Only postings flagged to get started'),
        query: z.string().optional().describe('Case-insensitive match on company or role'),
      },
      annotations: READ,
    },
    safe(async ({ status, flagged, query }) => {
      const q = query?.trim().toLowerCase();
      const apps = (await desk.listApplications())
        .filter((a) => !status || a.status === status)
        .filter((a) => !flagged || a.flags.includes('start'))
        .filter((a) => !q || `${a.companyName} ${a.role}`.toLowerCase().includes(q));
      if (apps.length === 0) return reply('No applications match.');
      return reply(apps.map(line).join('\n'));
    }),
  );

  server.registerTool(
    'get_application',
    {
      title: 'Get an application',
      description:
        'Full detail for one application: fields, people at the company, and its history.',
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    safe(async ({ id }) => {
      const a = await desk.getApplicationDetail(id);
      return reply(line(a), a);
    }),
  );

  server.registerTool(
    'follow_ups',
    {
      title: 'Follow-ups due',
      description:
        'Applications and people that have gone quiet for a week or more since the user last reached out.',
      annotations: READ,
    },
    safe(async () => {
      const d = await desk.dashboard();
      if (d.followUps.length === 0) return reply('Nobody is waiting on a follow-up.');
      return reply(
        d.followUps
          .map((f) => {
            const who = f.contact
              ? `${f.contact.name}${f.contact.companyName ? ` at ${f.contact.companyName}` : ''}`
              : f.application?.label;
            return `${who}: quiet for ${f.daysWaiting} days`;
          })
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'deadlines',
    {
      title: 'Upcoming deadlines',
      description: 'Saved postings with a deadline in the next N days (default 14), soonest first.',
      inputSchema: { days: z.number().int().positive().max(120).optional() },
      annotations: READ,
    },
    safe(async ({ days }) => {
      const apps = await desk.upcomingDeadlines(days ?? 14);
      if (apps.length === 0) return reply(`Nothing is due in the next ${days ?? 14} days.`);
      return reply(apps.map(line).join('\n'));
    }),
  );

  // ── capture (additive, safe to auto-approve) ────────────────────────────
  server.registerTool(
    'capture_posting',
    {
      title: 'Add a job posting from the screen',
      description: [
        'Add a job or internship posting to the tracker, flagged as one to get started on.',
        'Use this when the user says "add this to my tracker" while looking at a posting (Handshake, LinkedIn, a company careers page).',
        'First look at the screen, and read the browser tab URL if you can. Then pass what the page actually shows.',
        'Company and role are required. Leave any other field out rather than guess.',
        'Deadline must be YYYY-MM-DD. Include the job description as postingText so the resume can be tailored later.',
        'If the result says duplicate, tell the user it was already tracked. Do not call this if the screen is not a posting.',
      ].join(' '),
      inputSchema: {
        company: z.string().min(1),
        role: z.string().min(1),
        location: z.string().optional(),
        deadline: IsoDate.optional().describe('Application deadline, YYYY-MM-DD'),
        postingUrl: z.string().url().optional(),
        pay: z.string().optional(),
        source: z.string().optional().describe('Where it was found, e.g. "Handshake"'),
        season: z.string().optional().describe('e.g. "Summer 2027"'),
        postingText: z.string().max(40_000).optional().describe('The job description as shown'),
      },
      annotations: ADD,
    },
    safe(async (args) => {
      const { application: a, duplicate } = await desk.capturePosting({
        ...args,
        capturedBy: 'vesper',
      });
      if (duplicate) {
        return reply(`Already tracked: ${line(a)}. Nothing was added.`, {
          duplicate,
          application: a,
        });
      }
      return reply(`Added ${a.companyName} — ${a.role} and flagged it to get started.`, {
        duplicate,
        application: a,
      });
    }),
  );

  // ── table views ─────────────────────────────────────────────────────────
  server.registerTool(
    'list_views',
    {
      title: 'List table views',
      description:
        "Saved table views (built-in presets and the user's own), with their columns and filters.",
      annotations: READ,
    },
    safe(async () => {
      const views = await desk.views.list();
      return reply(
        views.map((v) => `${v.name}${v.builtIn ? ' (built in)' : ''} [id ${v.id}]`).join('\n'),
        views.map((v) => ({ id: v.id, name: v.name, builtIn: v.builtIn, spec: v.spec })),
      );
    }),
  );

  server.registerTool(
    'run_view',
    {
      title: 'Run a table view',
      description:
        'Show the rows of a saved table view by name or id, e.g. "Waiting to hear" (applied, no reply yet, with days waiting) or "Response times" (days from applying to first reply). Use for questions like "who haven\'t I heard back from?".',
      inputSchema: { view: z.string().min(1).describe('View name or id') },
      annotations: READ,
    },
    safe(async ({ view }) => {
      const report = await desk.report({ viewId: (await findView(desk, view)).id });
      const title = `${report.view?.name}: ${plural(report.rows.length, 'row')}.`;
      return reply(report.rows.length === 0 ? title : `${title}\n\n${asText(report)}`);
    }),
  );

  server.registerTool(
    'export_view',
    {
      title: 'Export a table view',
      description:
        'Save a table view as a spreadsheet file (.xlsx with typed columns and colored statuses, or .csv). Writes to ~/Downloads unless given an absolute path ending in .xlsx or .csv. Returns the path.',
      inputSchema: {
        view: z.string().min(1).describe('View name or id'),
        format: z.enum(['xlsx', 'csv']).default('xlsx'),
        path: z.string().optional().describe('Absolute file path; defaults to ~/Downloads'),
      },
      annotations: { ...ADD, idempotentHint: true },
    },
    async ({ view, format, path }) => {
      try {
        const v = await findView(desk, view);
        const out =
          path ?? join(homedir(), 'Downloads', `${slug(v.name)}-${isoDate(Date.now())}.${format}`);
        const ext = extname(out).slice(1).toLowerCase();
        if (!isAbsolute(out)) throw new Error('path must be absolute');
        if (ext !== 'xlsx' && ext !== 'csv') throw new Error('path must end in .xlsx or .csv');
        const report = await desk.report({ viewId: v.id });
        writeFileSync(out, ext === 'xlsx' ? await toXlsx(report) : toCsv(report));
        const rows = report.rows.length;
        return reply(`Saved "${v.name}" (${plural(rows, 'row')}) to ${out}.`, { path: out, rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'push_view_to_sheet',
    {
      title: 'Push a table view to Google Sheets',
      description:
        "Write a table view to its Google Sheet in the user's OfferDesk Drive folder, creating the sheet the first time. Sheets update only when pushed, so use this when the user wants the sheet current. Returns the sheet URL. Needs Google connected in OfferDesk Settings.",
      inputSchema: { view: z.string().min(1).describe('View name or id') },
      // Rewrites only OfferDesk's own tab, in the user's Google Drive.
      annotations: { ...CHANGE, openWorldHint: true },
    },
    async ({ view }) => {
      try {
        const v = await findView(desk, view);
        const pushed = await desk.pushViewToSheet(v.id);
        const verb = pushed.created ? 'Created' : 'Updated';
        return reply(
          `${verb} the "${v.name}" sheet (${plural(pushed.rows, 'row')}): ${pushed.url}`,
          {
            url: pushed.url,
            rows: pushed.rows,
            created: pushed.created,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── changes ─────────────────────────────────────────────────────────────
  server.registerTool(
    'add_application',
    {
      title: 'Add an application',
      description:
        'Add an application by hand (use capture_posting when reading a posting off the screen).',
      inputSchema: {
        company: z.string().min(1),
        role: z.string().min(1),
        status: Status.optional(),
        deadline: IsoDate.optional(),
        location: z.string().optional(),
        postingUrl: z.string().url().optional(),
        source: z.string().optional(),
      },
      annotations: ADD,
    },
    safe(async (args) => {
      const a = await desk.addApplication(args, { source: 'vesper' });
      return reply(`Added ${line(a)}.`, a);
    }),
  );

  server.registerTool(
    'set_status',
    {
      title: 'Move an application',
      description: `Move an application to a new status: ${STATUSES.join(', ')}. Find the id with list_applications first.`,
      inputSchema: { id: z.string(), status: Status },
      annotations: CHANGE,
    },
    safe(async ({ id, status }) => {
      const a = await desk.setStatus(id, status);
      return reply(`${a.companyName} — ${a.role} is now ${STATUS_LABELS[a.status].toLowerCase()}.`);
    }),
  );

  server.registerTool(
    'flag',
    {
      title: 'Flag to get started',
      description: 'Turn the "get started" flag on or off for an application.',
      inputSchema: { id: z.string(), flag: z.enum(FLAGS).default('start'), on: z.boolean() },
      annotations: CHANGE,
    },
    safe(async ({ id, flag, on }) => {
      const a = on ? await desk.flag(id, flag) : await desk.unflag(id, flag);
      return reply(
        `${a.companyName} — ${a.role}: ${on ? 'flagged to get started' : 'flag removed'}.`,
      );
    }),
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Attach a note to an application (interview questions, referral details, anything).',
      inputSchema: { id: z.string(), text: z.string().min(1) },
      annotations: ADD,
    },
    safe(async ({ id, text }) => {
      await desk.addNote(id, text);
      return reply('Note saved.');
    }),
  );

  const outreachInput = {
    contactId: z.string().optional(),
    applicationId: z.string().optional(),
    summary: z.string().optional(),
  };

  server.registerTool(
    'log_outreach',
    {
      title: 'Log outreach',
      description: 'Record that the user reached out to a person and/or about an application.',
      inputSchema: {
        ...outreachInput,
        channel: z.enum(['email', 'linkedin', 'in-person', 'referral', 'other']),
      },
      annotations: ADD,
    },
    safe(async (args) => {
      await desk.logOutreach(args);
      return reply('Outreach logged.');
    }),
  );

  server.registerTool(
    'log_response',
    {
      title: 'Log a reply',
      description: 'Record that a person or company replied.',
      inputSchema: {
        ...outreachInput,
        channel: z.enum(['email', 'linkedin', 'phone', 'portal', 'other']),
      },
      annotations: ADD,
    },
    safe(async (args) => {
      await desk.logResponse(args);
      return reply('Reply logged.');
    }),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'The documents library: resumes, cover letters, transcripts and other files, each with its versions (newest first) and the applications it is attached to.',
      inputSchema: { archived: z.boolean().optional() },
      annotations: READ,
    },
    safe(async ({ archived }) => {
      const docs = await desk.documents.list({ archived });
      const lines = docs.map(
        (d) =>
          `${d.name} (${DOCUMENT_KIND_LABELS[d.kind].toLowerCase()}, v${d.versions[0]?.version}, ${plural(d.applicationIds.length, 'application')})`,
      );
      return reply(
        docs.length
          ? `${plural(docs.length, 'document')}:\n${lines.join('\n')}`
          : 'No documents yet.',
        docs,
      );
    }),
  );

  server.registerTool(
    'attach_document',
    {
      title: 'Attach a document',
      description:
        'Attach a library document to an application, pinned to the version that was sent (the latest unless versionId is given). Use detach to remove it.',
      inputSchema: {
        applicationId: z.string(),
        documentId: z.string(),
        versionId: z.string().optional(),
        detach: z.boolean().optional(),
      },
      annotations: CHANGE,
    },
    safe(async ({ applicationId, documentId, versionId, detach }) => {
      const doc = await desk.documents.get(documentId);
      const app = detach
        ? await desk.detachDocument(applicationId, documentId)
        : await desk.attachDocument(applicationId, documentId, { versionId });
      const where = `${app.companyName} — ${app.role}`;
      return reply(
        detach ? `Detached ${doc.name} from ${where}.` : `Attached ${doc.name} to ${where}.`,
      );
    }),
  );

  return server;
}

/** Tool names that only read or only add, and so are safe for a client to auto-approve. */
export const AUTO_APPROVABLE_TOOLS = [
  'dashboard',
  'list_applications',
  'get_application',
  'follow_ups',
  'deadlines',
  'list_views',
  'run_view',
  'list_documents',
  'capture_posting',
] as const;

function slug(name: string): string {
  return `offerdesk-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'view'
  }`;
}
