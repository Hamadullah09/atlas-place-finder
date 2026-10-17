'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { browseFolder, fetchCategories, fetchSourceCatalogue } from '@/lib/api';
import type { SourceLink } from '@/lib/types';
import type { CategorySuggestion, SearchQuery } from '@/lib/types';
import { ALL_COLOUR, PRIMARY_BUTTON, pickColour } from '@/lib/palette';

export interface SearchFormValues extends SearchQuery {
  limit: number;
  useLlm: boolean;
  includeImages: boolean;
  downloadPath: string;
  extraSources: string;
}

interface SearchFormProps {
  initialValues: SearchFormValues;
  values?: SearchFormValues;
  /** Sources the last search actually used, listed under More options. */
  sources?: SourceLink[];
  loading: boolean;
  /**
   * 'hero' is the first-run screen: the form owns the whole window, so the
   * fields sit on one row and everything is larger. 'panel' is the compact
   * sidebar form shown once the map and results are on screen.
   */
  variant?: 'panel' | 'hero';
  onSearch: (values: SearchFormValues) => void;
  onCancel: () => void;
}

/** One-click starting points, so the first search needs no typing. */
export const ALL_PLACES = 'all';

/** Common types, offered as toggles. Several may be picked at once. */
export const QUICK_PICKS = [
  'tourist places', 'museums', 'historical sites', 'parks',
  'universities', 'hospitals', 'hotels', 'restaurants',
];

/** Splits the comma-separated keyword field into its parts. */
export function keywordParts(keyword: string): string[] {
  return keyword.split(',').map((part) => part.trim()).filter(Boolean);
}

/** Empty counts as "all" - it is the default, not a missing answer. */
export function isAll(keyword: string): boolean {
  const value = keyword.trim().toLowerCase();
  return value.length === 0 || value === ALL_PLACES;
}

