'use client';

import SearchForm, { type SearchFormValues } from '@/components/SearchForm';
import { ACCENT } from '@/lib/palette';

/**
 * The first-run screen. Before any search there is nothing to plot, so the map
 * is dead space — the form takes the whole window instead. Once a search
 * starts, PlaceFinder swaps to the map + results layout.
 */

const STEPS = [
  { n: '1', title: 'Say what and where', body: 'A kind of place, a city and a folder.' },
  { n: '2', title: 'It researches each one', body: 'Checks relevance, translates names, finds HD photos.' },
  { n: '3', title: 'Open the folder', body: 'One illustrated PDF plus photos per place.' },
];

const SUGGESTED_PLACES: Array<{ keyword: string; city: string; country: string; label: string }> = [
  { keyword: 'museums', city: 'Kyoto', country: 'Japan', label: 'Museums in Kyoto' },
  { keyword: 'parks', city: 'Barcelona', country: 'Spain', label: 'Parks in Barcelona' },
  { keyword: 'tourist places', city: 'Istanbul', country: 'Turkey', label: 'Sights in Istanbul' },
  { keyword: 'universities', city: 'Oxford', country: 'United Kingdom', label: 'Universities in Oxford' },
  { keyword: 'temples', city: 'Bangkok', country: 'Thailand', label: 'Temples in Bangkok' },
  { keyword: 'historical sites', city: 'Rome', country: 'Italy', label: 'Historic Rome' },
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
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto scroll-region px-4 py-6 sm:py-10">
      <div className="my-auto w-full max-w-3xl">
        <div className="text-center">
          <h1 className="text-balance text-[28px] font-semibold leading-tight tracking-tight text-black sm:text-[36px]">
            Research every place of a kind, in any city
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-[18px] leading-relaxed text-mist-400 sm:text-[19px]">
            Get a folder of illustrated PDF write-ups you can keep.
          </p>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-200 border-t-4 border-t-teal-600 bg-white shadow-lg shadow-slate-900/5 sm:mt-7">
          <div className="p-4 sm:p-6">
          <SearchForm
            initialValues={initialValues}
            values={values}
            loading={loading}
            variant="hero"
            onSearch={onSearch}
            onCancel={onCancel}
          />
          </div>
        </div>

        {onAddSuggestion && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
            <span className="mr-1 text-[17px] font-semibold text-mist-400">Try:</span>
            {SUGGESTED_PLACES.map((place) => (
              <button
                key={`${place.keyword}-${place.city}`}
                type="button"
                onClick={() => onAddSuggestion(place.keyword, place.city, place.country)}
                className={`inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[17px] font-medium text-mist-200 shadow-sm transition ${ACCENT.ring}`}
              >
                <span aria-hidden className={`h-2 w-2 rounded-full ${ACCENT.dot}`} />
                {place.label}
              </button>
            ))}
          </div>
        )}

        <ol className="mt-7 grid gap-2 sm:grid-cols-3 sm:gap-3">
          {STEPS.map((step) => (
            <li key={step.n} className="flex items-start gap-2.5 rounded-xl px-1 sm:block sm:border sm:border-slate-200 sm:bg-white sm:p-3.5">
              <span
                aria-hidden
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[17px] font-bold ${ACCENT.badge}`}
              >
                {step.n}
              </span>
              <span className="min-w-0 sm:mt-2 sm:block">
                <span className="block text-[18px] font-semibold text-mist-200">{step.title}</span>
                <span className="block text-[17px] leading-snug text-mist-500">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-center text-[17px] text-mist-500">
          Got a list of cities?{' '}
          <button
            type="button"
            onClick={onBatch}
            className="font-semibold text-aqua-300 underline-offset-2 hover:underline"
          >
            Use Batch search
          </button>
        </p>
      </div>
    </div>
  );
}
