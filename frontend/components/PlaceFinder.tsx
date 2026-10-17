'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import BatchPanel from '@/components/BatchPanel';
import MapView from '@/components/MapView';
import ResultsPanel from '@/components/ResultsPanel';
import SearchForm, { type SearchFormValues } from '@/components/SearchForm';
import HeroSearch from '@/components/HeroSearch';
import SearchProgressView from '@/components/SearchProgress';
import { downloadArchive, NetworkError, searchPlaces, type SearchProgress } from '@/lib/api';
import { formatDuration, shortPath } from '@/lib/format';
import type { Place, SearchResult } from '@/lib/types';

const DEFAULT_VALUES: SearchFormValues = {
  // Every kind of place by default; the user narrows it if they want to.
  keyword: 'all',
  city: '',
  country: '',
  // 0 means "no limit" — the server returns everything it finds.
  limit: 0,
  useLlm: true,
  includeImages: true,
  downloadPath: '',
  extraSources: '',
};

export default function PlaceFinder() {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const engine = 'osm';
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'info' | 'error'; message: string } | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadingPlaceId, setDownloadingPlaceId] = useState<string | null>(null);

  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [formValues, setFormValues] = useState<SearchFormValues>(DEFAULT_VALUES);
  /** How long the last full save took, shown beside the search time. */
  const [exportTiming, setExportTiming] = useState<{ searchId: string; ms: number } | null>(null);
  /** The full form is open over the results (otherwise it is one summary line). */
  const [editing, setEditing] = useState(false);

  const searchAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      downloadAbort.current?.abort();
    },
    [],
  );

  const handleSearch = useCallback(async (values: SearchFormValues) => {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setLoading(true);
    setEditing(false);
    setError(null);
    setSelectedId(null);
    setProgress(null);
    setStartedAt(Date.now());
    setFormValues(values);
    try {
      const response = await searchPlaces(
        { ...values, source: engine },
        controller.signal,
        setProgress,
      );
      setResult(response);
      if (response.places.length === 0) {
        setToast({
          tone: 'info',
          message: `No “${values.keyword}” entries are mapped in ${response.area.city}.`,
        });
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      let message: string;
      if (caught instanceof NetworkError) {
        if (caught.kind === 'no-internet') {
          message = 'No internet connection. Please check your network and try again.';
        } else if (caught.kind === 'timeout') {
          message = 'Search timed out. The server may be overloaded — try a smaller area or fewer results.';
        } else {
          message = `Search failed: ${caught.message}`;
        }
      } else {
        message = caught instanceof Error ? caught.message : String(caught);
      }
      setError(message);
      setResult(null);
    } finally {
      if (searchAbort.current === controller) {
        searchAbort.current = null;
        setLoading(false);
        setProgress(null);
      }
    }
  }, []);

  const handleCancelSearch = useCallback(() => {
    searchAbort.current?.abort();
    searchAbort.current = null;
    setLoading(false);
  }, []);

  const handleSelect = useCallback((place: Place | null) => {
    setSelectedId(place?.id ?? null);
    if (!place) return;
    document
      .getElementById(`place-${place.id.replace('/', '-')}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const handleAddSuggestion = useCallback((place: Place) => {
    setFormValues((prev) => ({
      ...prev,
      keyword: place.categoryLabel,
    }));
    setToast({
      tone: 'info',
      message: `Added "${place.categoryLabel}" — modify if needed, then search again.`,
    });
  }, []);

  const runDownload = useCallback(
    async (placeIds: string[] | undefined, place: Place | null) => {
      if (!result) return;

      downloadAbort.current?.abort();
      const controller = new AbortController();
      downloadAbort.current = controller;

      if (place) setDownloadingPlaceId(place.id);
      else setDownloadingAll(true);

      try {
        // The folder is required before a search can start, and the places
        // go into it as plain folders -- never a ZIP. It can only be missing
        // here if it was cleared after searching.
        const savePath = formValues.downloadPath.trim();
        if (!savePath) {
          setToast({ tone: 'error', message: 'Choose the folder to save in first.' });
          return;
        }

        const exportStart = Date.now();
        const outcome = await downloadArchive(
          {
            searchId: result.searchId,
            placeIds,
            savePath,
          },
          `${result.query.keyword}-${result.area.city}.zip`,
          controller.signal,
        );
        const exportMs = Date.now() - exportStart;
        if (!placeIds) setExportTiming({ searchId: result.searchId, ms: exportMs });
        setToast({
          tone: 'info',
          message: outcome.kind === 'saved'
            ? `Saved to ${outcome.path ? shortPath(outcome.path) : 'your folder'} in ${formatDuration(exportMs)}`
            : `Downloaded ${outcome.filename}`,
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        setToast({
          tone: 'error',
          message: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        downloadAbort.current = null;
        setDownloadingPlaceId(null);
        setDownloadingAll(false);
      }
    },
    [result, formValues.downloadPath],
  );

  const handleDownloadAll = useCallback(() => void runDownload(undefined, null), [runDownload]);

  /**
   * A chosen folder is an instruction, not a preference: write the export
   * there as soon as there is something to write, rather than making the
   * user ask for it a second time. Runs once per result; the button stays
   * for re-exporting after changing the filters.
   */
  const autoSaved = useRef<string | null>(null);
  useEffect(() => {
    if (!result || result.places.length === 0) return;
    if (!formValues.downloadPath.trim()) return;
    if (autoSaved.current === result.searchId) return;

    autoSaved.current = result.searchId;
    void runDownload(undefined, null);
  }, [result, formValues.downloadPath, runDownload]);
  const handleDownloadPlace = useCallback(
    (place: Place) => void runDownload([place.id], place),
    [runDownload],
  );

  // Before the first search there is nothing to plot, so the form owns the
  // whole window rather than being squeezed beside an empty map.
  const showHero = mode === 'single' && !result && !loading && !error;
  // Batch never plots anything, so it always gets the full window.
  const showBatch = mode === 'batch';

  const content = (
    <>
      {/* The nav bar: the name on the left, Single / Batch on the right. On a
          phone there is no room for both on one line, so the switch takes a
          full-width second row of the same bar. */}
      <header className="shrink-0 bg-white">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3 sm:h-[76px] sm:flex-nowrap sm:px-6 sm:py-0">
          <a href="/" className="flex min-w-0 items-center gap-3">
            <Image
              src="/logo.png"
              alt=""
              width={52}
              height={52}
              priority
              // A 61 KB file shown at one size: served as is, so the header
              // never waits on the image optimiser for a new width.
              unoptimized
              className="h-10 w-10 shrink-0 object-contain sm:h-[52px] sm:w-[52px]"
            />
            <span className="truncate whitespace-nowrap text-[23px] font-bold leading-none tracking-tight text-black sm:text-[28px]">
              SMA Place Finder
            </span>
          </a>

        <div role="tablist" aria-label="Search mode" className="flex w-full rounded-xl bg-slate-100 p-1 sm:ml-auto sm:w-auto">
          {(
            [
              { id: 'single', label: 'Single search' },
              { id: 'batch', label: 'Batch search' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              onClick={() => setMode(tab.id)}
              className={`flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-[18px] font-semibold transition sm:px-5 ${
                mode === tab.id
                  ? 'bg-teal-700 text-white shadow-sm'
                  : 'text-mist-300 hover:text-mist-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        </div>
        {/* A thin accent line under the bar. */}
        <div aria-hidden className="h-[3px] bg-teal-600" />
      </header>

      {showBatch ? (
        <div className="flex min-h-0 flex-1 overflow-y-auto scroll-region px-4 py-6">
          <BatchPanel engine={engine} />
        </div>
      ) : showHero ? (
        <HeroSearch
          initialValues={DEFAULT_VALUES}
          values={formValues}
          loading={loading}
          onSearch={handleSearch}
          onCancel={handleCancelSearch}
          onBatch={() => setMode('batch')}
          onAddSuggestion={(keyword, city, country) => {
            setFormValues((prev) => ({
              ...prev,
              keyword,
              city,
              country,
            }));
            setToast({
              tone: 'info',
              message: `Ready to search for "${keyword}" in ${city}, ${country}. Hit Search!`,
            });
          }}
        />
      ) : (
      <div className="relative flex min-h-0 flex-1 flex-col lg:block">
      {/* Map — in flow on small screens, full-bleed canvas on large */}
      <div className="relative order-1 h-[28vh] shrink-0 border-b sm:h-[38vh] border-slate-200 lg:absolute lg:inset-0 lg:h-auto lg:border-0">
        <MapView places={result?.places ?? []} area={result?.area ?? null} />
      </div>

      {/* Control panel — floats over the map on large screens */}
      <div className="order-2 flex min-h-0 flex-1 flex-col gap-3 p-3 lg:absolute lg:bottom-3 lg:left-3 lg:top-3 lg:z-20 lg:w-[520px] lg:flex-none lg:rounded-2xl lg:p-3.5 lg:shadow-2xl lg:shadow-slate-900/10 lg:glass">
        {(
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-region pr-0.5">
            {/* Once there are results the form folds to one line, so the
                results are what fills the screen, especially on a phone. */}
            <div className="shrink-0">
              {editing || (!loading && !result) ? (
                <div className="space-y-2">
                  {result && !loading && (
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="text-[17px] font-semibold text-aqua-300 hover:underline"
                    >
                      ← Back to results
                    </button>
                  )}
                  <SearchForm
                    initialValues={DEFAULT_VALUES}
                    values={formValues}
                    sources={result?.sources}
                    loading={loading}
                    onSearch={handleSearch}
                    onCancel={handleCancelSearch}
                  />
                </div>
              ) : (
                <SearchSummary
                  values={formValues}
                  disabled={loading}
                  onEdit={() => setEditing(true)}
                />
              )}
            </div>

            {/* One of: live progress, an error, or results. The first-run case
                is handled by the hero screen, so it cannot occur here. */}
            {loading && (
              <div className="shrink-0">
                <SearchProgressView
                  progress={progress}
                  startedAt={startedAt}
                  onCancel={handleCancelSearch}
                />
              </div>
            )}

            {!loading && error && (
              <div className="shrink-0 rounded-2xl border border-red-500/25 bg-red-500/10 p-3.5">
                <p className="text-[20px] font-semibold text-red-700">Search failed</p>
                <p className="mt-1 text-[19px] leading-relaxed text-mist-300">{error}</p>
                <button
                  type="button"
                  onClick={() => void handleSearch(formValues)}
                  className="mt-2.5 rounded-xl border border-red-500/30 px-3.5 py-1.5 text-[18px] font-semibold text-red-700 transition hover:bg-red-500/10"
                >
                  Retry search
                </button>
              </div>
            )}

            {result && !loading && (
              <section aria-label="Search results">
                <ResultsPanel
                  result={result}
                  loading={false}
                  error={null}
                  selectedId={selectedId}
                  downloadingAll={downloadingAll}
                  downloadingPlaceId={downloadingPlaceId}
                  onSelect={handleSelect}
                  onDownloadPlace={handleDownloadPlace}
                  onDownloadAll={handleDownloadAll}
                  onAddSuggestion={handleAddSuggestion}
                  savePath={formValues.downloadPath.trim() || undefined}
                  exportMs={exportTiming && result && exportTiming.searchId === result.searchId ? exportTiming.ms : undefined}
                />
              </section>
            )}
          </div>
        )}
      </div>

      </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed inset-x-4 bottom-4 z-50 flex items-center sm:inset-x-auto sm:left-1/2 sm:max-w-[92vw] sm:-translate-x-1/2 gap-2.5 rounded-xl px-3.5 py-2.5 text-[20px] shadow-2xl shadow-slate-900/10 glass-strong ${
            toast.tone === 'error' ? 'text-red-700' : 'text-mist-100'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              toast.tone === 'error' ? 'bg-red-400' : 'bg-aqua-400'
            }`}
          />
          <span className="min-w-0 break-words">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="ml-1 text-mist-500 transition hover:text-mist-100"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );

  return content;
}

/** The search that produced the results on screen, in one line, with a way back into the form. */
function SearchSummary({
  values,
  disabled,
  onEdit,
}: {
  values: SearchFormValues;
  disabled: boolean;
  onEdit: () => void;
}) {
  const what = values.keyword.trim().replace(/,\s*$/, '') || 'all';
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 border-l-4 border-l-teal-500 bg-white px-3.5 py-2.5 shadow-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[19px] font-semibold text-mist-100" title={what}>
          {what === 'all' ? 'All places' : what}
        </p>
        <p className="truncate text-[17px] text-mist-500" title={values.downloadPath}>
          {values.city}, {values.country}
          {values.downloadPath ? ` · ${values.downloadPath}` : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        className="shrink-0 rounded-xl border border-slate-300 px-3.5 py-2 text-[18px] font-semibold text-mist-200 transition hover:border-aqua-500 hover:text-aqua-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Change
      </button>
    </div>
  );
}
