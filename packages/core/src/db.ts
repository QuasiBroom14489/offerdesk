import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema. Entity tables hold descriptive, editable facts (a role's title, a
 * contact's email). The `events` table holds what *happened* and is
 * append-only — status is never a column, it is folded from events.
 * See docs/decisions/0001-sqlite-and-an-event-log.md.
 */
const MIGRATIONS: string[] = [
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
];

export type Db = DatabaseSync;

/** Open (and migrate) a database. Pass `:memory:` for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
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
