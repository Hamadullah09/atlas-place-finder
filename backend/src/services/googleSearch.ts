import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { mapLimit } from '../lib/concurrency.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import { buildTravelLinks } from '../lib/travelLinks.js';
import type { GeoArea, Place, PlaceImage, SearchQuery, SearchResult } from '../types.js';

/**
 * The Google Maps engine: Geocoding API for the area, Places Text Search for
 * discovery, Place Details for contact data and editorial summaries, and
 * Place Photos for imagery. The API key stays server-side — photo URLs handed
 * to the browser point at our own /api/google-photo proxy.
 */

const GOOGLE_BASE = 'https://maps.googleapis.com/maps/api';

export class GoogleSearchError extends Error {
  constructor(
    message: string,
    readonly status?: string,
  ) {
    super(message);
    this.name = 'GoogleSearchError';
  }
}

export function googleConfigured(): boolean {
  return config.googleMapsApiKey.length > 0;
}

function requireKey(): string {
  if (!googleConfigured()) {
    throw new GoogleSearchError(
      'Google search needs GOOGLE_MAPS_API_KEY in backend/.env (enable the Places API and Geocoding API).',
    );
  }
  return config.googleMapsApiKey;
}

/** Google's error statuses are cryptic — translate the common ones. */
function explainStatus(status: string, message?: string): string {
  if (status === 'REQUEST_DENIED') {
    return `Google rejected the request (${message ?? 'REQUEST_DENIED'}). Check that the key is valid and the Places API + Geocoding API are enabled.`;
  }
  if (status === 'OVER_QUERY_LIMIT') {
    return 'Google API quota exceeded. Check your billing and quota settings.';
  }
  return message ?? status;
}

interface GeocodeResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
    geometry?: {
      location?: { lat: number; lng: number };
      viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
    };
  }>;
}

export async function geocodeViaGoogle(city: string, country: string): Promise<GeoArea> {
  const key = requireKey();
  const payload = await fetchJson<GeocodeResponse>(
    `${GOOGLE_BASE}/geocode/json?${qs({ address: `${city}, ${country}`, key, language: 'en' })}`,
    { timeoutMs: 20_000, retries: 1, skipThrottle: true },
  );

  if (payload.status !== 'OK' || !payload.results?.length) {
    throw new GoogleSearchError(
      payload.status === 'ZERO_RESULTS'
        ? `Google could not find "${city}, ${country}".`
        : explainStatus(payload.status, payload.error_message),
      payload.status,
    );
  }

  const top = payload.results[0]!;
  const location = top.geometry?.location;
  const viewport = top.geometry?.viewport;
  if (!location) throw new GoogleSearchError(`Google returned no coordinates for "${city}, ${country}".`);

  const countryComponent = top.address_components?.find((component) => component.types?.includes('country'));

  return {
    displayName: top.formatted_address ?? `${city}, ${country}`,
    city,
    country: countryComponent?.long_name ?? country,
    countryCode: countryComponent?.short_name?.toLowerCase(),
    lat: location.lat,
    lon: location.lng,
    bbox: viewport
      ? [viewport.southwest.lat, viewport.southwest.lng, viewport.northeast.lat, viewport.northeast.lng]
      : [location.lat - 0.25, location.lng - 0.25, location.lat + 0.25, location.lng + 0.25],
  };
}

interface TextSearchResponse {
  status: string;
  error_message?: string;
  next_page_token?: string;
  results?: Array<{
    place_id?: string;
    name?: string;
    geometry?: { location?: { lat: number; lng: number } };
    types?: string[];
    rating?: number;
    user_ratings_total?: number;
    formatted_address?: string;
    business_status?: string;
  }>;
}

interface PlaceDetailsResponse {
  status: string;
  error_message?: string;
  result?: {
    place_id?: string;
    name?: string;
    url?: string;
    website?: string;
    formatted_address?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    rating?: number;
    user_ratings_total?: number;
    editorial_summary?: { overview?: string };
    opening_hours?: { weekday_text?: string[] };
    photos?: Array<{ photo_reference?: string; width?: number; height?: number; html_attributions?: string[] }>;
    types?: string[];
  };
}

