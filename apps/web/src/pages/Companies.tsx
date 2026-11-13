import {
  type CompanyContext,
  type CompanyField,
  type CompanyProfilePatch,
  type CompanySummary,
  DESCRIPTION_VARIANTS,
  FIT_LABELS,
  FIT_SIGNAL,
  FITS,
  type Fit,
} from '@offerdesk/shared';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAddCompany, useCompanies, useCompany, useUpdateCompany } from '../api';
import { buttonClass, inputClass, quietButtonClass } from '../components/Dialog';
import { Dot, StatusMark } from '../components/StatusMark';
import { relativeDays } from '../format';
import { ServerDown } from './Home';

const FIT_ORDER: Record<Fit, number> = { strong: 0, good: 1, stretch: 2 };

/** Fit is always a word next to its dot, never color alone (docs/design.md). */
export function FitMark({ fit }: { fit: Fit | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted">
      <Dot signal={fit ? FIT_SIGNAL[fit] : 'grey'} />
      {fit ? FIT_LABELS[fit] : 'Fit not set'}
    </span>
  );
}

/** Companies (ADR 0011): the target list, best chances first. */
export function Companies() {
  const { data, isPending, error } = useCompanies();
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? [])
      .filter((c) => all || c.target)
      .filter(
        (c) =>
          !q || `${c.name} ${c.industry ?? ''} ${c.fields.join(' ')}`.toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          (a.fit ? FIT_ORDER[a.fit] : 3) - (b.fit ? FIT_ORDER[b.fit] : 3) ||
          a.name.localeCompare(b.name),
      );
  }, [data, all, query]);

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const targets = data.filter((c) => c.target).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">Companies</h1>
          <p className="text-sm text-muted">
            Where you have the best chance, why, and what to say when you apply.
          </p>
        </div>
        <AddCompany />
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Company, industry or field…"
          aria-label="Filter companies"
          className={`${inputClass} w-full sm:w-80`}
        />
        <fieldset className="flex gap-1 text-sm" aria-label="Which companies">
          {[
            [false, `Target list (${targets})`],
            [true, `Everyone (${data.length})`],
          ].map(([value, label]) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={all === value}
              onClick={() => setAll(value as boolean)}
              className={`rounded-md px-2.5 py-1 ${all === value ? 'bg-sunken text-fg' : 'text-muted hover:text-fg'}`}
            >
              {label as string}
            </button>
          ))}
        </fieldset>
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-sm text-faint">
          {query
            ? `No company matches “${query}”.`
            : all
              ? 'Companies show up here as you add applications and people.'
              : 'Add the companies you want to work for. Each one keeps why it fits you and what to lead with when you apply.'}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => (
            <CompanyRow key={c.id} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CompanyRow({ c }: { c: CompanySummary }) {
  return (
    <li>
      <Link
        href={`/companies/${c.id}`}
        className="flex items-center justify-between gap-4 py-3 hover:text-accent"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{c.name}</span>
          <span className="block truncate text-sm text-muted">
            {[c.industry, c.fields.join(', ')].filter(Boolean).join(' · ') || 'Not researched yet'}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-sm">
          <FitMark fit={c.fit} />
          {c.bestStatus ? (
            <StatusMark status={c.bestStatus} />
          ) : (
            <span className="text-faint">Not applied</span>
          )}
        </span>
      </Link>
    </li>
  );
}

function AddCompany() {
  const add = useAddCompany();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const c = await add.mutateAsync({ name: name.trim() });
    setName('');
    setOpen(false);
    navigate(`/companies/${c.id}`);
  }

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass}>
        Add company
      </button>
    );
  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Company name"
        aria-label="Company name"
        className={inputClass}
      />
      <button type="submit" disabled={add.isPending || !name.trim()} className={buttonClass}>
        Add
      </button>
    </form>
  );
}

