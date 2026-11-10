import {
  copyProfileFields,
  DESCRIPTION_VARIANTS,
  describeVariants,
  PROFILE_CATEGORIES,
  type ProfileContent,
  type ProfileEntry,
  type SourceFact,
  type SourceUpload,
  SyncProfile,
} from '@offerdesk/shared';
import { useState } from 'react';
import { profileRequest, useProfile } from '../api';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from '../components/Dialog';

const workFields = {
  'Job Title': '',
  Company: '',
  Location: '',
  'Start Date': '',
  'End Date': '',
  'Currently Employed': '',
  Description: '',
};
const categoryFields: Record<string, Record<string, string>> = {
  'Personal Information': {
    'Full Name': '',
    Email: '',
    Phone: '',
    Location: '',
    LinkedIn: '',
    GitHub: '',
    Portfolio: '',
  },
  Education: {
    Institution: '',
    Degree: '',
    Major: '',
    'Graduation Date': '',
    Coursework: '',
    Accomplishments: '',
  },
  'Work Experience': workFields,
  Projects: { Description: '', Technologies: '', Responsibilities: '', Results: '', Links: '' },
  Skills: { Languages: '', Frameworks: '', Tools: '', 'Data Analysis': '', Other: '' },
  Leadership: { Organization: '', Role: '', 'Start Date': '', 'End Date': '', Description: '' },
  'Common Questions': { Question: '', Answer: '' },
  'Custom Responses': { Response: '' },
};

