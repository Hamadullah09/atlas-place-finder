import { config } from '../config.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import type { PlaceImage, RawPlace } from '../types.js';

/**
 * Additional free image sources, all properly licensed for redistribution.
 *
 * Deliberately NOT here: scraping Google/Bing/Yahoo image search. Those
 * results are overwhelmingly all-rights-reserved, and this app embeds imagery
 * into PDFs and ZIPs that users keep and share — redistributing them would be
 * a copyright problem, quite apart from the terms of service and the fact that
 * scrapers get blocked within weeks. Everything below is either CC-licensed,
 * public domain, or explicitly cleared for reuse.
 *
 * The important idea here is GEOGRAPHIC search. Matching a place by name is
 * unreliable ("Bell Tower" exists in a hundred cities); searching for photos
 * taken within a few hundred metres of the coordinates finds pictures OF the
 * place, which is what "only relevant" actually requires.
 */

/** CC + public-domain license ids on Flickr. Excludes all-rights-reserved. */
const FLICKR_FREE_LICENSES = '1,2,3,4,5,6,7,8,9,10';

interface FlickrPhoto {
  id: string;
  title?: string;
  ownername?: string;
  license?: string;
  url_o?: string; width_o?: number; height_o?: number;
  url_k?: string; width_k?: number; height_k?: number;
  url_h?: string; width_h?: number; height_h?: number;
  url_b?: string; width_b?: number; height_b?: number;
}

const FLICKR_LICENSE_NAME: Record<string, string> = {
  '1': 'CC BY-NC-SA 2.0', '2': 'CC BY-NC 2.0', '3': 'CC BY-NC-ND 2.0',
  '4': 'CC BY 2.0', '5': 'CC BY-SA 2.0', '6': 'CC BY-ND 2.0',
  '7': 'No known copyright restrictions', '8': 'United States Government Work',
  '9': 'CC0 1.0', '10': 'Public Domain Mark 1.0',
};

interface Rendition {
  url: string;
  width?: number;
  height?: number;
}

/** Picks the largest available rendition, so "ultra HD" means what it says. */
function bestFlickrSize(photo: FlickrPhoto): Rendition | null {
  const candidates: Array<Rendition | null> = [
    photo.url_o ? { url: photo.url_o, width: photo.width_o, height: photo.height_o } : null,
    photo.url_k ? { url: photo.url_k, width: photo.width_k, height: photo.height_k } : null,
    photo.url_h ? { url: photo.url_h, width: photo.width_h, height: photo.height_h } : null,
    photo.url_b ? { url: photo.url_b, width: photo.width_b, height: photo.height_b } : null,
  ];
  return candidates.find((candidate): candidate is Rendition => candidate !== null) ?? null;
}

/**
 * Flickr photos taken near the place, restricted to reusable licenses.
 * Free API key: https://www.flickr.com/services/apps/create/apply
 */
export async function flickrGeoSearch(
  place: RawPlace,
  cityName: string,
  limit: number,
): Promise<PlaceImage[]> {
  if (!config.images.flickrApiKey || limit <= 0) return [];

  const url = `https://api.flickr.com/services/rest/?${qs({
    method: 'flickr.photos.search',
    api_key: config.images.flickrApiKey,
    // Text AND position: the radius keeps "Bell Tower" in this city, not another.
    text: place.name,
    lat: place.lat.toFixed(6),
    lon: place.lon.toFixed(6),
    radius: config.images.geoRadiusKm,
    radius_units: 'km',
    license: FLICKR_FREE_LICENSES,
    sort: 'relevance',
    content_type: 1, // photos only, no screenshots or art
    media: 'photos',
    safe_search: 1,
    per_page: Math.min(limit * 3, 30),
    extras: 'url_o,url_k,url_h,url_b,license,owner_name',
    format: 'json',
    nojsoncallback: 1,
  })}`;

  try {
    const payload = await fetchJson<{ photos?: { photo?: FlickrPhoto[] } }>(url, {
      timeoutMs: 25_000,
      retries: 1,
    });

    const images: PlaceImage[] = [];
    for (const photo of payload.photos?.photo ?? []) {
      const size = bestFlickrSize(photo);
      if (!size) continue;
      // Reject anything below the HD floor — a thumbnail helps nobody.
      if ((size.width ?? 0) < config.minImageWidth) continue;

      images.push({
        url: size.url,
        downloadUrl: size.url,
        thumbUrl: photo.url_b ?? size.url,
        width: size.width,
        height: size.height,
        source: 'flickr',
        title: cleanText(photo.title ?? '', 160) || `${place.name}, ${cityName}`,
        credit: photo.ownername ? cleanText(photo.ownername, 120) : undefined,
        license: FLICKR_LICENSE_NAME[photo.license ?? ''] ?? 'Creative Commons',
        sourcePage: `https://www.flickr.com/photos/${photo.ownername ?? ''}/${photo.id}`,
      });
      if (images.length >= limit) break;
    }
    return images;
  } catch {
    return [];
  }
}

