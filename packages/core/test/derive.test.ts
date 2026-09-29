import type { AnyEvent } from '@offerdesk/shared';
import { describe, expect, it } from 'vitest';
import { foldApplication, followUpsDue, pipelineStats } from '../src/derive.js';

const DAY = 86_400_000;
let seq = 0;
function ev(e: Partial<AnyEvent> & Pick<AnyEvent, 'kind' | 'payload' | 'ts'>): AnyEvent {
  seq++;
  return { seq, id: `e${seq}`, applicationId: null, contactId: null, ...e } as AnyEvent;
}

describe('foldApplication', () => {
  it('starts from the created status and follows status changes', () => {
    const h = foldApplication([
      ev({ kind: 'application.created', applicationId: 'a', payload: { status: 'saved' }, ts: 1 }),
      ev({
        kind: 'status.changed',
        applicationId: 'a',
        payload: { from: 'saved', to: 'applied' },
        ts: 2,
      }),
      ev({
        kind: 'status.changed',
        applicationId: 'a',
        payload: { from: 'applied', to: 'interview' },
        ts: 5,
      }),
    ]);
    expect(h.status).toBe('interview');
    expect(h.statusSince).toBe(5);
    expect([...h.reached]).toEqual(['saved', 'applied', 'interview']);
    expect(h.responded).toBe(true);
  });

  it('counts an explicit response as responded even while still applied', () => {
    const h = foldApplication([
      ev({
        kind: 'application.created',
        applicationId: 'a',
        payload: { status: 'applied' },
        ts: 1,
      }),
      ev({ kind: 'response.received', applicationId: 'a', payload: { channel: 'email' }, ts: 3 }),
    ]);
    expect(h.status).toBe('applied');
    expect(h.responded).toBe(true);
    expect(h.lastActivityAt).toBe(3);
  });
});

describe('followUpsDue', () => {
  const now = 30 * DAY;

  it('flags an application left in applied past the threshold', () => {
    const due = followUpsDue(
      [
        ev({
          kind: 'application.created',
          applicationId: 'a',
          payload: { status: 'applied' },
          ts: now - 8 * DAY,
        }),
      ],
      { now, afterDays: 7 },
    );
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'application', applicationId: 'a', daysWaiting: 8 });
  });

  it('does not flag an application that is still inside the window', () => {
    const due = followUpsDue(
      [
        ev({
          kind: 'application.created',
          applicationId: 'a',
          payload: { status: 'applied' },
          ts: now - 3 * DAY,
        }),
      ],
      { now, afterDays: 7 },
    );
    expect(due).toEqual([]);
  });

  it('resets the clock when we follow up ourselves', () => {
    const due = followUpsDue(
      [
        ev({
          kind: 'application.created',
          applicationId: 'a',
          payload: { status: 'applied' },
          ts: now - 20 * DAY,
        }),
        ev({
          kind: 'outreach.sent',
          applicationId: 'a',
          payload: { channel: 'email' },
          ts: now - 2 * DAY,
        }),
      ],
      { now, afterDays: 7 },
    );
    expect(due).toEqual([]);
  });

  it('clears once the company responds', () => {
    const due = followUpsDue(
      [
        ev({
          kind: 'application.created',
          applicationId: 'a',
          payload: { status: 'applied' },
          ts: now - 20 * DAY,
        }),
        ev({
          kind: 'response.received',
          applicationId: 'a',
          payload: { channel: 'email' },
          ts: now - 10 * DAY,
        }),
      ],
      { now, afterDays: 7 },
    );
    expect(due).toEqual([]);
  });

  it('flags unanswered outreach to a contact, and clears it on reply', () => {
    const sent = ev({
      kind: 'outreach.sent',
      contactId: 'c',
      payload: { channel: 'linkedin' },
      ts: now - 9 * DAY,
    });
    expect(followUpsDue([sent], { now, afterDays: 7 })).toMatchObject([
      { kind: 'contact', contactId: 'c', daysWaiting: 9 },
    ]);
    const reply = ev({
      kind: 'response.received',
      contactId: 'c',
      payload: { channel: 'linkedin' },
      ts: now - 1 * DAY,
    });
    expect(followUpsDue([sent, reply], { now, afterDays: 7 })).toEqual([]);
  });
});

describe('pipelineStats', () => {
  it('computes response rate over submitted applications only', () => {
    const histories = [
      foldApplication([
        ev({
          kind: 'application.created',
          applicationId: 'a',
          payload: { status: 'saved' },
          ts: 1,
        }),
      ]),
      foldApplication([
        ev({
          kind: 'application.created',
          applicationId: 'b',
          payload: { status: 'applied' },
          ts: 1,
        }),
      ]),
      foldApplication([
        ev({
          kind: 'application.created',
          applicationId: 'c',
          payload: { status: 'applied' },
          ts: 1,
        }),
        ev({
          kind: 'status.changed',
          applicationId: 'c',
          payload: { from: 'applied', to: 'rejected' },
          ts: 2,
        }),
      ]),
      foldApplication([
        ev({
          kind: 'application.created',
          applicationId: 'd',
          payload: { status: 'applied' },
          ts: 1,
        }),
        ev({
          kind: 'status.changed',
          applicationId: 'd',
          payload: { from: 'applied', to: 'interview' },
          ts: 2,
        }),
        ev({
          kind: 'status.changed',
          applicationId: 'd',
          payload: { from: 'interview', to: 'offer' },
          ts: 3,
        }),
      ]),
    ];
    const s = pipelineStats(histories);
    expect(s.total).toBe(4);
    expect(s.submitted).toBe(3);
    expect(s.responded).toBe(2);
    expect(s.responseRate).toBeCloseTo(2 / 3);
    expect(s.interviews).toBe(1);
    expect(s.offers).toBe(1);
    expect(s.byStatus).toMatchObject({ saved: 1, applied: 1, rejected: 1, offer: 1 });
  });

  it('reports a null response rate before anything is submitted', () => {
    expect(pipelineStats([]).responseRate).toBeNull();
  });
});
