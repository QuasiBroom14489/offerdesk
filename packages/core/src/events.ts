import { randomUUID } from 'node:crypto';
import {
  type AnyEvent,
  type EventKind,
  EventPayloads,
  type EventSource,
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
  source: string;
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
    source: row.source as EventSource,
    payload: JSON.parse(row.payload),
  } as AnyEvent;
}

/**
 * The only write path for events, scoped to one workspace. Payloads are
 * validated before they land; reads never cross workspaces.
 */
export class EventLog {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string = 'local',
  ) {}

  append<K extends EventKind>(ev: NewEvent<K>): OfferdeskEvent<K> {
    const payload = EventPayloads[ev.kind].parse(ev.payload) as OfferdeskEvent<K>['payload'];
    const id = randomUUID();
    const ts = ev.ts ?? Date.now();
    const source = ev.source ?? 'manual';
    const info = this.db
      .prepare(
        `INSERT INTO events (id, workspace_id, ts, kind, application_id, contact_id, source, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspaceId,
        ts,
        ev.kind,
        ev.applicationId ?? null,
        ev.contactId ?? null,
        source,
        JSON.stringify(payload),
      );
    return {
      seq: Number(info.lastInsertRowid),
      id,
      ts,
      kind: ev.kind,
      applicationId: ev.applicationId ?? null,
      contactId: ev.contactId ?? null,
      source,
      payload,
    };
  }

  all(): AnyEvent[] {
    return this.select('ORDER BY ts, seq');
  }

  forApplication(applicationId: string): AnyEvent[] {
    return this.select('AND application_id = ? ORDER BY ts, seq', applicationId);
  }

  forContact(contactId: string): AnyEvent[] {
    return this.select('AND contact_id = ? ORDER BY ts, seq', contactId);
  }

  recent(limit: number): AnyEvent[] {
    return this.select('ORDER BY ts DESC, seq DESC LIMIT ?', limit);
  }

  private select(tail: string, ...params: (string | number)[]): AnyEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE workspace_id = ? ${tail}`)
      .all(this.workspaceId, ...params) as unknown as EventRow[];
    return rows.map(fromRow);
  }
}