export function Autofill() {
  const { data, error, isPending } = useProfile();
  const [tab, setTab] = useState('Autofill Library');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [filter, setFilter] = useState('All');
  const [editing, setEditing] = useState<ProfileEntry | 'new' | null>(null);
  const [reviewing, setReviewing] = useState<SourceFact | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const pending = data?.facts.filter((f) => f.status === 'pending') ?? [];
  async function perform(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setFailure('');
    setMessage('');
    try {
      await fn();
      setMessage(success);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Copied to clipboard');
      await profileRequest('POST', `/entries/${id}/used`);
    } catch {
      setFailure('Clipboard unavailable. Select the text and copy it manually.');
    }
  }
  async function sync() {
    const uploads: SourceUpload[] = [];
    for (const file of files) {
      if (file.size > (/\.(pdf|json)$/i.test(file.name) ? 4_000_000 : 500_000))
        throw new Error(`${file.name} exceeds the size limit`);
      if (/\.json$/i.test(file.name)) {
        const selected = SyncProfile.parse(JSON.parse(await file.text()));
        uploads.push(...selected.files);
        continue;
      }
      const kind = /\.pdf$/i.test(file.name) ? 'resume' : 'markdown';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let content = '';
      if (kind === 'resume') {
        for (const byte of bytes) content += String.fromCharCode(byte);
        content = btoa(content);
      } else content = new TextDecoder().decode(bytes);
      uploads.push({ name: file.webkitRelativePath || file.name, kind, content });
    }
    // A batch is atomic. Limit requests so the serverless upload limit is respected.
    if (JSON.stringify(uploads).length > 4_000_000)
      throw new Error('Selected files exceed 4 MB combined. Import fewer notes at a time.');
    await profileRequest('POST', '/sync', { files: uploads });
    setFiles([]);
  }
  if (isPending) return <p>Loading professional profile…</p>;
  if (error || !data) return <p role="alert">{error?.message || 'Profile unavailable'}</p>;
  let entries = data.entries.filter(
    (e) =>
      (category === 'All' || e.category === category) &&
      JSON.stringify([e.name, e.fields, e.variants]).toLowerCase().includes(search.toLowerCase()) &&
      (filter !== 'Favorites' || e.favorite),
  );
  if (filter === 'Recent')
    entries = entries
      .filter((e) => e.lastUsed)
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">Application Autofill</h1>
          <p className="mt-1 text-sm text-muted">
            Your professional facts, ready when applications ask.
          </p>
        </div>
        <button className={buttonClass} type="button" onClick={() => setEditing('new')}>
          New entry
        </button>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Profile sections">
        {['Autofill Library', 'Professional Profile', 'Source Management'].map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={tab === t ? buttonClass : quietButtonClass}
          >
            {t}
            {t === 'Source Management' && pending.length ? ` (${pending.length})` : ''}
          </button>
        ))}
      </nav>
      <div aria-live="polite">
        {message && <p className="text-sm text-muted">{message}</p>}
        {failure && (
          <p role="alert" className="text-red">
            {failure}
          </p>
        )}
      </div>
      {tab === 'Source Management' ? (
        <>
          <section className="rounded-xl border border-line bg-raised p-5 flex flex-col gap-4">
            <h2 className="text-lg font-medium">Sync Sources</h2>
            <p className="text-sm text-muted">
              Choose professional Markdown notes from LifeVault, your PDF resume, or a
              selected-source JSON package from the local importer. Selected files are sent to your
              private OfferDesk workspace for local parsing. No AI service is used. The vault
              remains untouched. Re-select updated files to sync again.
            </p>
            <Field label="LifeVault notes and resume">
              <input
                type="file"
                multiple
                accept=".md,.pdf,.json"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </Field>
            <ul className="text-sm text-muted">
              {files.map((f) => (
                <li key={`${f.webkitRelativePath || f.name}-${f.lastModified}-${f.size}`}>
                  {f.name}
                </li>
              ))}
            </ul>
            <button
              className={buttonClass}
              type="button"
              disabled={busy || !files.length}
              onClick={() => void perform(sync, 'Sources synchronized. Review suggestions below.')}
            >
              {busy ? 'Synchronizing…' : 'Sync Sources'}
            </button>
            <p className="text-xs text-muted">
              For nested folders, the local importer supports an explicit file allowlist and saves
              source paths. Run <code>node scripts/profile-import.mjs --help</code> on the computer
              containing LifeVault. Hosted servers cannot access your local folders.
            </p>
          </section>
          <section>
            <h2 className="mb-3 font-medium">Configured sources</h2>
            {data.sources.length === 0 ? (
              <p className="text-muted">No sources imported yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.sources.map((s) => (
                  <li key={s.id} className="py-2 text-sm">
                    <span className="break-all">{s.name}</span>
                    <span className="text-muted">
                      {' '}
                      · {s.kind} · {s.factCount} records · synced{' '}
                      {new Date(s.syncedAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="mb-3 text-lg font-medium">Import review queue · {pending.length}</h2>
            <p className="mb-4 text-sm text-muted">
              Resume evidence is preferred for formal titles, dates and education. Differences
              always require review. Empty fields remain unknown. Accepting an update changes
              canonical facts and preserves your tailored variants.
            </p>
            {pending.map((f) => (
              <article key={f.id} className="mb-3 rounded-lg border border-line p-4">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{f.name}</h3>
                    <p className="text-xs text-muted">
                      {f.category} · {f.provenance.kind}
                    </p>
                  </div>
                  <button className={buttonClass} type="button" onClick={() => setReviewing(f)}>
                    Review / edit
                  </button>
                </div>
                <p className="mt-2 text-sm break-all">
                  Source: {f.provenance.file} → {f.provenance.section}
                </p>
                {f.duplicateIds.length > 0 && (
                  <p className="mt-2 text-sm">
                    Possible update or duplicate:{' '}
                    {f.duplicateIds
                      .map((id) => data.entries.find((e) => e.id === id)?.name)
                      .join(', ')}
                  </p>
                )}
                {[...f.warnings, ...f.conflicts].map((w) => (
                  <p className="mt-2 text-sm text-red" key={w}>
                    {w}
                  </p>
                ))}
                <pre className="mt-3 whitespace-pre-wrap text-sm text-muted">
                  {copyProfileFields(f)}
                </pre>
                <button
                  className={`${quietButtonClass} mt-3`}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => profileRequest('POST', `/review/${f.id}`, { action: 'reject' }),
                      'Suggestion rejected',
                    )
                  }
                >
                  Reject
                </button>
              </article>
            ))}
            {!pending.length && <p className="text-muted">No suggestions awaiting review.</p>}
          </section>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <input
              className={`${inputClass} grow`}
              aria-label="Search library"
              placeholder="Search experiences, skills, and answers…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Category"
              className={inputClass}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option>All</option>
              {PROFILE_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              aria-label="Library filter"
              className={inputClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {['All', 'Favorites', 'Recent'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
          {tab === 'Professional Profile' && (
            <p className="text-sm text-muted">
              Verified canonical fields with source references. Manually changed fields are labeled
              as user-authored. Review source updates in Source Management.
            </p>
          )}
          {!entries.length && (
            <p className="py-8 text-muted">
              No entries yet. Import sources for review or create your own response.
            </p>
          )}
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              facts={data.facts}
              profile={tab === 'Professional Profile'}
              onCopy={(text) => void copy(text, entry.id)}
              onEdit={() => setEditing(entry)}
              onFavorite={() =>
                void perform(
                  () =>
                    profileRequest('PUT', `/entries/${entry.id}`, {
                      ...entry,
                      favorite: !entry.favorite,
                    }),
                  'Favorite updated',
                )
              }
              onDelete={() =>
                void perform(
                  () => profileRequest('DELETE', `/entries/${entry.id}`),
                  'Entry deleted',
                )
              }
              onMove={(direction) => {
                const index = data.entries.findIndex((e) => e.id === entry.id);
                const other = data.entries[index + direction];
                if (!other) return;
                void perform(async () => {
                  const reordered = [...data.entries];
                  [reordered[index], reordered[index + direction]] = [other, entry];
                  for (let i = 0; i < reordered.length; i++)
                    await profileRequest('PUT', `/entries/${reordered[i]!.id}`, {
                      ...reordered[i],
                      position: i,
                    });
                }, 'Order updated');
              }}
            />
          ))}
        </>
      )}
      {editing && (
        <Editor
          key={editing === 'new' ? 'new' : editing.id}
          initial={
            editing === 'new'
              ? { category: 'Custom Responses', name: '', fields: { Response: '' } }
              : editing
          }
          onClose={() => setEditing(null)}
          onSave={async (content, variants) => {
            await profileRequest(
              editing === 'new' ? 'POST' : 'PUT',
              editing === 'new' ? '/entries' : `/entries/${editing.id}`,
              {
                ...(editing === 'new' ? { position: data.entries.length } : editing),
                ...content,
                variants,
              },
            );
            setEditing(null);
          }}
        />
      )}
      {reviewing && (
        <Editor
          key={reviewing.id}
          initial={reviewing}
          review
          entries={data.entries}
          onClose={() => setReviewing(null)}
          onSave={async (content, _variants, targetId) => {
            await profileRequest('POST', `/review/${reviewing.id}`, {
              action: 'accept',
              content,
              ...(targetId === '__new__' ? { createNew: true } : { targetId }),
            });
            setReviewing(null);
          }}
        />
      )}
    </div>
  );
}

function EntryCard({
  entry,
  facts,
  profile,
  onCopy,
  onEdit,
  onFavorite,
  onMove,
  onDelete,
}: {
  entry: ProfileEntry;
  facts: SourceFact[];
  profile: boolean;
  onCopy: (text: string) => void;
  onEdit: () => void;
  onFavorite: () => void;
  onMove: (direction: number) => void;
  onDelete: () => void;
}) {
  const [variant, setVariant] = useState('Canonical default');
  const [deleting, setDeleting] = useState(false);
  const description =
    variant === 'Canonical default'
      ? entry.fields.Description || ''
      : entry.variants[variant] || '';
  return (
    <details className="rounded-xl border border-line bg-raised p-5" open={profile || undefined}>
      <summary className="cursor-pointer">
        <span className="font-medium">{entry.name}</span>
        <span className="ml-3 text-sm text-muted">
          {entry.fields['Job Title'] || entry.category}
          {entry.favorite ? ' ★' : ''}
        </span>
      </summary>
      <div className="mt-5 flex flex-col gap-4">
        {Object.entries(entry.fields).map(([key, value]) => (
          <div key={key} className="border-b border-line pb-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">{key}</span>
              <button
                type="button"
                className={quietButtonClass}
                disabled={!value}
                onClick={() => onCopy(value)}
              >
                Copy {key}
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm">{value || 'Not confirmed'}</p>
            {profile && (
              <p className="mt-1 text-xs text-muted break-all">
                {entry.fieldSources[key]?.length
                  ? entry.fieldSources[key]!.map((id) => {
                      const fact = facts.find((f) => f.id === id);
                      return fact
                        ? `${fact.provenance.file} / ${fact.provenance.section}`
                        : 'Source unavailable';
                    }).join(' · ')
                  : 'User-authored / unconfirmed'}
              </p>
            )}
          </div>
        ))}
        {entry.fields.Description !== undefined && !profile && (
          <div className="flex flex-col gap-3">
            <Field label="Description variant">
              <select
                className={inputClass}
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
              >
                <option>Canonical default</option>
                {Object.keys(entry.variants).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <p className="whitespace-pre-wrap text-sm">
              {description || 'Create a tailored version with Edit.'}
            </p>
            <button
              className={quietButtonClass}
              type="button"
              disabled={!description}
              onClick={() => onCopy(description)}
            >
              Copy Description
            </button>
            {variant !== 'Canonical default' && (
              <details>
                <summary className="text-sm text-muted cursor-pointer">
                  Compare canonical default
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm">{entry.fields.Description}</p>
              </details>
            )}
          </div>
        )}
        {entry.sourceFactIds.some((id) => facts.find((f) => f.id === id)?.fields.Description) && (
          <details>
            <summary className="cursor-pointer text-sm text-muted">
              Compare imported source descriptions
            </summary>
            {entry.sourceFactIds.map((id) => {
              const fact = facts.find((f) => f.id === id);
              return fact?.fields.Description ? (
                <div key={id} className="mt-3">
                  <p className="text-xs text-muted break-all">
                    {fact.provenance.file} / {fact.provenance.section}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{fact.fields.Description}</p>
                </div>
              ) : null;
            })}
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={quietButtonClass}
            onClick={() => onCopy(copyProfileFields(entry))}
          >
            Copy All
          </button>
          <button type="button" className={quietButtonClass} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={quietButtonClass} onClick={onFavorite}>
            {entry.favorite ? 'Unfavorite' : 'Favorite'}
          </button>
          <button
            type="button"
            aria-label={`Move ${entry.name} up`}
            className={quietButtonClass}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${entry.name} down`}
            className={quietButtonClass}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className={quietButtonClass} onClick={() => setDeleting(true)}>
            Delete
          </button>
          {deleting && (
            <>
              <span className="text-sm">Delete this library entry?</span>
              <button type="button" className={quietButtonClass} onClick={onDelete}>
                Confirm delete
              </button>
              <button type="button" className={quietButtonClass} onClick={() => setDeleting(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function Editor({
  initial,
  onClose,
  onSave,
  review = false,
  entries = [],
}: {
  initial: ProfileContent & { variants?: Record<string, string> };
  onClose: () => void;
  onSave: (
    content: ProfileContent,
    variants: Record<string, string>,
    targetId?: string,
  ) => Promise<void>;
  review?: boolean;
  entries?: ProfileEntry[];
}) {
  const [content, setContent] = useState<ProfileContent>({
    category: initial.category,
    name: initial.name,
    fields: { ...categoryFields[initial.category], ...initial.fields },
  });
  const [variants, setVariants] = useState(initial.variants ?? {});
  const [variant, setVariant] = useState<string>('General');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={review ? 'Review extracted record' : 'Edit library entry'}
    >
      <form
        className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onSave(content, variants, targetId || undefined);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-lg font-medium">
          {review ? 'Review extracted record' : 'Edit library entry'}
        </h2>
        <Field label="Category">
          <select
            className={inputClass}
            value={content.category}
            onChange={(e) =>
              setContent({
                ...content,
                category: e.target.value as ProfileContent['category'],
                fields: { ...categoryFields[e.target.value], ...content.fields },
              })
            }
          >
            {PROFILE_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input
            required
            className={inputClass}
            value={content.name}
            onChange={(e) => setContent({ ...content, name: e.target.value })}
          />
        </Field>
        {Object.entries(content.fields).map(([key, value]) => (
          <Field key={key} label={key}>
            <textarea
              className={inputClass}
              rows={key === 'Description' || key === 'Answer' ? 6 : 2}
              value={value}
              onChange={(e) =>
                setContent({ ...content, fields: { ...content.fields, [key]: e.target.value } })
              }
            />
          </Field>
        ))}
        {review ? (
          <>
            <p className="text-sm text-muted">
              Confirm these facts before accepting. For conflicts, edit the proposed fields to the
              verified values. Unknown values should stay empty.
            </p>
            <Field label="Merge with existing entry (optional)">
              <select
                className={inputClass}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Match by identity automatically</option>
                <option value="__new__">Create a separate entry</option>
                {entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.category}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Tailored description">
              <select
                className={inputClass}
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
              >
                {DESCRIPTION_VARIANTS.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <textarea
              aria-label="Variant description"
              className={inputClass}
              rows={6}
              value={variants[variant] ?? ''}
              placeholder="Select and reorder verified accomplishments from the default description. Do not add unverified claims."
              onChange={(e) => setVariants({ ...variants, [variant]: e.target.value })}
            />
            <button
              type="button"
              className={quietButtonClass}
              onClick={() =>
                setVariants({ ...variants, [variant]: content.fields.Description ?? '' })
              }
            >
              Start from canonical description
            </button>
            <button
              type="button"
              className={quietButtonClass}
              onClick={() => {
                const drafts = describeVariants(content.fields.Description ?? '');
                setVariants({
                  ...drafts,
                  ...Object.fromEntries(Object.entries(variants).filter(([, text]) => text.trim())),
                });
              }}
            >
              Generate missing variants from canonical facts
            </button>
            <p className="text-xs text-muted">
              Variants are preserved during sync. Generated drafts only select sentences from the
              canonical description; review them before use. Compare them with the default after
              approving source changes.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-red">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button disabled={busy} className={buttonClass} type="submit">
            {review ? 'Accept reviewed facts' : 'Save'}
          </button>
          <button className={quietButtonClass} type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
