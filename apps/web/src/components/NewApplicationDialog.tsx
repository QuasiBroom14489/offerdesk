import {
  type Application,
  type PostingDraft,
  STATUS_LABELS,
  STATUSES,
  type Status,
} from '@offerdesk/shared';
import { type ClipboardEvent, type DragEvent, type FormEvent, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAddApplication, useCapturePosting, useHealth, useReadScreenshots } from '../api';
import { imageFiles, prepareScreenshots } from '../screenshots';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from './Dialog';

export function NewApplicationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddApplication();
  const capture = useCapturePosting();
  const read = useReadScreenshots();
  const health = useHealth();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  /** Fields read from screenshots. Non-null switches the form to a capture. */
  const [draft, setDraft] = useState<PostingDraft | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<Application | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Bumped on each reading so the uncontrolled inputs pick up new defaults. */
  const [readCount, setReadCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const canRead = health.data?.screenshots === true;

  const close = () => {
    for (const url of previews) URL.revokeObjectURL(url);
    setPreviews([]);
    setDraft(null);
    setDuplicateOf(null);
    setError(null);
    read.reset();
    onClose();
  };

  const readScreenshots = async (files: File[]) => {
    if (files.length === 0 || read.isPending) return;
    setError(null);
    for (const url of previews) URL.revokeObjectURL(url);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
    try {
      const { draft: d, duplicateOf: dup } = await read.mutateAsync(
        await prepareScreenshots(files),
      );
      if (!d.isPosting) {
        setError(
          "That doesn't look like a job posting. Fill it in below, or try another screenshot.",
        );
        return;
      }
      setDraft(d);
      setDuplicateOf(dup);
      setReadCount((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!canRead) return;
    const files = imageFiles(e.clipboardData.items);
    if (files.length > 0) {
      e.preventDefault();
      void readScreenshots(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!canRead) return;
    e.preventDefault();
    setDragging(false);
    void readScreenshots(imageFiles(e.dataTransfer.files));
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v === '' ? null : v;
    };
    const fields = {
      company: text('company') ?? '',
      role: text('role') ?? '',
      postingUrl: text('postingUrl'),
      location: text('location'),
      deadline: text('deadline'),
      source: text('source'),
      season: text('season'),
    };
    const done = (app: Application) => {
      close();
      navigate(`/applications/${app.id}`);
    };
    const onError = (err: Error) => setError(err.message);

    if (draft) {
      capture.mutate(
        {
          ...fields,
          pay: text('pay'),
          postingText: text('postingText'),
          flagToStart: f.get('flagToStart') === 'on',
          capturedBy: 'manual',
        },
        { onSuccess: ({ application }) => done(application), onError },
      );
    } else {
      add.mutate(
        { ...fields, status: (text('status') ?? 'saved') as Status },
        { onSuccess: done, onError },
      );
    }
  };

  const d: Partial<PostingDraft> = draft ?? {};

  return (
    <Dialog open={open} onClose={close} title="Add an application">
      <form
        onSubmit={submit}
        onPaste={onPaste}
        onDragOver={(e) => {
          if (!canRead) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
        className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5"
      >
        <h2 className="text-lg font-medium">Add an application</h2>

        {canRead && (
          <div
            className={`flex items-center gap-3 rounded-md border border-dashed px-3 py-2.5 text-sm ${
              dragging ? 'border-accent bg-sunken' : 'border-line'
            }`}
          >
            {previews.length > 0 && (
              <div className="flex shrink-0 gap-1">
                {previews.map((src) => (
                  <img
                    key={src}
                    src={src}
                    alt=""
                    className="h-10 w-10 rounded border border-line object-cover object-top"
                  />
                ))}
              </div>
            )}
            <p className="flex-1 text-muted">
              {read.isPending
                ? 'Reading the posting…'
                : draft
                  ? 'Filled in from the screenshot. Check the fields before adding.'
                  : 'Paste (⌘V) or drop screenshots of a posting to fill this in.'}
            </p>
            <button
              type="button"
              disabled={read.isPending}
              onClick={() => fileInput.current?.click()}
              className={quietButtonClass}
            >
              {previews.length > 0 ? 'Replace' : 'Choose…'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void readScreenshots(imageFiles(e.currentTarget.files));
                e.currentTarget.value = '';
              }}
            />
          </div>
        )}

        {duplicateOf && (
          <p className="rounded-md bg-attention-bg px-3 py-2 text-sm">
            Already tracked:{' '}
            <Link href={`/applications/${duplicateOf.id}`} onClick={close} className="underline">
              {duplicateOf.companyName} — {duplicateOf.role}
            </Link>
            . Adding it again opens that one instead.
          </p>
        )}

        <div key={readCount} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company">
            <input
              name="company"
              required
              autoFocus
              defaultValue={d.company ?? ''}
              className={inputClass}
            />
          </Field>
          <Field label="Role">
            <input name="role" required defaultValue={d.role ?? ''} className={inputClass} />
          </Field>
          <Field label="Posting link">
            <input
              name="postingUrl"
              type="url"
              placeholder="https://"
              defaultValue={d.postingUrl ?? ''}
              className={inputClass}
            />
          </Field>
          <Field label="Location">
            <input name="location" defaultValue={d.location ?? ''} className={inputClass} />
          </Field>
          <Field label="Deadline">
            <input
              name="deadline"
              type="date"
              defaultValue={d.deadline ?? ''}
              className={inputClass}
            />
          </Field>
          <Field label="Where you found it">
            <input
              name="source"
              placeholder="Career fair, Handshake…"
              defaultValue={d.source ?? ''}
              className={inputClass}
            />
          </Field>
          <Field label="Season">
            <input
              name="season"
              defaultValue={draft ? (d.season ?? '') : 'Summer 2027'}
              className={inputClass}
            />
          </Field>
          {draft ? (
            <Field label="Pay">
              <input name="pay" defaultValue={d.pay ?? ''} className={inputClass} />
            </Field>
          ) : (
            <Field label="Status">
              <select name="status" defaultValue="saved" className={inputClass}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {draft && (
            <>
              <div className="sm:col-span-2">
                <Field label="Job description">
                  <textarea
                    name="postingText"
                    rows={5}
                    defaultValue={d.postingText ?? ''}
                    className={`${inputClass} resize-y text-sm`}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input name="flagToStart" type="checkbox" defaultChecked />
                Flag it to get started
              </label>
            </>
          )}
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className={quietButtonClass}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={add.isPending || capture.isPending || read.isPending}
            className={buttonClass}
          >
            Add application
          </button>
        </div>
      </form>
    </Dialog>
  );
}
