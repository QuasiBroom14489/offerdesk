import { randomUUID } from 'node:crypto';
import {
  type AnyEvent,
  type EventKind,
  EventPayloads,
  type NewEvent,
  type OfferdeskEvent,
} from '@offerdesk/shared';
import type { Db } from './db.js';

interface EventRow {
  seq: number;
  id: string;
  ts: number;
  kind: string;
  application_id: string | null;
  contact_id: string | null;
  payload: string;
}

function fromRow(row: EventRow): AnyEvent {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    kind: row.kind as EventKind,
    applicationId: row.application_id,
    contactId: row.contact_id,
    payload: JSON.parse(row.payload),
  } as AnyEvent;
}

/** The only write path for events. Payloads are validated before they land. */
export class EventLog {
  constructor(private readonly db: Db) {}

  append<K extends EventKind>(ev: NewEvent<K>): OfferdeskEvent<K> {
    const payload = EventPayloads[ev.kind].parse(ev.payload) as OfferdeskEvent<K>['payload'];
    const id = randomUUID();
    const ts = ev.ts ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO events (id, ts, kind, application_id, contact_id, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ts,
        ev.kind,
        ev.applicationId ?? null,
        ev.contactId ?? null,
        JSON.stringify(payload),
      );
    return {
      seq: Number(info.lastInsertRowid),
      id,
      ts,
      kind: ev.kind,
      applicationId: ev.applicationId ?? null,
      contactId: ev.contactId ?? null,
      payload,
    };
  }

  all(): AnyEvent[] {
    return (
      this.db.prepare('SELECT * FROM events ORDER BY ts, seq').all() as unknown as EventRow[]
    ).map(fromRow);
  }

  forApplication(applicationId: string): AnyEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE application_id = ? ORDER BY ts, seq')
        .all(applicationId) as unknown as EventRow[]
    ).map(fromRow);
  }

  forContact(contactId: string): AnyEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE contact_id = ? ORDER BY ts, seq')
        .all(contactId) as unknown as EventRow[]
    ).map(fromRow);
  }

  recent(limit: number): AnyEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events ORDER BY ts DESC, seq DESC LIMIT ?')
        .all(limit) as unknown as EventRow[]
    ).map(fromRow);
  }
}
