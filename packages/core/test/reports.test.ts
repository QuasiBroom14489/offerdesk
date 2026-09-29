import type { Report } from '@offerdesk/shared';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../src/errors.js';
import { Offerdesk } from '../src/offerdesk.js';
import { resolveDate } from '../src/reports/run.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 15); // 2026-09-01, mid-day everywhere in the US

/** Column name → cell, for readable assertions. */
function table(report: Report): Record<string, unknown>[] {
  return report.rows.map((r) =>
    Object.fromEntries(report.columns.map((c, i) => [c.id, r.cells[i]])),
  );
}

describe('reports', () => {
  let clock: number;
  let desk: Offerdesk;

  beforeEach(() => {
    clock = T0;
    desk = Offerdesk.open(':memory:', { now: () => clock });
    const at = (days: number) => T0 + days * DAY;

    // Applied on day 0, heard back on day 5.
    const acme = desk.addApplication({ company: 'Acme', role: 'Data Intern', status: 'applied' });
    desk.logResponse({ applicationId: acme.id, channel: 'email', at: at(5) });
    desk.setStatus(acme.id, 'interview', at(6));
    desk.scheduleInterview(acme.id, { at: at(20), round: 'Final' }, at(6));

    // Saved on day 0, applied on day 2, followed up on day 6, still waiting.
    const beta = desk.addApplication({ company: 'Beta Labs', role: 'Analyst Intern' });
    desk.setStatus(beta.id, 'applied', at(2));
    const priya = desk.addContact({ name: 'Priya', company: 'Beta Labs' });
    desk.logOutreach({ contactId: priya.id, applicationId: beta.id, channel: 'email', at: at(6) });

    // Only saved, due in five days, flagged.
    desk.capturePosting({
      company: 'Gamma, Inc.',
      role: '=HYPERLINK("x")',
      deadline: '2026-09-15',
      pay: '$30/hr',
      postingUrl: 'https://example.com/jobs/1',
    });

    // Applied then rejected on day 3.
    const delta = desk.addApplication({ company: 'Delta', role: 'Intern', status: 'applied' });
    desk.setStatus(delta.id, 'rejected', at(3));

    clock = at(10);
  });

  it('computes derived columns from the event log', () => {
    const rows = table(
      desk.report({
        spec: {
          columns: [
            'company',
            'status',
            'signal',
            'flag',
            'pay',
            'appliedOn',
            'daysSinceApplied',
            'daysWaiting',
            'responseDays',
            'contacts',
            'lastContact',
            'nextInterview',
          ],
          sort: [{ column: 'company' }],
        },
      }),
    );
    expect(rows).toEqual([
      {
        company: 'Acme',
        status: 'interview',
        signal: 'green',
        flag: null,
        pay: null,
        appliedOn: '2026-09-01',
        daysSinceApplied: 10,
        daysWaiting: null,
        responseDays: 5,
        contacts: 0,
        lastContact: '2026-09-06',
        nextInterview: '2026-09-21',
      },
      {
        company: 'Beta Labs',
        status: 'applied',
        signal: 'yellow',
        flag: null,
        pay: null,
        appliedOn: '2026-09-03',
        daysSinceApplied: 8,
        // Waiting since the follow-up on day 6, not since applying.
        daysWaiting: 4,
        responseDays: null,
        contacts: 1,
        lastContact: '2026-09-07',
        nextInterview: null,
      },
      {
        company: 'Delta',
        status: 'rejected',
        signal: 'red',
        flag: null,
        pay: null,
        appliedOn: '2026-09-01',
        daysSinceApplied: 10,
        daysWaiting: null,
        responseDays: 3,
        contacts: 0,
        lastContact: null,
        nextInterview: null,
      },
      {
        company: 'Gamma, Inc.',
        status: 'saved',
        signal: 'grey',
        flag: 'Get started',
        pay: '$30/hr',
        appliedOn: null,
        daysSinceApplied: null,
        daysWaiting: null,
        responseDays: null,
        contacts: 0,
        lastContact: null,
        nextInterview: null,
      },
    ]);
  });

  it('runs the presets', () => {
    expect(desk.views.list().map((v) => v.name)).toEqual([
      'Everything',
      'Waiting to hear',
      'Response times',
      'Due this month',
    ]);
    expect(desk.report().view?.id).toBe('everything');
    expect(desk.report().rows).toHaveLength(4);

    const waiting = table(desk.report({ viewId: 'waiting' }));
    expect(waiting.map((r) => [r.company, r.daysWaiting])).toEqual([['Beta Labs', 4]]);

    const responses = table(desk.report({ viewId: 'response-times' }));
    expect(responses.map((r) => [r.company, r.responseDays])).toEqual([
      ['Delta', 3],
      ['Acme', 5],
    ]);

    const due = table(desk.report({ viewId: 'deadlines' }));
    expect(due.map((r) => r.company)).toEqual(['Gamma, Inc.']);
    clock += 10 * DAY; // past the deadline
    expect(desk.report({ viewId: 'deadlines' }).rows).toHaveLength(0);
  });

  it('filters by every operator family', () => {
    const companies = (filters: object[], query?: string) =>
      table(
        desk.report({
          spec: { columns: ['company'], filters, query, sort: [{ column: 'company' }] },
        } as never),
      ).map((r) => r.company);

    expect(companies([{ column: 'status', op: 'in', value: ['applied', 'rejected'] }])).toEqual([
      'Beta Labs',
      'Delta',
    ]);
    expect(companies([{ column: 'company', op: 'contains', value: 'LAB' }])).toEqual(['Beta Labs']);
    expect(companies([{ column: 'daysSinceApplied', op: 'gte', value: 9 }])).toEqual([
      'Acme',
      'Delta',
    ]);
    expect(companies([{ column: 'deadline', op: 'lte', value: 'today+7' }])).toEqual([
      'Gamma, Inc.',
    ]);
    // An empty cell "is not" anything, so neq keeps it.
    expect(companies([{ column: 'responseDays', op: 'neq', value: 3 }])).toEqual([
      'Acme',
      'Beta Labs',
      'Gamma, Inc.',
    ]);
    expect(companies([{ column: 'responseDays', op: 'empty' }])).toEqual([
      'Beta Labs',
      'Gamma, Inc.',
    ]);
    // Search sees what the screen shows: status labels, not ids.
    expect(
      table(desk.report({ spec: { columns: ['company', 'status'], query: 'interviewing' } })).map(
        (r) => r.company,
      ),
    ).toEqual(['Acme']);
  });

  it('sorts with empty cells last in both directions', () => {
    const order = (desc: boolean) =>
      table(
        desk.report({
          spec: { columns: ['company', 'responseDays'], sort: [{ column: 'responseDays', desc }] },
        }),
      ).map((r) => r.responseDays);
    expect(order(false)).toEqual([3, 5, null, null]);
    expect(order(true)).toEqual([5, 3, null, null]);

    const byStatus = table(
      desk.report({ spec: { columns: ['status'], sort: [{ column: 'status' }] } }),
    ).map((r) => r.status);
    expect(byStatus).toEqual(['saved', 'applied', 'interview', 'rejected']);
  });

  it('rejects filters that do not fit the column', () => {
    expect(() =>
      desk.report({
        spec: { columns: ['company'], filters: [{ column: 'status', op: 'gt', value: 'x' }] },
      }),
    ).toThrow(/does not apply/);
    expect(() =>
      desk.report({
        spec: { columns: ['company'], filters: [{ column: 'deadline', op: 'lt', value: 'soon' }] },
      }),
    ).toThrow(/today/);
    expect(() => desk.report({ spec: { columns: [] } })).toThrow(/at least one/);
  });

  it('resolves relative dates', () => {
    expect(resolveDate('today', T0)).toBe('2026-09-01');
    expect(resolveDate('today+30', T0)).toBe('2026-10-01');
    expect(resolveDate('today-1', T0)).toBe('2026-08-31');
    expect(resolveDate('2027-01-02', T0)).toBe('2027-01-02');
  });

  describe('saved views', () => {
    const spec = { columns: ['company', 'daysWaiting'] as const, sort: [] };

    it('saves, renames, reuses and deletes a view', () => {
      const v = desk.views.create({
        name: 'Nudge list',
        spec: { ...spec, columns: [...spec.columns] },
      });
      expect(v).toMatchObject({ name: 'Nudge list', builtIn: false, sheetId: null });
      expect(desk.report({ viewId: v.id }).view).toEqual({
        id: v.id,
        name: 'Nudge list',
        builtIn: false,
      });

      const renamed = desk.views.update(v.id, { name: 'Nudges' });
      expect(renamed.spec.columns).toEqual(['company', 'daysWaiting']);
      expect(desk.views.list().map((x) => x.name)).toContain('Nudges');

      desk.views.remove(v.id);
      expect(() => desk.views.get(v.id)).toThrow(NotFoundError);
    });

    it('refuses duplicate names and edits to presets', () => {
      desk.views.create({ name: 'Mine', spec: { columns: ['company'] } });
      expect(() => desk.views.create({ name: 'mine', spec: { columns: ['role'] } })).toThrow(
        ConflictError,
      );
      expect(() => desk.views.create({ name: 'Everything', spec: { columns: ['role'] } })).toThrow(
        ConflictError,
      );
      expect(() => desk.views.update('waiting', { name: 'x' })).toThrow(ConflictError);
      expect(() => desk.views.remove('everything')).toThrow(ConflictError);
    });

    it('keeps views inside their workspace', () => {
      const other = new Offerdesk(desk.db, { workspaceId: 'someone-else' });
      const v = desk.views.create({ name: 'Private', spec: { columns: ['company'] } });
      expect(other.views.list().map((x) => x.name)).not.toContain('Private');
      expect(() => other.views.get(v.id)).toThrow(NotFoundError);
      expect(other.report().rows).toHaveLength(0);
    });
  });

  describe('exports', () => {
    const spec = {
      columns: ['company', 'role', 'status', 'deadline', 'responseDays', 'postingUrl'],
      sort: [{ column: 'company' }],
    } as const;
    const input = { spec: { ...spec, columns: [...spec.columns], sort: [...spec.sort] } };

    it('writes CSV that matches the report row for row', () => {
      const csv = desk.exportCsv(input);
      expect(csv.startsWith('﻿')).toBe(true);
      const lines = csv.slice(1).trimEnd().split('\r\n');
      expect(lines).toEqual([
        'Company,Role,Status,Deadline,Response time (days),Posting',
        'Acme,Data Intern,Interviewing,,5,',
        'Beta Labs,Analyst Intern,Applied,,,',
        'Delta,Intern,Rejected,,3,',
        // Quoted for the comma; the formula-looking role is neutralized.
        `"Gamma, Inc.","'=HYPERLINK(""x"")",Saved,2026-09-15,,https://example.com/jobs/1`,
      ]);
      expect(lines).toHaveLength(desk.report(input).rows.length + 1);
    });

    it('writes a typed .xlsx with a frozen header and signal-colored status', async () => {
      const buf = await desk.exportXlsx(input);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const [ws] = wb.worksheets;
      if (!ws) throw new Error('no worksheet');

      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(ws.rowCount).toBe(5);
      expect(ws.getRow(1).values).toEqual([
        undefined,
        'Company',
        'Role',
        'Status',
        'Deadline',
        'Response time (days)',
        'Posting',
      ]);

      const gamma = ws.getRow(5);
      expect(gamma.getCell(1).value).toBe('Gamma, Inc.');
      expect(gamma.getCell(4).value).toEqual(new Date(Date.UTC(2026, 8, 15)));
      expect(gamma.getCell(6).value).toMatchObject({ hyperlink: 'https://example.com/jobs/1' });

      const acme = ws.getRow(2);
      expect(acme.getCell(3).value).toBe('Interviewing');
      expect(acme.getCell(5).value).toBe(5);
      expect(acme.getCell(3).fill).toMatchObject({ fgColor: { argb: 'FFEAF7EF' } });
      // Saved is neutral: no tint.
      expect(gamma.getCell(3).fill).toBeUndefined();
    });
  });
});
