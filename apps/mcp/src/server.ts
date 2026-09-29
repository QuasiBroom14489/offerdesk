import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError, type Offerdesk } from '@offerdesk/core';
import { type Application, FLAGS, STATUS_LABELS, STATUSES } from '@offerdesk/shared';
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
      : err instanceof NotFoundError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function safe<A>(fn: (args: A) => Content): (args: A) => Promise<Content> {
  return async (args) => {
    try {
      return fn(args);
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
    safe(() => {
      const d = desk.dashboard();
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
    safe(({ status, flagged, query }) => {
      const q = query?.trim().toLowerCase();
      const apps = desk
        .listApplications()
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
    safe(({ id }) => {
      const a = desk.getApplicationDetail(id);
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
    safe(() => {
      const d = desk.dashboard();
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
    safe(({ days }) => {
      const apps = desk.upcomingDeadlines(days ?? 14);
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
    safe((args) => {
      const { application: a, duplicate } = desk.capturePosting({ ...args, capturedBy: 'vesper' });
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
    safe((args) => {
      const a = desk.addApplication(args, { source: 'vesper' });
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
    safe(({ id, status }) => {
      const a = desk.setStatus(id, status);
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
    safe(({ id, flag, on }) => {
      const a = on ? desk.flag(id, flag) : desk.unflag(id, flag);
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
    safe(({ id, text }) => {
      desk.addNote(id, text);
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
    safe((args) => {
      desk.logOutreach(args);
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
    safe((args) => {
      desk.logResponse(args);
      return reply('Reply logged.');
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
  'capture_posting',
] as const;
