'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import BatchPanel from '@/components/BatchPanel';
import MapView, { type TravelModeId } from '@/components/MapView';
import ResultsPanel from '@/components/ResultsPanel';
import SearchForm, { type SearchFormValues } from '@/components/SearchForm';
import { downloadArchive, fetchEngineInfo, searchPlaces, type EngineInfo } from '@/lib/api';
import { clearGooglePlaceCache } from '@/lib/googlePlaces';
import type { LatLng, Place, PlaceEngine, RouteSummary, SearchResult } from '@/lib/types';

type LocationStatus = 'idle' | 'pending' | 'granted' | 'denied' | 'unavailable';

const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

const DEFAULT_VALUES: SearchFormValues = {
  keyword: 'tourist places',
  city: 'Karachi',
  country: 'Pakistan',
  limit: 20,
  useLlm: true,
  includeImages: true,
};

export default function PlaceFinder() {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [engine, setEngine] = useState<PlaceEngine>('osm');
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  // Build-time key wins; otherwise Google-enabled installs serve one at runtime.
  const mapsKey = MAPS_API_KEY || engineInfo?.mapsBrowserKey || '';
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'info' | 'error'; message: string } | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');

  const [routeDestination, setRouteDestination] = useState<Place | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [travelMode, setTravelMode] = useState<TravelModeId>('DRIVING');

  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadingPlaceId, setDownloadingPlaceId] = useState<string | null>(null);
  const [mapsError, setMapsError] = useState<string | null>(null);

  const searchAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Which engines this install offers; a pinned install locks the choice.
  useEffect(() => {
    const controller = new AbortController();
    void fetchEngineInfo(controller.signal).then((info) => {
      setEngineInfo(info);
      if (info.mode === 'google') setEngine('google');
      if (info.mode === 'osm') setEngine('osm');
    });
    return () => controller.abort();
  }, []);

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
    setRouteDestination(null);
    setRouteSummary(null);
    // Google Places content is display-only and must not outlive the view that
    // showed it; a new search drops everything cached for the previous one.
    clearGooglePlaceCache();

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
  }, [engine]);

  const handleCancelSearch = useCallback(() => {
    searchAbort.current?.abort();
    searchAbort.current = null;
    setLoading(false);
  }, []);

  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('unavailable');
      return;
    }

    setLocationStatus('pending');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocationStatus('granted');
      },
      (positionError) => {
        // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        setLocationStatus(positionError.code === 1 ? 'denied' : 'unavailable');
        setToast({
          tone: 'error',
          message:
            positionError.code === 1
              ? 'Location permission denied, so directions are unavailable.'
              : `Could not determine your location (${positionError.message}).`,
        });
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.isSecureContext) {
      setLocationStatus('unavailable');
      return;
    }
    if (!navigator.permissions?.query) return;

    void navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        // Only auto-request when already granted — an unprompted permission
        // dialog on page load is hostile.
        if (status.state === 'granted') requestLocation();
        else if (status.state === 'denied') setLocationStatus('denied');
      })
      .catch(() => undefined);
  }, [requestLocation]);

  const handleSelect = useCallback((place: Place | null) => {
    setSelectedId(place?.id ?? null);
    if (!place) return;
    document
      .getElementById(`place-${place.id.replace('/', '-')}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const handleDirections = useCallback(
    (place: Place) => {
      setSelectedId(place.id);
      if (!userLocation) {
        requestLocation();
        setToast({ tone: 'info', message: 'Share your location to draw the route.' });
        return;
      }
      setRouteSummary(null);
      setRouteDestination(place);
    },
    [userLocation, requestLocation],
  );

  const handleClearRoute = useCallback(() => {
    setRouteDestination(null);
    setRouteSummary(null);
  }, []);

  const handleRouteError = useCallback((message: string) => {
    setToast({ tone: 'error', message });
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
        {/* Engine picker — hidden when the install is pinned to one engine */}
        {engineInfo?.mode !== 'osm' && engineInfo?.mode !== 'google' && (
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-white/[0.07] bg-ink-900/70 p-0.5">
            {(
              [
                { id: 'osm', label: 'Open source', disabled: false, hint: 'OpenStreetMap · Wikipedia · Wikidata' },
                {
                  id: 'google',
                  label: 'Google Maps',
                  disabled: !engineInfo?.googleConfigured,
                  hint: engineInfo?.googleConfigured
                    ? 'Google Places search, details and photos'
                    : 'Set GOOGLE_MAPS_API_KEY in backend/.env to enable',
                },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={option.disabled}
                title={option.hint}
                onClick={() => setEngine(option.id)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition ${
                  engine === option.id
                    ? 'bg-aqua-500/15 text-aqua-300'
                    : 'text-mist-400 hover:text-mist-200'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:block">
      {/* Map — in flow on small screens, full-bleed canvas on large */}
      <div className="relative order-1 h-[38vh] shrink-0 border-b border-white/[0.06] lg:absolute lg:inset-0 lg:h-auto lg:border-0">
        <MapView
          places={result?.places ?? []}
          area={result?.area ?? null}
          mapsError={mapsError}
          mapsKey={mapsKey}
          hideGoogleNotice={engineInfo?.mode === 'osm'}
          selectedId={selectedId}
          userLocation={userLocation}
          locationStatus={locationStatus}
          routeDestination={routeDestination}
          routeSummary={routeSummary}
          travelMode={travelMode}
          onSelect={handleSelect}
          onDirections={handleDirections}
          onClearRoute={handleClearRoute}
          onTravelModeChange={setTravelMode}
          onRequestLocation={requestLocation}
          onRouteResult={setRouteSummary}
          onRouteError={handleRouteError}
        />
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
                hasUserLocation={Boolean(userLocation)}
                googleEnabled={Boolean(mapsKey) && !mapsError}
                downloadingAll={downloadingAll}
                downloadingPlaceId={downloadingPlaceId}
                onSelect={handleSelect}
                onDirections={handleDirections}
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

  // APIProvider wraps the whole view, not just the map: the results list also
  // uses `useMapsLibrary('places')` for the per-place Google details panel.
  if (!mapsKey) return content;

  return (
    <APIProvider
      apiKey={mapsKey}
      libraries={['marker', 'routes', 'places']}
      onError={(error) => setMapsError(error instanceof Error ? error.message : String(error))}
    >
      {content}
    </APIProvider>
  );
}
