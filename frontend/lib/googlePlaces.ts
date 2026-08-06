/**
 * Google Places (New) lookup — DISPLAY ONLY.
 *
 * Everything this module returns is Google Maps Content and is governed by the
 * Maps Platform Service Specific Terms, which forbid extracting or exporting it
 * ("pre-fetch, index, store, reshare, or rehost ... outside the services",
 * "copy and save business names, addresses, or user reviews").
 *
 * Consequences, enforced by construction:
 *   - Nothing here is ever POSTed to our backend or written into the ZIP/PDF
 *     export. That pipeline stays purely OpenStreetMap + Wikimedia, which are
 *     licensed for redistribution.
 *   - The cache below is a plain in-memory Map, scoped to the browser tab and
 *     cleared on every new search. No localStorage, no IndexedDB, no disk.
 *   - `place_id` is the one field Google exempts from caching limits, so it is
 *     the only value that would be safe to persist if you ever need to.
 *
 * Uses the Place class (`searchByText` / `fetchFields`). The older
 * `PlacesService.getDetails` is in Legacy status.
 */

import type { Place } from './types';

export interface GooglePhoto {
  uri: string;
  attributions: Array<{ name: string; uri?: string }>;
}

export interface GooglePlaceDetails {
  /** Google place ID — the only cache-exempt field. */
  id: string;
  displayName?: string;
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  phone?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  priceLevel?: string;
  editorialSummary?: string;
  openNow?: boolean;
  weekdayDescriptions?: string[];
  photos: GooglePhoto[];
  /** Distance from the OpenStreetMap coordinates, in metres. */
  matchDistanceMeters: number;
}

/**
 * How far a Google result may sit from the OSM node and still be considered the
 * same real-world place. Loose enough for a large campus entrance vs. centroid,
 * tight enough to reject the next café down the street.
 */
const MATCH_RADIUS_METERS = 400;

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Field tiers map to Google's billing SKUs. Requesting an Enterprise field on a
 * Pro-only key throws, so each tier is attempted separately and a failure just
 * drops that group rather than losing the whole lookup.
 */
const FIELDS_ESSENTIAL = ['displayName', 'formattedAddress', 'location', 'googleMapsURI', 'businessStatus', 'photos'];
const FIELDS_PRO = ['rating', 'userRatingCount', 'regularOpeningHours', 'nationalPhoneNumber', 'websiteURI', 'priceLevel'];
const FIELDS_ENTERPRISE = ['editorialSummary'];

/** Tab-scoped, deliberately non-persistent. Shared promises de-dupe concurrent callers. */
const inFlight = new Map<string, Promise<GooglePlaceDetails | null>>();

export function clearGooglePlaceCache(): void {
  inFlight.clear();
}

type PlaceCtor = google.maps.PlacesLibrary['Place'];
type PlaceInstance = InstanceType<PlaceCtor>;

async function tryFetchFields(place: PlaceInstance, fields: string[]): Promise<boolean> {
  try {
    await place.fetchFields({ fields });
    return true;
  } catch {
    // Field group not available on this key's SKU tier — skip it.
    return false;
  }
}

function readPhotos(place: PlaceInstance): GooglePhoto[] {
  const photos = place.photos ?? [];
  return photos.slice(0, 3).flatMap((photo) => {
    let uri: string;
    try {
      uri = photo.getURI({ maxWidth: 900 });
    } catch {
      return [];
    }
    return [
      {
        uri,
        attributions: (photo.authorAttributions ?? []).map((author) => ({
          name: author.displayName,
          uri: author.uri ?? undefined,
        })),
      },
    ];
  });
}

async function lookup(
  placesLibrary: google.maps.PlacesLibrary,
  osmPlace: Place,
  city: string,
): Promise<GooglePlaceDetails | null> {
  const { Place: GooglePlace } = placesLibrary;

  const { places: candidates } = await GooglePlace.searchByText({
    textQuery: `${osmPlace.name} ${city}`.trim(),
    fields: ['id', 'location', 'displayName'],
    locationBias: {
      center: { lat: osmPlace.lat, lng: osmPlace.lon },
      radius: 1_000,
    },
    maxResultCount: 5,
    language: 'en',
  });

  if (!candidates || candidates.length === 0) return null;

  // Text search happily returns a plausible-but-wrong business, so trust
  // geometry over the name and reject anything too far from the OSM node.
  let best: PlaceInstance | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const location = candidate.location;
    if (!location) continue;
    const distance = distanceMeters(
      { lat: osmPlace.lat, lng: osmPlace.lon },
      { lat: location.lat(), lng: location.lng() },
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (!best || bestDistance > MATCH_RADIUS_METERS) return null;

  const gotEssential = await tryFetchFields(best, FIELDS_ESSENTIAL);
  if (!gotEssential) return null;

  await tryFetchFields(best, FIELDS_PRO);
  await tryFetchFields(best, FIELDS_ENTERPRISE);

  let openNow: boolean | undefined;
  try {
    openNow = (await best.isOpen()) ?? undefined;
  } catch {
    openNow = undefined;
  }

  return {
    id: best.id,
    displayName: best.displayName ?? undefined,
    formattedAddress: best.formattedAddress ?? undefined,
    rating: best.rating ?? undefined,
    userRatingCount: best.userRatingCount ?? undefined,
    phone: best.nationalPhoneNumber ?? undefined,
    websiteUri: best.websiteURI ?? undefined,
    googleMapsUri: best.googleMapsURI ?? undefined,
    businessStatus: best.businessStatus ?? undefined,
    priceLevel: best.priceLevel ?? undefined,
    editorialSummary: best.editorialSummary ?? undefined,
    openNow,
    weekdayDescriptions: best.regularOpeningHours?.weekdayDescriptions ?? undefined,
    photos: readPhotos(best),
    matchDistanceMeters: Math.round(bestDistance),
  };
}

export function loadGooglePlaceDetails(
  placesLibrary: google.maps.PlacesLibrary,
  osmPlace: Place,
  city: string,
): Promise<GooglePlaceDetails | null> {
  const existing = inFlight.get(osmPlace.id);
  if (existing) return existing;

  const promise = lookup(placesLibrary, osmPlace, city).catch((error: unknown) => {
    // Don't poison the cache — a transient failure should be retryable.
    inFlight.delete(osmPlace.id);
    throw error;
  });

  inFlight.set(osmPlace.id, promise);
  return promise;
}

export function formatPriceLevel(level: string | undefined): string | undefined {
  if (!level) return undefined;
  const levels: Record<string, string> = {
    FREE: 'Free',
    INEXPENSIVE: '$',
    MODERATE: '$$',
    EXPENSIVE: '$$$',
    VERY_EXPENSIVE: '$$$$',
  };
  return levels[level] ?? undefined;
}

export function formatBusinessStatus(status: string | undefined): string | undefined {
  if (!status || status === 'OPERATIONAL') return undefined;
  if (status === 'CLOSED_TEMPORARILY') return 'Temporarily closed';
  if (status === 'CLOSED_PERMANENTLY') return 'Permanently closed';
  return undefined;
}
