import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fetch,
  GoogleAuthError,
  type GoogleConfig,
  googleConfigFromEnv,
  MemoryCredentialStore,
  OAuthStateError,
} from '../src/connectors/index.js';
import { UnavailableError } from '../src/errors.js';
import { Offerdesk } from '../src/offerdesk.js';

const cfg: GoogleConfig = { clientId: 'client-1', clientSecret: 'shh' };
const REDIRECT = 'http://localhost:5417/api/connections/google/callback';

/** Just enough of Google: the token endpoint, revoke, and Drive's `about`. */
class FakeGoogle {
  calls: { url: string; body: URLSearchParams | null; auth: string | null }[] = [];
  /** The one live access token; anything else gets a 401. */
  liveToken = 'access-1';
  refreshWorks = true;
  issued = 1;

  fetch: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ url, body, auth: headers.authorization ?? null });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url === 'https://oauth2.googleapis.com/token') {
      const grant = body?.get('grant_type');
      if (grant === 'authorization_code') {
        if (body?.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
        return json(200, {
          access_token: this.liveToken,
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
        });
      }
      if (!this.refreshWorks) {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
      }
      this.liveToken = `access-${++this.issued}`;
      return json(200, { access_token: this.liveToken, expires_in: 3600 });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    if (url.startsWith('https://www.googleapis.com/drive/v3/about')) {
      if (headers.authorization !== `Bearer ${this.liveToken}`) return json(401, {});
      return json(200, { user: { emailAddress: 'student@example.com' } });
    }
    return json(404, { error: { message: `unexpected ${url}` } });
  };

  tokenCalls(grant: string) {
    return this.calls.filter((c) => c.body?.get('grant_type') === grant);
  }
}

/** Run the consent redirect in reverse: pull `state` out of the auth URL. */
function stateFrom(url: string): string {
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error('no state in auth URL');
  return state;
}

describe('Google connection', () => {
  let clock: number;
  let google: FakeGoogle;
  let credentials: MemoryCredentialStore;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 1, 12);
    google = new FakeGoogle();
    credentials = new MemoryCredentialStore();
    desk = await Offerdesk.open(':memory:', {
      now: () => clock,
      credentials,
      google: cfg,
      fetch: google.fetch,
    });
  });
  afterEach(() => desk.close());

  const connect = async (d = desk) => {
    const url = d.google.start(REDIRECT);
    return d.google.finish({ code: 'good-code', state: stateFrom(url), redirectUri: REDIRECT });
  };

  it('builds a PKCE consent URL asking only for drive.file, offline', () => {
    const url = new URL(desk.google.start(REDIRECT));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client-1');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('connects: exchanges the code with its verifier, stores tokens, records the account', async () => {
    const status = await connect();
    expect(status).toEqual({
      available: true,
      status: 'connected',
      email: 'student@example.com',
      lastError: null,
    });
    const [exchange] = google.tokenCalls('authorization_code');
    expect(exchange?.body?.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(exchange?.body?.get('redirect_uri')).toBe(REDIRECT);
    expect(await credentials.get('local', 'google')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  });

  it('seals the state: the verifier and workspace never appear in the URL', async () => {
    const url = desk.google.start(REDIRECT);
    await desk.google.finish({ code: 'good-code', state: stateFrom(url), redirectUri: REDIRECT });
    const verifier = google.tokenCalls('authorization_code')[0]?.body?.get('code_verifier');
    expect(verifier).toBeTruthy();
    const decoded = Buffer.from(stateFrom(url), 'base64url').toString('latin1');
    for (const secret of [verifier as string, '"w":"local"']) {
      expect(url).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  it('rejects a state minted for another workspace', async () => {
    const theirs = desk.forWorkspace('attacker').google.start(REDIRECT);
    await expect(
      desk.google.finish({ code: 'good-code', state: stateFrom(theirs), redirectUri: REDIRECT }),
    ).rejects.toThrow(OAuthStateError);
    expect(google.tokenCalls('authorization_code')).toHaveLength(0);
  });

  it('rejects a tampered, expired, or re-pointed state', async () => {
    const state = stateFrom(desk.google.start(REDIRECT));
    const tampered = `${state.slice(0, -2)}${state.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(
      desk.google.finish({ code: 'good-code', state: tampered, redirectUri: REDIRECT }),
    ).rejects.toThrow(OAuthStateError);
    await expect(
      desk.google.finish({ code: 'good-code', state, redirectUri: 'https://evil.example/cb' }),
    ).rejects.toThrow(/redirect URI/);
    clock += 11 * 60 * 1000;
    await expect(
      desk.google.finish({ code: 'good-code', state, redirectUri: REDIRECT }),
    ).rejects.toThrow(/too long/);
  });

  it('refreshes an expired access token and saves the new one', async () => {
    await connect();
    clock += 2 * 3600 * 1000;
    expect(await desk.google.client().accessToken()).toBe('access-2');
    expect(await credentials.get('local', 'google')).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-1',
    });
  });

  it('retries once after a 401 with a refreshed token', async () => {
    await connect();
    google.liveToken = 'rotated-elsewhere';
    const status = await desk.google.check();
    expect(status.status).toBe('connected');
    expect(google.tokenCalls('refresh_token')).toHaveLength(1);
  });

  it('marks the connection for reconnecting when the grant is revoked', async () => {
    await connect();
    google.refreshWorks = false;
    clock += 2 * 3600 * 1000;
    await expect(desk.google.client().accessToken()).rejects.toThrow(GoogleAuthError);
    const status = await desk.google.status();
    expect(status.status).toBe('error');
    expect(status.lastError).toMatch(/^Reconnect Google: Token has been revoked/);
  });

  it('disconnects: revokes at Google and forgets everything', async () => {
    await connect();
    await desk.google.disconnect();
    expect(google.calls.some((c) => c.url.includes('/revoke?token=refresh-1'))).toBe(true);
    expect(await credentials.get('local', 'google')).toBeNull();
    expect((await desk.google.status()).status).toBe('disconnected');
  });

  it('keeps workspaces apart', async () => {
    await connect();
    const other = desk.forWorkspace('someone-else');
    expect((await other.google.status()).status).toBe('disconnected');
    await expect(other.google.client().accessToken()).rejects.toThrow(/not connected/);
  });

  it('is unavailable without an OAuth client or a credential store', async () => {
    const bare = await Offerdesk.open(':memory:', { credentials });
    expect((await bare.google.status()).available).toBe(false);
    expect(() => bare.google.start(REDIRECT)).toThrow(UnavailableError);
    const noStore = await Offerdesk.open(':memory:', { google: cfg });
    expect(() => noStore.google.start(REDIRECT)).toThrow(/OFFERDESK_CREDENTIALS_KEY/);
    bare.close();
    noStore.close();
  });
});

describe('googleConfigFromEnv', () => {
  it('needs both the client id and secret', () => {
    expect(googleConfigFromEnv({ GOOGLE_CLIENT_ID: 'x' })).toBeNull();
    expect(
      googleConfigFromEnv({
        GOOGLE_CLIENT_ID: 'x',
        GOOGLE_CLIENT_SECRET: 'y',
        GOOGLE_APP_ID: '42',
      }),
    ).toEqual({ clientId: 'x', clientSecret: 'y', apiKey: undefined, appId: '42' });
  });
});
