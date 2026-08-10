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
  loading: boolean;
  onSearch: (values: SearchFormValues) => void;
  onCancel: () => void;
}

export default function SearchForm({ initialValues, loading, onSearch, onCancel }: SearchFormProps) {
  const [values, setValues] = useState<SearchFormValues>(initialValues);
  const [categories, setCategories] = useState<CategorySuggestion[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const listId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCategories(controller.signal).then(setCategories);
    return () => controller.abort();
  }, []);

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
            placeholder=""
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
            placeholder=""
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
            placeholder=""
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

      <div className="mt-3 space-y-3 rounded-2xl border border-white/[0.07] bg-ink-900/60 p-3">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-mist-500">
            Download path
          </span>
          <div className="mt-1 flex gap-1.5">
            <input
              type="text"
              className="flex-1 rounded-xl border border-white/[0.07] bg-ink-950/80 px-3 py-2 text-sm font-medium text-mist-100 outline-none focus:border-aqua-400 focus:ring-2 focus:ring-aqua-400/20"
              placeholder="C:\\Users\\you\\Downloads\\Places"
              value={values.downloadPath}
              onChange={(event) => update('downloadPath', event.target.value)}
            />
            <button
              type="button"
              onClick={async () => {
                setBrowsing(true);
                setHintVisible(false);
                try {
                  const folder = await browseFolder();
                  if (folder) update('downloadPath', folder);
                } catch {
                  // ignore; the field can still be typed manually.
                } finally {
                  setBrowsing(false);
                }
              }}
              disabled={browsing}
              className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 text-[12px] font-semibold text-mist-200 transition hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {browsing ? 'Choosing…' : 'Browse…'}
            </button>
          </div>
          {hintVisible && (
            <span className="mt-1 block text-[10.5px] leading-snug text-aqua-300">
              A folder browser window is open. It may appear behind your browser.
            </span>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-mist-500">
            Additional links
          </span>
          <textarea
            className="w-full min-h-[72px] rounded-xl border border-white/[0.07] bg-ink-950/80 px-3 py-2 text-sm font-medium text-mist-100 outline-none resize-y focus:border-aqua-400 focus:ring-2 focus:ring-aqua-400/20"
            placeholder="https://example.com/article, https://another.example.com"
            value={values.extraSources}
            onChange={(event) => update('extraSources', event.target.value)}
          />
        </label>
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
