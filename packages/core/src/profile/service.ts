import { randomUUID } from 'node:crypto';
import {
  ProfileEdit,
  type ProfileEntry,
  type ProfileSource,
  type ProfileState,
  ReviewProfile,
  type SourceFact,
  SyncProfile,
} from '@offerdesk/shared';
import type { Db } from '../db.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { EXTRACTOR_VERSION, extractSource, hashText, identity } from './extract.js';

function possibleMatch(
  a: import('@offerdesk/shared').ProfileContent,
  b: import('@offerdesk/shared').ProfileContent,
): boolean {
  if (a.category !== b.category) return false;
  if (identity(a) === identity(b)) return true;
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((word) => word.length > 2) ?? [],
    );
  const left = words(a.fields.Company || a.name);
  const right = words(b.fields.Company || b.name);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared >= 2 && shared / Math.min(left.size, right.size) >= 0.6;
}

export class ProfessionalProfile {
  constructor(
    private db: Db,
    private workspace: string,
    private now: () => number = Date.now,
  ) {}

  private async rows<T>(table: 'sources' | 'facts' | 'entries'): Promise<T[]> {
    return (
      await this.db.all<{ data: string }>(
        `SELECT data FROM profile_${table} WHERE workspace_id = ?`,
        this.workspace,
      )
    ).map((row) => JSON.parse(row.data) as T);
  }
  private async put<T extends { id: string }>(table: 'sources' | 'facts' | 'entries', value: T) {
    await this.db.run(
      `INSERT INTO profile_${table} (workspace_id, id, data) VALUES (?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET data = excluded.data`,
      this.workspace,
      value.id,
      JSON.stringify(value),
    );
  }
  async state(): Promise<ProfileState> {
    const [sources, facts, entries] = await Promise.all([
      this.rows<ProfileSource>('sources'),
      this.rows<SourceFact>('facts'),
      this.rows<ProfileEntry>('entries'),
    ]);
    // Conflict and duplicate indicators reflect the CURRENT profile, including edits since extraction.
    for (const fact of facts) {
      const matches = entries.filter((entry) => possibleMatch(entry, fact));
      fact.duplicateIds = matches.map((entry) => entry.id);
      fact.conflicts = matches.flatMap((entry) =>
        Object.keys(fact.fields)
          .filter(
            (key) =>
              fact.fields[key] && entry.fields[key] && fact.fields[key] !== entry.fields[key],
          )
          .map(
            (key) => `${key}: canonical “${entry.fields[key]}” → suggested “${fact.fields[key]}”`,
          ),
      );
      const peers = facts.filter(
        (other) =>
          other.id !== fact.id &&
          possibleMatch(other, fact) &&
          other.status !== 'superseded' &&
          other.status !== 'rejected' &&
          sources.some(
            (source) =>
              source.id === other.sourceId &&
              (source.factIds?.includes(other.id) ?? source.hash === other.provenance.hash),
          ),
      );
      for (const other of peers)
        for (const key of Object.keys(fact.fields)) {
          if (fact.fields[key] && other.fields[key] && fact.fields[key] !== other.fields[key])
            fact.conflicts.push(
              `${key}: differs from ${other.provenance.file} / ${other.provenance.section}. Resume preferred for formal titles, dates and education; review required.`,
            );
        }
    }
    return { sources, facts, entries: entries.sort((a, b) => a.position - b.position) };
  }

  async sync(input: unknown) {
    const { files } = SyncProfile.parse(input);
    // Parse before writing: a malformed PDF/YAML leaves the whole batch unchanged.
    const state = await this.state();
    const staged: {
      file: import('@offerdesk/shared').SourceUpload;
      sourceId: string;
      hash: string;
      records: Awaited<ReturnType<typeof extractSource>>;
    }[] = [];
    for (const file of files) {
      const sourceId = hashText(`${file.kind}:${file.name}`);
      const hash = hashText(file.content);
      if (
        state.sources.some(
          (source) =>
            source.id === sourceId &&
            source.hash === hash &&
            source.extractorVersion === EXTRACTOR_VERSION,
        )
      )
        continue;
      staged.push({ file, sourceId, hash, records: await extractSource(file) });
    }
    await this.db.transaction(async () => {
      for (const { file, sourceId, hash, records } of staged) {
        // Recheck inside transaction to make concurrent sync idempotent.
        const previous = await this.rows<ProfileSource>('sources');
        if (
          previous.some(
            (source) =>
              source.id === sourceId &&
              source.hash === hash &&
              source.extractorVersion === EXTRACTOR_VERSION,
          )
        )
          continue;
        const existing = await this.rows<SourceFact>('facts');
        const recordIds = records.map((record) =>
          hashText(`${sourceId}:${JSON.stringify(record)}`),
        );
        for (const fact of existing.filter(
          (fact) =>
            fact.sourceId === sourceId && fact.status === 'pending' && !recordIds.includes(fact.id),
        ))
          await this.put('facts', { ...fact, status: 'superseded' });
        for (const record of records) {
          const id = hashText(`${sourceId}:${JSON.stringify(record)}`);
          const old = existing.find((fact) => fact.id === id);
          if (old && old.status !== 'superseded') continue;
          const fact: SourceFact = {
            ...record.content,
            id,
            sourceId,
            identity: identity(record.content),
            provenance: { file: file.name, section: record.section, kind: file.kind, hash },
            warnings: record.warnings,
            status: 'pending',
            conflicts: [],
            duplicateIds: [],
          };
          await this.put('facts', fact);
        }
        await this.put('sources', {
          id: sourceId,
          name: file.name,
          kind: file.kind,
          hash,
          syncedAt: this.now(),
          factCount: records.length,
          extractorVersion: EXTRACTOR_VERSION,
          factIds: recordIds,
        } as ProfileSource);
      }
    });
    return {
      processed: staged.length,
      unchanged: files.length - staged.length,
      ...(await this.state()),
    };
  }

