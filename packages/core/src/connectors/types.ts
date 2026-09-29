import type { Offerdesk } from '../offerdesk.js';

/**
 * Connectors bring outside data in (files, notes, mail) or push OfferDesk data
 * out (sheets, vault notes). Each one is a small adapter behind this interface,
 * so the service can grow providers without the core knowing any vendor SDK.
 * See docs/decisions/0002-local-first-service-ready.md.
 */

export const PROVIDERS = ['obsidian', 'google', 'gmail', 'dropbox'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Capability = 'files' | 'notes' | 'mail' | 'sheets';

export type ConnectionStatus = 'disconnected' | 'connected' | 'error';

export interface Connection {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  /** Non-secret settings, e.g. a vault path or a Drive folder id. */
  config: Record<string, unknown>;
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface SyncResult {
  /** Human-readable lines for the UI and logs: "Imported 3 notes". */
  summary: string[];
  /** Suggestions that need the user's confirmation before anything is written. */
  suggestions?: unknown[];
}

export interface ConnectorContext {
  desk: Offerdesk;
  connection: Connection;
  credentials: CredentialStore;
  now: () => number;
}

export interface Connector {
  readonly provider: Provider;
  readonly capabilities: readonly Capability[];
  /** Cheap check that the connection still works (token valid, path exists). */
  check(ctx: ConnectorContext): Promise<ConnectionStatus>;
  sync(ctx: ConnectorContext): Promise<SyncResult>;
}

/** OAuth tokens or API keys. Opaque to the core; each connector knows its own shape. */
export type Secret = Record<string, unknown>;

/**
 * Where secrets live. Never the SQLite database and never git: locally the
 * macOS Keychain (or a 0600 file), in a hosted deployment an encrypted store.
 */
export interface CredentialStore {
  get(workspaceId: string, provider: Provider): Promise<Secret | null>;
  set(workspaceId: string, provider: Provider, secret: Secret): Promise<void>;
  delete(workspaceId: string, provider: Provider): Promise<void>;
}
