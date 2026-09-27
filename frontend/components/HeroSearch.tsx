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
    body: 'One folder per place: an illustrated PDF plus the photographs.',
  },
];

const SUGGESTED_PLACES: Array<{ keyword: string; city: string; country: string; label: string; description: string }> = [
  { keyword: 'museums', city: 'Kyoto', country: 'Japan', label: 'Museums in Kyoto', description: 'Explore Kyoto\'s rich museum scene' },
  { keyword: 'parks', city: 'Barcelona', country: 'Spain', label: 'Parks in Barcelona', description: 'Discover Barcelona\'s green spaces' },
  { keyword: 'tourist places', city: 'Istanbul', country: 'Turkey', label: 'Sights in Istanbul', description: 'Historic landmarks of Istanbul' },
  { keyword: 'universities', city: 'Oxford', country: 'United Kingdom', label: 'Universities in Oxford', description: 'World-famous academic institutions' },
  { keyword: 'temples', city: 'Bangkok', country: 'Thailand', label: 'Temples in Bangkok', description: 'Sacred temples and shrines' },
  { keyword: 'historical sites', city: 'Rome', country: 'Italy', label: 'Historic Rome', description: 'Ancient Roman landmarks' },
];

export default function HeroSearch({
  values,
  initialValues,
  loading,
  onSearch,
  onCancel,
  onBatch,
  onAddSuggestion,
}: {
  values: SearchFormValues;
  initialValues: SearchFormValues;
  loading: boolean;
  onSearch: (values: SearchFormValues) => void;
  onCancel: () => void;
  onBatch: () => void;
  onAddSuggestion?: (keyword: string, city: string, country: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto scroll-region px-4 py-8">
      <div className="my-auto w-full max-w-3xl">
        <div className="text-center">
          <h1 className="text-balance text-[26px] font-semibold leading-tight tracking-tight text-mist-50 sm:text-[32px]">
            Research every place of a kind,
            <br className="hidden sm:block" /> in any city on earth
          </h1>
          <p className="mx-auto mt-2.5 max-w-lg text-[16px] leading-relaxed text-mist-400">
            Search once and get a folder of illustrated PDF write-ups you can keep.
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-slate-200 bg-ink-900/60 p-5 shadow-2xl shadow-slate-900/10 backdrop-blur">
          <SearchForm
            initialValues={initialValues}
            values={values}
            loading={loading}
            variant="hero"
            onSearch={onSearch}
            onCancel={onCancel}
          />
        </div>

        {onAddSuggestion && (
          <div className="mt-6">
            <h2 className="text-center text-[15.5px] font-semibold text-mist-300">
              Suggested searches
            </h2>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {SUGGESTED_PLACES.map((place) => (
                <button
                  key={`${place.keyword}-${place.city}`}
                  type="button"
                  onClick={() => onAddSuggestion(place.keyword, place.city, place.country)}
                  className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-aqua-500/40 hover:bg-aqua-500/[0.04]"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-aqua-500/10 text-[14.5px] font-bold text-aqua-300 transition group-hover:bg-aqua-500/20">
                    +
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15.5px] font-semibold text-mist-100 group-hover:text-aqua-300">
                      {place.label}
                    </span>
                    <span className="block text-[14.5px] text-mist-500">
                      {place.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n} className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded-full bg-aqua-500/15 text-[14.5px] font-bold text-aqua-300"
              >
                {step.n}
              </span>
              <span className="mt-2 block text-[15.5px] font-medium text-mist-200">{step.title}</span>
              <span className="mt-1 block text-[16px] leading-snug text-mist-500">
                {step.body}
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-center text-[14.5px] text-mist-500">
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
