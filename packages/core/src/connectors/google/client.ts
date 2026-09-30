import type { CredentialStore } from '../types.js';
import {
  type Fetch,
  GoogleAuthError,
  type GoogleConfig,
  type GoogleTokens,
  refreshTokens,
} from './oauth.js';

/** Refresh this long before Google's stated expiry, to absorb clock skew and latency. */
const EXPIRY_MARGIN_MS = 60_000;

/** A Google API call that failed for a reason other than authorization. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/**
 * Authorized calls to Google's REST APIs for one workspace. Tokens are read
 * from, and refreshed tokens written back to, the CredentialStore; a dead grant
 * becomes a GoogleAuthError after `onAuthLost` has recorded it.
 */
export class GoogleClient {
  constructor(
    private readonly cfg: GoogleConfig,
    private readonly store: CredentialStore,
    private readonly workspaceId: string,
    private readonly fetchFn: Fetch,
    private readonly now: () => number,
    private readonly onAuthLost: (message: string) => Promise<void>,
  ) {}

  private async load(): Promise<GoogleTokens> {
    const secret = await this.store.get(this.workspaceId, 'google');
    if (!secret) throw new GoogleAuthError('Google is not connected');
    return secret as unknown as GoogleTokens;
  }

  private async refresh(tokens: GoogleTokens): Promise<GoogleTokens> {
    try {
      const fresh = await refreshTokens(this.cfg, this.fetchFn, tokens, this.now());
      await this.store.set(this.workspaceId, 'google', { ...fresh });
      return fresh;
    } catch (err) {
      if (err instanceof GoogleAuthError) await this.onAuthLost(err.message);
      throw err;
    }
  }

  /** A valid access token, refreshing first if it's about to expire. */
  async accessToken(): Promise<string> {
    let tokens = await this.load();
    if (tokens.expiresAt - EXPIRY_MARGIN_MS <= this.now()) tokens = await this.refresh(tokens);
    return tokens.accessToken;
  }

  /** An authorized request. A 401 gets one refresh and one retry. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) =>
      this.fetchFn(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send((await this.refresh(await this.load())).accessToken);
    if (res.status === 401) {
      await this.onAuthLost('Google rejected the stored credentials');
      throw new GoogleAuthError('Google rejected the stored credentials');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(res.status, body.error?.message ?? `Google returned ${res.status}`);
    }
    return res;
  }

  async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(url, init)).json()) as T;
  }
}
