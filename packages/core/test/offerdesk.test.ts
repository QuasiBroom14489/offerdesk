import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, Offerdesk } from '../src/offerdesk.js';

const DAY = 86_400_000;

describe('Offerdesk', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(() => {
    clock = Date.UTC(2026, 9, 1, 12);
    desk = Offerdesk.open(':memory:', { now: () => clock, followUpAfterDays: 7 });
  });

  it('creates an application with a derived status and a creation event', () => {
    const app = desk.addApplication({
      company: 'Acme Analytics',
      role: 'Data Intern',
      deadline: '2026-10-10',
    });
    expect(app).toMatchObject({
      companyName: 'Acme Analytics',
      role: 'Data Intern',
      status: 'saved',
    });
    expect(desk.events.forApplication(app.id).map((e) => e.kind)).toEqual(['application.created']);
  });

  it('reuses companies case-insensitively', () => {
    const a = desk.addApplication({ company: 'Acme', role: 'A' });
    const b = desk.addApplication({ company: 'acme ', role: 'B' });
    expect(a.companyId).toBe(b.companyId);
  });

  it('moves status by appending events, and ignores no-op moves', () => {
    const app = desk.addApplication({ company: 'Acme', role: 'Intern' });
    desk.setStatus(app.id, 'applied');
    desk.setStatus(app.id, 'applied');
    const moved = desk.setStatus(app.id, 'interview');
    expect(moved.status).toBe('interview');
    const changes = desk.events.forApplication(app.id).filter((e) => e.kind === 'status.changed');
    expect(changes.map((e) => e.payload)).toEqual([
      { from: 'saved', to: 'applied' },
      { from: 'applied', to: 'interview' },
    ]);
  });

  it('refuses to update or delete events at the database level', () => {
    desk.addApplication({ company: 'Acme', role: 'Intern' });
    expect(() => desk.db.exec("UPDATE events SET kind = 'x'")).toThrow(/append-only/);
    expect(() => desk.db.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('edits descriptive fields without touching the log', () => {
    const app = desk.addApplication({ company: 'Acme', role: 'Intern' });
    const updated = desk.updateApplication(app.id, {
      role: 'Data Science Intern',
      location: 'Chicago',
    });
    expect(updated).toMatchObject({ role: 'Data Science Intern', location: 'Chicago' });
    expect(desk.events.forApplication(app.id)).toHaveLength(1);
  });

  it('surfaces follow-ups after a week of silence', () => {
    const app = desk.addApplication({ company: 'Acme', role: 'Intern', status: 'applied' });
    const contact = desk.addContact({ name: 'Jordan Lee', company: 'Acme', title: 'Recruiter' });
    desk.logOutreach({ contactId: contact.id, applicationId: app.id, channel: 'linkedin' });
    expect(desk.followUps()).toEqual([]);

    clock += 8 * DAY;
    const due = desk.followUps();
    expect(due.map((f) => f.kind).sort()).toEqual(['application', 'contact']);
    expect(desk.getContact(contact.id).lastTouchedAt).toBe(clock - 8 * DAY);

    desk.logResponse({ contactId: contact.id, applicationId: app.id, channel: 'email' });
    expect(desk.followUps()).toEqual([]);
  });

  it('lists upcoming deadlines for applications not yet submitted', () => {
    const soon = desk.addApplication({ company: 'A', role: 'r', deadline: '2026-10-05' });
    desk.addApplication({ company: 'B', role: 'r', deadline: '2026-12-01' });
    const done = desk.addApplication({ company: 'C', role: 'r', deadline: '2026-10-03' });
    desk.setStatus(done.id, 'applied');
    expect(desk.upcomingDeadlines(14).map((a) => a.id)).toEqual([soon.id]);
  });

  it('includes company contacts and the timeline in the detail view', () => {
    const app = desk.addApplication({ company: 'Acme', role: 'Intern' });
    desk.addContact({ name: 'Jordan Lee', company: 'Acme' });
    desk.addContact({ name: 'Other Person', company: 'Elsewhere' });
    desk.addNote(app.id, 'Referral from club alum');
    const detail = desk.getApplicationDetail(app.id);
    expect(detail.contacts.map((c) => c.name)).toEqual(['Jordan Lee']);
    expect(detail.timeline.map((e) => e.kind)).toEqual(['application.created', 'note.added']);
  });

  it('throws NotFoundError for unknown ids', () => {
    expect(() => desk.getApplication('nope')).toThrow(NotFoundError);
    expect(() => desk.logOutreach({ contactId: 'nope', channel: 'email' })).toThrow(NotFoundError);
  });

  it('rejects outreach with no target', () => {
    expect(() => desk.logOutreach({ channel: 'email' })).toThrow(/contactId/);
  });
});
