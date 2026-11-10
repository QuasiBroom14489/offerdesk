import { Offerdesk } from '@offerdesk/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';

describe('profile API', () => {
  let desk: Offerdesk;
  let app: FastifyInstance;
  beforeEach(async () => {
    desk = await Offerdesk.open(':memory:');
    app = buildServer(desk, { auth: (req) => (req.headers['x-workspace'] as string) || null });
  });
  afterEach(async () => {
    await app.close();
    desk.db.close();
  });
  const headers = { 'x-workspace': 'owner' };
  it('authenticates every profile route and isolates uploaded suggestions', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/profile' })).statusCode).toBe(401);
    const sync = await app.inject({
      method: 'POST',
      url: '/api/profile/sync',
      headers,
      payload: {
        files: [
          {
            name: 'Career/project.md',
            kind: 'markdown',
            content: '# Projects\n## Demo\n- Built a dashboard.',
          },
        ],
      },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().facts).toHaveLength(1);
    const other = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { 'x-workspace': 'other' },
    });
    expect(other.json().facts).toHaveLength(0);
    const review = await app.inject({
      method: 'POST',
      url: `/api/profile/review/${sync.json().facts[0].id}`,
      headers,
      payload: { action: 'accept' },
    });
    expect(review.statusCode).toBe(200);
    const state = (await app.inject({ method: 'GET', url: '/api/profile', headers })).json();
    expect(state.entries).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/profile/entries/${state.entries[0].id}`,
          headers: { 'x-workspace': 'other' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('never returns parser errors containing source content or accepts server paths', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/profile/sync',
      headers,
      payload: {
        files: [{ name: 'note.md', kind: 'markdown', content: '---\nprivate_marker: [\n---\n' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('private_marker');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/profile/sync',
          headers,
          payload: { vaultPath: '/etc' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
