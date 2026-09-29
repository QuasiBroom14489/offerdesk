import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { type Connection, type ConnectionStatus, PROVIDERS, type Provider } from './types.js';

interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  config: string;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
}

function fromRow(r: ConnectionRow): Connection {
  return {
    id: r.id,
    provider: r.provider as Provider,
    status: r.status as ConnectionStatus,
    config: JSON.parse(r.config),
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

/**
 * Which services a workspace has connected, and how the last sync went.
 * One row per provider per workspace. Secrets live in a CredentialStore.
 */
export class Connections {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<Connection[]> {
    const rows = await this.db.all<ConnectionRow>(
      'SELECT * FROM connections WHERE workspace_id = ? ORDER BY provider',
      this.workspaceId,
    );
    return rows.map(fromRow);
  }

  async get(provider: Provider): Promise<Connection | null> {
    const row = await this.db.get<ConnectionRow>(
      'SELECT * FROM connections WHERE workspace_id = ? AND provider = ?',
      this.workspaceId,
      provider,
    );
    return row ? fromRow(row) : null;
  }

  /** Create or update a provider's settings. */
  async upsert(
    provider: Provider,
    config: Record<string, unknown>,
    status: ConnectionStatus,
  ): Promise<Connection> {
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider: ${provider}`);
    await this.db.run(
      `INSERT INTO connections (id, workspace_id, provider, status, config, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, provider)
       DO UPDATE SET status = excluded.status, config = excluded.config, last_error = NULL`,
      randomUUID(),
      this.workspaceId,
      provider,
      status,
      JSON.stringify(config),
      this.now(),
    );
    return (await this.get(provider)) as Connection;
  }

  async recordSync(
    provider: Provider,
    result: { ok: true } | { ok: false; error: string },
  ): Promise<void> {
    await this.db.run(
      `UPDATE connections
       SET status = ?, last_synced_at = CASE WHEN ? THEN ? ELSE last_synced_at END, last_error = ?
       WHERE workspace_id = ? AND provider = ?`,
      result.ok ? 'connected' : 'error',
      result.ok ? 1 : 0,
      this.now(),
      result.ok ? null : result.error,
      this.workspaceId,
      provider,
    );
  }

  async remove(provider: Provider): Promise<void> {
    await this.db.run(
      'DELETE FROM connections WHERE workspace_id = ? AND provider = ?',
      this.workspaceId,
      provider,
    );
  }
}