  async review(id: string, input: unknown) {
    const review = ReviewProfile.parse(input);
    return this.db.transaction(async () => {
      const state = await this.state();
      const fact = state.facts.find((f) => f.id === id);
      if (!fact) throw new NotFoundError('Source fact', id);
      if (fact.status !== 'pending')
        throw new ConflictError('This suggestion has already been reviewed or superseded');
      if (review.action === 'reject') {
        await this.put('facts', { ...fact, status: 'rejected' });
        return;
      }
      const content = review.content ?? {
        category: fact.category,
        name: fact.name,
        fields: fact.fields,
      };
      const matching = state.entries.filter((e) => identity(e) === identity(content));
      if (!review.targetId && !review.createNew && matching.length > 1)
        throw new ConflictError('Choose the canonical record to update');
      const entry = review.createNew
        ? undefined
        : review.targetId
          ? state.entries.find((e) => e.id === review.targetId)
          : matching[0];
      if (review.targetId && !entry)
        throw new NotFoundError('Profile record', review.targetId ?? '');
      if (
        entry &&
        !review.targetId &&
        fact.fields['Job Title'] &&
        entry.fields['Job Title'] &&
        fact.fields['Job Title'] !== entry.fields['Job Title']
      )
        throw new ConflictError(
          'Different job titles: choose an explicit merge target or create a separate entry',
        );
      const proposedFields = Object.fromEntries(
        Object.entries(content.fields).filter(
          ([key, value]) => value !== '' || !entry?.fields[key] || fact.fields[key] !== value,
        ),
      );
      const fields = { ...entry?.fields, ...proposedFields };
      const fieldSources = { ...entry?.fieldSources };
      for (const [key, value] of Object.entries(proposedFields)) {
        // Reviewer edits are user-authored, not falsely attributed to the imported fact.
        fieldSources[key] =
          value === fact.fields[key]
            ? [
                ...new Set([
                  ...(entry?.fields[key] === value ? (fieldSources[key] ?? []) : []),
                  fact.id,
                ]),
              ]
            : [];
      }
      await this.put('entries', {
        ...content,
        id: entry?.id ?? randomUUID(),
        fields,
        fieldSources,
        sourceFactIds: [...new Set([...(entry?.sourceFactIds ?? []), fact.id])],
        variants: entry?.variants ?? {},
        favorite: entry?.favorite ?? false,
        position: entry?.position ?? state.entries.length,
        lastUsed: entry?.lastUsed ?? null,
      } satisfies ProfileEntry);
      await this.put('facts', { ...fact, status: 'accepted' });
    });
  }
  async save(id: string | null, input: unknown) {
    const edit = ProfileEdit.parse(input);
    return this.db.transaction(async () => {
      const state = await this.state();
      const old = id ? state.entries.find((e) => e.id === id) : undefined;
      if (id && !old) throw new NotFoundError('Profile record', id ?? '');
      const fieldSources = { ...old?.fieldSources };
      for (const key of Object.keys(edit.fields))
        if (old?.fields[key] !== edit.fields[key]) fieldSources[key] = [];
      const entry: ProfileEntry = {
        ...edit,
        id: id ?? randomUUID(),
        sourceFactIds: old?.sourceFactIds ?? [],
        fieldSources,
        lastUsed: old?.lastUsed ?? null,
      };
      await this.put('entries', entry);
      return entry;
    });
  }
  async remove(id: string) {
    const result = await this.db.run(
      'DELETE FROM profile_entries WHERE workspace_id = ? AND id = ?',
      this.workspace,
      id,
    );
    if (!result.changes) throw new NotFoundError('Profile record', id ?? '');
  }
  async used(id: string) {
    await this.db.transaction(async () => {
      const entry = (await this.rows<ProfileEntry>('entries')).find((e) => e.id === id);
      if (!entry) throw new NotFoundError('Profile record', id);
      await this.put('entries', { ...entry, lastUsed: this.now() });
    });
  }
}
