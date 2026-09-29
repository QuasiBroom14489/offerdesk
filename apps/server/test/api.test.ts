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
});