export default function SearchForm({
  initialValues,
  values: controlled,
  sources,
  loading,
  variant = 'panel',
  onSearch,
}: SearchFormProps) {
  const hero = variant === 'hero';
  const [values, setValues] = useState<SearchFormValues>(initialValues);
  const [categories, setCategories] = useState<CategorySuggestion[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const keywordRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  /** Open state of the "something else" field at the end of the chip row. */
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState('');
  const [hintVisible, setHintVisible] = useState(false);
  const listId = useId();

  // Lets the parent fill the form (e.g. the "try an example" button).
  useEffect(() => {
    if (controlled) setValues(controlled);
  }, [controlled]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCategories(controller.signal).then(setCategories);
    return () => controller.abort();
  }, []);

  /**
   * Appends a type to the search box and leaves the cursor after the comma.
   *
   * "all" stands for everything, so the first real pick replaces it rather
   * than joining it.
   */
  function addKeyword(value: string, focusBox = true): void {
    const pick = value.trim().replace(/,+$/, '').trim();
    if (!pick) return;

    const current = isAll(values.keyword) ? [] : keywordParts(values.keyword);
    if (current.some((part) => part.toLowerCase() === pick.toLowerCase())) return;

    setValues((previous) => ({
      ...previous,
      keyword: `${[...current, pick].join(', ')}, `,
    }));

    if (!focusBox) return;
    requestAnimationFrame(() => {
      const input = keywordRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function update<K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  // A blank keyword searches for everything, so it is never a blocker.
  const keyword = values.keyword.trim() || ALL_PLACES;
  const missing: string[] = [];
  if (!values.city.trim()) missing.push('a city');
  if (!values.country.trim()) missing.push('a country');
  // The results are written into this folder, so a search without one would
  // have nowhere to go. Checked here rather than after a search of several
  // minutes, which is when the server would otherwise refuse it.
  const folder = values.downloadPath.trim();
  if (!folder) missing.push('the folder to save in');
  else if (!isAbsoluteFolder(folder)) missing.push('a full folder path, such as D:\\Places');
  const canSubmit = missing.length === 0;

  const input = hero ? heroInputClass : inputClass;
  const chip = hero ? 'px-4 py-2 text-[18px]' : 'px-3 py-1.5 text-[18px]';
  const extraCount = keywordParts(values.extraSources.replace(/\n/g, ',')).length;

  return (
    <form
      className={hero ? 'space-y-4' : 'space-y-3 rounded-2xl border border-slate-200 border-t-4 border-t-teal-500 bg-ink-900 p-3.5'}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !loading) onSearch({ ...values, keyword });
      }}
    >
      {/* What and where. On a wide hero screen the three read as one row; on a
          phone and in the sidebar "what" gets a full row above city and country. */}
      <div className={`grid grid-cols-2 gap-2.5 ${hero ? 'sm:grid-cols-[1.4fr_1fr_1fr]' : ''}`}>
        <div className={hero ? 'col-span-2 sm:col-span-1' : 'col-span-2'}>
          <Field label="What to find" big={hero}>
            <input
              ref={keywordRef}
              list={listId}
              className={input}
              placeholder="all"
              value={values.keyword}
              autoComplete="off"
              onChange={(event) => update('keyword', event.target.value)}
            />
            <datalist id={listId}>
              {categories.map((category) => (
                <option key={category.id} value={category.example}>
                  {category.label}
                </option>
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="City" big={hero}>
          <input
            className={input}
            placeholder="Kyoto"
            value={values.city}
            autoComplete="address-level2"
            onChange={(event) => update('city', event.target.value)}
          />
        </Field>
        <Field label="Country" big={hero}>
          <input
            className={input}
            placeholder="Japan"
            value={values.country}
            autoComplete="country-name"
            onChange={(event) => update('country', event.target.value)}
          />
        </Field>
      </div>

      {/* Quick picks: one swipeable row on a phone, wrapped on wider screens. */}
      <div className={`chip-row flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0 ${hero ? 'sm:justify-center' : ''}`}>
        <button
          type="button"
          onClick={() => update('keyword', ALL_PLACES)}
          className={`shrink-0 whitespace-nowrap rounded-full border font-semibold transition ${chip} ${
            isAll(values.keyword) ? ALL_COLOUR.on : ALL_COLOUR.idle
          }`}
        >
          All places
        </button>

        {QUICK_PICKS.map((pick) => {
          const chosen = !isAll(values.keyword) && keywordParts(values.keyword).includes(pick);
          return (
            <button
              key={pick}
              type="button"
              aria-pressed={chosen}
              onClick={() => {
                if (chosen) {
                  const next = keywordParts(values.keyword).filter((part) => part !== pick);
                  update('keyword', next.length > 0 ? next.join(', ') : ALL_PLACES);
                  return;
                }
                addKeyword(pick);
              }}
              className={`shrink-0 whitespace-nowrap rounded-full border font-medium transition ${chip} ${
                chosen ? pickColour(pick).on : pickColour(pick).idle
              }`}
            >
              {chosen ? `✓ ${pick}` : pick}
            </button>
          );
        })}

        {/* Anything the row does not offer. */}
        {adding ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            <input
              ref={customRef}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                // Enter belongs to this field, not to the search.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addKeyword(custom, false);
                  setCustom('');
                  return;
                }
                if (event.key === 'Escape') {
                  setAdding(false);
                  setCustom('');
                }
              }}
              onBlur={() => {
                if (!custom.trim()) setAdding(false);
              }}
              placeholder="e.g. libraries"
              aria-label="Add another kind of place"
              className={`w-36 animate-slide-in rounded-full border border-aqua-500 bg-white px-3 text-mist-50 outline-none transition placeholder:text-mist-500 focus:ring-2 focus:ring-aqua-500/20 ${
                hero ? 'py-2 text-[18px]' : 'py-1.5 text-[18px]'
              }`}
            />
            <button
              type="button"
              onClick={() => {
                addKeyword(custom, false);
                setCustom('');
                customRef.current?.focus();
              }}
              disabled={!custom.trim()}
              className="rounded-full bg-aqua-500 px-3 py-1.5 text-[18px] font-semibold text-white transition hover:bg-aqua-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setCustom(''); }}
              aria-label="Close"
              className="px-1 text-[19px] text-mist-500 transition hover:text-mist-200"
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              requestAnimationFrame(() => customRef.current?.focus());
            }}
            className={`shrink-0 whitespace-nowrap rounded-full border border-dashed border-slate-400 bg-white font-semibold text-mist-400 transition hover:border-aqua-500 hover:text-aqua-300 ${chip}`}
          >
            + Other
          </button>
        )}
      </div>

      <Field label="Save to folder" big={hero}>
        <div className={`flex gap-1.5 ${hero ? 'flex-col sm:flex-row' : ''}`}>
          <input
            type="text"
            required
            className={input}
            placeholder="e.g. D:\Places"
            value={values.downloadPath}
            onChange={(event) => update('downloadPath', event.target.value)}
          />
          <button
            type="button"
            disabled={browsing}
            onClick={async () => {
              setBrowsing(true);
              setHintVisible(true);
              try {
                const picked = await browseFolder();
                if (picked) update('downloadPath', picked);
              } catch {
                // The field can still be typed manually.
              } finally {
                setBrowsing(false);
                setHintVisible(false);
              }
            }}
            className={`shrink-0 rounded-xl border border-slate-300 bg-slate-100 font-semibold text-mist-200 transition hover:border-slate-400 hover:bg-slate-200 disabled:opacity-50 ${
              hero ? 'px-5 py-2.5 text-[19px] sm:py-0' : 'px-3.5 text-[18px]'
            }`}
          >
            {browsing ? 'Choosing…' : 'Browse…'}
          </button>
        </div>
        {hintVisible && (
          <span className="mt-1 block text-[18px] text-aqua-300">
            A folder window is open — it may be behind your browser.
          </span>
        )}
      </Field>

      <div>
        <button
          type="submit"
          disabled={!canSubmit || loading}
          // The button stays disabled until every answer is in; hovering it says which are missing.
          title={canSubmit ? undefined : `Still needed: ${listOf(missing)}`}
          className={`w-full rounded-xl font-semibold ${PRIMARY_BUTTON} ${
            hero ? 'px-6 py-3 text-[20px] sm:mx-auto sm:block sm:max-w-xs' : 'px-4 py-2.5 text-[19px]'
          }`}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>

      </div>

      {/* Everything else, folded away so the common path is three answers. */}
      <div className="rounded-xl border border-slate-200 bg-slate-50">
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[18px] font-semibold text-mist-300 transition hover:text-mist-100"
        >
          <span className="shrink-0 whitespace-nowrap">More options</span>
          <span className="truncate font-normal text-mist-500">
            {[
              values.limit ? `max ${values.limit}` : null,
              !values.useLlm ? 'AI off' : null,
              !values.includeImages ? 'no photos' : null,
              extraCount ? `${extraCount} link${extraCount === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' · ')}
          </span>
          <span aria-hidden className={`ml-auto transition ${showAdvanced ? 'rotate-180' : ''}`}>⌄</span>
        </button>

        {showAdvanced && (
          <div className="space-y-3 border-t border-slate-200 bg-white p-3.5">
            <Field label="Max results" hint="Blank takes every place found. Fewer finishes sooner.">
              <input
                type="number"
                min={0}
                inputMode="numeric"
                className={inputClass}
                placeholder="All"
                value={values.limit === 0 ? '' : values.limit}
                onChange={(event) => update('limit', Number(event.target.value) || 0)}
              />
            </Field>

            <Toggle
              label="Use AI to check relevance"
              hint="Off is much faster but keeps irrelevant places"
              checked={values.useLlm}
              onChange={(checked) => update('useLlm', checked)}
            />
            <Toggle
              label="Find photographs"
              hint="Adds images to the PDFs; slower"
              checked={values.includeImages}
              onChange={(checked) => update('includeImages', checked)}
            />

            <Field label="Extra source links" hint="Web pages to read as well, separated by commas.">
              <textarea
                className={`${inputClass} min-h-[60px] resize-y`}
                placeholder="https://example.com/city-guide"
                value={values.extraSources}
                onChange={(event) => update('extraSources', event.target.value)}
              />
            </Field>

            <SourcesInUse sources={sources} typed={values.extraSources} country={values.country} />
          </div>
        )}
      </div>
    </form>
  );
}

/**
 * What this search reads.
 *
 * Shows the sources the backend reported for the last run, plus anything
 * typed into the box above that has not been searched with yet, so adding a
 * link has visible effect before pressing Search.
 */
function SourcesInUse({
  sources,
  typed,
  country,
}: {
  sources?: SourceLink[];
  typed: string;
  country?: string;
}) {
  const pending = useMemo(() => {
    const known = new Set((sources ?? []).map((source) => source.url.toLowerCase()));
    const seen = new Set<string>();
    const out: SourceLink[] = [];
    for (const raw of typed.split(/[,\n]+/)) {
      const value = raw.trim();
      if (!value) continue;
      try {
        const url = new URL(value);
        const key = url.href.toLowerCase();
        if (known.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ label: url.hostname, url: url.href, kind: 'extra' });
      } catch {
        // Half-typed or invalid: nothing useful to show yet.
      }
    }
    return out;
  }, [sources, typed]);

  const [catalogue, setCatalogue] = useState<SourceLink[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    // Typing a country changes the list, so wait for a pause before asking
    // rather than firing a request per keystroke.
    const timer = setTimeout(() => {
      void fetchSourceCatalogue(controller.signal, country).then(setCatalogue);
    }, country ? 400 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [country]);

  const used = sources ?? [];
  const listed = used.length > 0 ? used : catalogue;
  const searched = used.length > 0;
  if (listed.length === 0 && pending.length === 0) return null;

  return (
    <SourcesDisclosure
      count={listed.length}
      extra={pending.length > 0 ? `+${pending.length} added` : undefined}
      footer={searched ? 'What this search read.' : 'Read for every place.'}
    >
      {pending.map((source) => (
        <li key={`pending-${source.url}`} className="flex items-baseline gap-1.5">
          <span className="shrink-0 rounded bg-aqua-500/10 px-1.5 text-[16px] font-semibold text-aqua-300">new</span>
          <SourceAnchor source={source} />
        </li>
      ))}
      {listed.map((source) => (
        <li key={source.url}>
          <SourceAnchor source={source} />
        </li>
      ))}
    </SourcesDisclosure>
  );
}

/**
 * The folded list of sources, shared by single and batch search: closed until
 * clicked, with a Show / Hide cue so it is obvious it opens.
 */
export function SourcesDisclosure({
  count,
  extra,
  footer,
  children,
}: {
  count: number;
  extra?: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white p-2.5">
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5 text-[18px] font-semibold text-mist-300 marker:hidden [&::-webkit-details-marker]:hidden">
        Sources ({count})
        {extra && <span className="truncate font-medium text-aqua-300">{extra}</span>}
        <span className="ml-auto shrink-0 text-[17px] font-medium text-aqua-300">
          <span className="group-open:hidden">Show ▸</span>
          <span className="hidden group-open:inline">Hide ▾</span>
        </span>
      </summary>
      <ul className="mt-2 space-y-1 text-[18px]">{children}</ul>
      {footer && <p className="mt-1.5 text-[17px] text-mist-500">{footer}</p>}
    </details>
  );
}

export function SourceAnchor({ source }: { source: { label: string; url: string } }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      title={source.url}
      className="break-words text-mist-400 underline-offset-2 hover:text-aqua-300 hover:underline"
    >
      {source.label}
    </a>
  );
}

const inputClass =
  'w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[18px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

/** Larger, roomier inputs for the first-run screen. */
const heroInputClass =
  'w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-[19px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

/** A path the server can write to as given: a drive, a network share, or a root. */
export function isAbsoluteFolder(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path) || path.startsWith('/');
}

/** "a, b and c" */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function Field({
  label,
  hint,
  big,
  children,
}: {
  label: string;
  hint?: string;
  big?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className={`mb-1 block font-semibold text-mist-300 ${big ? 'text-[18px]' : 'text-[18px]'}`}>
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[17px] leading-snug text-mist-500">{hint}</span>}
    </label>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={`mt-0.5 flex h-[20px] w-[36px] shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? 'bg-teal-600' : 'bg-ink-600'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[18px] font-medium text-mist-100">{label}</span>
        {hint && <span className="block text-[17px] leading-snug text-mist-500">{hint}</span>}
      </span>
    </button>
  );
}
