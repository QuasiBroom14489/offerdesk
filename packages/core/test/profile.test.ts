import { copyProfileFields, type SourceUpload } from '@offerdesk/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Offerdesk } from '../src/offerdesk.js';
import { extractMarkdown, extractResume } from '../src/profile/extract.js';

const note = (description: string): SourceUpload => ({
  name: 'Career/Nested/experience.md',
  kind: 'markdown',
  content: `---\napplication_profile:\n  category: Work Experience\n  name: Sample Co\n  fields:\n    Company: Sample Co\n    Job Title: Engineer\n    Description: ${description}\n---\n`,
});

describe('professional profile', () => {
  let desk: Offerdesk;
  beforeEach(async () => {
    desk = await Offerdesk.open(':memory:');
  });
  afterEach(() => desk.db.close());

  it('imports idempotently with provenance and never bypasses review', async () => {
    const state = await desk.profile.sync({ files: [note('Built a dashboard')] });
    expect(state.entries).toHaveLength(0);
    expect(state.facts).toHaveLength(1);
    expect(state.facts[0]?.provenance).toMatchObject({
      file: 'Career/Nested/experience.md',
      section: 'frontmatter.application_profile',
      kind: 'markdown',
    });
    const repeat = await desk.profile.sync({ files: [note('Built a dashboard')] });
    expect(repeat.processed).toBe(0);
    expect(repeat.facts).toHaveLength(1);
    await desk.profile.review(state.facts[0]!.id, { action: 'accept' });
    expect((await desk.profile.state()).entries[0]?.fieldSources.Description).toEqual([
      state.facts[0]!.id,
    ]);
  });

  it('flags changed fields; approved updates preserve user-authored variants', async () => {
    const first = await desk.profile.sync({ files: [note('Built a dashboard')] });
    await desk.profile.review(first.facts[0]!.id, { action: 'accept' });
    const entry = (await desk.profile.state()).entries[0]!;
    await desk.profile.save(entry.id, {
      ...entry,
      variants: { 'Data Analytics': 'My manual text' },
      favorite: true,
    });
    const next = await desk.profile.sync({ files: [note('Built two dashboards')] });
    const pending = next.facts.find((f) => f.status === 'pending')!;
    expect(pending.conflicts.join(' ')).toContain('Description');
    expect(pending.duplicateIds).toEqual([entry.id]);
    expect(next.entries[0]?.fields.Description).toBe('Built a dashboard');
    await desk.profile.review(pending.id, { action: 'accept' });
    const final = await desk.profile.state();
    expect(final.entries).toHaveLength(1);
    expect(final.entries[0]?.fields.Description).toBe('Built two dashboards');
    expect(final.entries[0]?.variants['Data Analytics']).toBe('My manual text');
    expect(final.entries[0]?.favorite).toBe(true);
  });

  it('supports rejection, superseding stale pending proposals and reviewer edits', async () => {
    const first = await desk.profile.sync({ files: [note('Version one')] });
    const next = await desk.profile.sync({ files: [note('Version two')] });
    expect(next.facts.find((f) => f.id === first.facts[0]!.id)?.status).toBe('superseded');
    await expect(desk.profile.review(first.facts[0]!.id, { action: 'accept' })).rejects.toThrow(
      /superseded/,
    );
    const pending = next.facts.find((f) => f.status === 'pending')!;
    await desk.profile.review(pending.id, {
      action: 'accept',
      content: {
        category: pending.category,
        name: pending.name,
        fields: { ...pending.fields, Description: 'Reviewer correction' },
      },
    });
    expect((await desk.profile.state()).entries[0]?.fieldSources.Description).toEqual([]);
    const third = await desk.profile.sync({ files: [note('Version three')] });
    await desk.profile.review(third.facts.find((f) => f.status === 'pending')!.id, {
      action: 'reject',
    });
    expect((await desk.profile.state()).entries[0]?.fields.Description).toBe('Reviewer correction');
  });

  it('scopes reading, editing, reviewing and deleting to a workspace', async () => {
    const state = await desk.profile.sync({ files: [note('Built dashboard')] });
    const other = desk.forWorkspace('other');
    expect((await other.profile.state()).facts).toHaveLength(0);
    await expect(other.profile.review(state.facts[0]!.id, { action: 'accept' })).rejects.toThrow(
      /not found/,
    );
    await desk.profile.review(state.facts[0]!.id, { action: 'accept' });
    const entry = (await desk.profile.state()).entries[0]!;
    await expect(other.profile.save(entry.id, entry)).rejects.toThrow(/not found/);
    await expect(other.profile.remove(entry.id)).rejects.toThrow(/not found/);
    await expect(other.profile.used(entry.id)).rejects.toThrow(/not found/);
  });

  it('rejects unsafe paths and malformed files atomically', async () => {
    for (const name of [
      '../secret.md',
      '/etc/passwd',
      'Career/../secret.md',
      '.obsidian/note.md',
      'C:\\note.md',
    ])
      await expect(desk.profile.sync({ files: [{ ...note('x'), name }] })).rejects.toThrow();
    await expect(
      desk.profile.sync({
        files: [note('Good'), { name: 'broken.pdf', kind: 'resume', content: 'not pdf' }],
      }),
    ).rejects.toThrow();
    expect((await desk.profile.state()).facts).toHaveLength(0);
  });

  it('normalizes wiki links, excludes code, plans and private notes', () => {
    const content =
      '# Projects\n## Demo\n- Built a [[tools/Chart|dashboard]] for analysis.\n- [ ] Build a forecast\n- Need to add a skill\n```dataview\n- Built a fake accomplishment\n```\n## Related\n- Built unrelated content';
    const result = extractMarkdown(content, 'projects.md');
    expect(result).toHaveLength(1);
    expect(result[0]?.content.fields.Description).toBe('Built a dashboard for analysis.');
    expect(extractMarkdown(`---\nprivate: true\n---\n${content}`, 'p.md')).toEqual([]);
  });

  it('splits combined employers without inventing separate titles or dates', () => {
    const result = extractResume(
      'EXPERIENCE\nGuest Services & Valet — Hotel Co; Valet Co\nAtlanta, GA | 2022 – 2024\nManaged vehicles.\nPROJECTS\nDemo — Python\nBuilt a chart.',
    );
    const work = result.filter((r) => r.content.category === 'Work Experience');
    expect(work.map((r) => r.content.fields.Company)).toEqual(['Hotel Co', 'Valet Co']);
    expect(
      work.every(
        (r) =>
          r.content.fields['Start Date'] === '' &&
          r.content.fields['Job Title'] === '' &&
          r.warnings.length,
      ),
    ).toBe(true);
    expect(result.find((r) => r.content.category === 'Projects')?.content.fields.Description).toBe(
      'Built a chart.',
    );
  });

  it('keeps unchanged pending facts when unrelated source content changes', async () => {
    const input = note('Built dashboard');
    const original = await desk.profile.sync({ files: [input] });
    const updated = await desk.profile.sync({
      files: [{ ...input, content: input.content + '\nUnrelated annotation.' }],
    });
    expect(updated.facts.filter((f) => f.status === 'pending').map((f) => f.id)).toEqual([
      original.facts[0]!.id,
    ]);
  });

  it('does not erase known canonical fields when importing partial context', async () => {
    const original = await desk.profile.sync({ files: [note('Built dashboard')] });
    await desk.profile.review(original.facts[0]!.id, { action: 'accept' });
    const partial = {
      name: 'Career/context.md',
      kind: 'markdown',
      content:
        '---\napplication_profile:\n  category: Work Experience\n  name: Sample Co\n  fields:\n    Company: Sample Co\n    Job Title: ""\n    Description: Led reviews\n---\n',
    };
    const next = await desk.profile.sync({ files: [partial] });
    await desk.profile.review(next.facts.find((f) => f.status === 'pending')!.id, {
      action: 'accept',
    });
    const entry = (await desk.profile.state()).entries[0]!;
    expect(entry.fields['Job Title']).toBe('Engineer');
    expect(entry.fields.Description).toBe('Led reviews');
  });

  it('requires explicit merge for different job titles and supports separate stints', async () => {
    const first = await desk.profile.sync({ files: [note('Built dashboard')] });
    await desk.profile.review(first.facts[0]!.id, { action: 'accept' });
    const next = await desk.profile.sync({
      files: [
        {
          ...note('Led reviews'),
          content: note('Led reviews').content.replace('Job Title: Engineer', 'Job Title: Manager'),
        },
      ],
    });
    const fact = next.facts.find((f) => f.status === 'pending')!;
    expect(fact.conflicts.join(' ')).toContain('Job Title');
    await expect(desk.profile.review(fact.id, { action: 'accept' })).rejects.toThrow(
      /Different job titles/,
    );
    await desk.profile.review(fact.id, { action: 'accept', createNew: true });
    expect((await desk.profile.state()).entries).toHaveLength(2);
  });

  it('extracts actual PDF bytes with an embedded text layer', async () => {
    const stream =
      'BT /F1 12 Tf 50 750 Td (TEST PERSON) Tj 0 -20 Td (person@example.test | 555-123-4567) Tj 0 -20 Td (SUMMARY) Tj 0 -20 Td (Seeking a software internship.) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const state = await desk.profile.sync({
      files: [
        {
          name: 'fictional-resume.pdf',
          kind: 'resume',
          content: Buffer.from(pdf).toString('base64'),
        },
      ],
    });
    expect(state.facts.find((f) => f.category === 'Personal Information')?.fields.Email).toBe(
      'person@example.test',
    );
    expect(state.facts.find((f) => f.category === 'Common Questions')?.fields.Answer).toBe(
      'Seeking a software internship.',
    );
  });

  it('copies exact fields and records recent use', async () => {
    const entry = await desk.profile.save(null, {
      category: 'Work Experience',
      name: 'Demo',
      fields: {
        'Job Title': 'Engineer',
        Company: 'Demo',
        Description: 'Built dashboards.\nLed reviews.',
        Unknown: '',
      },
    });
    expect(copyProfileFields(entry)).toBe(
      'Job Title: Engineer\nCompany: Demo\nDescription: Built dashboards.\nLed reviews.',
    );
    await desk.profile.used(entry.id);
    expect((await desk.profile.state()).entries[0]?.lastUsed).toBeTypeOf('number');
  });
});

it('does not treat wrapped resume responsibilities containing em dashes as employers', () => {
  const records = extractResume(
    'EXPERIENCE\nEngineer — Demo Co\nRemote | May 2026 – Present\nBuilt a pipeline with\nnormalization — cutting manual work.\nConsultant — Other Co\nSummer 2026\nAuthored a strategy for\nthe distribution model — parish wholesale — plus a\nplaybook.',
  );
  expect(records.map((r) => r.content.fields.Company)).toEqual(['Demo Co', 'Other Co']);
  expect(records[0]?.content.fields.Description).toContain('normalization — cutting manual work.');
});

it('tailors by selecting exact canonical sentences', async () => {
  const { describeVariants } = await import('@offerdesk/shared');
  const sentences = [
    'Built software infrastructure.',
    'Analyzed data in Tableau.',
    'Led market research and strategy.',
  ];
  const variants = describeVariants(sentences.join('\n'));
  expect(variants['Software Engineering']).toBe(sentences[0]);
  expect(variants['Data Analytics']).toBe(`${sentences[1]}\n${sentences[2]}`);
  for (const text of Object.values(variants))
    expect(text.split('\n').every((line) => sentences.includes(line))).toBe(true);
});