interface EuropeanaItem {
  title?: string[];
  edmIsShownBy?: string[];
  edmPreview?: string[];
  dataProvider?: string[];
  rights?: string[];
  guid?: string;
}

/**
 * Europeana aggregates ~50 million items from European museums, libraries and
 * archives — strong on monuments, architecture and historic sites.
 * Free API key: https://pro.europeana.eu/pages/get-api
 */
export async function europeanaSearch(
  place: RawPlace,
  cityName: string,
  limit: number,
): Promise<PlaceImage[]> {
  if (!config.images.europeanaApiKey || limit <= 0) return [];

  const url = `https://api.europeana.eu/record/v2/search.json?${qs({
    wskey: config.images.europeanaApiKey,
    query: `${place.name} ${cityName}`.trim(),
    qf: 'TYPE:IMAGE',
    media: 'true',
    // Only items cleared for reuse; excludes rights-reserved records.
    reusability: 'open',
    rows: Math.min(limit * 2, 20),
    profile: 'rich',
  })}`;

  try {
    const payload = await fetchJson<{ items?: EuropeanaItem[] }>(url, {
      timeoutMs: 25_000,
      retries: 1,
    });

    const images: PlaceImage[] = [];
    for (const item of payload.items ?? []) {
      const full = item.edmIsShownBy?.[0];
      if (!full) continue;
      images.push({
        url: full,
        downloadUrl: full,
        thumbUrl: item.edmPreview?.[0] ?? full,
        source: 'europeana',
        title: cleanText(item.title?.[0] ?? '', 160) || place.name,
        credit: item.dataProvider?.[0] ? cleanText(item.dataProvider[0], 120) : undefined,
        license: item.rights?.[0] ? cleanText(item.rights[0], 160) : 'Europeana (open reuse)',
        sourcePage: item.guid,
      });
      if (images.length >= limit) break;
    }
    return images;
  } catch {
    return [];
  }
}

/**
 * Wikimedia Commons geosearch: files whose coordinates sit near the place.
 * Needs no key at all, and finds photographs that carry no matching title —
 * the single biggest gap in name-based Commons search.
 */
export async function commonsGeoSearch<TInfo>(
  place: RawPlace,
  limit: number,
  commonsApi: <T>(params: Record<string, string | number | boolean | undefined>) => Promise<T | null>,
  toImage: (info: TInfo, source: PlaceImage['source'], title?: string) => PlaceImage | null,
): Promise<PlaceImage[]> {
  if (limit <= 0) return [];

  const payload = await commonsApi<{
    query?: { pages?: Record<string, { title?: string; imageinfo?: TInfo[] }> };
  }>({
    action: 'query',
    format: 'json',
    formatversion: 1,
    generator: 'geosearch',
    ggscoord: `${place.lat}|${place.lon}`,
    ggsradius: Math.min(Math.round(config.images.geoRadiusKm * 1000), 10_000),
    ggslimit: Math.min(limit * 3, 30),
    ggsnamespace: 6, // File:
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: 2560,
    origin: '*',
  });

  const images: PlaceImage[] = [];
  for (const page of Object.values(payload?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const image = toImage(info, 'commons-geo', page.title);
    if (image) images.push(image);
    if (images.length >= limit) break;
  }
  return images;
}
