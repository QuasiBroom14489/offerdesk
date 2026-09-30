import { UnavailableError } from '../../errors.js';
import type { Connections } from '../connections.js';
import type { ConnectionStatus, CredentialStore } from '../types.js';
import { GoogleClient } from './client.js';
import {
  authorizationUrl,
  exchangeCode,
  type Fetch,
  type GoogleConfig,
  type GoogleTokens,
  OAuthStateError,
  openState,
  revokeTokens,
} from './oauth.js';
import { GoogleSheets } from './sheets.js';

const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';

/** What the Connections page shows for Google. */
export interface GoogleStatus {
  /** This deployment has an OAuth client and somewhere to keep tokens. */
  available: boolean;
  status: ConnectionStatus;
  email: string | null;
  lastError: string | null;
}

/**
 * Connecting, checking and disconnecting one workspace's Google account
 * (ADR 0007). Sheets push and Drive import build on `client()`.
 */
export class GoogleService {
  constructor(
    private readonly cfg: GoogleConfig | null,
    private readonly store: CredentialStore | null,
    private readonly connections: Connections,
    private readonly workspaceId: string,
    private readonly fetchFn: Fetch,
    private readonly now: () => number,
  ) {}

  get available(): boolean {
    return this.cfg !== null && this.store !== null;
  }

  private require(): { cfg: GoogleConfig; store: CredentialStore } {
    if (!this.cfg) throw new UnavailableError('Google is not configured on this server');
    if (!this.store) {
      throw new UnavailableError('no credential store here (set OFFERDESK_CREDENTIALS_KEY)');
    }
    return { cfg: this.cfg, store: this.store };
  }

  async status(): Promise<GoogleStatus> {
    const conn = await this.connections.get('google');
    return {
      available: this.available,
      status: conn?.status ?? 'disconnected',
      email: (conn?.config.email as string | undefined) ?? null,
      lastError: conn?.lastError ?? null,
    };
  }

  /** The Google consent URL to send this workspace's browser to. */
  start(redirectUri: string): string {
    const { cfg } = this.require();
    return authorizationUrl(cfg, { workspaceId: this.workspaceId, redirectUri, now: this.now() });
  }

  /**
   * Finish the flow Google redirected back from. The sealed state must have been
   * minted for this workspace and this redirect URI, so another account's
   * half-finished flow can't land here.
   */
  async finish(opts: { code: string; state: string; redirectUri: string }): Promise<GoogleStatus> {
    const { cfg, store } = this.require();
    const state = openState(cfg, opts.state, this.now());
    if (state.w !== this.workspaceId) {
      throw new OAuthStateError('this Google sign-in was started by another account');
    }
    if (state.r !== opts.redirectUri) throw new OAuthStateError('redirect URI mismatch');
    const tokens = await exchangeCode(cfg, this.fetchFn, {
      code: opts.code,
      verifier: state.v,
      redirectUri: opts.redirectUri,
      now: this.now(),
    });
    await store.set(this.workspaceId, 'google', { ...tokens });
    const about = await this.client().json<{ user?: { emailAddress?: string } }>(ABOUT_URL);
    await this.connections.upsert(
      'google',
      { email: about.user?.emailAddress ?? null },
      'connected',
    );
    await this.connections.recordSync('google', { ok: true });
    return this.status();
  }

  /** Cheap liveness check: an authorized call that touches no files. */
  async check(): Promise<GoogleStatus> {
    try {
      await this.client().json(ABOUT_URL);
      await this.connections.recordSync('google', { ok: true });
    } catch (err) {
      await this.connections.recordSync('google', { ok: false, error: (err as Error).message });
    }
    return this.status();
  }

  /** Revoke at Google (best effort), then forget the tokens and the connection. */
  async disconnect(): Promise<void> {
    const { store } = this.require();
    const secret = await store.get(this.workspaceId, 'google');
    if (secret) await revokeTokens(this.fetchFn, secret as unknown as GoogleTokens);
    await store.delete(this.workspaceId, 'google');
    await this.connections.remove('google');
  }

  /** Spreadsheets in the workspace's Drive (ADR 0007). */
  sheets(): GoogleSheets {
    return new GoogleSheets(this.client());
  }

  /** Authorized API access. A dead grant marks the connection as needing a reconnect. */
  client(): GoogleClient {
    const { cfg, store } = this.require();
    return new GoogleClient(cfg, store, this.workspaceId, this.fetchFn, this.now, (message) =>
      this.connections.recordSync('google', {
        ok: false,
        error: `Reconnect Google: ${message}`,
      }),
    );
  }
}
