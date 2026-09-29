import { Offerdesk } from '@offerdesk/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';

describe('REST API', () => {
  let desk: Offerdesk;
  let app: FastifyInstance;

  beforeEach(() => {
    desk = Offerdesk.open(':memory:');
    app = buildServer(desk);
  });

  afterEach(async () => {
    await app.close();
    desk.close();
  });

  it('creates an application and moves it through the pipeline', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { company: 'Acme', role: 'Data Intern', deadline: '2026-11-01' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const moved = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/status`,
      payload: { status: 'applied' },
    });
    expect(moved.json()).toMatchObject({ status: 'applied' });

    const detail = await app.inject({ method: 'GET', url: `/api/applications/${id}` });
    expect(detail.json().timeline.map((e: { kind: string }) => e.kind)).toEqual([
      'application.created',
      'status.changed',
    ]);
  });

  it('rejects invalid input with a 400 and issues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { company: 'Acme', role: 'x', deadline: 'next friday' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(['deadline']);
  });

  it('returns 404 for unknown applications', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/applications/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('logs outreach and a response against a contact', async () => {
    const contact = (
      await app.inject({
        method: 'POST',
        url: '/api/contacts',
        payload: { name: 'Jordan Lee', company: 'Acme' },
      })
    ).json();
    const out = await app.inject({
      method: 'POST',
      url: '/api/outreach',
      payload: { contactId: contact.id, channel: 'linkedin', summary: 'Coffee chat?' },
    });
    expect(out.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: '/api/responses',
      payload: { contactId: contact.id, channel: 'email' },
    });

    const got = (await app.inject({ method: 'GET', url: `/api/contacts/${contact.id}` })).json();
    expect(got.timeline.map((e: { kind: string }) => e.kind)).toEqual([
      'outreach.sent',
      'response.received',
    ]);
    expect(got.lastTouchedAt).toBeTypeOf('number');
  });

  it('serves the dashboard aggregate', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/applications',
      payload: { company: 'Acme', role: 'Intern', status: 'applied' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toMatchObject({ total: 1, submitted: 1 });
  });

  it('captures a posting once, flagged to get started', async () => {
    const payload = {
      company: 'Acme',
      role: 'Data Intern',
      postingUrl: 'https://app.joinhandshake.com/stu/jobs/123',
      source: 'Handshake',
    };
    const first = await app.inject({ method: 'POST', url: '/api/capture', payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().application).toMatchObject({ flags: ['start'], addedBy: 'vesper' });

    const again = await app.inject({ method: 'POST', url: '/api/capture', payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);

    const bad = await app.inject({ method: 'POST', url: '/api/capture', payload: { role: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('toggles the get-started flag', async () => {
    const { id } = (
      await app.inject({
        method: 'POST',
        url: '/api/applications',
        payload: { company: 'A', role: 'r' },
      })
    ).json();
    const on = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/flags`,
      payload: { flag: 'start', on: true },
    });
    expect(on.json().flags).toEqual(['start']);
    const off = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/flags`,
      payload: { flag: 'start', on: false },
    });
    expect(off.json().flags).toEqual([]);
  });

  describe('views and exports', () => {
    beforeEach(() => {
      desk.addApplication({ company: 'Acme', role: 'Data Intern', status: 'applied' });
      desk.addApplication({ company: 'Beta', role: 'Analyst', deadline: '2026-12-01' });
    });

    const spec = { columns: ['company', 'status', 'deadline'], sort: [{ column: 'company' }] };

    it('runs presets and ad-hoc specs', async () => {
      const preset = await app.inject({ method: 'GET', url: '/api/report?view=waiting' });
      expect(preset.json().view.name).toBe('Waiting to hear');
      expect(preset.json().rows).toHaveLength(1);

      const adhoc = await app.inject({ method: 'POST', url: '/api/report', payload: { spec } });
      expect(adhoc.json().view).toBeNull();
      expect(adhoc.json().rows.map((r: { cells: unknown[] }) => r.cells)).toEqual([
        ['Acme', 'applied', null],
        ['Beta', 'saved', '2026-12-01'],
      ]);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/report',
        payload: { spec: { columns: ['company', 'salary'] } },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().issues[0].path).toEqual(['spec', 'columns', 1]);
    });

    it('saves, updates and deletes views; presets are read-only', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/views',
        payload: { name: 'Mine', spec },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json();

      const dup = await app.inject({
        method: 'POST',
        url: '/api/views',
        payload: { name: 'MINE', spec },
      });
      expect(dup.statusCode).toBe(409);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/views/${id}`,
        payload: { name: 'Ours' },
      });
      expect(renamed.json().name).toBe('Ours');

      const list = await app.inject({ method: 'GET', url: '/api/views' });
      expect(list.json().map((v: { name: string }) => v.name)).toContain('Ours');

      expect((await app.inject({ method: 'DELETE', url: `/api/views/${id}` })).statusCode).toBe(
        204,
      );
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/views/everything' })).statusCode,
      ).toBe(409);
    });

    it('downloads CSV and .xlsx named after the view', async () => {
      const csv = await app.inject({ method: 'GET', url: '/api/export.csv?view=waiting' });
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toMatch(
        /^attachment; filename="offerdesk-waiting-to-hear-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(csv.body).toContain('Acme,Data Intern');

      const q = encodeURIComponent(JSON.stringify(spec));
      const xlsx = await app.inject({ method: 'GET', url: `/api/export.xlsx?spec=${q}` });
      expect(xlsx.statusCode).toBe(200);
      expect(xlsx.headers['content-disposition']).toMatch(/offerdesk-applications-.*\.xlsx/);
      // A zip container: .xlsx starts with PK.
      expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');

      const junk = await app.inject({ method: 'GET', url: '/api/export.csv?spec=%7Bnope' });
      expect(junk.statusCode).toBe(400);
    });
  });
});
