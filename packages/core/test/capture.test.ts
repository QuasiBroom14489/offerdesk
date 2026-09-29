import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeUrl, Offerdesk } from '../src/offerdesk.js';

const HANDSHAKE = 'https://app.joinhandshake.com/stu/jobs/9876543?ref=search&searchId=abc';

describe('capturePosting', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 1, 12);
    desk = await Offerdesk.open(':memory:', { now: () => clock });
  });

  it('adds a saved application flagged to get started, with the posting kept', async () => {
    const { application, duplicate } = await desk.capturePosting({
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
    const kinds = (await desk.events.forApplication(application.id)).map((e) => [e.kind, e.source]);
    expect(kinds).toEqual([
      ['application.created', 'vesper'],
      ['posting.captured', 'vesper'],
      ['application.flagged', 'vesper'],
    ]);
    const captured = (await desk.events.forApplication(application.id))[1];
    expect(captured?.payload).toMatchObject({ text: 'You will build dashboards…', pay: '$32/hr' });
  });

  it('does not add the same posting twice', async () => {
    const first = await desk.capturePosting({
      company: 'Acme',
      role: 'Intern',
      postingUrl: HANDSHAKE,
    });
    const sameUrl = await desk.capturePosting({
      company: 'ACME Corp',
      role: 'Summer Intern',
      postingUrl: 'https://app.joinhandshake.com/stu/jobs/9876543/',
    });
    const sameRole = await desk.capturePosting({ company: 'acme', role: ' intern ' });
    expect(sameUrl).toEqual({ application: first.application, duplicate: true });
    expect(sameRole.duplicate).toBe(true);
    expect(await desk.listApplications()).toHaveLength(1);
  });

  it('rejects a capture without a company or role', async () => {
    await expect(() => desk.capturePosting({ company: ' ', role: 'Intern' })).rejects.toThrow();
    await expect(() => desk.capturePosting({ company: 'Acme', role: '' })).rejects.toThrow();
    expect(await desk.listApplications()).toHaveLength(0);
  });

  it('can capture without flagging', async () => {
    const { application } = await desk.capturePosting({
      company: 'Acme',
      role: 'Intern',
      flagToStart: false,
    });
    expect(application.flags).toEqual([]);
  });
});

describe('the get-started flag', () => {
  it('clears itself once the application moves past saved', async () => {
    const desk = await Offerdesk.open(':memory:');
    const { application } = await desk.capturePosting({ company: 'Acme', role: 'Intern' });
    expect((await desk.toStart()).map((a) => a.id)).toEqual([application.id]);

    await desk.setStatus(application.id, 'applied');
    expect((await desk.getApplication(application.id)).flags).toEqual([]);
    expect(await desk.toStart()).toEqual([]);

    // Moving back to saved does not resurrect it; flagging again does.
    await desk.setStatus(application.id, 'saved');
    expect((await desk.getApplication(application.id)).flags).toEqual([]);
    expect((await desk.flag(application.id, 'start')).flags).toEqual(['start']);
  });

  it('flags and unflags by hand, idempotently', async () => {
    const desk = await Offerdesk.open(':memory:');
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern' });
    await desk.flag(app.id, 'start');
    await desk.flag(app.id, 'start');
    expect((await desk.unflag(app.id, 'start')).flags).toEqual([]);
    await desk.unflag(app.id, 'start');
    const kinds = (await desk.events.forApplication(app.id)).map((e) => e.kind);
    expect(kinds).toEqual(['application.created', 'application.flagged', 'application.unflagged']);
  });

  it('orders the list by deadline and keeps flagged postings out of Deadlines', async () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const desk = await Offerdesk.open(':memory:', { now: () => now });
    await desk.capturePosting({ company: 'Later', role: 'r', deadline: '2026-10-12' });
    await desk.capturePosting({ company: 'Undated', role: 'r' });
    await desk.capturePosting({ company: 'Sooner', role: 'r', deadline: '2026-10-04' });
    await desk.addApplication({ company: 'Plain', role: 'r', deadline: '2026-10-06' });

    const d = await desk.dashboard();
    expect(d.toStart.map((a) => a.companyName)).toEqual(['Sooner', 'Later', 'Undated']);
    expect(d.deadlines.map((a) => a.companyName)).toEqual(['Plain']);
  });
});

describe('normalizeUrl', () => {
  it('ignores query strings, fragments, www and trailing slashes', async () => {
    expect(normalizeUrl('https://www.Example.com/jobs/1/?utm=x#top')).toBe('example.com/jobs/1');
  });
});

describe('dashboard feed', () => {
  it('shows a capture as one line', async () => {
    const desk = await Offerdesk.open(':memory:');
    await desk.capturePosting({ company: 'Acme', role: 'Intern', postingText: 'x' });
    expect((await desk.dashboard()).recent.map((r) => r.event.kind)).toEqual([
      'application.created',
    ]);
  });
});
