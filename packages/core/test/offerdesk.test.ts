import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/errors.js';
import { Offerdesk } from '../src/offerdesk.js';

const DAY = 86_400_000;

describe('Offerdesk', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 1, 12);
    desk = await Offerdesk.open(':memory:', { now: () => clock, followUpAfterDays: 7 });
  });

  it('creates an application with a derived status and a creation event', async () => {
    const app = await desk.addApplication({
      company: 'Acme Analytics',
      role: 'Data Intern',
      deadline: '2026-10-10',
    });
    expect(app).toMatchObject({
      companyName: 'Acme Analytics',
      role: 'Data Intern',
      status: 'saved',
    });
    expect((await desk.events.forApplication(app.id)).map((e) => e.kind)).toEqual([
      'application.created',
    ]);
  });

  it('reuses companies case-insensitively', async () => {
    const a = await desk.addApplication({ company: 'Acme', role: 'A' });
    const b = await desk.addApplication({ company: 'acme ', role: 'B' });
    expect(a.companyId).toBe(b.companyId);
  });

  it('moves status by appending events, and ignores no-op moves', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern' });
    await desk.setStatus(app.id, 'applied');
    await desk.setStatus(app.id, 'applied');
    const moved = await desk.setStatus(app.id, 'interview');
    expect(moved.status).toBe('interview');
    const changes = (await desk.events.forApplication(app.id)).filter(
      (e) => e.kind === 'status.changed',
    );
    expect(changes.map((e) => e.payload)).toEqual([
      { from: 'saved', to: 'applied' },
      { from: 'applied', to: 'interview' },
    ]);
  });

  it('refuses to update or delete events at the database level', async () => {
    await desk.addApplication({ company: 'Acme', role: 'Intern' });
    await expect(() => desk.db.exec("UPDATE events SET kind = 'x'")).rejects.toThrow(/append-only/);
    await expect(() => desk.db.exec('DELETE FROM events')).rejects.toThrow(/append-only/);
  });

  it('edits descriptive fields without touching the log', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern' });
    const updated = await desk.updateApplication(app.id, {
      role: 'Data Science Intern',
      location: 'Chicago',
    });
    expect(updated).toMatchObject({ role: 'Data Science Intern', location: 'Chicago' });
    expect(await desk.events.forApplication(app.id)).toHaveLength(1);
  });

  it('surfaces follow-ups after a week of silence', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern', status: 'applied' });
    const contact = await desk.addContact({
      name: 'Jordan Lee',
      company: 'Acme',
      title: 'Recruiter',
    });
    await desk.logOutreach({ contactId: contact.id, applicationId: app.id, channel: 'linkedin' });
    expect(await desk.followUps()).toEqual([]);

    clock += 8 * DAY;
    const due = await desk.followUps();
    expect(due).toMatchObject([{ kind: 'contact', contactId: contact.id, applicationId: app.id }]);
    expect((await desk.getContact(contact.id)).lastTouchedAt).toBe(clock - 8 * DAY);

    await desk.logResponse({ contactId: contact.id, applicationId: app.id, channel: 'email' });
    expect(await desk.followUps()).toEqual([]);
  });

  it('lists upcoming deadlines for applications not yet submitted', async () => {
    const soon = await desk.addApplication({ company: 'A', role: 'r', deadline: '2026-10-05' });
    await desk.addApplication({ company: 'B', role: 'r', deadline: '2026-12-01' });
    const done = await desk.addApplication({ company: 'C', role: 'r', deadline: '2026-10-03' });
    await desk.setStatus(done.id, 'applied');
    expect((await desk.upcomingDeadlines(14)).map((a) => a.id)).toEqual([soon.id]);
  });

  it('includes company contacts and the timeline in the detail view', async () => {
    const app = await desk.addApplication({ company: 'Acme', role: 'Intern' });
    await desk.addContact({ name: 'Jordan Lee', company: 'Acme' });
    await desk.addContact({ name: 'Other Person', company: 'Elsewhere' });
    await desk.addNote(app.id, 'Referral from club alum');
    const detail = await desk.getApplicationDetail(app.id);
    expect(detail.contacts.map((c) => c.name)).toEqual(['Jordan Lee']);
    expect(detail.timeline.map((e) => e.kind)).toEqual(['application.created', 'note.added']);
  });

  it('throws NotFoundError for unknown ids', async () => {
    await expect(() => desk.getApplication('nope')).rejects.toThrow(NotFoundError);
    await expect(() => desk.logOutreach({ contactId: 'nope', channel: 'email' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('rejects outreach with no target', async () => {
    await expect(() => desk.logOutreach({ channel: 'email' })).rejects.toThrow(/contactId/);
  });
});

describe('seedDemo', () => {
  it('builds a coherent demo pipeline', async () => {
    const { seedDemo } = await import('../src/demo.js');
    const now = Date.UTC(2026, 9, 1, 12);
    const desk = await Offerdesk.open(':memory:', { now: () => now });
    await seedDemo(desk, now);
    const d = await desk.dashboard();
    expect(d.stats.total).toBe(13);
    expect(d.toStart.map((a) => a.companyName)).toEqual([
      'Summit Health Labs',
      'Beacon Transit Authority',
    ]);
    expect(d.stats.offers).toBe(1);
    expect(d.deadlines).toHaveLength(3);
    expect(d.followUps.length).toBeGreaterThan(0);
    expect(d.followUps.every((f) => f.application || f.contact)).toBe(true);
    expect(d.recent[0]?.event.ts).toBeLessThanOrEqual(now);
  });
});
