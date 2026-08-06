'use client';

import { useEffect, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  formatBusinessStatus,
  formatPriceLevel,
  loadGooglePlaceDetails,
  type GooglePlaceDetails,
} from '@/lib/googlePlaces';
import type { Place } from '@/lib/types';

type Status = 'idle' | 'loading' | 'found' | 'not-found' | 'error';

/**
 * Fetches Google Places (New) details for one place.
 *
 * Only ever called for the *selected* place — enriching all 20 results would
 * bill 20 Place Details requests per search for data nobody looked at.
 */
export function useGooglePlaceDetails(place: Place | null, city: string) {
  const placesLibrary = useMapsLibrary('places');
  const [status, setStatus] = useState<Status>('idle');
  const [details, setDetails] = useState<GooglePlaceDetails | null>(null);

  useEffect(() => {
    if (!placesLibrary || !place) {
      setStatus('idle');
      setDetails(null);
      return undefined;
    }

    let cancelled = false;
    setStatus('loading');
    setDetails(null);

    loadGooglePlaceDetails(placesLibrary, place, city)
      .then((result) => {
        if (cancelled) return;
        setDetails(result);
        setStatus(result ? 'found' : 'not-found');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [placesLibrary, place, city]);

  return { status, details };
}

interface GooglePlacePanelProps {
  place: Place;
  city: string;
  variant?: 'compact' | 'full';
}

/**
 * Renders live Google Places content. Per the Maps Platform terms this data is
 * display-only: it is never sent to our backend and never lands in the export.
 */
export default function GooglePlacePanel({ place, city, variant = 'full' }: GooglePlacePanelProps) {
  const { status, details } = useGooglePlaceDetails(place, city);
  const compact = variant === 'compact';

  if (status === 'idle') return null;

  if (status === 'loading') {
    return (
      <div className={wrapperClass(compact)}>
        <GoogleHeading compact={compact} />
        <div className="mt-1.5 space-y-1.5">
          <div className="skeleton h-2.5 w-1/2 rounded" />
          <div className="skeleton h-2.5 w-3/4 rounded" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={wrapperClass(compact)}>
        <GoogleHeading compact={compact} />
        <p className="mt-1 text-[10px] leading-snug text-mist-500">
          Google Places lookup failed. Check that <strong>Places API (New)</strong> is enabled on
          your key and that billing is active.
        </p>
      </div>
    );
  }

  if (status === 'not-found' || !details) {
    return (
      <div className={wrapperClass(compact)}>
        <GoogleHeading compact={compact} />
        <p className="mt-1 text-[10px] leading-snug text-mist-500">
          No matching Google listing within 400 m of this OpenStreetMap location.
        </p>
      </div>
    );
  }

  const status_ = formatBusinessStatus(details.businessStatus);
  const price = formatPriceLevel(details.priceLevel);

  return (
    <div className={wrapperClass(compact)}>
      <GoogleHeading compact={compact} />

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {details.rating !== undefined && (
          <span className="flex items-center gap-1 text-[11.5px] font-semibold text-mist-100">
            <span aria-hidden className="text-ember-400">
              ★
            </span>
            {details.rating.toFixed(1)}
            {details.userRatingCount !== undefined && (
              <span className="font-normal text-mist-500">
                ({details.userRatingCount.toLocaleString()})
              </span>
            )}
          </span>
        )}

        {details.openNow !== undefined && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              details.openNow
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-white/[0.06] text-mist-400'
            }`}
          >
            {details.openNow ? 'Open now' : 'Closed now'}
          </span>
        )}

        {price && <span className="text-[11px] font-medium text-mist-400">{price}</span>}

        {status_ && (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
            {status_}
          </span>
        )}
      </div>

      {details.editorialSummary && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-mist-400">
          {details.editorialSummary}
        </p>
      )}

      {!compact && (
        <>
          {details.formattedAddress && (
            <p className="mt-1.5 text-[11px] text-mist-400">{details.formattedAddress}</p>
          )}

          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {details.phone && (
              <a
                href={`tel:${details.phone.replace(/\s+/g, '')}`}
                className="text-aqua-400 hover:text-aqua-300 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {details.phone}
              </a>
            )}
            {details.websiteUri && (
              <a
                href={details.websiteUri}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-aqua-400 hover:text-aqua-300 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {details.websiteUri.replace(/^https?:\/\//, '').split('/')[0]}
              </a>
            )}
            {details.googleMapsUri && (
              <a
                href={details.googleMapsUri}
                target="_blank"
                rel="noreferrer noopener"
                className="text-aqua-400 hover:text-aqua-300 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                View on Google Maps ↗
              </a>
            )}
          </div>

          {details.weekdayDescriptions && details.weekdayDescriptions.length > 0 && (
            <details className="mt-1.5" onClick={(event) => event.stopPropagation()}>
              <summary className="cursor-pointer text-[11px] font-medium text-mist-500">
                Opening hours
              </summary>
              <ul className="mt-1 space-y-0.5 text-[10.5px] text-mist-400">
                {details.weekdayDescriptions.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          )}

          {details.photos.length > 0 && (
            <div className="mt-2 flex gap-1.5">
              {details.photos.map((photo) => (
                <figure key={photo.uri} className="min-w-0 flex-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.uri}
                    alt=""
                    loading="lazy"
                    className="h-16 w-full rounded object-cover"
                  />
                  {/* Photo author attribution is required by the Places terms. */}
                  {photo.attributions.length > 0 && (
                    <figcaption className="mt-0.5 truncate text-[9px] text-mist-500">
                      {photo.attributions.map((author) => author.name).join(', ')}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          )}

          <p className="mt-2 text-[9px] leading-snug text-mist-500">
            Live from Google — not included in PDF/JPEG downloads, which use OpenStreetMap and
            Wikimedia data only.
          </p>
        </>
      )}
    </div>
  );
}

function wrapperClass(compact: boolean): string {
  return compact
    ? 'mt-2 border-t border-white/[0.08] pt-2'
    : 'border-t border-white/[0.06] bg-white/[0.03] px-3 py-2.5';
}

/**
 * "Powered by Google" is required wherever Places content appears outside a
 * Google map. Inside the map InfoWindow the map's own logo already covers it.
 */
function GoogleHeading({ compact }: { compact: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">
      <span className="h-1 w-1 rounded-full bg-ember-400" />
      Google details
      {!compact && <span className="font-normal normal-case tracking-normal">· Powered by Google</span>}
    </p>
  );
}
