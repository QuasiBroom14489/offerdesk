import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/errors.js';
import { Offerdesk } from '../src/offerdesk.js';

// Fictional companies only (house rules).
describe('companies (ADR 0011)', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(async () => {
    clock = Date.UTC(2026, 10, 1, 12);
    desk = await Offerdesk.open(':memory:', { now: () => clock });
  });

  it('adds a target with research, and updates it by name without case', async () => {
    const c = await desk.addCompany({
      name: 'Acme Analytics',
      fit: 'strong',
      fields: ['Data Analytics', 'Data Analytics'],
      why: 'Their analytics team builds pipelines like mine.',
      highlights: ['Pipeline project'],
    });
    expect(c).toMatchObject({
      target: true,
      fit: 'strong',
      fields: ['Data Analytics'],
      updatedAt: clock,
    });
    clock += 1000;
    const again = await desk.addCompany({
      name: 'acme analytics',
      angle: 'Lead with the pipeline.',
    });
    expect(again.id).toBe(c.id);
    expect(again).toMatchObject({ why: c.why, angle: 'Lead with the pipeline.', updatedAt: clock });
    // Blank text clears a field; omitted fields stay.
    expect(await desk.updateCompany(c.id, { why: '  ', target: false })).toMatchObject({
      why: null,
      target: false,
      fit: 'strong',
    });
    await expect(desk.updateCompany('Nobody Inc', { fit: 'good' })).rejects.toThrow(NotFoundError);
  });

  it('shares the row applications and contacts use, and derives progress from them', async () => {
    const a = await desk.addApplication({ company: 'Beta Health', role: 'Data Intern' });
    await desk.addApplication({ company: 'beta health', role: 'Analyst Intern' });
    await desk.setStatus(a.id, 'interview');
    await desk.addContact({ name: 'Pat Example', company: 'Beta Health' });
    // Known from an application, but not on the target list until saved there.
    const [known] = await desk.listCompanies();
    expect(known).toMatchObject({
      name: 'Beta Health',
      target: false,
      applicationCount: 2,
      openCount: 2,
      bestStatus: 'interview',
      contactCount: 1,
    });
    const saved = await desk.addCompany({ name: 'Beta Health', fit: 'good' });
    expect(saved.id).toBe(known!.id);
    expect(saved.applications).toHaveLength(2);
    expect(saved.contacts.map((p) => p.name)).toEqual(['Pat Example']);
  });

  it('resolves highlights against the profile in the first field’s description variant', async () => {
    await desk.profile.save(null, {
      category: 'Projects',
      name: 'Pipeline project (school)',
      fields: { Description: 'General text.' },
      variants: { 'Data Analytics': 'Analytics text.' },
    });
    await desk.addCompany({
      name: 'Acme',
      fields: ['Data Analytics'],
      highlights: ['Pipeline project', 'Unknown thing'],
    });
    const ctx = await desk.companyContext('acme');
    expect(ctx.highlightDetails).toEqual([
      {
        name: 'Pipeline project',
        entryId: expect.any(String),
        category: 'Projects',
        description: 'Analytics text.',
      },
      { name: 'Unknown thing', entryId: null, category: null, description: null },
    ]);
    await desk.updateCompany('Acme', { fields: ['Software Engineering'] });
    expect((await desk.companyContext('Acme')).highlightDetails[0]?.description).toBe(
      'General text.',
    );
  });

  it('keeps workspaces apart', async () => {
    await desk.addCompany({ name: 'Acme', fit: 'strong' });
    const other = desk.forWorkspace('someone-else');
    expect(await other.listCompanies()).toEqual([]);
    await expect(other.companyContext('Acme')).rejects.toThrow(NotFoundError);
  });
});
