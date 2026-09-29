import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeUrl, Offerdesk } from '../src/offerdesk.js';

const HANDSHAKE = 'https://app.joinhandshake.com/stu/jobs/9876543?ref=search&searchId=abc';

describe('capturePosting', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(() => {
    clock = Date.UTC(2026, 9, 1, 12);
    desk = Offerdesk.open(':memory:', { now: () => clock });
  });

  it('adds a saved application flagged to get started, with the posting kept', () => {
    const { application, duplicate } = desk.capturePosting({
      company: 'Northwind Analytics',
      role: 'Data Science Intern',
      location: 'Chicago, IL',
      deadline: '2026-10-20',
      postingUrl: HANDSHAKE,
      pay: '$32/hr',
      source: 'Handshake',
      postingText: 'You will build dashboards…',
    });
    expect(duplicate).toBe(false);
    expect(application).toMatchObject({
      status: 'saved',
      flags: ['start'],
      addedBy: 'vesper',
      source: 'Handshake',
      deadline: '2026-10-20',
    });
    const kinds = desk.events.forApplication(application.id).map((e) => [e.kind, e.source]);
    expect(kinds).toEqual([
      ['application.created', 'vesper'],
      ['posting.captured', 'vesper'],
      ['application.flagged', 'vesper'],
    ]);
    const captured = desk.events.forApplication(application.id)[1];
    expect(captured?.payload).toMatchObject({ text: 'You will build dashboards…', pay: '$32/hr' });
  });

  it('does not add the same posting twice', () => {
    const first = desk.capturePosting({ company: 'Acme', role: 'Intern', postingUrl: HANDSHAKE });
    const sameUrl = desk.capturePosting({
      company: 'ACME Corp',
      role: 'Summer Intern',
      postingUrl: 'https://app.joinhandshake.com/stu/jobs/9876543/',
    });
    const sameRole = desk.capturePosting({ company: 'acme', role: ' intern ' });
    expect(sameUrl).toEqual({ application: first.application, duplicate: true });
    expect(sameRole.duplicate).toBe(true);
    expect(desk.listApplications()).toHaveLength(1);
  });

  it('rejects a capture without a company or role', () => {
    expect(() => desk.capturePosting({ company: ' ', role: 'Intern' })).toThrow();
    expect(() => desk.capturePosting({ company: 'Acme', role: '' })).toThrow();
    expect(desk.listApplications()).toHaveLength(0);
  });

  it('can capture without flagging', () => {
    const { application } = desk.capturePosting({
      company: 'Acme',
      role: 'Intern',
      flagToStart: false,
    });
    expect(application.flags).toEqual([]);
  });
});

describe('the get-started flag', () => {
  it('clears itself once the application moves past saved', () => {
    const desk = Offerdesk.open(':memory:');
    const { application } = desk.capturePosting({ company: 'Acme', role: 'Intern' });
    expect(desk.toStart().map((a) => a.id)).toEqual([application.id]);

    desk.setStatus(application.id, 'applied');
    expect(desk.getApplication(application.id).flags).toEqual([]);
    expect(desk.toStart()).toEqual([]);

    // Moving back to saved does not resurrect it; flagging again does.
    desk.setStatus(application.id, 'saved');
    expect(desk.getApplication(application.id).flags).toEqual([]);
    expect(desk.flag(application.id, 'start').flags).toEqual(['start']);
  });

  it('flags and unflags by hand, idempotently', () => {
    const desk = Offerdesk.open(':memory:');
    const app = desk.addApplication({ company: 'Acme', role: 'Intern' });
    desk.flag(app.id, 'start');
    desk.flag(app.id, 'start');
    expect(desk.unflag(app.id, 'start').flags).toEqual([]);
    desk.unflag(app.id, 'start');
    const kinds = desk.events.forApplication(app.id).map((e) => e.kind);
    expect(kinds).toEqual(['application.created', 'application.flagged', 'application.unflagged']);
  });

  it('orders the list by deadline and keeps flagged postings out of Deadlines', () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const desk = Offerdesk.open(':memory:', { now: () => now });
    desk.capturePosting({ company: 'Later', role: 'r', deadline: '2026-10-12' });
    desk.capturePosting({ company: 'Undated', role: 'r' });
    desk.capturePosting({ company: 'Sooner', role: 'r', deadline: '2026-10-04' });
    desk.addApplication({ company: 'Plain', role: 'r', deadline: '2026-10-06' });

    const d = desk.dashboard();
    expect(d.toStart.map((a) => a.companyName)).toEqual(['Sooner', 'Later', 'Undated']);
    expect(d.deadlines.map((a) => a.companyName)).toEqual(['Plain']);
  });
});

describe('normalizeUrl', () => {
  it('ignores query strings, fragments, www and trailing slashes', () => {
    expect(normalizeUrl('https://www.Example.com/jobs/1/?utm=x#top')).toBe('example.com/jobs/1');
  });
});

describe('dashboard feed', () => {
  it('shows a capture as one line', () => {
    const desk = Offerdesk.open(':memory:');
    desk.capturePosting({ company: 'Acme', role: 'Intern', postingText: 'x' });
    expect(desk.dashboard().recent.map((r) => r.event.kind)).toEqual(['application.created']);
  });
});
