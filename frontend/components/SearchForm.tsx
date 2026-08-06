'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { fetchCategories } from '@/lib/api';
import type { CategorySuggestion, SearchQuery } from '@/lib/types';

export interface SearchFormValues extends SearchQuery {
  limit: number;
  useLlm: boolean;
  includeImages: boolean;
}

interface SearchFormProps {
  initialValues: SearchFormValues;
  loading: boolean;
  onSearch: (values: SearchFormValues) => void;
  onCancel: () => void;
}

const QUICK_PICKS = [
  { label: 'Tourist places', value: 'tourist places', icon: '🏛' },
  { label: 'Historical', value: 'historical sites', icon: '🏺' },
  { label: 'Universities', value: 'universities', icon: '🎓' },
  { label: 'Hospitals', value: 'hospitals', icon: '🏥' },
  { label: 'Cafes', value: 'cafes', icon: '☕' },
  { label: 'Hotels', value: 'hotels', icon: '🛎' },
  { label: 'Companies', value: 'companies', icon: '🏢' },
  { label: 'Museums', value: 'museums', icon: '🖼' },
];

export default function SearchForm({ initialValues, loading, onSearch, onCancel }: SearchFormProps) {
  const [values, setValues] = useState<SearchFormValues>(initialValues);
  const [categories, setCategories] = useState<CategorySuggestion[]>([]);
  const [showOptions, setShowOptions] = useState(false);
  const listId = useId();
  const optionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCategories(controller.signal).then(setCategories);
    return () => controller.abort();
  }, []);

  // Dismiss the options popover on outside click / Escape.
  useEffect(() => {
    if (!showOptions) return undefined;

    function onPointerDown(event: MouseEvent) {
      if (!optionsRef.current?.contains(event.target as Node)) setShowOptions(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowOptions(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showOptions]);

  function update<K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  const canSubmit =
    values.keyword.trim().length >= 2
    && values.city.trim().length > 0
    && values.country.trim().length > 0;

  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !loading) onSearch(values);
      }}
    >
      {/* Segmented search bar */}
      <div className="group flex items-stretch overflow-hidden rounded-2xl border border-white/[0.09] bg-ink-850/80 shadow-xl shadow-black/40 transition focus-within:border-aqua-500/50 focus-within:shadow-aqua-500/10">
        <Segment label="Looking for" grow>
          <input
            id="keyword"
            list={listId}
            className={inputClass}
            placeholder="tourist places"
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
        </Segment>

        <Divider />

        <Segment label="City">
          <input
            id="city"
            className={inputClass}
            placeholder="Karachi"
            value={values.city}
            autoComplete="address-level2"
            onChange={(event) => update('city', event.target.value)}
          />
        </Segment>

        <Divider />

        <Segment label="Country">
          <input
            id="country"
            className={inputClass}
            placeholder="Pakistan"
            value={values.country}
            autoComplete="country-name"
            onChange={(event) => update('country', event.target.value)}
          />
        </Segment>

        <div className="flex items-center gap-1.5 p-1.5">
          {loading ? (
            <button
              type="button"
              onClick={onCancel}
              className="h-11 rounded-xl border border-white/10 px-4 text-sm font-semibold text-mist-200 transition hover:border-white/20 hover:bg-white/5"
            >
              Stop
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canSubmit || loading}
            aria-label="Search"
            className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-b from-aqua-400 to-aqua-600 text-ink-950 shadow-lg shadow-aqua-500/25 transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:from-ink-700 disabled:to-ink-700 disabled:text-mist-500 disabled:shadow-none sm:w-auto sm:px-5"
          >
            {loading ? (
              <Spinner />
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-4 w-4 sm:hidden" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"
                  />
                </svg>
                <span className="hidden text-sm font-semibold sm:inline">Search</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Quick picks + options */}
      <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto pb-0.5 scroll-region">
        {QUICK_PICKS.map((pick) => {
          const active = values.keyword.toLowerCase() === pick.value;
          return (
            <button
              key={pick.value}
              type="button"
              onClick={() => update('keyword', pick.value)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition ${
                active
                  ? 'border-aqua-500/40 bg-aqua-500/15 text-aqua-300'
                  : 'border-white/[0.07] text-mist-400 hover:border-white/15 hover:text-mist-200'
              }`}
            >
              <span aria-hidden className="text-[12px] leading-none">
                {pick.icon}
              </span>
              {pick.label}
            </button>
          );
        })}

        <div className="relative ml-auto shrink-0 pl-2" ref={optionsRef}>
          <button
            type="button"
            onClick={() => setShowOptions((open) => !open)}
            aria-expanded={showOptions}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition ${
              showOptions
                ? 'border-white/20 bg-white/[0.07] text-mist-100'
                : 'border-white/[0.07] text-mist-400 hover:border-white/15 hover:text-mist-200'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
              <path
                fill="currentColor"
                d="M3 6h11a3 3 0 0 1 6 0h1v2h-1a3 3 0 0 1-6 0H3V6Zm0 10h5a3 3 0 0 1 6 0h7v2h-7a3 3 0 0 1-6 0H3v-2Z"
              />
            </svg>
            Options
          </button>

          {showOptions && (
            <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl p-3.5 shadow-2xl shadow-black/60 glass-strong animate-rise">
              <label className="block">
                <span className="flex items-baseline justify-between text-[11px] font-medium text-mist-400">
                  Max results
                  <span className="text-sm font-semibold tabular-nums text-mist-50">
                    {values.limit}
                  </span>
                </span>
                <input
                  type="range"
                  min={5}
                  max={60}
                  step={5}
                  value={values.limit}
                  onChange={(event) => update('limit', Number(event.target.value))}
                  className="mt-1.5 w-full accent-aqua-400"
                />
              </label>

              <div className="mt-3 space-y-2.5 border-t border-white/[0.07] pt-3">
                <Switch
                  label="Clean results with the LLM"
                  hint="Falls back to rule-based cleaning without a key."
                  checked={values.useLlm}
                  onChange={(checked) => update('useLlm', checked)}
                />
                <Switch
                  label="Fetch ultra-HD images"
                  hint="Wikidata → Wikipedia → Commons → Unsplash."
                  checked={values.includeImages}
                  onChange={(checked) => update('includeImages', checked)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

const inputClass =
  'w-full bg-transparent text-[13.5px] font-medium text-mist-50 outline-none placeholder:text-mist-500/70';

function Segment({
  label,
  children,
  grow,
}: {
  label: string;
  children: React.ReactNode;
  grow?: boolean;
}) {
  return (
    <label
      className={`flex min-w-0 cursor-text flex-col justify-center px-3.5 py-2 transition hover:bg-white/[0.03] ${
        grow ? 'flex-[1.4]' : 'flex-1'
      }`}
    >
      <span className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-mist-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function Divider() {
  return <span aria-hidden className="my-2.5 w-px shrink-0 bg-white/[0.07]" />;
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        d="M21 12a9 9 0 0 0-9-9"
      />
    </svg>
  );
}

function Switch({
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
