'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AdvancedMarker,
  InfoWindow,
  Map,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import GooglePlacePanel from '@/components/GooglePlaceDetails';
import type { GeoArea, LatLng, Place, RouteSummary } from '@/lib/types';

export type TravelModeId = 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TRANSIT';

const TRAVEL_MODES: Array<{ id: TravelModeId; label: string; icon: string }> = [
  { id: 'DRIVING', label: 'Drive', icon: '🚗' },
  { id: 'WALKING', label: 'Walk', icon: '🚶' },
  { id: 'BICYCLING', label: 'Cycle', icon: '🚲' },
  { id: 'TRANSIT', label: 'Transit', icon: '🚌' },
];

interface MapViewProps {
  places: Place[];
  area: GeoArea | null;
  /** Non-null when the Maps JS bundle failed to load; rendered as a fallback. */
  mapsError: string | null;
  /** Maps JS key resolved at runtime (build-time env or served by the backend). */
  mapsKey?: string;
  /** Open-source edition: never mention Google Maps configuration. */
  hideGoogleNotice?: boolean;
  selectedId: string | null;
  userLocation: LatLng | null;
  locationStatus: 'idle' | 'pending' | 'granted' | 'denied' | 'unavailable';
  routeDestination: Place | null;
  routeSummary: RouteSummary | null;
  travelMode: TravelModeId;
  onSelect: (place: Place | null) => void;
  onDirections: (place: Place) => void;
  onClearRoute: () => void;
  onTravelModeChange: (mode: TravelModeId) => void;
  onRequestLocation: () => void;
  onRouteResult: (summary: RouteSummary | null) => void;
  onRouteError: (message: string) => void;
}

