import { type Fetch, MemoryCredentialStore, Offerdesk } from '@offerdesk/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';

const CALLBACK = 'http://localhost:5417/api/connections/google/callback';

/** Google's token endpoint and Drive `about`, faked. */
const fakeGoogle: Fetch = async (input, init) => {
  const url = String(input);
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token') {
    const code = new URLSearchParams(init?.body as URLSearchParams).get('code');
    if (code !== 'good-code')
      return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
    return json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  }
  if (url.includes('/revoke')) return json(200, {});
  if (url.includes('/drive/v3/about'))
    return json(200, { user: { emailAddress: 'me@example.com' } });
  return json(404, {});
};

describe('connections API', () => {
  let desk: Offerdesk;
  let app: FastifyInstance;
  /** Who the next request is signed in as; null is signed out. */
  let signedIn: string | null;

  beforeEach(async () => {
    signedIn = 'user_a';
    desk = await Offerdesk.open(':memory:', {
      credentials: new MemoryCredentialStore(),
      google: { clientId: 'cid', clientSecret: 'secret' },
      fetch: fakeGoogle,
    });
    app = buildServer(desk, { auth: () => signedIn });
  });
  afterEach(async () => {
    await app.close();
    desk.close();
  });

  const start = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/google/start',
      headers: { host: 'localhost:5417' },
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    return url.searchParams.get('state') as string;
  };
  const callback = (query: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: `/api/connections/google/callback?${new URLSearchParams(query)}`,
      headers: { host: 'localhost:5417' },
    });
  const outcome = (res: { headers: Record<string, unknown> }) =>
    Object.fromEntries(new URL(String(res.headers.location), 'http://x').searchParams);

  it('connects end to end and shows the account', async () => {
    const state = await start();
    const res = await callback({ code: 'good-code', state });
    expect(res.statusCode).toBe(302);
    expect(outcome(res)).toEqual({ google: 'connected' });

    const list = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(list.json().google).toMatchObject({ status: 'connected', email: 'me@example.com' });
  });

  it('refuses to finish a flow in a different signed-in workspace', async () => {
    const state = await start();
    signedIn = 'user_b';
    const res = await callback({ code: 'good-code', state });
    expect(outcome(res)).toMatchObject({
      google: 'error',
      reason: expect.stringMatching(/another account/),
    });
    signedIn = 'user_a';
    const list = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(list.json().google.status).toBe('disconnected');
  });

  it('sends a signed-out callback back with a message, not a 401', async () => {
    const state = await start();
    signedIn = null;
    const res = await callback({ code: 'good-code', state });
    expect(res.statusCode).toBe(302);
    expect(outcome(res)).toMatchObject({
      google: 'error',
      reason: expect.stringMatching(/sign in/),
    });
  });

  it('reports a declined consent and a dead code', async () => {
    expect(outcome(await callback({ error: 'access_denied' }))).toMatchObject({ google: 'denied' });
    const state = await start();
    expect(outcome(await callback({ code: 'stale', state }))).toEqual({
      google: 'error',
      reason: 'Bad code',
    });
  });

  it('disconnects', async () => {
    await callback({ code: 'good-code', state: await start() });
    const res = await app.inject({ method: 'DELETE', url: '/api/connections/google' });
    expect(res.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(list.json().google.status).toBe('disconnected');
  });

  it('answers 503 to start where Google is not configured', async () => {
    const bare = await Offerdesk.open(':memory:');
    const bareApp = buildServer(bare);
    const res = await bareApp.inject({ method: 'POST', url: '/api/connections/google/start' });
    expect(res.statusCode).toBe(503);
    const list = await bareApp.inject({ method: 'GET', url: '/api/connections' });
    expect(list.json().google.available).toBe(false);
    await bareApp.close();
    bare.close();
  });
});

describe('view sheets API', () => {
  it('reports no sheet, maps a dead Google grant to 409, and 503s without Google', async () => {
    const credentials = new MemoryCredentialStore();
    const desk = await Offerdesk.open(':memory:', {
      credentials,
      google: { clientId: 'cid', clientSecret: 'secret' },
      fetch: fakeGoogle,
    });
    const app = buildServer(desk);

    const none = await app.inject({ method: 'GET', url: '/api/views/everything/sheet' });
    expect(none.json()).toEqual({ sheet: null });
    expect((await app.inject({ method: 'GET', url: '/api/views/nope/sheet' })).statusCode).toBe(
      404,
    );

    // Google set up here but never connected: reconnect, not sign in.
    const push = await app.inject({ method: 'POST', url: '/api/views/everything/sheet' });
    expect(push.statusCode).toBe(409);
    expect(push.json()).toMatchObject({ reconnect: 'google' });

    const bare = await Offerdesk.open(':memory:');
    const bareApp = buildServer(bare);
    const off = await bareApp.inject({ method: 'POST', url: '/api/views/everything/sheet' });
    expect(off.statusCode).toBe(503);

    await Promise.all([app.close(), bareApp.close()]);
    desk.close();
    bare.close();
  });
});

describe('Drive API', () => {
  it('validates imports and needs Picker keys for the picker', async () => {
    const desk = await Offerdesk.open(':memory:', {
      credentials: new MemoryCredentialStore(),
      google: { clientId: 'cid', clientSecret: 'secret' },
      fetch: fakeGoogle,
    });
    const app = buildServer(desk);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/documents/import-drive',
      payload: { fileIds: [] },
    });
    expect(empty.statusCode).toBe(400);
    const picker = await app.inject({ method: 'GET', url: '/api/connections/google/picker' });
    expect(picker.statusCode).toBe(503);
    expect(picker.json().error).toMatch(/GOOGLE_API_KEY/);
    await app.close();
    desk.close();
  });
});
