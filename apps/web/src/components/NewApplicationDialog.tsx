import {
  type Application,
  type PostingDraft,
  type ScreenshotRead,
  STATUS_LABELS,
  STATUSES,
  type Status,
} from '@offerdesk/shared';
import { type ClipboardEvent, type DragEvent, type FormEvent, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  cancelScreenshotRead,
  getScreenshotRead,
  startScreenshotRead,
  useAddApplication,
  useCapturePosting,
  useHealth,
} from '../api';
import { imageFiles, prepareScreenshots } from '../screenshots';
import { buttonClass, Dialog, Field, inputClass, quietButtonClass } from './Dialog';

export function NewApplicationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddApplication();
  const capture = useCapturePosting();
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
  const mode = health.data?.screenshots ?? null;
  const canRead = mode !== null;
  /** The reading in flight. Queued ones carry an id to poll and to cancel. */
  const [reading, setReading] = useState<ScreenshotRead | 'sending' | null>(null);
  /** Which reading is current; a newer one or closing the dialog stops the old poll. */
  const readToken = useRef(0);
  const busy = reading !== null;

  /** Stop following the current reading, and drop it from the queue if it's there. */
  const abandonReading = () => {
    readToken.current++;
    if (reading && reading !== 'sending' && reading.id) {
      void cancelScreenshotRead(reading.id).catch(() => {});
    }
    setReading(null);
  };

  const close = () => {
    abandonReading();
    for (const url of previews) URL.revokeObjectURL(url);
    setPreviews([]);
    setDraft(null);
    setDuplicateOf(null);
    setError(null);
    onClose();
  };

  const readScreenshots = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    const token = ++readToken.current;
    setError(null);
    for (const url of previews) URL.revokeObjectURL(url);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
    setReading('sending');
    try {
      let r = await startScreenshotRead(await prepareScreenshots(files));
      // Queued for the owner's computer (ADR 0009): poll until it's read.
      while ((r.status === 'queued' || r.status === 'reading') && r.id) {
        if (token !== readToken.current) return;
        setReading(r);
        await new Promise((done) => setTimeout(done, 1500));
        if (token !== readToken.current) return;
        r = await getScreenshotRead(r.id);
      }
      if (token !== readToken.current) return;
      setReading(null);
      if (r.status === 'failed' || !r.draft) {
        setError(`Couldn't read the screenshots: ${r.error ?? 'unknown error'}`);
        return;
      }
      if (!r.draft.isPosting) {
        setError(
          "That doesn't look like a job posting. Fill it in below, or try another screenshot.",
        );
        return;
      }
      setDraft(r.draft);
      setDuplicateOf(r.duplicateOf);
      setReadCount((n) => n + 1);
    } catch (err) {
      if (token !== readToken.current) return;
      setReading(null);
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
              {reading
                ? readingMessage(reading)
                : draft
                  ? 'Filled in from the screenshot. Check the fields before adding.'
                  : mode === 'queue'
                    ? 'Paste (⌘V) or drop screenshots of a posting. Your computer reads them.'
                    : 'Paste (⌘V) or drop screenshots of a posting to fill this in.'}
            </p>
            {reading && reading !== 'sending' ? (
              <button type="button" onClick={abandonReading} className={quietButtonClass}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                className={quietButtonClass}
              >
                {previews.length > 0 ? 'Replace' : 'Choose…'}
              </button>
            )}
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
            disabled={add.isPending || capture.isPending || busy}
            className={buttonClass}
          >
            Add application
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A reader that checked in within this long is running (it checks in every 30 s). */
const READER_ONLINE_MS = 90_000;

function readingMessage(r: ScreenshotRead | 'sending'): string {
  if (r === 'sending' || r.status === 'reading') return 'Reading the posting…';
  if (r.readerSeenAt !== null && Date.now() - r.readerSeenAt < READER_ONLINE_MS) {
    return 'Waiting for your computer to read it…';
  }
  return r.readerSeenAt === null
    ? 'Queued. No reader has run yet: start `pnpm reader` on your computer.'
    : `Queued. Your computer's reader was last seen ${ago(r.readerSeenAt)}; it reads this when it's back.`;
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
