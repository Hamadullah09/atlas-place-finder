import { config } from '../config.js';
import { mapLimitSettled, chunk } from '../lib/concurrency.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import { commonsGeoSearch, europeanaSearch, flickrGeoSearch } from './imageSources.js';
import type { PlaceImage, RawPlace } from '../types.js';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/**
 * Commons access with host failover.
 *
 * `commons.wikimedia.org` is blocked on some networks — it shares an IP with
 * Wikipedia, so DNS resolves fine and the connection is reset by SNI instead.
 * Silently returning no images there makes the app look broken, so we try the
 * configured alternatives and remember whichever answers.
 */
let workingCommonsHost: string | null = null;
let commonsUnreachable = false;

function commonsHostOrder(extra: string[] = []): string[] {
  const hosts = [...config.commonsHosts, ...extra];
  if (!workingCommonsHost) return hosts;
  return [workingCommonsHost, ...hosts.filter((host) => host !== workingCommonsHost)];
}

/** True once every configured Commons host has failed at least once. */
export function isCommonsUnreachable(): boolean {
  return commonsUnreachable;
}

async function commonsApi<T>(
  params: Record<string, string | number | boolean | undefined>,
  options: { imageInfoOnly?: boolean } = {},
): Promise<T | null> {
  // `prop=imageinfo` on a File: title also resolves through any wiki that uses
  // Commons as a shared repo, so Wikipedia is a safe last resort for those.
  // Category listings are NOT safe that way — enwiki has its own categories.
  const hosts = commonsHostOrder(options.imageInfoOnly ? ['en.wikipedia.org'] : []);

  for (const host of hosts) {
    try {
      const payload = await fetchJson<T>(`https://${host}/w/api.php?${qs(params)}`, {
        timeoutMs: 25_000,
        retries: 1,
      });
      workingCommonsHost = host;
      commonsUnreachable = false;
      return payload;
    } catch {
      // Try the next host.
    }
  }

  commonsUnreachable = true;
  return null;
}

/** sharp can rasterise SVG, but the results are unpredictable — skip them. */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/jpg']);

/**
 * The download endpoint fetches these URLs server-side, so an attacker who can
 * put a URL in a request body would otherwise have an SSRF primitive pointed
 * at the cloud metadata service. Only the hosts this module produces are
 * fetchable, and only over https.
 */
const ALLOWED_IMAGE_HOSTS = [
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  'www.wikidata.org',
  'images.unsplash.com',
  'plus.unsplash.com',
  // Flickr CDN shards serve the original-size renditions.
  'live.staticflickr.com',
  'www.flickr.com',
  // Europeana proxies member-institution media through its own host.
  'api.europeana.eu',
  'proxy.europeana.eu',
  // Openverse serves originals from the source provider via its own CDN.
  'api.openverse.org',
  'api.openverse.engineering',
  'live.staticflickr.com',
  'farm1.staticflickr.com',
  'farm2.staticflickr.com',
  'farm3.staticflickr.com',
  'farm4.staticflickr.com',
  'farm5.staticflickr.com',
  'farm6.staticflickr.com',
  'farm8.staticflickr.com',
  'farm9.staticflickr.com',
];

export function isAllowedImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();

  // Our own Google-photo proxy: the archive builder fetches Google imagery
  // back through this server so the API key never appears in any URL.
  if (url.pathname === '/api/google-photo' && (host === 'localhost' || host === '127.0.0.1')) {
    return true;
  }

  if (url.protocol !== 'https:') return false;
  if (ALLOWED_IMAGE_HOSTS.includes(host)) return true;
  // Wikipedia thumbnails are served from per-language hosts.
  return host.endsWith('.wikipedia.org') || host.endsWith('.wikimedia.org');
}

interface CommonsImageInfo {
  url: string;
  descriptionurl?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width: number;
  height: number;
  mime?: string;
  extmetadata?: Record<string, { value?: string }>;
}

interface MediaWikiQueryResponse {
  query?: {
    pages?: Record<string, { title?: string; imageinfo?: CommonsImageInfo[]; original?: { source?: string; width?: number; height?: number } }>;
  };
}

interface WikidataEntitiesResponse {
  entities?: Record<string, {
    claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  }>;
}

