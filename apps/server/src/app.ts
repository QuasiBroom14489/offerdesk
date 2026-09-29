import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { ConflictError, isoDate, NotFoundError, type Offerdesk } from '@offerdesk/core';
import {
  ApplicationPatch,
  CapturePosting,
  FLAGS,
  NewApplication,
  NewContact,
  NewView,
  Status,
  ViewPatch,
  ViewSpec,
} from '@offerdesk/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';

const IdParams = z.object({ id: z.string().min(1) });

const OutreachBody = z.object({
  contactId: z.string().nullish(),
  applicationId: z.string().nullish(),
  channel: z.enum(['email', 'linkedin', 'in-person', 'referral', 'other']),
  summary: z.string().optional(),
});

/** A saved view, an ad-hoc spec, or both (the spec wins; the view names the file). */
const ReportBody = z.object({ viewId: z.string().min(1).optional(), spec: ViewSpec.optional() });

/** Downloads are plain links, so an ad-hoc spec travels as a JSON query parameter. */
const ExportQuery = z.object({
  view: z.string().min(1).optional(),
  spec: z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'spec must be JSON' });
        return z.NEVER;
      }
    })
    .pipe(ViewSpec)
    .optional(),
});

const ResponseBody = OutreachBody.extend({
  channel: z.enum(['email', 'linkedin', 'phone', 'portal', 'other']),
});

export interface ServerOptions {
  /** Built web UI to serve at `/`. Omitted in tests and when running Vite. */
  webRoot?: string;
  logger?: boolean;
}

/**
 * The REST API. Every handler is parse → call `Offerdesk` → return. Validation
 * errors become 400s and unknown ids become 404s in one place, below.
 */
export function buildServer(desk: Offerdesk, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid request', issues: err.issues });
    }
    if (err instanceof NotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof ConflictError) {
      return reply.status(409).send({ error: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/dashboard', async () => desk.dashboard());

  // ── applications ──────────────────────────────────────────────────────────
  app.get('/api/applications', async () => desk.listApplications());

  app.post('/api/applications', async (req, reply) => {
    const app = desk.addApplication(NewApplication.parse(req.body));
    return reply.status(201).send(app);
  });

  app.get('/api/applications/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return desk.getApplicationDetail(id);
  });

  app.patch('/api/applications/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return desk.updateApplication(id, ApplicationPatch.parse(req.body));
  });

  app.post('/api/applications/:id/status', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { status } = z.object({ status: Status }).parse(req.body);
    return desk.setStatus(id, status);
  });

  app.post('/api/applications/:id/flags', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { flag, on } = z.object({ flag: z.enum(FLAGS), on: z.boolean() }).parse(req.body);
    return on ? desk.flag(id, flag) : desk.unflag(id, flag);
  });

  /** A posting read off a page. 201 when added, 200 with `duplicate: true` when already tracked. */
  app.post('/api/capture', async (req, reply) => {
    const result = desk.capturePosting(CapturePosting.parse(req.body));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/api/applications/:id/notes', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(desk.addNote(id, text));
  });

  app.post('/api/applications/:id/interviews', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({ at: z.number(), round: z.string().optional(), location: z.string().optional() })
      .parse(req.body);
    return reply.status(201).send(desk.scheduleInterview(id, body));
  });

  // ── contacts & outreach ───────────────────────────────────────────────────
  app.get('/api/contacts', async () => desk.listContacts());

  app.post('/api/contacts', async (req, reply) => {
    return reply.status(201).send(desk.addContact(NewContact.parse(req.body)));
  });

  app.get('/api/contacts/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return desk.getContactDetail(id);
  });

  app.post('/api/outreach', async (req, reply) => {
    return reply.status(201).send(desk.logOutreach(OutreachBody.parse(req.body)));
  });

  app.post('/api/responses', async (req, reply) => {
    return reply.status(201).send(desk.logResponse(ResponseBody.parse(req.body)));
  });

  // ── views, reports & exports ──────────────────────────────────────────────
  app.get('/api/views', async () => desk.views.list());

  app.post('/api/views', async (req, reply) => {
    return reply.status(201).send(desk.views.create(NewView.parse(req.body)));
  });

  app.patch('/api/views/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return desk.views.update(id, ViewPatch.parse(req.body));
  });

  app.delete('/api/views/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    desk.views.remove(id);
    return reply.status(204).send();
  });

  app.get('/api/report', async (req) => {
    const { view } = z.object({ view: z.string().min(1).optional() }).parse(req.query);
    return desk.report({ viewId: view });
  });

  app.post('/api/report', async (req) => desk.report(ReportBody.parse(req.body)));

  app.get('/api/export.csv', async (req, reply) => {
    const { view, spec } = ExportQuery.parse(req.query);
    const input = { viewId: view, spec };
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', attachment(exportName(desk, input), 'csv'))
      .send(desk.exportCsv(input));
  });

  app.get('/api/export.xlsx', async (req, reply) => {
    const { view, spec } = ExportQuery.parse(req.query);
    const input = { viewId: view, spec };
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', attachment(exportName(desk, input), 'xlsx'))
      .send(await desk.exportXlsx(input));
  });

  // ── web UI ────────────────────────────────────────────────────────────────
  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.register(fastifyStatic, { root: opts.webRoot });
    // Client-side routes fall back to the SPA shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** `offerdesk-waiting-to-hear-2026-10-01` */
function exportName(desk: Offerdesk, input: { viewId?: string; spec?: unknown }): string {
  const name = input.viewId
    ? desk.views.get(input.viewId).name
    : input.spec
      ? 'applications'
      : 'everything';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `offerdesk-${slug || 'view'}-${isoDate(Date.now())}`;
}

function attachment(base: string, ext: string): string {
  return `attachment; filename="${base}.${ext}"`;
}
