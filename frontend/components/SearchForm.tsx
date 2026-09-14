'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { browseFolder, fetchCategories, fetchSourceCatalogue } from '@/lib/api';
import type { SourceLink } from '@/lib/types';
import type { CategorySuggestion, SearchQuery } from '@/lib/types';

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
  /** Sources the last search actually used, listed above the extras box. */
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
  const canSubmit = missing.length === 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !loading) onSearch({ ...values, keyword });
      }}
    >
      <div
        className={
          hero
            ? 'space-y-3'
            : 'space-y-2.5 rounded-2xl border border-slate-200 bg-ink-900/60 p-3.5'
        }
      >
        {/* On the hero screen the three inputs read as one sentence across a
            single row; in the sidebar they stack. */}
        <div className={hero ? 'grid gap-2.5 sm:grid-cols-[1.4fr_1fr_1fr]' : 'space-y-2.5'}>
          <Field label="What are you looking for?" big={hero}>
            <input
              ref={keywordRef}
              list={listId}
              className={hero ? heroInputClass : inputClass}
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

          {hero ? (
            <>
              <Field label="City" big>
                <input
                  className={heroInputClass}
                  placeholder="Kyoto"
                  value={values.city}
                  autoComplete="address-level2"
                  onChange={(event) => update('city', event.target.value)}
                />
              </Field>
              <Field label="Country" big>
                <input
                  className={heroInputClass}
                  placeholder="Japan"
                  value={values.country}
                  autoComplete="country-name"
                  onChange={(event) => update('country', event.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="City">
                <input
                  className={inputClass}
                  placeholder="Kyoto"
                  value={values.city}
                  autoComplete="address-level2"
                  onChange={(event) => update('city', event.target.value)}
                />
              </Field>
              <Field label="Country">
                <input
                  className={inputClass}
                  placeholder="Japan"
                  value={values.country}
                  autoComplete="country-name"
                  onChange={(event) => update('country', event.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        <div className={`flex flex-wrap gap-1.5 ${hero ? 'justify-center' : ''}`}>
          <button
            type="button"
            onClick={() => update('keyword', ALL_PLACES)}
            className={`rounded-full border font-semibold transition ${
              hero ? 'px-4 py-2 text-[15px]' : 'px-3 py-1.5 text-[15px]'
            } ${
              isAll(values.keyword)
                ? 'border-aqua-500 bg-aqua-500 text-white'
                : 'border-slate-300 text-mist-300 hover:border-aqua-500 hover:text-aqua-300'
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
                className={`rounded-full border font-medium transition ${
                  hero ? 'px-4 py-2 text-[15px]' : 'px-3 py-1.5 text-[15px]'
                } ${
                  chosen
                    ? 'border-aqua-500 bg-aqua-500/10 text-aqua-300'
                    : 'border-slate-300 text-mist-300 hover:border-aqua-500 hover:text-aqua-300'
                }`}
              >
                {chosen ? `✓ ${pick}` : pick}
              </button>
            );
          })}

          {/* Anything the row does not offer. */}
          {adding ? (
            <span className="inline-flex items-center gap-1 overflow-hidden">
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
                className={`w-40 animate-slide-in rounded-full border border-aqua-500 bg-white px-3 text-mist-50 outline-none transition placeholder:text-mist-500 focus:ring-2 focus:ring-aqua-500/20 ${
                  hero ? 'py-2 text-[15px]' : 'py-1.5 text-[15px]'
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
                className="rounded-full bg-aqua-500 px-3 py-1.5 text-[15px] font-semibold text-white transition hover:bg-aqua-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setCustom(''); }}
                aria-label="Close"
                className="px-1 text-[16px] text-mist-500 transition hover:text-mist-200"
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
              className={`rounded-full border border-dashed border-slate-400 font-semibold text-mist-400 transition hover:border-aqua-500 hover:text-aqua-300 ${
                hero ? 'px-4 py-2 text-[15px]' : 'px-3 py-1.5 text-[15px]'
              }`}
            >
              + Add
            </button>
          )}
        </div>

        <Field
          label="Save downloads to"
          hint="Pick a folder and the ZIP is written straight into it. Leave it empty to download through the browser."
          big={hero}
        >
          <div className="flex gap-1.5">
            <input
              type="text"
              className={hero ? heroInputClass : inputClass}
              placeholder="Ask me each time"
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
                  const folder = await browseFolder();
                  if (folder) update('downloadPath', folder);
                } catch {
                  // The field can still be typed manually.
                } finally {
                  setBrowsing(false);
                  setHintVisible(false);
                }
              }}
              className={`shrink-0 rounded-xl border border-slate-300 bg-slate-100 font-semibold text-mist-200 transition hover:border-slate-400 hover:bg-slate-200 disabled:opacity-50 ${
                hero ? 'px-5 text-[17px]' : 'px-3.5 text-[16px]'
              }`}
            >
              {browsing ? 'Choosing…' : 'Choose folder'}
            </button>
          </div>
          {hintVisible && (
            <span className="mt-1 block text-[15.5px] text-aqua-300">
              A folder window is open — it may be behind your browser.
            </span>
          )}
        </Field>

        <SourcesInUse sources={sources} typed={values.extraSources} big={hero} />

        <Field
          label="Extra source links"
          hint="Optional. Web pages to read alongside Wikipedia, separated by commas."
          big={hero}
        >
          <textarea
            className={`${hero ? heroInputClass : inputClass} min-h-[60px] resize-y`}
            placeholder="https://example.com/city-guide"
            value={values.extraSources}
            onChange={(event) => update('extraSources', event.target.value)}
          />
        </Field>

        <button
          type="submit"
          disabled={!canSubmit || loading}
          className={`rounded-xl bg-gradient-to-b from-aqua-400 to-aqua-600 font-semibold text-white shadow-lg shadow-aqua-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:from-ink-700 disabled:to-ink-700 disabled:text-mist-500 disabled:shadow-none ${
            hero ? 'mx-auto block w-full max-w-xs px-6 py-3 text-[17px]' : 'w-full px-4 py-2.5 text-[16px]'
          }`}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>

        {!canSubmit && (
          <p className={`text-center text-mist-500 ${hero ? 'text-[14.5px]' : 'text-[15.5px]'}`}>
            Enter {missing.join(' and ')} to search.
          </p>
        )}
      </div>

      {/* Advanced — collapsed by default so the common path stays three fields */}
      <div className="rounded-2xl border border-slate-200 bg-ink-900/40">
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-[14.5px] font-semibold text-mist-300 transition hover:text-mist-100"
        >
          <span>Options</span>
          <span aria-hidden className={`transition ${showAdvanced ? 'rotate-180' : ''}`}>⌄</span>
        </button>

        {showAdvanced && (
          <div className="space-y-3 border-t border-slate-200 p-3.5">
            <Field
              label="Max results"
              hint="Blank means every place found. Each is researched separately, so large cities take longer."
            >
              <input
                type="number"
                min={0}
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
 * typed into the box below that has not been searched with yet, so adding a
 * link has visible effect before pressing Search.
 */
function SourcesInUse({
  sources,
  typed,
  big,
}: {
  sources?: SourceLink[];
  typed: string;
  big?: boolean;
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
    void fetchSourceCatalogue(controller.signal).then(setCatalogue);
    return () => controller.abort();
  }, []);

  const used = sources ?? [];
  const listed = used.length > 0 ? used : catalogue;
  const searched = used.length > 0;
  if (listed.length === 0 && pending.length === 0) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
      <summary className="cursor-pointer list-none text-[15.5px] font-semibold text-mist-300 marker:hidden">
        Sources ({listed.length})
        {pending.length > 0 && (
          <span className="ml-1.5 font-medium text-aqua-300">
            +{pending.length} added
          </span>
        )}
      </summary>

      <ul className={`mt-2 space-y-1 ${big ? 'text-[15.5px]' : 'text-[15px]'}`}>
        {pending.map((source) => (
          <li key={`pending-${source.url}`} className="flex items-baseline gap-1.5">
            <span className="shrink-0 rounded bg-aqua-500/10 px-1.5 text-[13.5px] font-semibold text-aqua-300">
              new
            </span>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-mist-400 underline-offset-2 hover:text-aqua-300 hover:underline"
            >
              {source.label}
            </a>
          </li>
        ))}
        {listed.map((source) => (
          <li key={source.url}>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              title={source.url}
              className="text-mist-400 underline-offset-2 hover:text-aqua-300 hover:underline"
            >
              {source.label}
            </a>
          </li>
        ))}
      </ul>

      <p className="mt-1.5 text-[14.5px] text-mist-500">
        {searched
          ? 'What this search read.'
          : 'Searched for every place. Add your own pages below.'}
      </p>
    </details>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-ink-950/70 px-2.5 py-2 text-[15.5px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

/** Larger, roomier inputs for the first-run screen. */
const heroInputClass =
  'w-full rounded-xl border border-slate-300 bg-ink-950/70 px-3.5 py-3 text-[17px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

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
    <label className="block">
      <span
        className={`mb-1 block font-semibold text-mist-300 ${big ? 'text-[14.5px]' : 'text-[16px]'}`}
      >
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[15.5px] leading-snug text-mist-500">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 text-left"
    >
      <span
        className={`mt-0.5 flex h-[18px] w-[32px] shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? 'bg-aqua-500' : 'bg-ink-600'
        }`}
      >
        <span
          className={`h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[14px]' : ''
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-medium text-mist-100">{label}</span>
        <span className="block text-[15.5px] leading-snug text-mist-500">{hint}</span>
      </span>
    </button>
  );
}
