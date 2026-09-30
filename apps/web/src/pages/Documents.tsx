import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  type Document,
  type DocumentKind,
  MAX_DOCUMENT_BYTES,
} from '@offerdesk/shared';
import { type FormEvent, useRef, useState } from 'react';
import {
  type DriveImport,
  fileUrl,
  useAddVersion,
  useConnections,
  useDocuments,
  useHealth,
  useImportFromDrive,
  useSaveToDrive,
  useUpdateDocument,
  useUploadDocument,
} from '../api';
import { buttonClass, Field, inputClass, quietButtonClass } from '../components/Dialog';
import { fileSize, relativeDays } from '../format';
import { ServerDown } from './Home';

/** "Resume_Data_v3.pdf" → "Resume Data v3" */
function nameFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function tooBig(file: File): string | null {
  return file.size > MAX_DOCUMENT_BYTES
    ? `${file.name} is ${fileSize(file.size)}; the limit is 4 MB.`
    : null;
}

export function Documents() {
  const [archived, setArchived] = useState(false);
  const { data, isPending, error } = useDocuments(archived);
  const health = useHealth();
  const [adding, setAdding] = useState(false);
  const canUpload = health.data?.files !== null;
  const connections = useConnections();
  const driveReady = canUpload && connections.data?.google.status === 'connected';
  const fromDrive = useImportFromDrive();

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-medium">Documents</h1>
        <div className="flex gap-2">
          {driveReady && (
            <button
              type="button"
              onClick={() => fromDrive.mutate({})}
              disabled={fromDrive.isPending}
              className={quietButtonClass}
            >
              {fromDrive.isPending ? 'Importing…' : 'Import from Drive'}
            </button>
          )}
          {canUpload && !adding && (
            <button type="button" onClick={() => setAdding(true)} className={buttonClass}>
              Upload
            </button>
          )}
        </div>
      </header>

      {fromDrive.error && <p className="text-sm text-red">{fromDrive.error.message}</p>}
      {fromDrive.data && <p className="text-sm text-muted">{importSummary(fromDrive.data)}</p>}

      {!canUpload && (
        <p className="text-sm text-muted">
          File storage isn’t set up on this deployment yet, so uploads are off. Connect a private
          Vercel Blob store to turn them on.
        </p>
      )}

      {adding && <UploadForm onDone={() => setAdding(false)} />}

      {data.length === 0 ? (
        <p className="py-8 text-sm text-faint">
          {archived
            ? 'Nothing archived.'
            : 'Keep every resume, cover letter and transcript here. Each upload becomes a new version, and applications remember which version you sent.'}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((d) => (
            <DocumentRow key={d.id} doc={d} canUpload={canUpload} driveReady={driveReady} />
          ))}
        </ul>
      )}

      <div>
        <button
          type="button"
          onClick={() => setArchived(!archived)}
          className="text-sm text-faint hover:text-fg"
        >
          {archived ? 'Back to the library' : 'Show archived'}
        </button>
      </div>
    </div>
  );
}

/** "Imported 2 files, updated 1, 1 unchanged." */
function importSummary(results: DriveImport[]): string {
  const count = (o: DriveImport['outcome']) => results.filter((r) => r.outcome === o).length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const parts = [
    count('created') && `imported ${files(count('created'))}`,
    count('new-version') && `added a new version to ${files(count('new-version'))}`,
    count('unchanged') && `${count('unchanged')} unchanged since the last import`,
  ].filter(Boolean);
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const upload = useUploadDocument();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DocumentKind>('resume');
  const problem = file ? tooBig(file) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || problem) return;
    upload.mutate(
      { file, name: name.trim() || nameFromFile(file.name), kind },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-y border-line py-4">
      <Field label="File">
        <input
          type="file"
          required
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !name) setName(nameFromFile(f.name));
          }}
          className="text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-bg file:px-3 file:py-1.5 file:text-sm file:text-fg"
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Resume — data science"
            className={inputClass}
          />
        </Field>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
            className={inputClass}
          >
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {(problem || upload.error) && (
        <p className="text-sm text-red">{problem ?? upload.error?.message}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={buttonClass}
          disabled={!file || !!problem || upload.isPending}
        >
          {upload.isPending ? 'Uploading…' : 'Save to library'}
        </button>
        <button type="button" onClick={onDone} className={quietButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DocumentRow({
  doc,
  canUpload,
  driveReady,
}: {
  doc: Document;
  canUpload: boolean;
  driveReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addVersion = useAddVersion();
  const update = useUpdateDocument();
  const [problem, setProblem] = useState<string | null>(null);
  const latest = doc.versions[0];
  if (!latest) return null;
  const used = doc.applicationIds.length;

  const pick = (file: File | undefined) => {
    if (!file) return;
    const big = tooBig(file);
    setProblem(big);
    if (!big) addVersion.mutate({ id: doc.id, file }, { onSuccess: () => setOpen(true) });
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 text-left hover:text-accent"
        >
          <span className="block truncate font-medium">{doc.name}</span>
          <span className="block truncate text-sm text-muted">
            {DOCUMENT_KIND_LABELS[doc.kind]} · v{latest.version} · updated{' '}
            {relativeDays(latest.createdAt)}
            {used > 0 && ` · in ${used} application${used === 1 ? '' : 's'}`}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <a
            href={fileUrl(latest.id)}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            Open
          </a>
          {canUpload && !doc.archivedAt && (
            <>
              <button
                type="button"
                onClick={() => picker.current?.click()}
                disabled={addVersion.isPending}
                className="text-muted hover:text-fg disabled:opacity-50"
              >
                {addVersion.isPending ? 'Uploading…' : 'New version'}
              </button>
              <input
                ref={picker}
                type="file"
                hidden
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => update.mutate({ id: doc.id, archived: !doc.archivedAt })}
            className="text-faint hover:text-fg"
          >
            {doc.archivedAt ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>
      {(problem || addVersion.error) && (
        <p className="mt-1 text-sm text-red">{problem ?? addVersion.error?.message}</p>
      )}
      {open && (
        <ol className="mt-3 flex flex-col gap-2 border-l border-line pl-4 text-sm">
          {doc.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-baseline justify-between gap-x-4">
              <span className="min-w-0">
                <span className="font-medium">v{v.version}</span>{' '}
                <span className="text-muted">
                  {v.filename} · {fileSize(v.size)} · {relativeDays(v.createdAt)}
                  {v.source === 'drive' && ' · from Drive'}
                </span>
                {v.note && <span className="block text-muted">{v.note}</span>}
              </span>
              <span className="flex gap-3">
                <a
                  href={fileUrl(v.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  Open
                </a>
                <a href={fileUrl(v.id, true)} className="text-muted hover:text-fg">
                  Download
                </a>
                {driveReady && <SaveToDrive versionId={v.id} />}
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** Copy a version into the OfferDesk Drive folder; afterwards, a link to the copy. */
function SaveToDrive({ versionId }: { versionId: string }) {
  const save = useSaveToDrive();
  if (save.data) {
    return (
      <a href={save.data.url} target="_blank" rel="noreferrer" className="text-muted hover:text-fg">
        In Drive ↗
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => save.mutate(versionId)}
      disabled={save.isPending}
      title={save.error?.message}
      className={`hover:text-fg disabled:opacity-50 ${save.error ? 'text-red' : 'text-muted'}`}
    >
      {save.isPending ? 'Saving…' : save.error ? 'Retry save to Drive' : 'Save to Drive'}
    </button>
  );
}
