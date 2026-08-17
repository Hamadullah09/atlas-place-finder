'use client';

import SearchForm, { type SearchFormValues } from '@/components/SearchForm';

/**
 * The first-run screen. Before any search there is nothing to plot, so the map
 * is dead space — the form takes the whole window instead, and the three steps
 * explain what the tool actually does. Once a search starts, PlaceFinder swaps
 * to the map + sidebar layout.
 */

const STEPS = [
  {
    n: '1',
    title: 'Say what and where',
    body: 'A kind of place and a city. Leave Max results blank to take everything.',
  },
  {
    n: '2',
    title: 'It researches each one',
    body: 'Finds them, translates non-English names, checks relevance, gathers photos.',
  },
  {
    n: '3',
    title: 'Download the write-ups',
    body: 'A ZIP with one folder per place: an illustrated PDF plus the photographs.',
  },
];

export default function HeroSearch({
  values,
  initialValues,
  loading,
  onSearch,
  onCancel,
  onBatch,
}: {
  values: SearchFormValues;
  initialValues: SearchFormValues;
  loading: boolean;
  onSearch: (values: SearchFormValues) => void;
  onCancel: () => void;
  onBatch: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto scroll-region px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="text-center">
          <h1 className="text-balance text-[26px] font-semibold leading-tight tracking-tight text-mist-50 sm:text-[32px]">
            Research every place of a kind,
            <br className="hidden sm:block" /> in any city on earth
          </h1>
          <p className="mx-auto mt-2.5 max-w-lg text-[13.5px] leading-relaxed text-mist-400">
            Search once and get a folder of illustrated PDF write-ups you can keep.
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-white/[0.08] bg-ink-900/60 p-5 shadow-2xl shadow-black/40 backdrop-blur">
          <SearchForm
            initialValues={initialValues}
            values={values}
            loading={loading}
            variant="hero"
            onSearch={onSearch}
            onCancel={onCancel}
          />
        </div>

        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded-full bg-aqua-500/15 text-[12px] font-bold text-aqua-300"
              >
                {step.n}
              </span>
              <span className="mt-2 block text-[13px] font-medium text-mist-200">{step.title}</span>
              <span className="mt-1 block text-[11.5px] leading-snug text-mist-500">
                {step.body}
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-center text-[12px] text-mist-500">
          Got a list of cities?{' '}
          <button
            type="button"
            onClick={onBatch}
            className="font-semibold text-aqua-300 underline-offset-2 hover:underline"
          >
            Switch to Batch search
          </button>{' '}
          to work through a whole CSV unattended.
        </p>
      </div>
    </div>
  );
}
