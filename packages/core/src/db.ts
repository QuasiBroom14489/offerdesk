import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
];

export type Db = DatabaseSync;

/** Open (and migrate) a database. Pass `:memory:` for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  // The web server and the MCP server share one file; wait briefly for a lock
  // instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= MIGRATIONS.length) return;
  // Table rebuilds need foreign keys off, and the pragma is a no-op inside a
  // transaction — so toggle it around the loop and verify integrity after.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      transaction(db, () => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) {
      throw new Error(`migration left ${broken.length} broken foreign key(s)`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Run `fn` atomically. Reentrant: a nested call joins the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
