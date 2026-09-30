import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Google OAuth for a web server: authorization code + PKCE, offline access,
 * `drive.file` only (ADR 0007). Plain `fetch`, no SDK; tests inject a fake.
 */

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive.file'] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** How long a user has to finish Google's consent screen. */
const STATE_TTL_MS = 10 * 60 * 1000;

export type Fetch = typeof fetch;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Browser key for the Google Picker (HTTP-referrer restricted). */
  apiKey?: string;
  /** The Cloud project number; the Picker needs it to grant `drive.file` access. */
  appId?: string;
}

/** The OAuth client from the environment, or null when Google isn't set up here. */
export function googleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    apiKey: env.GOOGLE_API_KEY || undefined,
    appId: env.GOOGLE_APP_ID || undefined,
  };
}

/** What the CredentialStore keeps for Google. */
export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

/** Google refused the grant (revoked, expired, or the app lost access): reconnect. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** The OAuth `state` was forged, tampered with, expired, or meant for someone else. */
export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

interface StatePayload {
  /** Workspace that started the flow. */
  w: string;
  /** PKCE verifier. */
  v: string;
  /** Redirect URI, which the token exchange must repeat exactly. */
  r: string;
  /** Expiry, epoch ms. */
  e: number;
}

function stateKey(cfg: GoogleConfig): Buffer {
  return createHash('sha256').update(`offerdesk-oauth-state\0${cfg.clientSecret}`).digest();
}

/**
 * The flow's server-side memory, carried by Google and handed back: sealed with
 * AES-GCM so it can't be read (the PKCE verifier stays secret) or forged (the
 * workspace can't be swapped). Stateless, which suits serverless functions.
 */
export function sealState(cfg: GoogleConfig, payload: StatePayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKey(cfg), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openState(cfg: GoogleConfig, state: string, now: number): StatePayload {
  let payload: StatePayload;
  try {
    const raw = Buffer.from(state, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', stateKey(cfg), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    payload = JSON.parse(plain.toString('utf8')) as StatePayload;
  } catch {
    throw new OAuthStateError('invalid OAuth state');
  }
  if (payload.e < now) throw new OAuthStateError('the Google sign-in took too long; try again');
  return payload;
}

/** Where to send the browser, and the sealed state that will come back with it. */
export function authorizationUrl(
  cfg: GoogleConfig,
  opts: { workspaceId: string; redirectUri: string; now: number },
): string {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = sealState(cfg, {
    w: opts.workspaceId,
    v: verifier,
    r: opts.redirectUri,
    e: opts.now + STATE_TTL_MS,
  });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Offline + consent: Google only issues a refresh token when asked this way.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(fetchFn: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    // invalid_grant: the code or refresh token is dead. Anything else is ours or Google's.
    const message = data.error_description ?? data.error ?? `token endpoint returned ${res.status}`;
    if (data.error === 'invalid_grant') throw new GoogleAuthError(message);
    throw new Error(`Google token request failed: ${message}`);
  }
  return data;
}

/** Trade the callback's code for tokens. */
export async function exchangeCode(
  cfg: GoogleConfig,
  fetchFn: Fetch,
  opts: { code: string; verifier: string; redirectUri: string; now: number },
): Promise<GoogleTokens> {
  const data = await tokenRequest(fetchFn, {
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (!data.refresh_token) {
    throw new GoogleAuthError('Google did not grant offline access; try connecting again');
  }
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token,
    expiresAt: opts.now + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? GOOGLE_SCOPES.join(' '),
  };
}

/** A fresh access token. Google usually keeps the refresh token the same. */
export async function refreshTokens(
  cfg: GoogleConfig,
  fetchFn: Fetch,
  tokens: GoogleTokens,
  now: number,
): Promise<GoogleTokens> {
  const data = await tokenRequest(fetchFn, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? tokens.scope,
  };
}

/** Best effort: tell Google to forget the grant. Disconnecting succeeds either way. */
export async function revokeTokens(fetchFn: Fetch, tokens: GoogleTokens): Promise<void> {
  try {
    await fetchFn(`${REVOKE_URL}?${new URLSearchParams({ token: tokens.refreshToken })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    // Offline or already revoked: the local secret is deleted regardless.
  }
}
