'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import BatchPanel from '@/components/BatchPanel';
import MapView from '@/components/MapView';
import ResultsPanel from '@/components/ResultsPanel';
import SearchForm, { type SearchFormValues } from '@/components/SearchForm';
import { downloadArchive, searchPlaces } from '@/lib/api';
import type { Place, SearchResult } from '@/lib/types';

const DEFAULT_VALUES: SearchFormValues = {
  keyword: '',
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
    setError(null);
    setSelectedId(null);
    try {
      const response = await searchPlaces({ ...values, source: engine }, controller.signal);
      setResult(response);
      if (response.places.length === 0) {
        setToast({
          tone: 'info',
          message: `No “${values.keyword}” entries are mapped in ${response.area.city}.`,
        });
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setResult(null);
    } finally {
      if (searchAbort.current === controller) {
        searchAbort.current = null;
        setLoading(false);
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

  const runDownload = useCallback(
    async (placeIds: string[] | undefined, place: Place | null) => {
      if (!result) return;

      downloadAbort.current?.abort();
      const controller = new AbortController();
      downloadAbort.current = controller;

      if (place) setDownloadingPlaceId(place.id);
      else setDownloadingAll(true);

      try {
        const filename = await downloadArchive(
          { searchId: result.searchId, placeIds },
          `${result.query.keyword}-${result.area.city}.zip`,
          controller.signal,
        );
        setToast({ tone: 'info', message: `Downloaded ${filename}` });
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
    [result],
  );

  const handleDownloadAll = useCallback(() => void runDownload(undefined, null), [runDownload]);
  const handleDownloadPlace = useCallback(
    (place: Place) => void runDownload([place.id], place),
    [runDownload],
  );

  const content = (
    <>
      {/* Mode bar — sits directly under the app header */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-ink-950/60 px-4 py-1.5 backdrop-blur-xl sm:px-5">
        {(
          [
            { id: 'single', label: 'Single search' },
            { id: 'batch', label: 'Batch search' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMode(tab.id)}
            className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold transition ${
              mode === tab.id
                ? 'bg-aqua-500/15 text-aqua-300'
                : 'text-mist-400 hover:bg-white/[0.04] hover:text-mist-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:block">
      {/* Map — in flow on small screens, full-bleed canvas on large */}
      <div className="relative order-1 h-[38vh] shrink-0 border-b border-white/[0.06] lg:absolute lg:inset-0 lg:h-auto lg:border-0">
        <MapView places={result?.places ?? []} area={result?.area ?? null} />
      </div>

      {/* Control panel — floats over the map on large screens */}
      <div className="order-2 flex min-h-0 flex-1 flex-col gap-3 p-3 lg:absolute lg:bottom-3 lg:left-3 lg:top-3 lg:z-20 lg:w-[404px] lg:flex-none lg:rounded-2xl lg:p-3.5 lg:shadow-2xl lg:shadow-black/50 lg:glass">
        {mode === 'single' ? (
          <>
            <div className="shrink-0">
              <SearchForm
                initialValues={DEFAULT_VALUES}
                loading={loading}
                onSearch={handleSearch}
                onCancel={handleCancelSearch}
              />
            </div>

            <section className="flex min-h-0 flex-1 flex-col" aria-label="Search results">
              <ResultsPanel
                result={result}
                loading={loading}
                error={error}
                selectedId={selectedId}
                downloadingAll={downloadingAll}
                downloadingPlaceId={downloadingPlaceId}
                onSelect={handleSelect}
                onDownloadPlace={handleDownloadPlace}
                onDownloadAll={handleDownloadAll}
              />
            </section>
          </>
        ) : (
          <BatchPanel engine={engine} />
        )}
      </div>

      {toast && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px] shadow-2xl shadow-black/60 glass-strong ${
            toast.tone === 'error' ? 'text-red-300' : 'text-mist-100'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              toast.tone === 'error' ? 'bg-red-400' : 'bg-aqua-400'
            }`}
          />
          <span>{toast.message}</span>
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
      </div>
    </>
  );

  return content;
}
