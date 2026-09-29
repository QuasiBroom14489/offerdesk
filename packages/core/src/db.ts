import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type Client, createClient, type Transaction } from '@libsql/client';

/**
 * Schema. Entity tables hold descriptive, editable facts (a role's title, a
 * contact's email). The `events` table holds what *happened* and is
 * append-only — status is never a column, it is folded from events.
 * See docs/decisions/0001-sqlite-and-an-event-log.md.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE companies (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    website    TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE applications (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id),
    role        TEXT NOT NULL,
    posting_url TEXT,
    location    TEXT,
    season      TEXT,
    deadline    TEXT,
    source      TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_applications_company ON applications(company_id);

  CREATE TABLE contacts (
    id         TEXT PRIMARY KEY,
    company_id TEXT REFERENCES companies(id),
    name       TEXT NOT NULL,
    title      TEXT,
    email      TEXT,
    linkedin   TEXT,
    how_met    TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_contacts_company ON contacts(company_id);

  CREATE TABLE events (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT    NOT NULL UNIQUE,
    ts             INTEGER NOT NULL,
    kind           TEXT    NOT NULL,
    application_id TEXT REFERENCES applications(id),
    contact_id     TEXT REFERENCES contacts(id),
    payload        TEXT    NOT NULL
  );
  CREATE INDEX idx_events_application ON events(application_id, seq);
  CREATE INDEX idx_events_contact     ON events(contact_id, seq);
  CREATE INDEX idx_events_kind_ts     ON events(kind, ts);

  -- The log is append-only; enforce it in the database, not by convention.
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
  // v2 — service-ready seams (ADR 0002). Every row belongs to a workspace;
  // a local install is the single workspace 'local'. Company names become
  // unique per workspace, which needs a table rebuild in SQLite.
  `
  CREATE TABLE companies_v2 (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT 'local',
    name         TEXT NOT NULL COLLATE NOCASE,
    website      TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (workspace_id, name)
  );
  INSERT INTO companies_v2 (id, name, website, created_at)
    SELECT id, name, website, created_at FROM companies;
  DROP TABLE companies;
  ALTER TABLE companies_v2 RENAME TO companies;

  ALTER TABLE applications ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE contacts     ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE events       ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
  -- Provenance: who or what recorded the fact (manual, vesper, gmail, obsidian, drive).
  ALTER TABLE events       ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

  CREATE INDEX idx_applications_workspace ON applications(workspace_id, created_at);
  CREATE INDEX idx_contacts_workspace     ON contacts(workspace_id);
  CREATE INDEX idx_events_workspace       ON events(workspace_id, ts, seq);

  -- Connected services. Mutable configuration, not history, so not events.
  -- Credentials are never stored here; see CredentialStore.
  CREATE TABLE connections (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL DEFAULT 'local',
    provider       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'disconnected',
    config         TEXT NOT NULL DEFAULT '{}',
    last_synced_at INTEGER,
    last_error     TEXT,
    created_at     INTEGER NOT NULL,
    UNIQUE (workspace_id, provider)
  );
  `,
  // v3 — saved table views (ADR 0004). Configuration, not history, so a
  // mutable row. `spec` is a JSON ViewSpec; presets live in code, not here.
  `
  CREATE TABLE views (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT 'local',
    name         TEXT NOT NULL COLLATE NOCASE,
    spec         TEXT NOT NULL,
    sheet_id     TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (workspace_id, name)
  );
  `,
];

/** A value SQLite can bind. */
export type SqlArg = string | number | bigint | null;

/**
 * The only way core touches the database: libSQL, which opens a local file,
 * `:memory:` for tests, or a hosted Turso database (ADR 0005). Every call
 * inside `transaction()` runs on that transaction, wherever it is awaited.
 */
export interface Db {
  all<T>(sql: string, ...args: SqlArg[]): Promise<T[]>;
  get<T>(sql: string, ...args: SqlArg[]): Promise<T | undefined>;
  run(sql: string, ...args: SqlArg[]): Promise<{ changes: number; lastInsertRowid: number }>;
  /** Run a script of statements with no parameters. */
  exec(sql: string): Promise<void>;
  /** Run `fn` atomically. Reentrant: a nested call joins the outer transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

class LibsqlDb implements Db {
  /** The open transaction for the current async call chain, if any. */
  private readonly tx = new AsyncLocalStorage<Transaction>();

  constructor(private readonly client: Client) {}

  private get target(): Client | Transaction {
    return this.tx.getStore() ?? this.client;
  }

  async all<T>(sql: string, ...args: SqlArg[]): Promise<T[]> {
    const rs = await this.target.execute({ sql, args });
    return rs.rows as unknown as T[];
  }

  async get<T>(sql: string, ...args: SqlArg[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...args))[0];
  }

  async run(sql: string, ...args: SqlArg[]) {
    const rs = await this.target.execute({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.target.executeMultiple(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    const tx = await this.client.transaction('write');
    try {
      const out = await this.tx.run(tx, fn);
      await tx.commit();
      return out;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  }

  close(): void {
    this.client.close();
  }
}

/**
 * Open (and migrate) a database: a file path, `:memory:`, or a `libsql://`
 * URL with its auth token.
 */
export async function openDb(location: string, authToken?: string): Promise<Db> {
  const remote = /^(libsql|https?|wss?):/.test(location);
  const url = remote || location === ':memory:' ? location : fileUrl(location);
  // Two local processes (web and MCP) can share one file: wait for a lock
  // instead of failing with SQLITE_BUSY. libSQL turns foreign keys on per connection.
  const db = new LibsqlDb(createClient({ url, authToken, timeout: 5000 }));
  if (url.startsWith('file:')) await db.exec('PRAGMA journal_mode = WAL');
  await migrate(db);
  return db;
}

function fileUrl(path: string): string {
  const file = path.startsWith('file:') ? path.slice(5) : resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  return `file:${file}`;
}

async function migrate(db: Db): Promise<void> {
  // Hosted SQLite may read `PRAGMA user_version` but not set it, so applied
  // migrations are rows. Databases from before this table recorded their
  // version in user_version; carry it over once.
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  let current =
    (await db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations'))?.v ?? 0;
  if (current === 0) {
    const legacy =
      (await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    for (let v = 1; v <= legacy; v++) {
      await db.run('INSERT INTO schema_migrations VALUES (?, 0)', v);
    }
    current = legacy;
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Table rebuilds need foreign keys off, and the pragma is a no-op inside a
    // transaction, so it wraps BEGIN/COMMIT in the same script (one connection).
    try {
      await db.exec(
        `PRAGMA foreign_keys = OFF; BEGIN; ${MIGRATIONS[v]}; INSERT INTO schema_migrations VALUES (${v + 1}, ${Date.now()}); COMMIT; PRAGMA foreign_keys = ON;`,
      );
    } catch (err) {
      await db.exec('ROLLBACK; PRAGMA foreign_keys = ON;').catch(() => {});
      throw err;
    }
    const broken = await db.all('PRAGMA foreign_key_check');
    if (broken.length > 0) {
      throw new Error(`migration ${v + 1} left ${broken.length} broken foreign key(s)`);
    }
  }
}

/** Run `fn` atomically. Reentrant: a nested call joins the outer transaction. */
export function transaction<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
