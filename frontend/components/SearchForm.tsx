'use client';

import { useEffect, useId, useState } from 'react';
import { browseFolder, fetchCategories } from '@/lib/api';
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
const QUICK_PICKS = ['tourist places', 'museums', 'historical sites', 'parks', 'universities'];

export default function SearchForm({
  initialValues,
  values: controlled,
  loading,
  variant = 'panel',
  onSearch,
}: SearchFormProps) {
  const hero = variant === 'hero';
  const [values, setValues] = useState<SearchFormValues>(initialValues);
  const [categories, setCategories] = useState<CategorySuggestion[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [browsing, setBrowsing] = useState(false);
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

  function update<K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  const missing: string[] = [];
  if (values.keyword.trim().length < 2) missing.push('what to look for');
  if (!values.city.trim()) missing.push('a city');
  if (!values.country.trim()) missing.push('a country');
  const canSubmit = missing.length === 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !loading) onSearch(values);
      }}
    >
      <div
        className={
          hero
            ? 'space-y-3'
            : 'space-y-2.5 rounded-2xl border border-white/[0.08] bg-ink-900/60 p-3.5'
        }
      >
        {/* On the hero screen the three inputs read as one sentence across a
            single row; in the sidebar they stack. */}
        <div className={hero ? 'grid gap-2.5 sm:grid-cols-[1.4fr_1fr_1fr]' : 'space-y-2.5'}>
          <Field
            label="What are you looking for?"
            hint={hero ? undefined : 'A kind of place, not a specific one'}
            big={hero}
          >
            <input
              list={listId}
              className={hero ? heroInputClass : inputClass}
              placeholder="museums"
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
          {QUICK_PICKS.map((pick) => (
            <button
              key={pick}
              type="button"
              onClick={() => update('keyword', pick)}
              className={`rounded-full border font-medium transition ${
                hero ? 'px-3 py-1.5 text-[12px]' : 'px-2.5 py-1 text-[11px]'
              } ${
                values.keyword.toLowerCase() === pick
                  ? 'border-aqua-500/40 bg-aqua-500/15 text-aqua-300'
                  : 'border-white/[0.07] text-mist-400 hover:border-white/15 hover:text-mist-200'
              }`}
            >
              {pick}
            </button>
          ))}
        </div>

        <button
          type="submit"
          disabled={!canSubmit || loading}
          className={`rounded-xl bg-gradient-to-b from-aqua-400 to-aqua-600 font-semibold text-ink-950 shadow-lg shadow-aqua-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:from-ink-700 disabled:to-ink-700 disabled:text-mist-500 disabled:shadow-none ${
            hero ? 'mx-auto block w-full max-w-xs px-6 py-3 text-[15px]' : 'w-full px-4 py-2.5 text-[13.5px]'
          }`}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>

        {!canSubmit && (
          <p className={`text-center text-mist-500 ${hero ? 'text-[12px]' : 'text-[10.5px]'}`}>
            Enter {missing.join(' and ')} to search.
          </p>
        )}
      </div>

      {/* Advanced — collapsed by default so the common path stays three fields */}
      <div className="rounded-2xl border border-white/[0.08] bg-ink-900/40">
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-[12px] font-semibold text-mist-300 transition hover:text-mist-100"
        >
          <span>Options</span>
          <span aria-hidden className={`transition ${showAdvanced ? 'rotate-180' : ''}`}>⌄</span>
        </button>

        {showAdvanced && (
          <div className="space-y-3 border-t border-white/[0.06] p-3.5">
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

            <Field label="Save downloads to" hint="Where the ZIP is written">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  className={inputClass}
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
                  className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11.5px] font-semibold text-mist-200 transition hover:border-white/20 hover:bg-white/10 disabled:opacity-50"
                >
                  {browsing ? '…' : 'Browse'}
                </button>
              </div>
              {hintVisible && (
                <span className="mt-1 block text-[10.5px] text-aqua-300">
                  A folder window is open — it may be behind your browser.
                </span>
              )}
            </Field>

            <Field
              label="Extra source links"
              hint="Optional pages to read alongside Wikipedia, comma separated"
            >
              <textarea
                className={`${inputClass} min-h-[60px] resize-y`}
                placeholder="https://example.com/city-guide"
                value={values.extraSources}
                onChange={(event) => update('extraSources', event.target.value)}
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

const inputClass =
  'w-full rounded-lg border border-white/[0.08] bg-ink-950/70 px-2.5 py-2 text-[13px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

/** Larger, roomier inputs for the first-run screen. */
const heroInputClass =
  'w-full rounded-xl border border-white/[0.1] bg-ink-950/70 px-3.5 py-3 text-[15px] font-medium text-mist-50 outline-none transition placeholder:text-mist-600 focus:border-aqua-500/50 focus:ring-2 focus:ring-aqua-500/15';

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
        className={`mb-1 block font-semibold text-mist-300 ${big ? 'text-[12px]' : 'text-[11px]'}`}
      >
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[10.5px] leading-snug text-mist-500">{hint}</span>}
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
        <span className="block text-[12px] font-medium text-mist-100">{label}</span>
        <span className="block text-[10.5px] leading-snug text-mist-500">{hint}</span>
      </span>
    </button>
  );
}