function stripHtml(input: string | undefined): string {
  if (!input) return '';
  return cleanText(input.replace(/<[^>]*>/g, ' '), 200);
}

function toPlaceImage(info: CommonsImageInfo, source: PlaceImage['source'], title?: string): PlaceImage | null {
  if (info.mime && !ALLOWED_MIME.has(info.mime)) return null;
  if (!info.url) return null;

  // We ask the API for a 2560px thumbnail; use it when the original is larger
  // so a 60 MP TIFF doesn't get pulled through the archive pipeline.
  const scaled = info.thumburl && info.thumbwidth && info.thumbwidth >= 1024 ? info.thumburl : undefined;
  const downloadUrl = info.width > 2560 && scaled ? scaled : info.url;

  return {
    url: scaled ?? info.url,
    downloadUrl,
    thumbUrl: buildCommonsThumb(info, 640) ?? scaled ?? info.url,
    width: info.width,
    height: info.height,
    source,
    title: title ? cleanText(title.replace(/^File:/, ''), 160) : undefined,
    credit: stripHtml(info.extmetadata?.Artist?.value) || stripHtml(info.extmetadata?.Credit?.value) || undefined,
    license: stripHtml(info.extmetadata?.LicenseShortName?.value) || undefined,
    sourcePage: info.descriptionurl,
  };
}

/** Commons thumbnail URLs are derivable, which saves an extra API round-trip. */
function buildCommonsThumb(info: CommonsImageInfo, width: number): string | undefined {
  if (!info.thumburl) return undefined;
  return info.thumburl.replace(/\/\d+px-/, `/${width}px-`);
}

async function commonsImageInfo(titles: string[]): Promise<Map<string, PlaceImage>> {
  const output = new Map<string, PlaceImage>();
  if (titles.length === 0) return output;

  for (const batch of chunk(titles, 40)) {
    const payload = await commonsApi<MediaWikiQueryResponse>(
      {
        action: 'query',
        format: 'json',
        formatversion: 1,
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: 2560,
        titles: batch.join('|'),
        origin: '*',
      },
      { imageInfoOnly: true },
    );

    for (const page of Object.values(payload?.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info || !page.title) continue;
      const image = toPlaceImage(info, 'commons', page.title);
      if (image) output.set(page.title, image);
    }
  }

  return output;
}

/** Resolve Wikidata Q-ids to their P18 "image" filenames, 50 at a time. */
async function wikidataImageFiles(qids: string[]): Promise<Map<string, string[]>> {
  const output = new Map<string, string[]>();
  if (qids.length === 0) return output;

  for (const batch of chunk(qids, 45)) {
    const url = `${WIKIDATA_API}?${qs({
      action: 'wbgetentities',
      format: 'json',
      props: 'claims',
      ids: batch.join('|'),
      origin: '*',
    })}`;

    try {
      const payload = await fetchJson<WikidataEntitiesResponse>(url, { timeoutMs: 20_000, retries: 1 });
      for (const [qid, entity] of Object.entries(payload.entities ?? {})) {
        const files: string[] = [];
        for (const property of ['P18', 'P3451', 'P5252']) {
          for (const claim of entity.claims?.[property] ?? []) {
            const value = claim.mainsnak?.datavalue?.value;
            if (typeof value === 'string' && value.trim()) files.push(value.trim());
          }
        }
        if (files.length > 0) output.set(qid, files);
      }
    } catch {
      // Ignore — the place simply won't get a Wikidata image.
    }
  }

  return output;
}