export default function MapView(props: MapViewProps) {
  const apiKey = props.mapsKey || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';

  const center = useMemo(
    () => ({ lat: props.area?.lat ?? 24.8607, lng: props.area?.lon ?? 67.0011 }),
    [props.area?.lat, props.area?.lon],
  );

  if (!apiKey) {
    return (
      <MapPlaceholder reason="missing-key" places={props.places} hideNotice={props.hideGoogleNotice} />
    );
  }
  if (props.mapsError) {
    return <MapPlaceholder reason="load-error" detail={props.mapsError} places={props.places} />;
  }

  return (
    <div className="relative h-full w-full bg-ink-900">
      <Map
        mapId={mapId}
        // Ask Google for dark tiles so the map matches the shell.
        colorScheme="DARK"
        defaultCenter={center}
        defaultZoom={11}
        gestureHandling="greedy"
        mapTypeControl={false}
        streetViewControl={false}
        fullscreenControl={false}
        zoomControl
        clickableIcons={false}
        reuseMaps
        className="h-full w-full"
        onClick={() => props.onSelect(null)}
      >
        <FitToResults places={props.places} area={props.area} userLocation={props.userLocation} />

        {props.places.map((place, index) => (
          <PlaceMarker
            key={place.id}
            place={place}
            index={index}
            selected={props.selectedId === place.id}
            onSelect={props.onSelect}
          />
        ))}

        {props.userLocation && (
          <AdvancedMarker position={props.userLocation} title="Your location" zIndex={999}>
            <div className="relative grid h-4 w-4 place-items-center">
              <span className="user-dot-ring absolute h-4 w-4 rounded-full bg-sky-400/50" />
              <span className="h-3.5 w-3.5 rounded-full border-2 border-white bg-sky-500 shadow-lg" />
            </div>
          </AdvancedMarker>
        )}

        <SelectedInfoWindow
          places={props.places}
          selectedId={props.selectedId}
          city={props.area?.city ?? ''}
          hasUserLocation={Boolean(props.userLocation)}
          onClose={() => props.onSelect(null)}
          onDirections={props.onDirections}
        />

        <DirectionsLayer
          origin={props.userLocation}
          destination={props.routeDestination}
          travelMode={props.travelMode}
          onResult={props.onRouteResult}
          onError={props.onRouteError}
        />
      </Map>

      <MapControls {...props} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Custom teardrop marker rather than <Pin>, so the numbering matches the result
 * list and the selected state can carry a glow.
 */
function PlaceMarker({
  place,
  index,
  selected,
  onSelect,
}: {
  place: Place;
  index: number;
  selected: boolean;
  onSelect: (place: Place) => void;
}) {
  return (
    <AdvancedMarker
      position={{ lat: place.lat, lng: place.lon }}
      title={place.name}
      zIndex={selected ? 500 : 1}
      onClick={() => onSelect(place)}
    >
      <div className="group relative -translate-y-1/2 cursor-pointer">
        <div
          className={`grid h-7 w-7 place-items-center rounded-full border-2 text-[11px] font-bold tabular-nums shadow-lg transition-all duration-200 ${
            selected
              ? 'scale-125 border-white bg-aqua-400 text-ink-950 shadow-aqua-400/50'
              : 'border-white/80 bg-ink-800 text-mist-100 group-hover:scale-110 group-hover:bg-aqua-500 group-hover:text-ink-950'
          }`}
        >
          {index + 1}
        </div>
        <span
          aria-hidden
          className={`absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 border-b-2 border-r-2 transition-colors ${
            selected ? 'border-white bg-aqua-400' : 'border-white/80 bg-ink-800 group-hover:bg-aqua-500'
          }`}
        />
      </div>
    </AdvancedMarker>
  );
}

function SelectedInfoWindow({
  places,
  selectedId,
  city,
  hasUserLocation,
  onClose,
  onDirections,
}: {
  places: Place[];
  selectedId: string | null;
  city: string;
  hasUserLocation: boolean;
  onClose: () => void;
  onDirections: (place: Place) => void;
}) {
  const place = places.find((candidate) => candidate.id === selectedId);
  if (!place) return null;

  return (
    <InfoWindow position={{ lat: place.lat, lng: place.lon }} onCloseClick={onClose} maxWidth={300}>
      <div className="w-[276px] overflow-hidden rounded-2xl bg-ink-850 text-mist-100">
        {place.images[0] && (
          <div className="relative h-32 w-full overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={place.images[0].thumbUrl}
              alt={place.name}
              className="h-full w-full object-cover"
              onError={(event) => {
                event.currentTarget.parentElement?.remove();
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink-850 to-transparent" />
          </div>
        )}
        <div className="p-3">
          <span className="rounded-md bg-aqua-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-aqua-300">
            {place.categoryLabel}
          </span>
          <h4 dir="auto" className="mt-1.5 text-[14px] font-semibold leading-snug text-white">
            {place.name}
          </h4>
          {place.summary && (
            <p dir="auto" className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-mist-400">
              {place.summary}
            </p>
          )}
          {place.contact.address && (
            <p className="mt-1.5 text-[11px] text-mist-500">{place.contact.address}</p>
          )}

          {/* Google Places content, live over the map — display only. */}
          <GooglePlacePanel place={place} city={city} variant="compact" />

          <div className="mt-2.5 flex gap-1.5">
            <button
              type="button"
              disabled={!hasUserLocation}
              onClick={() => onDirections(place)}
              title={hasUserLocation ? undefined : 'Share your location to get directions'}
              className="rounded-lg bg-aqua-500 px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-mist-500"
            >
              Directions
            </button>
            <a
              href={place.googleMapsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-lg border border-white/12 px-2.5 py-1.5 text-[11.5px] font-semibold text-mist-300 transition hover:border-white/25 hover:text-mist-100"
            >
              Open in Maps ↗
            </a>
          </div>
        </div>
      </div>
    </InfoWindow>
  );
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * Fits the viewport to the current result set — but only when the result set
 * changes, so panning isn't yanked back on every render.
 */
function FitToResults({
  places,
  area,
  userLocation,
}: {
  places: Place[];
  area: GeoArea | null;
  userLocation: LatLng | null;
}) {
  const map = useMap();
  const signature = places.map((place) => place.id).join(',');
  const lastSignature = useRef<string | null>(null);

  useEffect(() => {
    if (!map) return undefined;
    if (lastSignature.current === signature) return undefined;
    lastSignature.current = signature;

    if (places.length === 0) {
      if (area) {
        map.setCenter({ lat: area.lat, lng: area.lon });
        map.setZoom(11);
      }
      return undefined;
    }

    const bounds = new google.maps.LatLngBounds();
    for (const place of places) bounds.extend({ lat: place.lat, lng: place.lon });
    if (userLocation) bounds.extend(userLocation);

    // Extra left padding so markers don't hide under the floating panel.
    const isWide = typeof window !== 'undefined' && window.innerWidth >= 1024;
    map.fitBounds(bounds, { top: 64, right: 64, bottom: 64, left: isWide ? 460 : 64 });

    if (places.length === 1) {
      const listener = google.maps.event.addListenerOnce(map, 'idle', () => {
        if ((map.getZoom() ?? 0) > 16) map.setZoom(16);
      });
      return () => google.maps.event.removeListener(listener);
    }

    return undefined;
  }, [map, signature, places, area, userLocation]);

  return null;
}

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

function DirectionsLayer({
  origin,
  destination,
  travelMode,
  onResult,
  onError,
}: {
  origin: LatLng | null;
  destination: Place | null;
  travelMode: TravelModeId;
  onResult: (summary: RouteSummary | null) => void;
  onError: (message: string) => void;
}) {
  const map = useMap();
  const routesLibrary = useMapsLibrary('routes');
  const [service, setService] = useState<google.maps.DirectionsService | null>(null);
  const [renderer, setRenderer] = useState<google.maps.DirectionsRenderer | null>(null);

  useEffect(() => {
    if (!routesLibrary || !map) return undefined;

    const directionsService = new routesLibrary.DirectionsService();
    const directionsRenderer = new routesLibrary.DirectionsRenderer({
      map,
      // Our own AdvancedMarkers already mark both ends of the route.
      suppressMarkers: true,
      preserveViewport: false,
      polylineOptions: {
        strokeColor: '#34e0c8',
        strokeWeight: 5,
        strokeOpacity: 0.9,
      },
    });

    setService(directionsService);
    setRenderer(directionsRenderer);

    return () => {
      directionsRenderer.setMap(null);
      setService(null);
      setRenderer(null);
    };
  }, [routesLibrary, map]);

  useEffect(() => {
    if (!service || !renderer) return undefined;

    if (!origin || !destination) {
      renderer.set('directions', null);
      return undefined;
    }

    let cancelled = false;

    service
      .route({
        origin,
        destination: { lat: destination.lat, lng: destination.lon },
        travelMode: travelMode as unknown as google.maps.TravelMode,
      })
      .then((response) => {
        if (cancelled) return;
        renderer.setDirections(response);
        const leg = response.routes[0]?.legs[0];
        onResult({
          distanceText: leg?.distance?.text ?? '—',
          durationText: leg?.duration?.text ?? '—',
          travelMode: travelMode as unknown as google.maps.TravelMode,
          destinationName: destination.name,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        renderer.set('directions', null);
        onResult(null);
        const status = (error as { code?: string })?.code;
        onError(
          status === 'ZERO_RESULTS'
            ? `No ${travelMode.toLowerCase()} route exists to ${destination.name}.`
            : `Directions failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      cancelled = true;
    };
    // `onResult`/`onError` are stable callbacks; re-running on their identity
    // would refetch the route on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, renderer, origin?.lat, origin?.lng, destination?.id, travelMode]);

  return null;
}

// ---------------------------------------------------------------------------
// Overlay controls
// ---------------------------------------------------------------------------

function MapControls({
  userLocation,
  locationStatus,
  routeSummary,
  routeDestination,
  travelMode,
  onTravelModeChange,
  onRequestLocation,
  onClearRoute,
}: MapViewProps) {
  return (
    <>
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={onRequestLocation}
          disabled={locationStatus === 'pending'}
          className="pointer-events-auto flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-[11.5px] font-semibold text-mist-200 shadow-lg shadow-black/40 transition hover:text-white disabled:opacity-60 glass"
        >
          {locationStatus === 'pending' ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
              <path
                fill="currentColor"
                d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 3h-2.06A7 7 0 0 0 13 5.06V3h-2v2.06A7 7 0 0 0 5.06 11H3v2h2.06A7 7 0 0 0 11 18.94V21h2v-2.06A7 7 0 0 0 18.94 13H21v-2Zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
              />
            </svg>
          )}
          {locationStatus === 'pending' ? 'Locating…' : userLocation ? 'Recenter' : 'My location'}
        </button>

        {(locationStatus === 'denied' || locationStatus === 'unavailable') && (
          <span className="pointer-events-auto max-w-[190px] rounded-xl border border-ember-500/20 bg-ember-500/10 px-2.5 py-1.5 text-[10px] leading-snug text-ember-300 backdrop-blur">
            {locationStatus === 'denied'
              ? 'Location blocked — enable it in your browser for directions.'
              : 'Geolocation needs HTTPS (or localhost).'}
          </span>
        )}
      </div>

      {routeDestination && (
        <div className="absolute bottom-3 right-3 z-10 w-[min(340px,calc(100%-1.5rem))] rounded-2xl p-3 shadow-2xl shadow-black/60 glass-strong animate-rise">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">
                Route to
              </p>
              <p dir="auto" className="truncate text-[13.5px] font-semibold text-mist-50">
                {routeDestination.name}
              </p>
            </div>
            <button
              type="button"
              onClick={onClearRoute}
              aria-label="Clear route"
              className="shrink-0 rounded-lg px-1.5 py-0.5 text-xs text-mist-500 transition hover:bg-white/10 hover:text-mist-100"
            >
              ✕
            </button>
          </div>

          <div className="mt-2 grid grid-cols-4 gap-1">
            {TRAVEL_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => onTravelModeChange(mode.id)}
                className={`flex flex-col items-center gap-0.5 rounded-lg border py-1.5 text-[10px] font-medium transition ${
                  travelMode === mode.id
                    ? 'border-aqua-500/40 bg-aqua-500/15 text-aqua-300'
                    : 'border-white/[0.07] text-mist-400 hover:border-white/15 hover:text-mist-200'
                }`}
              >
                <span aria-hidden className="text-[13px] leading-none">
                  {mode.icon}
                </span>
                {mode.label}
              </button>
            ))}
          </div>

          {routeSummary ? (
            <div className="mt-2.5 flex items-baseline gap-2 border-t border-white/[0.07] pt-2.5">
              <span className="text-[17px] font-bold tracking-tight text-aqua-300">
                {routeSummary.durationText}
              </span>
              <span className="text-[12px] text-mist-400">{routeSummary.distanceText}</span>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${routeDestination.lat},${routeDestination.lon}&travelmode=${travelMode.toLowerCase()}`}
                target="_blank"
                rel="noreferrer noopener"
                className="ml-auto text-[11px] font-semibold text-mist-400 transition hover:text-aqua-300"
              >
                Open ↗
              </a>
            </div>
          ) : (
            <p className="mt-2.5 border-t border-white/[0.07] pt-2.5 text-[11.5px] text-mist-500">
              Calculating route…
            </p>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Fallback when Google Maps can't load
// ---------------------------------------------------------------------------

function MapPlaceholder({
  reason,
  detail,
  places,
  hideNotice,
}: {
  reason: 'missing-key' | 'load-error';
  detail?: string;
  places: Place[];
  /** OSM edition: the OpenStreetMap view IS the product — no Google notice. */
  hideNotice?: boolean;
}) {
  const bbox =
    places.length > 0
      ? places.reduce(
          (acc, place) => ({
            minLat: Math.min(acc.minLat, place.lat),
            maxLat: Math.max(acc.maxLat, place.lat),
            minLon: Math.min(acc.minLon, place.lon),
            maxLon: Math.max(acc.maxLon, place.lon),
          }),
          { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 },
        )
      : null;

  const osmEmbed = bbox
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${bbox.minLon - 0.02},${bbox.minLat - 0.02},${bbox.maxLon + 0.02},${bbox.maxLat + 0.02}&layer=mapnik`
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-900">
      {osmEmbed ? (
        <iframe
          title="OpenStreetMap preview of the search results"
          src={osmEmbed}
          className="osm-dark h-full w-full border-0"
        />
      ) : (
        <div className="grid h-full w-full place-items-center px-6">
          <div className="text-center">
            <span aria-hidden className="text-3xl opacity-30">
              🗺
            </span>
            <p className="mt-2 text-[12.5px] text-mist-500">Run a search to plot results here.</p>
          </div>
        </div>
      )}

      {!(hideNotice && reason === 'missing-key') && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3 lg:justify-end">
          <div className="pointer-events-auto max-w-[340px] rounded-2xl border border-ember-500/20 bg-ink-900/90 p-3 shadow-xl shadow-black/50 backdrop-blur">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ember-300">
              <span className="h-1.5 w-1.5 rounded-full bg-ember-400" />
              {reason === 'missing-key' ? 'Google Maps not configured' : 'Google Maps failed to load'}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-mist-400">
              {reason === 'missing-key' ? (
                <>
                  Set <code className="rounded bg-black/40 px-1 text-aqua-300">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>{' '}
                  in <code className="rounded bg-black/40 px-1 text-aqua-300">frontend/.env.local</code>.
                  Search, imagery and downloads all work without it — showing OpenStreetMap instead.
                </>
              ) : (
                (detail ?? 'Check the key is valid and the Maps JavaScript API is enabled.')
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
