import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Offerdesk } from '@offerdesk/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_APPROVABLE_TOOLS, createServer } from '../src/server.js';

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

describe('MCP server', () => {
  let desk: Offerdesk;
  let client: Client;

  beforeEach(async () => {
    desk = await Offerdesk.open(':memory:');
    const server = createServer(desk);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
    desk.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as TextResult;

  it('lists tools with valid Claude tool names and read-only hints', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...AUTO_APPROVABLE_TOOLS, 'set_status']));
    expect(tools.find((t) => t.name === 'dashboard')?.annotations?.readOnlyHint).toBe(true);
  });

  it('captures a posting from the screen, flagged, and reports duplicates', async () => {
    const args = {
      company: 'Northwind Analytics',
      role: 'Data Science Intern',
      deadline: '2026-10-20',
      postingUrl: 'https://app.joinhandshake.com/stu/jobs/42',
      source: 'Handshake',
      postingText: 'Build dashboards.',
    };
    const first = await call('capture_posting', args);
    expect(first.isError).toBeFalsy();
    expect(first.content[0]?.text).toMatch(
      /^Added Northwind Analytics — Data Science Intern and flagged/,
    );

    const [app] = await desk.listApplications();
    expect(app).toMatchObject({ flags: ['start'], addedBy: 'vesper', status: 'saved' });

    const again = await call('capture_posting', args);
    expect(again.content[0]?.text).toMatch(/^Already tracked/);
    expect(await desk.listApplications()).toHaveLength(1);
  });

  it('returns tool errors instead of throwing', async () => {
    const bad = await call('capture_posting', {
      company: 'Acme',
      role: 'Intern',
      deadline: 'next week',
    });
    expect(bad.isError).toBe(true);
    const missing = await call('set_status', { id: 'nope', status: 'applied' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toMatch(/not found/);
  });

  it('finds, moves and summarises applications', async () => {
    await desk.capturePosting({ company: 'Acme', role: 'Intern' });
    const listed = await call('list_applications', { flagged: true, query: 'acme' });
    const id = listed.content[0]?.text.match(/\[id ([^\]]+)\]/)?.[1];
    expect(id).toBeTruthy();

    const moved = await call('set_status', { id, status: 'applied' });
    expect(moved.content[0]?.text).toBe('Acme — Intern is now applied.');
    expect((await desk.getApplication(id as string)).flags).toEqual([]);

    const dash = await call('dashboard');
    expect(dash.content[0]?.text).toMatch(/^1 tracked, 1 submitted/);
  });

  it('runs and exports table views by name', async () => {
    await desk.addApplication({ company: 'Acme', role: 'Intern', status: 'applied' });
    await desk.addApplication({ company: 'Beta', role: 'Analyst' });

    const views = await call('list_views');
    expect(views.content[0]?.text).toMatch(/Waiting to hear \(built in\) \[id waiting\]/);

    const run = await call('run_view', { view: 'waiting to hear' });
    expect(run.content[0]?.text).toMatch(/^Waiting to hear: 1 row\.\n\nCompany \| Role/);
    expect(run.content[0]?.text).toContain('Acme | Intern');

    const unknown = await call('run_view', { view: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toContain('"Everything"');

    const path = join(mkdtempSync(join(tmpdir(), 'offerdesk-')), 'waiting.csv');
    const saved = await call('export_view', { view: 'waiting', path });
    expect(saved.content[0]?.text).toMatch(/^Saved "Waiting to hear" \(1 row\)/);
    expect(readFileSync(path, 'utf8')).toContain('Acme,Intern');

    const relative = await call('export_view', { view: 'waiting', path: 'out.csv' });
    expect(relative.isError).toBe(true);
  });
});
