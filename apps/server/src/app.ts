import { existsSync } from 'node:fs';
import { clerkPlugin, getAuth } from '@clerk/fastify';
import fastifyStatic from '@fastify/static';
import {
  ConflictError,
  GoogleApiError,
  GoogleAuthError,
  isoDate,
  NotFoundError,
  OAuthStateError,
  type Offerdesk,
  UnavailableError,
} from '@offerdesk/core';
import {
  ApplicationPatch,
  CapturePosting,
  DocumentKind,
  DocumentPatch,
  FLAGS,
  MAX_DOCUMENT_BYTES,
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

/** Uploads are the raw file as the body; what describes it rides in the query string. */
const UploadQuery = z.object({
  filename: z.string().min(1),
  note: z.string().optional(),
});
const NewDocumentQuery = UploadQuery.extend({
  name: z.string().min(1),
  kind: DocumentKind.optional(),
});

const DriveImportBody = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(10),
  kind: DocumentKind.optional(),
  applicationId: z.string().min(1).optional(),
});

const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)(;|$)/i;

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
    if (err instanceof UnavailableError) {
      return reply.status(503).send({ error: err.message });
    }
    // Not 401: that means "sign in to OfferDesk"; this means "reconnect Google".
    if (err instanceof GoogleAuthError) {
      return reply.status(409).send({ error: err.message, reconnect: 'google' });
    }
    if (err instanceof GoogleApiError) {
      return reply.status(502).send({ error: `Google: ${err.message}` });
    }
    // Fastify's own client errors: unsupported media type, body too large, bad JSON.
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.status(413).send({ error: 'the file is larger than 4 MB' });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  // Resolve the caller's workspace once per request, before any handler runs.
  let workspaceFor: (req: FastifyRequest) => string | null | Promise<string | null>;
  if (opts.auth === 'clerk') {
    app.register(clerkPlugin, {
      hookName: 'onRequest',
      // The Vercel Clerk integration names the key the Next.js way.
      publishableKey:
        process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    });
    workspaceFor = (req) => getAuth(req).userId;
  } else {
    workspaceFor = opts.auth ?? (() => base.workspaceId);
  }
  app.decorateRequest('desk', null as unknown as Offerdesk);
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    // Google's redirect is a page load, not an API call: it signs itself in below.
    if (!path.startsWith('/api/') || path === '/api/health' || path === GOOGLE_CALLBACK) return;
    const workspace = await workspaceFor(req);
    if (!workspace) return reply.status(401).send({ error: 'sign in required' });
    req.desk = workspace === base.workspaceId ? base : base.forWorkspace(workspace);
  });

  /** `files` names the document store, or null when uploads aren't available here. */
  app.get('/api/health', async () => ({ ok: true, files: base.documents.storage }));

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

  app.post('/api/applications/:id/documents', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { documentId, versionId } = z
      .object({ documentId: z.string().min(1), versionId: z.string().min(1).optional() })
      .parse(req.body);
    return req.desk.attachDocument(id, documentId, { versionId });
  });

  app.delete('/api/applications/:id/documents/:documentId', async (req) => {
    const { id, documentId } = IdParams.extend({ documentId: z.string().min(1) }).parse(req.params);
    return req.desk.detachDocument(id, documentId);
  });

  // ── documents library (ADR 0006) ──────────────────────────────────────────
  app.get('/api/documents', async (req) => {
    const { archived } = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query);
    return req.desk.documents.list({ archived: archived === '1' });
  });

  app.get('/api/documents/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.documents.get(id);
  });

  app.patch('/api/documents/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.documents.update(id, DocumentPatch.parse(req.body));
  });

  // Raw-body uploads, in their own scope so every other route keeps JSON-only parsing.
  app.register(async (files) => {
    files.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES },
      (_req, body, done) => done(null, body),
    );

    files.post('/api/documents', async (req, reply) => {
      const q = NewDocumentQuery.parse(req.query);
      const doc = await req.desk.documents.create(
        { name: q.name, kind: q.kind },
        uploadBytes(req.body),
        { filename: q.filename, contentType: req.headers['content-type'], note: q.note },
      );
      return reply.status(201).send(doc);
    });

    files.post('/api/documents/:id/versions', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const q = UploadQuery.parse(req.query);
      const doc = await req.desk.documents.addVersion(id, uploadBytes(req.body), {
        filename: q.filename,
        contentType: req.headers['content-type'],
        note: q.note,
      });
      return reply.status(201).send(doc);
    });
  });

  /** A version's bytes, private to the signed-in workspace. `?download=1` saves instead of opening. */
  // Drive in and out (ADR 0007). Files picked in the Google Picker are imported
  // server side, so their bytes never pass through the 4.5 MB request limit.
  app.post('/api/documents/import-drive', async (req) => {
    const body = DriveImportBody.parse(req.body);
    return { results: await req.desk.importFromDrive(body) };
  });

  app.post('/api/documents/versions/:id/drive', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.saveVersionToDrive(id);
  });

  app.get('/api/documents/versions/:id/file', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { download } = z.object({ download: z.enum(['0', '1']).optional() }).parse(req.query);
    const { version, bytes } = await req.desk.documents.read(id);
    // Only types a browser shows safely open in a tab; anything else (HTML,
    // SVG) downloads, and the sandbox keeps it from running as our origin.
    const inline = download !== '1' && INLINE_TYPES.test(version.contentType);
    return reply
      .header('content-type', version.contentType)
      .header('content-disposition', contentDisposition(version.filename, !inline))
      .header('content-security-policy', 'sandbox')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
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

  // ── connections (ADR 0007) ────────────────────────────────────────────────
  app.get('/api/connections', async (req) => ({ google: await req.desk.google.status() }));

  /** Where to send the browser to connect Google; the web app navigates there. */
  app.post('/api/connections/google/start', async (req) => ({
    url: req.desk.google.start(`${publicOrigin(req)}${GOOGLE_CALLBACK}`),
  }));

  /**
   * Google sends the browser back here. The caller must be signed in to the
   * workspace that started the flow (the sealed state names it). Every outcome
   * lands on the Connections page with a message, never a JSON error.
   */
  app.get(GOOGLE_CALLBACK, async (req, reply) => {
    const back = (outcome: string, reason?: string) =>
      reply.redirect(
        `/settings?${new URLSearchParams({ google: outcome, ...(reason ? { reason } : {}) })}`,
      );
    const q = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    if (q.error) return back(q.error === 'access_denied' ? 'denied' : 'error', q.error);
    if (!q.code || !q.state) return back('error', 'Google sent no authorization code');
    const workspace = await workspaceFor(req);
    if (!workspace) return back('error', 'sign in to OfferDesk, then connect Google again');
    const desk = workspace === base.workspaceId ? base : base.forWorkspace(workspace);
    try {
      await desk.google.finish({
        code: q.code,
        state: q.state,
        redirectUri: `${publicOrigin(req)}${GOOGLE_CALLBACK}`,
      });
      return back('connected');
    } catch (err) {
      if (err instanceof OAuthStateError || err instanceof GoogleAuthError) {
        return back('error', err.message);
      }
      req.log.error(err);
      return back('error', 'something went wrong finishing the Google sign-in');
    }
  });

  /** A short-lived token and keys for the Google Picker, which runs in the browser. */
  app.get('/api/connections/google/picker', async (req) => req.desk.google.pickerConfig());

  app.post('/api/connections/google/check', async (req) => req.desk.google.check());

  app.delete('/api/connections/google', async (req, reply) => {
    await req.desk.google.disconnect();
    return reply.status(204).send();
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

  // A view's Google Sheet: its status, an on-demand push, and unlinking (ADR 0007).
  app.get('/api/views/:id/sheet', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { sheet: await req.desk.viewSheet(id) };
  });

  app.post('/api/views/:id/sheet', async (req) => {
    const { id } = IdParams.parse(req.params);
    return req.desk.pushViewToSheet(id);
  });

  app.delete('/api/views/:id/sheet', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await req.desk.unlinkViewSheet(id);
    return reply.status(204).send();
  });

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

const GOOGLE_CALLBACK = '/api/connections/google/callback';

/**
 * The origin the browser sees, for OAuth redirect URIs. `OFFERDESK_PUBLIC_URL`
 * pins it; otherwise the proxy's forwarded headers (Vercel), else the Host
 * header (local, including through Vite's proxy). Google only redirects to
 * URIs registered on the OAuth client, so a spoofed header goes nowhere.
 */
function publicOrigin(req: FastifyRequest): string {
  const pinned = process.env.OFFERDESK_PUBLIC_URL;
  if (pinned) return pinned.replace(/\/+$/, '');
  const first = (h: string | string[] | undefined) =>
    (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = first(req.headers['x-forwarded-host']) ?? req.headers.host;
  return `${proto}://${host}`;
}

function uploadBytes(body: unknown): Uint8Array {
  if (!Buffer.isBuffer(body))
    throw new z.ZodError([
      { code: 'custom', path: ['body'], message: 'send the file as the request body', input: body },
    ]);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/** An ASCII fallback plus the exact UTF-8 name (RFC 6266). */
function contentDisposition(filename: string, download: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function attachment(base: string, ext: string): string {
  return `attachment; filename="${base}.${ext}"`;
}