/** One company: why it fits, how to pitch it, what to cite, and everything you've done there. */
export function CompanyPage({ id }: { id: string }) {
  const { data: c, isPending, error } = useCompany(id);
  const update = useUpdateCompany();

  if (isPending) return <p className="text-faint">Loading…</p>;
  if (error) return <ServerDown message={error.message} />;

  const save = (patch: CompanyProfilePatch) => update.mutateAsync({ id: c.id, patch });
  const toggleField = (f: CompanyField) =>
    save({ fields: c.fields.includes(f) ? c.fields.filter((x) => x !== f) : [...c.fields, f] });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div>
          <Link href="/companies" className="text-sm text-faint hover:text-accent">
            Companies
          </Link>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">{c.name}</h1>
          <p className="mt-1 flex flex-wrap gap-x-4 text-sm">
            {c.industry && <span className="text-muted">{c.industry}</span>}
            {c.website && <ExternalLink href={c.website}>Website</ExternalLink>}
            {c.careersUrl && <ExternalLink href={c.careersUrl}>Careers page</ExternalLink>}
            {c.updatedAt && (
              <span className="text-faint">Researched {relativeDays(c.updatedAt)}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted">Fit</span>
            <select
              value={c.fit ?? ''}
              onChange={(e) => save({ fit: (e.target.value || null) as Fit | null })}
              className={`${inputClass} py-1`}
            >
              <option value="">Not set</option>
              {FITS.map((f) => (
                <option key={f} value={f}>
                  {FIT_LABELS[f]}
                </option>
              ))}
            </select>
            <Dot signal={c.fit ? FIT_SIGNAL[c.fit] : 'grey'} />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={c.target}
              onChange={(e) => save({ target: e.target.checked })}
            />
            <span className="text-muted">On my target list</span>
          </label>
        </div>
        <fieldset className="flex flex-wrap items-center gap-1.5 text-sm">
          <legend className="sr-only">Relevant fields</legend>
          <span className="mr-1 text-muted">Fields</span>
          {DESCRIPTION_VARIANTS.filter((f) => f !== 'General').map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={c.fields.includes(f)}
              onClick={() => toggleField(f)}
              className={`rounded-full border px-2.5 py-0.5 ${
                c.fields.includes(f)
                  ? 'border-accent bg-sunken text-fg'
                  : 'border-line text-faint hover:text-fg'
              }`}
            >
              {f}
            </button>
          ))}
        </fieldset>
      </header>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <TextSection
            title="Why it’s relevant to me"
            empty="Not written yet: which of your projects and experience line up with what they do."
            value={c.why}
            onSave={(why) => save({ why })}
          />
          <TextSection
            title="How to pitch it"
            empty="Not written yet: what to lead with, and which profile description to use."
            value={c.angle}
            onSave={(angle) => save({ angle })}
          />
          <Highlights c={c} onSave={(highlights) => save({ highlights })} />
          <TextSection
            title="About the company"
            empty="Not written yet: what they do, the team you'd join, internship programs, timeline, interview process."
            value={c.context}
            onSave={(context) => save({ context })}
          />
          <LinksForm c={c} onSave={save} />
        </div>

        <aside className="flex flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">Applications here</h2>
            {c.applications.length === 0 ? (
              <p className="text-sm text-faint">None yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {c.applications.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/applications/${a.id}`}
                      className="block text-sm hover:text-accent"
                    >
                      <span className="block font-medium">{a.role}</span>
                      <StatusMark status={a.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">People here</h2>
            {c.contacts.length === 0 ? (
              <p className="text-sm text-faint">You don’t know anyone here yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {c.contacts.map((p) => (
                  <li key={p.id}>
                    <Link href={`/people/${p.id}`} className="block text-sm hover:text-accent">
                      <span className="font-medium">{p.name}</span>
                      {p.title && <span className="block text-muted">{p.title}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href.startsWith('http') ? href : `https://${href}`}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline"
    >
      {children}
    </a>
  );
}

function TextSection({
  title,
  empty,
  value,
  onSave,
}: {
  title: string;
  empty: string;
  value: string | null;
  onSave: (v: string | null) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(draft?.trim() ? draft : null);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between text-sm font-medium text-muted">
        {title}
        {draft === null && (
          <button
            type="button"
            onClick={() => setDraft(value ?? '')}
            className="text-xs font-normal text-faint hover:text-fg"
          >
            Edit
          </button>
        )}
      </h2>
      {draft === null ? (
        value ? (
          <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{value}</p>
        ) : (
          <p className="text-sm text-faint">{empty}</p>
        )
      ) : (
        <form onSubmit={save} className="flex flex-col gap-2">
          <textarea
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit Edit click
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
            aria-label={title}
            className={`${inputClass} w-full`}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={buttonClass}>
              Save
            </button>
            <button type="button" onClick={() => setDraft(null)} className={quietButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Projects and roles to cite, each with its profile description when one matches. */
function Highlights({
  c,
  onSave,
}: {
  c: CompanyContext;
  onSave: (v: string[]) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = adding.trim();
    if (!name) return;
    await onSave([...c.highlights, name]);
    setAdding('');
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-muted">What to highlight</h2>
      {c.highlightDetails.length === 0 ? (
        <p className="text-sm text-faint">
          No highlights yet: name the projects and roles to bring up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {c.highlightDetails.map((h) => (
            <li key={h.name} className="rounded-md border border-line p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{h.name}</span>
                <button
                  type="button"
                  onClick={() => onSave(c.highlights.filter((x) => x !== h.name))}
                  className="text-xs text-faint hover:text-fg"
                >
                  Remove
                </button>
              </div>
              {h.description ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{h.description}</p>
              ) : (
                <p className="mt-1 text-sm text-faint">
                  {h.entryId ? 'No description in your profile yet.' : 'Not in your profile yet.'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Project or role, e.g. Encore"
          aria-label="Add a highlight"
          className={`${inputClass} min-w-0 flex-1 text-sm`}
        />
        <button type="submit" disabled={!adding.trim()} className={quietButtonClass}>
          Add
        </button>
      </form>
    </section>
  );
}

function LinksForm({
  c,
  onSave,
}: {
  c: CompanyContext;
  onSave: (p: CompanyProfilePatch) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [industry, setIndustry] = useState(c.industry ?? '');
  const [website, setWebsite] = useState(c.website ?? '');
  const [careersUrl, setCareersUrl] = useState(c.careersUrl ?? '');

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${quietButtonClass} self-start`}
      >
        Edit industry and links
      </button>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSave({ industry, website, careersUrl });
    setOpen(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-3">
      <input
        value={industry}
        onChange={(e) => setIndustry(e.target.value)}
        placeholder="Industry"
        aria-label="Industry"
        className={inputClass}
      />
      <input
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        placeholder="Website"
        aria-label="Website"
        className={inputClass}
      />
      <input
        value={careersUrl}
        onChange={(e) => setCareersUrl(e.target.value)}
        placeholder="Careers page"
        aria-label="Careers page"
        className={inputClass}
      />
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className={buttonClass}>
          Save
        </button>
        <button type="button" onClick={() => setOpen(false)} className={quietButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** On an application: the company's research, so it's at hand while applying. */
export function CompanyCard({ name }: { name: string }) {
  const { data: c } = useCompany(name);
  if (!c) return null;
  const researched = c.why || c.angle || c.highlights.length > 0;
  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between text-sm font-medium text-muted">
        Why {c.name}
        <Link href={`/companies/${c.id}`} className="text-xs font-normal text-faint hover:text-fg">
          {researched ? 'Open' : 'Research'}
        </Link>
      </h2>
      {researched ? (
        <div className="flex flex-col gap-2 text-sm">
          <FitMark fit={c.fit} />
          {c.why && <p className="line-clamp-6 whitespace-pre-wrap">{c.why}</p>}
          {c.angle && (
            <p className="line-clamp-4 whitespace-pre-wrap text-muted">
              <span className="font-medium text-fg">Pitch: </span>
              {c.angle}
            </p>
          )}
          {c.highlights.length > 0 && (
            <p className="text-muted">
              <span className="font-medium text-fg">Highlight: </span>
              {c.highlights.join(', ')}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-faint">Not researched yet.</p>
      )}
    </section>
  );
}
