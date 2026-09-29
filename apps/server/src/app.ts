import { existsSync } from 'node:fs';
import { clerkPlugin, getAuth } from '@clerk/fastify';
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
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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

declare module 'fastify' {
  interface FastifyRequest {
    /** The service scoped to the caller's workspace. Set for every /api route but health. */
    desk: Offerdesk;
  }
}

export interface ServerOptions {
  /** Built web UI to serve at `/`. Omitted in tests and when running Vite. */
  webRoot?: string;
  logger?: boolean;
  /**
   * Who is calling. `'clerk'` signs requests in with Clerk (keys from the
   * environment) and uses the Clerk user id as the workspace (ADR 0005). A
   * function is for tests. Omitted: no sign-in, the local workspace.
   */
  auth?: 'clerk' | ((req: FastifyRequest) => string | null | Promise<string | null>);
}

/**
 * The REST API. Every handler is parse → call `Offerdesk` → return. Validation
 * errors become 400s and unknown ids become 404s in one place, below.
 */
export function buildServer(base: Offerdesk, opts: ServerOptions = {}): FastifyInstance {
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

  // Resolve the caller's workspace once per request, before any handler runs.
  let workspaceFor: (req: FastifyRequest) => string | null | Promise<string | null>;
  if (opts.auth === 'clerk') {
    app.register(clerkPlugin, { hookName: 'onRequest' });
    workspaceFor = (req) => getAuth(req).userId;
  } else {
    workspaceFor = opts.auth ?? (() => base.workspaceId);
  }
  app.decorateRequest('desk', null as unknown as Offerdesk);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    const workspace = await workspaceFor(req);
    if (!workspace) return reply.status(401).send({ error: 'sign in required' });
    req.desk = workspace === base.workspaceId ? base : base.forWorkspace(workspace);
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/dashboard', async (req) => req.desk.dashboard());

  // ── applications ──────────────────────────────────────────────────────────
  app.get('/api/applications', async (req) => req.desk.listApplications());

  app.post('/api/applications', async (req, reply) => {
    const app = await req.desk.addApplication(NewApplication.parse(req.body));
    return reply.status(201).send(app);
  });

  app.get('/api/applications/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.getApplicationDetail(id);
  });

  app.patch('/api/applications/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.updateApplication(id, ApplicationPatch.parse(req.body));
  });

  app.post('/api/applications/:id/status', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { status } = z.object({ status: Status }).parse(req.body);
    return req.desk.setStatus(id, status);
  });

  app.post('/api/applications/:id/flags', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { flag, on } = z.object({ flag: z.enum(FLAGS), on: z.boolean() }).parse(req.body);
    return on ? req.desk.flag(id, flag) : req.desk.unflag(id, flag);
  });

  /** A posting read off a page. 201 when added, 200 with `duplicate: true` when already tracked. */
  app.post('/api/capture', async (req, reply) => {
    const result = await req.desk.capturePosting(CapturePosting.parse(req.body));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/api/applications/:id/notes', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(await req.desk.addNote(id, text));
  });

  app.post('/api/applications/:id/interviews', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({ at: z.number(), round: z.string().optional(), location: z.string().optional() })
      .parse(req.body);
    return reply.status(201).send(await req.desk.scheduleInterview(id, body));
  });

  // ── contacts & outreach ───────────────────────────────────────────────────
  app.get('/api/contacts', async (req) => req.desk.listContacts());

  app.post('/api/contacts', async (req, reply) => {
    return reply.status(201).send(await req.desk.addContact(NewContact.parse(req.body)));
  });

  app.get('/api/contacts/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.getContactDetail(id);
  });

  app.post('/api/outreach', async (req, reply) => {
    return reply.status(201).send(await req.desk.logOutreach(OutreachBody.parse(req.body)));
  });

  app.post('/api/responses', async (req, reply) => {
    return reply.status(201).send(await req.desk.logResponse(ResponseBody.parse(req.body)));
  });

  // ── views, reports & exports ──────────────────────────────────────────────
  app.get('/api/views', async (req) => req.desk.views.list());

  app.post('/api/views', async (req, reply) => {
    return reply.status(201).send(await req.desk.views.create(NewView.parse(req.body)));
  });

  app.patch('/api/views/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.views.update(id, ViewPatch.parse(req.body));
  });

  app.delete('/api/views/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await req.desk.views.remove(id);
    return reply.status(204).send();
  });

  app.get('/api/report', async (req) => {
    const { view } = z.object({ view: z.string().min(1).optional() }).parse(req.query);
    return req.desk.report({ viewId: view });
  });

  app.post('/api/report', async (req) => req.desk.report(ReportBody.parse(req.body)));

  app.get('/api/export.csv', async (req, reply) => {
    const { view, spec } = ExportQuery.parse(req.query);
    const input = { viewId: view, spec };
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', attachment(await exportName(req.desk, input), 'csv'))
      .send(await req.desk.exportCsv(input));
  });

  app.get('/api/export.xlsx', async (req, reply) => {
    const { view, spec } = ExportQuery.parse(req.query);
    const input = { viewId: view, spec };
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', attachment(await exportName(req.desk, input), 'xlsx'))
      .send(await req.desk.exportXlsx(input));
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
async function exportName(
  desk: Offerdesk,
  input: { viewId?: string; spec?: unknown },
): Promise<string> {
  const name = input.viewId
    ? (await desk.views.get(input.viewId)).name
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
