'use client';

import { useMemo, useState } from 'react';
import PlaceCard from '@/components/PlaceCard';
import type { Place, SearchResult } from '@/lib/types';

type SortKey = 'quality' | 'name' | 'images';

interface ResultsPanelProps {
  result: SearchResult | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  downloadingAll: boolean;
  downloadingPlaceId: string | null;
  onSelect: (place: Place) => void;
  onDownloadPlace: (place: Place) => void;
  onDownloadAll: () => void;
}

export default function ResultsPanel({
  result,
  loading,
  error,
  selectedId,
  downloadingAll,
  downloadingPlaceId,
  onSelect,
  onDownloadPlace,
  onDownloadAll,
}: ResultsPanelProps) {
  const [sortKey, setSortKey] = useState<SortKey>('quality');
  const [onlyWithImages, setOnlyWithImages] = useState(false);

  const places = useMemo(() => {
    if (!result) return [];
    const filtered = onlyWithImages
      ? result.places.filter((place) => place.images.length > 0)
      : result.places;

    const sorted = [...filtered];
    if (sortKey === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortKey === 'images') sorted.sort((a, b) => b.images.length - a.images.length);
    else sorted.sort((a, b) => b.qualityScore - a.qualityScore);
    return sorted;
  }, [result, sortKey, onlyWithImages]);

  if (loading) return <ResultsSkeleton />;
  if (error) return <ErrorState message={error} />;
  if (!result) return <EmptyState />;

  return (
    <div className="flex min-h-0 flex-col">
      {/* Summary header */}
      <div className="shrink-0 px-1 pb-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[19px] font-semibold tracking-tight text-mist-50">
            <span className="tabular-nums">{places.length}</span>{' '}
            <span className="text-mist-400">
              {places.length === 1 ? 'place' : 'places'} in
            </span>{' '}
            {result.area.city}
          </h2>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-mist-500" title={result.area.displayName}>
          {result.area.displayName}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Stat value={String(result.stats.overpassMatches)} label="OSM elements" />
          <Stat value={String(result.stats.withImages)} label="with imagery" />
          <Stat
            value={`${(result.stats.elapsedMs / 1000).toFixed(1)}s`}
            label={result.stats.llmUsed ? shortModel(result.stats.llmModel) : 'rule-based'}
            accent={result.stats.llmUsed}
          />
        </div>

        {result.stats.warnings.length > 0 && (
          <details className="group mt-2 rounded-xl border border-ember-500/20 bg-ember-500/[0.07] px-2.5 py-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-ember-300 marker:hidden">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-ember-400" />
                {result.stats.warnings.length} note
                {result.stats.warnings.length === 1 ? '' : 's'} about this search
              </span>
            </summary>
            <ul className="mt-1.5 space-y-1 border-t border-ember-500/15 pt-1.5 text-[10.5px] leading-relaxed text-ember-300/75">
              {result.stats.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-y border-white/[0.06] py-2">
        <button
          type="button"
          onClick={onDownloadAll}
          disabled={downloadingAll || result.places.length === 0}
          className="flex items-center gap-1.5 rounded-lg bg-mist-50 px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-mist-500"
        >
          {downloadingAll ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Building ZIP…
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
                <path fill="currentColor" d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3Zm-7 16h14v2H5Z" />
              </svg>
              Download all ({result.places.length})
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => setOnlyWithImages((on) => !on)}
          className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition ${
            onlyWithImages
              ? 'border-aqua-500/40 bg-aqua-500/15 text-aqua-300'
              : 'border-white/[0.07] text-mist-400 hover:border-white/15 hover:text-mist-200'
          }`}
        >
          With photos
        </button>

        <select
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SortKey)}
          aria-label="Sort results"
          className="ml-auto rounded-lg border border-white/[0.07] bg-ink-850 px-2 py-1.5 text-[11px] font-medium text-mist-300 outline-none transition hover:border-white/15 focus:border-aqua-500/50"
        >
          <option value="quality">Best match</option>
          <option value="name">Name A→Z</option>
          <option value="images">Most photos</option>
        </select>
      </div>

      {downloadingAll && (
        <p className="mt-2 shrink-0 rounded-xl bg-white/[0.04] px-2.5 py-2 text-[10.5px] leading-relaxed text-mist-400">
          Fetching source images, rendering one PDF per place, and zipping into{' '}
          <code className="rounded bg-black/40 px-1 text-aqua-300">
            {result.area.country}/{result.area.city}/…
          </code>{' '}
          — keep this tab open.
        </p>
      )}

      {/* List */}
      {places.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center">
          <p className="text-[13px] text-mist-400">
            {onlyWithImages
              ? 'No results have photos.'
              : `Nothing matching “${result.query.keyword}” in ${result.area.city}.`}
          </p>
          {onlyWithImages && (
            <button
              type="button"
              onClick={() => setOnlyWithImages(false)}
              className="mt-2 text-[12px] font-semibold text-aqua-400 hover:text-aqua-300"
            >
              Show all results
            </button>
          )}
        </div>
      ) : (
        <div className="scroll-region -mr-2 mt-2.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pb-4 pr-2">
          {places.map((place, index) => (
            <PlaceCard
              key={place.id}
              place={place}
              index={index}
              selected={selectedId === place.id}
              city={result.area.city}
              downloading={downloadingPlaceId === place.id}
              onSelect={onSelect}
              onDownload={onDownloadPlace}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function shortModel(model: string | undefined): string {
  if (!model) return 'LLM';
  return model.split('/').pop() ?? model;
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <span
      className={`flex items-baseline gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] ${
        accent ? 'bg-aqua-500/12 text-aqua-300' : 'bg-white/[0.05] text-mist-400'
      }`}
    >
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="opacity-70">{label}</span>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
      <span
        aria-hidden
        className="grid h-14 w-14 place-items-center rounded-2xl border border-white/[0.07] bg-white/[0.03] text-2xl"
      >
        🧭
      </span>
      <h2 className="mt-3.5 text-[16px] font-semibold tracking-tight text-mist-100">
        Search anywhere on earth
      </h2>
      <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-mist-500">
        Search for places anywhere on earth. Results come from OpenStreetMap and are exported with rich image and PDF support.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.07] p-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-red-300">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-red-500/20 text-[11px]">
          !
        </span>
        Search failed
      </p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-red-200/70">{message}</p>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex min-h-0 flex-col gap-2.5" aria-busy="true" aria-label="Loading results">
      <div className="skeleton h-6 w-2/3 shrink-0 rounded-lg" />
      <div className="skeleton h-3.5 w-1/2 shrink-0 rounded" />
      <div className="mt-1 flex shrink-0 gap-1.5">
        <div className="skeleton h-5 w-24 rounded-md" />
        <div className="skeleton h-5 w-20 rounded-md" />
      </div>
      {/* shrink-0 + a scroll region: without both, flex children compress to
          nothing instead of overflowing (same trap as the real card list). */}
      <div className="scroll-region -mr-2 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-hidden pr-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="shrink-0 overflow-hidden rounded-2xl border border-white/[0.06]"
          >
            <div className="skeleton aspect-[16/9] w-full" />
            <div className="space-y-2 p-3">
              <div className="skeleton h-3 w-full rounded" />
              <div className="skeleton h-3 w-4/5 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