const GENERIC_TYPES = new Set(['point_of_interest', 'establishment', 'premise', 'political', 'geocode']);

function labelFromTypes(types: string[] | undefined, fallback: string): { id: string; label: string } {
  const specific = (types ?? []).find((type) => !GENERIC_TYPES.has(type));
  if (!specific) return { id: 'custom', label: fallback };
  const label = specific.replace(/_/g, ' ');
  return { id: specific, label: label.charAt(0).toUpperCase() + label.slice(1) };
}

/** Stable numeric stand-in for the OSM id field, derived from the place_id. */
function numericId(placeId: string): number {
  let hash = 0;
  for (let i = 0; i < placeId.length; i += 1) {
    hash = (hash * 31 + placeId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Overridden at startup when the server had to fall back to another port. */
let publicBaseUrl = config.publicBaseUrl;

export function setPublicBaseUrl(url: string): void {
  publicBaseUrl = url.replace(/\/+$/, '');
}

export function googlePhotoProxyUrl(reference: string, width: number): string {
  return `${publicBaseUrl}/api/google-photo?${qs({ ref: reference, w: width })}`;
}

function photosToImages(
  photos: NonNullable<PlaceDetailsResponse['result']>['photos'],
  placeName: string,
): PlaceImage[] {
  const attributionText = (html: string | undefined): string | undefined => {
    if (!html) return undefined;
    return cleanText(html.replace(/<[^>]+>/g, ''), 160) || undefined;
  };

  return (photos ?? [])
    .filter((photo) => Boolean(photo.photo_reference))
    .slice(0, config.imagesPerPlace)
    .map((photo, index) => ({
      url: googlePhotoProxyUrl(photo.photo_reference!, 1200),
      downloadUrl: googlePhotoProxyUrl(photo.photo_reference!, Math.max(config.minImageWidth, 1600)),
      thumbUrl: googlePhotoProxyUrl(photo.photo_reference!, 480),
      width: photo.width,
      height: photo.height,
      source: 'google' as const,
      title: `${placeName} (${index + 1})`,
      credit: attributionText(photo.html_attributions?.[0]),
      license: 'Google Maps user content',
      sourcePage: undefined,
    }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function textSearchAll(query: string, key: string, limit: number): Promise<NonNullable<TextSearchResponse['results']>> {
  const collected: NonNullable<TextSearchResponse['results']> = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3 && collected.length < limit; page += 1) {
    if (pageToken) await sleep(2_100); // next_page_token takes ~2s to activate
    const payload = await fetchJson<TextSearchResponse>(
      `${GOOGLE_BASE}/place/textsearch/json?${qs({
        query,
        key,
        language: 'en',
        ...(pageToken ? { pagetoken: pageToken } : {}),
      })}`,
      { timeoutMs: 20_000, retries: 1, skipThrottle: true },
    );

    if (payload.status === 'ZERO_RESULTS') break;
    if (payload.status !== 'OK') {
      // A failing later page should not throw away earlier results.
      if (collected.length > 0) break;
      throw new GoogleSearchError(explainStatus(payload.status, payload.error_message), payload.status);
    }

    collected.push(...(payload.results ?? []));
    pageToken = payload.next_page_token;
    if (!pageToken) break;
  }

  return collected.slice(0, limit);
}

export async function runGoogleSearch(query: SearchQuery): Promise<SearchResult> {
  const startedAt = Date.now();
  const key = requireKey();
  const warnings: string[] = [];

  const keyword = query.keyword.trim();
  const city = query.city.trim();
  const country = query.country.trim();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), config.maxResults);
  const includeImages = query.includeImages !== false;

  const area = await geocodeViaGoogle(city, country);

  const found = await textSearchAll(`${keyword} in ${city}, ${country}`, key, limit);
  if (found.length === 0) {
    warnings.push(`Google Places found no "${keyword}" results in ${city}.`);
  }

  const places: Place[] = (
    await mapLimit(found, 5, async (item) => {
      const placeId = item.place_id;
      const baseName = cleanText(item.name ?? '', 200);
      if (!placeId || !baseName) throw new Error('missing place_id');

      let details: PlaceDetailsResponse['result'] | undefined;
      try {
        const payload = await fetchJson<PlaceDetailsResponse>(
          `${GOOGLE_BASE}/place/details/json?${qs({
            place_id: placeId,
            fields: [
              'place_id',
              'name',
              'url',
              'website',
              'formatted_address',
              'formatted_phone_number',
              'international_phone_number',
              'rating',
              'user_ratings_total',
              'editorial_summary',
              'opening_hours',
              'photos',
              'types',
            ].join(','),
            key,
            language: 'en',
          })}`,
          { timeoutMs: 20_000, retries: 1, skipThrottle: true },
        );
        if (payload.status === 'OK') details = payload.result;
      } catch {
        // Details are enrichment; the text-search row alone is still a result.
      }

      const location = item.geometry?.location;
      if (!location) throw new Error('missing coordinates');

      const category = labelFromTypes(details?.types ?? item.types, 'Place');
      const hours = details?.opening_hours?.weekday_text?.join('; ');
      const rating = details?.rating ?? item.rating;
      const ratingCount = details?.user_ratings_total ?? item.user_ratings_total;

      const tags: Record<string, string> = { google_place_id: placeId };
      if (rating !== undefined) tags.rating = `${rating} / 5 (${ratingCount ?? 0} reviews)`;
      if (hours) tags.opening_hours = hours;
      if (details?.formatted_address ?? item.formatted_address) {
        tags['addr:full'] = (details?.formatted_address ?? item.formatted_address)!;
      }
      if (details?.website) tags.website = details.website;
      if (details?.formatted_phone_number) tags.phone = details.formatted_phone_number;
      for (const type of (details?.types ?? item.types ?? []).slice(0, 6)) {
        if (!GENERIC_TYPES.has(type)) tags[`google:${type}`] = 'yes';
      }

      const summaryBits = [
        details?.editorial_summary?.overview,
        rating !== undefined ? `Rated ${rating}/5 by ${ratingCount ?? 0} Google reviewers.` : undefined,
      ].filter(Boolean);

      const googleUrl =
        details?.url
        ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(baseName)}&query_place_id=${placeId}`;

      const place: Place = {
        id: `google/${placeId}`,
        osmType: 'node',
        osmId: numericId(placeId),
        name: cleanText(details?.name ?? baseName, 200),
        lat: location.lat,
        lon: location.lng,
        tags,
        category: category.id,
        categoryLabel: category.label,
        source: 'google',
        summary: cleanText(summaryBits.join(' '), 4000),
        contact: {
          phone: details?.formatted_phone_number ?? details?.international_phone_number,
          website: details?.website,
          address: details?.formatted_address ?? item.formatted_address,
          openingHours: hours,
        },
        images: includeImages ? photosToImages(details?.photos, baseName) : [],
        travelLinks: buildTravelLinks({
          name: baseName,
          city,
          country,
          countryCode: area.countryCode,
        }),
        qualityScore: rating !== undefined ? Math.round(rating * 20) : 50,
        llmProcessed: false,
        googleMapsUrl: googleUrl,
        osmUrl: googleUrl,
      };
      return place;
    })
  )
    .filter((result): result is { ok: true; value: Place } => result.ok)
    .map((result) => result.value)
    .sort((a, b) => b.qualityScore - a.qualityScore);

  if (found.length > 0 && places.length < found.length) {
    warnings.push(`${found.length - places.length} result(s) were dropped for missing coordinates or names.`);
  }

  return {
    searchId: randomUUID(),
    query: { keyword, city, country, limit, useLlm: false, includeImages, source: 'google' },
    area,
    places,
    stats: {
      overpassMatches: found.length,
      afterDedupe: found.length,
      afterFilter: places.length,
      withImages: places.filter((place) => place.images.length > 0).length,
      llmUsed: false,
      elapsedMs: Date.now() - startedAt,
      warnings,
    },
    cachedAt: new Date().toISOString(),
  };
}