/** `wikipedia=en:Mohatta Palace` -> the article's lead image at full size. */
async function wikipediaLeadImage(wikipediaTag: string): Promise<PlaceImage | null> {
  const match = /^([a-z-]{2,12}):(.+)$/i.exec(wikipediaTag.trim());
  const lang = match ? match[1]!.toLowerCase() : 'en';
  const title = match ? match[2]! : wikipediaTag.trim();

  const url = `https://${lang}.wikipedia.org/w/api.php?${qs({
    action: 'query',
    format: 'json',
    formatversion: 1,
    prop: 'pageimages',
    piprop: 'original|thumbnail',
    pithumbsize: 1280,
    titles: title,
    origin: '*',
  })}`;

  try {
    const payload = await fetchJson<MediaWikiQueryResponse & {
      query?: { pages?: Record<string, { original?: { source?: string; width?: number; height?: number }; thumbnail?: { source?: string } }> };
    }>(url, { timeoutMs: 20_000, retries: 1 });

    for (const page of Object.values(payload.query?.pages ?? {})) {
      const original = page.original;
      if (!original?.source) continue;
      return {
        url: original.source,
        downloadUrl: original.source,
        thumbUrl: (page as { thumbnail?: { source?: string } }).thumbnail?.source ?? original.source,
        width: original.width,
        height: original.height,
        source: 'wikipedia',
        sourcePage: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        license: 'See Wikipedia file page',
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Every file in a Commons category. This is by far the richest source for a
 * notable place — `wikimedia_commons=Category:Mohatta Palace` typically holds
 * dozens of high-resolution photographs, where P18 gives exactly one.
 */
async function commonsCategoryImages(category: string, limit: number): Promise<PlaceImage[]> {
  const title = category.startsWith('Category:') ? category : `Category:${category}`;

  const payload = await commonsApi<MediaWikiQueryResponse>({
    action: 'query',
    format: 'json',
    formatversion: 1,
    generator: 'categorymembers',
    gcmtitle: title,
    gcmtype: 'file',
    gcmlimit: Math.min(limit * 3, 40),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: 2560,
    origin: '*',
  });

  const images: PlaceImage[] = [];
  for (const page of Object.values(payload?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const image = toPlaceImage(info, 'commons-category', page.title);
    if (image) images.push(image);
  }
  return images;
}

/**
 * Images embedded in a Wikipedia article. Filters out the usual chrome
 * (icons, flags, edit pencils) that would otherwise dominate the results.
 */
async function wikipediaArticleImages(
  lang: string,
  title: string,
  limit: number,
): Promise<PlaceImage[]> {
  const listUrl = `https://${lang}.wikipedia.org/w/api.php?${qs({
    action: 'query',
    format: 'json',
    formatversion: 1,
    prop: 'images',
    imlimit: 30,
    redirects: 1,
    titles: title,
    origin: '*',
  })}`;

  try {
    const listing = await fetchJson<{
      query?: { pages?: Record<string, { images?: Array<{ title?: string }> }> };
    }>(listUrl, { timeoutMs: 25_000, retries: 1 });

    const titles: string[] = [];
    for (const page of Object.values(listing.query?.pages ?? {})) {
      for (const image of page.images ?? []) {
        const fileTitle = image.title;
        if (!fileTitle) continue;
        // Skip UI furniture and non-photographic assets.
        if (/\.(svg|gif)$/i.test(fileTitle)) continue;
        if (/(icon|logo|flag|symbol|edit|commons-logo|wiki|ambox|question|padlock|arrow)/i.test(fileTitle)) {
          continue;
        }
        titles.push(fileTitle);
      }
    }

    if (titles.length === 0) return [];

    const byTitle = await commonsImageInfo(titles.slice(0, limit * 3));
    return [...byTitle.values()].map((image) => ({ ...image, source: 'wikipedia-article' as const }));
  } catch {
    return [];
  }
}

interface OpenverseResult {
  id: string;
  title?: string;
  url: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  creator?: string;
  license?: string;
  license_version?: string;
  foreign_landing_url?: string;
}

/**
 * Openverse aggregates ~700M openly-licensed images (Flickr, Commons, museums)
 * and needs no API key for anonymous search. Used as a general-purpose fallback
 * before Unsplash, since its licences are more permissive for redistribution.
 */
async function openverseSearch(query: string, limit: number): Promise<PlaceImage[]> {
  if (!config.openverseEnabled) return [];

  const url = `https://api.openverse.org/v1/images/?${qs({
    q: query,
    page_size: Math.min(limit * 2, 20),
    license_type: 'all-cc',
    mature: 'false',
  })}`;

  try {
    const payload = await fetchJson<{ results?: OpenverseResult[] }>(url, {
      timeoutMs: 25_000,
      retries: 1,
    });

    return (payload.results ?? [])
      .filter((item) => item.url && isAllowedImageUrl(item.url))
      .map((item) => ({
        url: item.url,
        downloadUrl: item.url,
        thumbUrl: item.thumbnail ?? item.url,
        width: item.width,
        height: item.height,
        source: 'openverse' as const,
        title: cleanText(item.title ?? '', 160) || undefined,
        credit: item.creator ? cleanText(item.creator, 160) : undefined,
        license: [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(' ') || undefined,
        sourcePage: item.foreign_landing_url,
      }));
  } catch {
    return [];
  }
}

async function commonsSearch(query: string, limit: number): Promise<PlaceImage[]> {
  const payload = await commonsApi<MediaWikiQueryResponse>({
    action: 'query',
    format: 'json',
    formatversion: 1,
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: 6, // File:
    gsrlimit: Math.min(limit * 2, 12),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: 2560,
    origin: '*',
  });

  const images: PlaceImage[] = [];
  for (const page of Object.values(payload?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const image = toPlaceImage(info, 'commons', page.title);
    if (image) images.push(image);
  }
  return images;
}

interface UnsplashPhoto {
  urls: { raw: string; full: string; regular: string; small: string };
  width: number;
  height: number;
  description?: string | null;
  alt_description?: string | null;
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

async function unsplashSearch(query: string, limit: number): Promise<PlaceImage[]> {
  if (!config.unsplashAccessKey) return [];

  const url = `https://api.unsplash.com/search/photos?${qs({
    query,
    per_page: Math.min(limit, 5),
    orientation: 'landscape',
    content_filter: 'high',
  })}`;

  try {
    const payload = await fetchJson<{ results?: UnsplashPhoto[] }>(url, {
      timeoutMs: 20_000,
      retries: 1,
      headers: { Authorization: `Client-ID ${config.unsplashAccessKey}` },
    });

    return (payload.results ?? []).map((photo) => ({
      url: `${photo.urls.raw}&w=2560&fit=max&fm=jpg&q=90`,
      downloadUrl: `${photo.urls.raw}&w=2560&fit=max&fm=jpg&q=95`,
      thumbUrl: `${photo.urls.raw}&w=640&fit=max&fm=jpg&q=80`,
      width: Math.min(photo.width, 2560),
      height: photo.height,
      source: 'unsplash' as const,
      title: cleanText(photo.description ?? photo.alt_description ?? '', 160) || undefined,
      credit: `${photo.user.name} on Unsplash`,
      license: 'Unsplash License',
      sourcePage: photo.links.html,
    }));
  } catch {
    return [];
  }
}

/**
 * Unsplash's API terms require pinging `download_location` whenever an image
 * is actually downloaded. Fire-and-forget; failures are irrelevant.
 */
export function notifyUnsplashDownload(sourcePage: string | undefined): void {
  if (!config.unsplashAccessKey || !sourcePage?.includes('unsplash.com')) return;
  const id = sourcePage.split('-').pop();
  if (!id) return;
  void fetchJson(`https://api.unsplash.com/photos/${id}/download`, {
    timeoutMs: 5_000,
    retries: 0,
    headers: { Authorization: `Client-ID ${config.unsplashAccessKey}` },
  }).catch(() => undefined);
}

/** Same file surfaced by two sources arrives with different URLs. */
function identityKey(image: PlaceImage): string {
  // Commons/Openverse both ultimately serve upload.wikimedia.org paths; the
  // filename is the stable identity. Fall back to the bare URL otherwise.
  const url = image.downloadUrl.split('?')[0]!;
  const filename = url.split('/').pop() ?? url;
  return decodeURIComponent(filename)
    .replace(/^\d+px-/, '') // thumbnail prefixes
    .toLowerCase();
}

function rankImages(images: PlaceImage[]): PlaceImage[] {
  const seenFile = new Set<string>();
  const seenTitle = new Set<string>();

  const unique = images.filter((image) => {
    const key = identityKey(image);
    if (seenFile.has(key)) return false;
    seenFile.add(key);

    // Bursts like "INTERIOR OF NATIONAL MUSEUM 1/2/3" are near-duplicates that
    // would otherwise eat the whole quota; keep the first of each title stem.
    const stem = (image.title ?? '')
      .toLowerCase()
      .replace(/\.[a-z]{3,4}$/, '')
      .replace(/[\s_-]*\(?\d+\)?$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (stem.length > 8) {
      if (seenTitle.has(stem)) return false;
      seenTitle.add(stem);
    }

    return true;
  });

  // Ordered by how certain the source is to actually depict this exact place.
  // Ordered by how certain the source is to depict this exact place. Anything
  // resolved by an explicit link or by coordinates beats a free-text guess.
  const sourceWeight: Record<PlaceImage['source'], number> = {
    google: 11, // only present in Google-engine results, where it is the sole source
    wikidata: 10, // the place's own P18 statement
    wikipedia: 9, // lead image of the place's own article
    'commons-category': 8, // the place's own Commons category
    'commons-geo': 7, // photographed at these coordinates
    flickr: 6, // geo-restricted search, reusable licence only
    'wikipedia-article': 5,
    europeana: 4,
    commons: 3, // free-text search from here down
    openverse: 2,
    unsplash: 1, // generic stock
  };

  return unique.sort((a, b) => {
    const aHd = (a.width ?? 0) >= config.minImageWidth ? 1 : 0;
    const bHd = (b.width ?? 0) >= config.minImageWidth ? 1 : 0;
    if (aHd !== bHd) return bHd - aHd;
    if (sourceWeight[a.source] !== sourceWeight[b.source]) {
      return sourceWeight[b.source] - sourceWeight[a.source];
    }
    return (b.width ?? 0) - (a.width ?? 0);
  });
}

export interface ImageLookupOptions {
  city: string;
  country: string;
  perPlace?: number;
  /** Set false to skip the (slower) Commons/Unsplash text search. */
  allowTextSearch?: boolean;
}

/**
 * Resolve ultra-HD imagery for a batch of places.
 *
 * Order of preference: Wikidata P18 -> Wikipedia lead image -> Commons text
 * search -> Unsplash. The first two are the only ones guaranteed to depict the
 * exact place, so they always win.
 */
export async function fetchImagesForPlaces(
  places: RawPlace[],
  options: ImageLookupOptions,
): Promise<Map<string, PlaceImage[]>> {
  const perPlace = Math.min(options.perPlace ?? config.imagesPerPlace, config.limits.maxImagesPerPlace);
  const allowTextSearch = options.allowTextSearch ?? true;
  const result = new Map<string, PlaceImage[]>();
  if (places.length === 0 || perPlace <= 0) return result;

  // --- Pass 1: Wikidata P18 (batched) ------------------------------------
  const qidByPlace = new Map<string, string>();
  for (const place of places) {
    const qid = place.tags.wikidata?.trim();
    if (qid && /^Q\d+$/.test(qid)) qidByPlace.set(place.id, qid);
  }

  const filesByQid = await wikidataImageFiles([...new Set(qidByPlace.values())]);
  const allFileTitles = [...new Set(
    [...filesByQid.values()].flat().map((file) => `File:${file.replace(/^File:/, '')}`),
  )];
  const commonsByTitle = await commonsImageInfo(allFileTitles);

  for (const place of places) {
    const qid = qidByPlace.get(place.id);
    if (!qid) continue;
    const images = (filesByQid.get(qid) ?? [])
      .map((file) => commonsByTitle.get(`File:${file.replace(/^File:/, '')}`))
      .filter((image): image is PlaceImage => Boolean(image))
      .map((image) => ({ ...image, source: 'wikidata' as const }));
    if (images.length > 0) result.set(place.id, images);
  }

  // --- Pass 2+: everything else, per place, cheapest-and-surest first -----
  const needsMore = places.filter((place) => (result.get(place.id)?.length ?? 0) < perPlace);

  await mapLimitSettled(needsMore, 4, async (place) => {
    const collected = [...(result.get(place.id) ?? [])];
    const short = () => collected.length < perPlace;

    // 2. The article's lead image — guaranteed to depict this place.
    const wikipediaTag = place.tags.wikipedia ?? place.tags['wikipedia:en'];
    const parsed = wikipediaTag ? /^([a-z-]{2,12}):(.+)$/i.exec(wikipediaTag.trim()) : null;
    const lang = parsed ? parsed[1]!.toLowerCase() : 'en';
    const articleTitle = parsed ? parsed[2]! : wikipediaTag?.trim();

    if (short() && wikipediaTag) {
      const image = await wikipediaLeadImage(wikipediaTag);
      if (image) collected.push(image);
    }

    // 3. The whole Commons category — usually the biggest single haul.
    const category = place.tags.wikimedia_commons?.trim();
    if (short() && category) {
      collected.push(...(await commonsCategoryImages(category, perPlace - collected.length)));
    }

    // 4. Everything embedded in the Wikipedia article.
    if (short() && articleTitle) {
      collected.push(
        ...(await wikipediaArticleImages(lang, articleTitle, perPlace - collected.length)),
      );
    }

    // Commons indexes Chinese sites under their Chinese names, so a place whose
    // name we translated to English must also be searched under its original.
    const localName = place.tags['name:local'];
    const searchNames = [...new Set([place.name, localName].filter(Boolean))] as string[];

    // 4b. Photographs taken AT the coordinates. More reliable than any name
    // match — "Bell Tower" exists in a hundred cities, but this bell tower is
    // only at these coordinates. Needs no API key.
    if (short()) {
      collected.push(
        ...(await commonsGeoSearch(place, perPlace - collected.length, commonsApi, toPlaceImage)),
      );
    }

    // 4c. Flickr, restricted to reusable licences and searched by position.
    if (short() && config.images.flickrApiKey) {
      collected.push(...(await flickrGeoSearch(place, options.city, perPlace - collected.length)));
    }

    // 4d. Europeana — museums, monuments and archives, open-reuse items only.
    if (short() && config.images.europeanaApiKey) {
      collected.push(...(await europeanaSearch(place, options.city, perPlace - collected.length)));
    }

    // 5. Commons free-text search.
    for (const term of searchNames) {
      if (!short() || !allowTextSearch) break;
      const query = `${term} ${options.city}`.trim();
      collected.push(...(await commonsSearch(query, perPlace - collected.length)));
    }

    // 6. Openverse — no key needed, CC-licensed.
    for (const term of searchNames) {
      if (!short() || !allowTextSearch) break;
      const query = `${term} ${options.city}`.trim();
      collected.push(...(await openverseSearch(query, perPlace - collected.length)));
    }

    // 7. Unsplash last: generic stock, only if a key is configured.
    if (short() && allowTextSearch && config.unsplashAccessKey) {
      const query = `${place.name} ${options.city} ${options.country}`.trim();
      collected.push(...(await unsplashSearch(query, perPlace - collected.length)));
    }

    if (collected.length > 0) result.set(place.id, collected);
  });

  // --- Rank and trim ------------------------------------------------------
  for (const [placeId, images] of result) {
    result.set(placeId, rankImages(images).slice(0, perPlace));
  }

  dedupeAcrossPlaces(places, result);

  return result;
}

/**
 * Sources that are tied to a specific place by an explicit link (a Wikidata
 * statement, that place's own article or Commons category). Anything else came
 * from a free-text query and may well be a generic city photo.
 */
const PLACE_SPECIFIC_SOURCES = new Set<PlaceImage['source']>([
  'wikidata',
  'wikipedia',
  'commons-category',
  'wikipedia-article',
  'google',
]);

/**
 * Free-text image search returns near-identical results for every place in the
 * same city, which is how the same three photos ended up in three different
 * place folders. A text-search image is therefore allowed to appear only once
 * across the whole result set; explicitly-linked imagery is left alone, since
 * two places legitimately sharing a photo there is real (and rare).
 */
function dedupeAcrossPlaces(places: RawPlace[], result: Map<string, PlaceImage[]>): void {
  const claimed = new Set<string>();

  // Claim explicitly-linked images first so a text-search hit never displaces
  // the place that actually owns that photo, regardless of iteration order.
  for (const images of result.values()) {
    for (const image of images) {
      if (PLACE_SPECIFIC_SOURCES.has(image.source)) claimed.add(identityKey(image));
    }
  }

  // Iterate in the caller's order so earlier (higher-ranked) places win ties.
  for (const place of places) {
    const images = result.get(place.id);
    if (!images) continue;

    const kept = images.filter((image) => {
      const key = identityKey(image);
      if (PLACE_SPECIFIC_SOURCES.has(image.source)) return true;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });

    if (kept.length > 0) result.set(place.id, kept);
    else result.delete(place.id);
  }
}
