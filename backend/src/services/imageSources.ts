import { config } from '../config.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import type { PlaceImage, RawPlace } from '../types.js';

/**
 * Additional free image sources, all properly licensed for redistribution.
 *
 * Deliberately NOT here: scraping Google/Bing/Yahoo image search. That breaches
 * their terms, and scrapers get blocked within weeks.
 *
 * Everything below is CC-licensed, public domain or cleared for reuse, except
 * braveImageSearch, which uses an official paid API and is off unless a key
 * is configured. Its results are mostly all-rights-reserved; this app embeds
 * imagery in PDFs and ZIPs people keep and share, so each one is labelled as
 * of unknown licence with a link to where it was found.
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
  /** Used when Commons itself cannot be reached. */
  viaGateway?: (limit: number) => Promise<PlaceImage[]>,
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
    // 4K Ultra HD, and Wikimedia’s largest standard thumbnail size.
    iiurlwidth: 3840,
    origin: '*',
  });

  // Commons blocked: the same position search, through its search engine.
  if (payload === null && viaGateway) return viaGateway(limit);

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

// ---------------------------------------------------------------------------
// Brave image search (official API, opt-in)
// ---------------------------------------------------------------------------

/** Field names as documented at api-dashboard.search.brave.com. */
interface BraveImageResult {
  title?: string | null;
  /** The page the image appears on. */
  url?: string | null;
  source?: string | null;
  thumbnail?: { src?: string | null } | null;
  properties?: {
    /** The original, full-size image. */
    url?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
  meta_url?: { hostname?: string | null } | null;
  confidence?: 'low' | 'medium' | 'high' | null;
}

/**
 * Web image search, for places the licensed sources cannot illustrate.
 *
 * Only high- and medium-confidence matches are kept: a low-confidence hit for
 * "Bell Tower Xi'an" is as likely to be a different tower.
 */
export async function braveImageSearch(query: string, limit: number): Promise<PlaceImage[]> {
  if (!config.images.braveApiKey || limit <= 0) return [];

  const url = `https://api.search.brave.com/res/v1/images/search?${qs({
    q: query,
    // Oversampled: many results fall below the HD threshold.
    count: Math.min(Math.max(limit * 4, 20), 100),
    safesearch: 'strict',
  })}`;

  try {
    const payload = await fetchJson<{ results?: BraveImageResult[] }>(url, {
      timeoutMs: 20_000,
      retries: 1,
      headers: {
        'X-Subscription-Token': config.images.braveApiKey,
        Accept: 'application/json',
      },
    });

    const images: PlaceImage[] = [];
    for (const result of payload.results ?? []) {
      const full = result.properties?.url;
      if (!full || !full.startsWith('https://')) continue;
      if (result.confidence === 'low') continue;

      // The thumbnail is served through Brave's own proxy, so the browser
      // shows it without hotlinking the publisher; the ZIP gets the original.
      const thumb = result.thumbnail?.src ?? full;
      images.push({
        url: thumb,
        downloadUrl: full,
        thumbUrl: thumb,
        width: result.properties?.width ?? undefined,
        height: result.properties?.height ?? undefined,
        source: 'brave',
        title: cleanText(result.title ?? '') || undefined,
        credit: result.meta_url?.hostname ?? result.source ?? undefined,
        license: 'Unknown — found by web search; check the source page before reuse',
        sourcePage: result.url ?? undefined,
      });
      if (images.length >= limit) break;
    }
    return images;
  } catch {
    return [];
  }
}
