import { config } from '../config.js';
import { mapLimitSettled, chunk } from '../lib/concurrency.js';
import { fetchJson, HttpError, qs } from '../lib/http.js';
import { describesPlace } from '../lib/nameMatch.js';
import { tourismImagesForPlace } from './tourismImages.js';
import { cleanText } from '../lib/sanitize.js';
import { commonsGeoSearch, europeanaSearch, braveImageSearch, flickrGeoSearch } from './imageSources.js';
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

/**
 * Until when Commons' own API is assumed blocked. Each failed attempt costs
 * seconds per host, and a search makes hundreds of them, so after one
 * confirmed failure the doomed hosts are skipped for a while.
 */
let commonsActionApiDownUntil = 0;
const COMMONS_RETRY_AFTER_MS = 5 * 60_000;

/** Whether the API gateway fallback is also failing. */
let commonsGatewayFailing = false;
/** Whether any photo this session had to come through the gateway. */
let commonsGatewayUsed = false;

function commonsHostOrder(extra: string[] = []): string[] {
  const hosts = [...config.commonsHosts, ...extra];
  // Try the host that last worked first, but only a host this call would use
  // anyway. Wikipedia is a valid last resort for imageinfo on a File: title
  // and nothing else, so promoting it for every Commons query sent
  // generator=geosearch and generator=search there, where a geosearch returns
  // articles and the File namespace is all but empty -- dozens of requests per
  // search that could not return a photo.
  if (!workingCommonsHost || !hosts.includes(workingCommonsHost)) return hosts;
  return [workingCommonsHost, ...hosts.filter((host) => host !== workingCommonsHost)];
}

/**
 * True when Commons imagery was actually lost: its own API is blocked and the
 * gateway fallback failed too. A blocked host alone no longer loses anything.
 */
export function isCommonsUnreachable(): boolean {
  return Date.now() < commonsActionApiDownUntil && commonsGatewayFailing;
}

/** True when Commons was blocked but its photos arrived through the gateway. */
export function isCommonsViaGateway(): boolean {
  return commonsGatewayUsed && !commonsGatewayFailing;
}

async function commonsApi<T>(
  params: Record<string, string | number | boolean | undefined>,
  options: { imageInfoOnly?: boolean } = {},
): Promise<T | null> {
  // `prop=imageinfo` on a File: title also resolves through any wiki that uses
  // Commons as a shared repo, so Wikipedia is a safe last resort for those.
  // Category listings are NOT safe that way — enwiki has its own categories.
  const commonsBlocked = Date.now() < commonsActionApiDownUntil;
  const hosts = commonsHostOrder(options.imageInfoOnly ? ['en.wikipedia.org'] : [])
    // Wikipedia is not Commons and is not subject to the block.
    .filter((host) => !commonsBlocked || !config.commonsHosts.includes(host));

  let commonsTried = false;
  const commonsInPlay = hosts.filter((host) => config.commonsHosts.includes(host)).length;
  let commonsUnreachable = 0;
  for (const host of hosts) {
    const isCommons = config.commonsHosts.includes(host);
    try {
      const payload = await fetchJson<T>(`https://${host}/w/api.php?${qs(params)}`, {
        timeoutMs: 25_000,
        retries: 1,
      });
      // Only a real Commons host is worth remembering: Wikipedia answering an
      // imageinfo lookup does not make it a Commons mirror.
      if (isCommons) {
        workingCommonsHost = host;
        commonsActionApiDownUntil = 0;
      }
      return payload;
    } catch (error) {
      if (isCommons) {
        commonsTried = true;
        // A connection that never got an answer means the host is blocked.
        // Remember it now: when Wikipedia then answered the imageinfo lookup,
        // the failure used to be forgotten, and every later lookup spent its
        // turn in the one-at-a-time API queue on the blocked host first --
        // 34 times, about 19 seconds, in a 12-place search.
        if (!(error instanceof HttpError)) commonsUnreachable += 1;
        if (commonsUnreachable > 0 && commonsUnreachable === commonsInPlay) {
          commonsActionApiDownUntil = Date.now() + COMMONS_RETRY_AFTER_MS;
        }
      }
      // Try the next host.
    }
  }

  // Only a Commons host failing says anything about Commons being blocked.
  if (commonsTried) commonsActionApiDownUntil = Date.now() + COMMONS_RETRY_AFTER_MS;
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

/**
 * The only thumbnail widths Wikimedia serves to a direct request. Anything else
 * is answered with HTTP 400 -- "Use thumbnail sizes listed on
 * https://w.wiki/GHai" (mediawiki.org/wiki/Common_thumbnail_sizes). Requests
 * through the imageinfo API are rounded up to one of these, but a URL built by
 * hand is not: a 2560px rendition and a 640px preview were both being refused,
 * which cost places photos they really had.
 */
export const WIKIMEDIA_THUMB_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840] as const;

/** The smallest standard width at least as wide as asked for, capped at the largest. */
export function standardThumbWidth(wanted: number): number {
  return WIKIMEDIA_THUMB_WIDTHS.find((width) => width >= wanted) ?? 3840;
}

/**
 * The widest rendition we serve or embed: 3840px, which is 4K Ultra HD and
 * also Wikimedia's largest standard thumbnail size.
 *
 * Compared against the original's WIDTH, never its long edge: Commons scales
 * by width and refuses to upscale, so a narrower original is served as it is.
 */
const SERVE_WIDTH = 3840;

/** Preview shown in the interface; 960 is standard, the 640 used before is not. */
const PREVIEW_WIDTH = 960;

/**
 * The URL of a scaled rendition, worked out from the original's address.
 *
 * Commons stores renditions at a fixed, derivable path:
 *   .../commons/c/ca/Name.jpg -> .../commons/thumb/c/ca/Name.jpg/3840px-Name.jpg
 *
 * Every imageinfo query here asks for a 3840px thumbnail, but not every source
 * answers with one -- the Commons gateway used when commons.wikimedia.org is
 * blocked does not -- and those places were handing back 4032px camera
 * originals. Deriving the rendition costs no extra request.
 *
 * Only raster files follow the scheme unchanged; SVG and friends render to a
 * different extension, so they are left alone.
 */
export function deriveCommonsThumb(url: string, width: number): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== 'upload.wikimedia.org') return undefined;

  // The path alone, so a tracking query string on the original cannot end up
  // inside the derived filename. A /thumb/ path is already a rendition.
  const match = /^\/wikipedia\/([a-z-]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i.exec(parsed.pathname);
  if (!match) return undefined;

  const [, project, first, second, name] = match;
  if (!/\.(jpe?g|png|webp)$/i.test(name!)) return undefined;

  const standard = standardThumbWidth(width);
  return `https://upload.wikimedia.org/wikipedia/${project}/thumb/${first}/${second}/${name}/${standard}px-${name}`;
}

/**
 * The rendition to hand out for an image of this width: a scaled copy when the
 * original is bigger than we ever need, the original otherwise. A no-op for
 * images hosted anywhere but Wikimedia.
 */
function scaledOrOriginal(url: string, width: number | undefined): string {
  if (!width || width <= SERVE_WIDTH) return url;
  return deriveCommonsThumb(url, SERVE_WIDTH) ?? url;
}

/** Sources not tied to the place by an explicit link: their photos must name it. */
const UNLINKED_SOURCES = new Set<PlaceImage['source']>(['commons-geo', 'commons', 'openverse', 'flickr', 'europeana']);

/** The map's names for a place, in every language that tends to appear in photo titles. */
const NAME_TAGS = ['name', 'name:en', 'name:zh', 'name:zh-Hans', 'name:zh-Hant', 'name:ja', 'name:ko', 'official_name', 'alt_name', 'int_name'];

function toPlaceImage(info: CommonsImageInfo, source: PlaceImage['source'], title?: string): PlaceImage | null {
  if (info.mime && !ALLOWED_MIME.has(info.mime)) return null;
  if (!info.url) return null;

  // We ask the API for a 3840px thumbnail; use it when the original is larger
  // so a 60 MP TIFF doesn't get pulled through the archive pipeline. When the
  // source did not give us one, work it out from the original's address.
  const scaled = (info.thumburl && info.thumbwidth && info.thumbwidth >= 1024 ? info.thumburl : undefined)
    ?? (info.width > SERVE_WIDTH ? deriveCommonsThumb(info.url, SERVE_WIDTH) : undefined);
  const downloadUrl = info.width > SERVE_WIDTH && scaled ? scaled : info.url;

  return {
    url: scaled ?? info.url,
    downloadUrl,
    // An original narrower than the preview cannot be scaled up to it.
    thumbUrl: (info.width > PREVIEW_WIDTH ? buildCommonsThumb(info, PREVIEW_WIDTH) : undefined) ?? scaled ?? info.url,
    width: info.width,
    height: info.height,
    source,
    title: title ? cleanText(title.replace(/^File:/, ''), 160) : undefined,
    credit: stripHtml(info.extmetadata?.Artist?.value) || stripHtml(info.extmetadata?.Credit?.value) || undefined,
    license: stripHtml(info.extmetadata?.LicenseShortName?.value) || undefined,
    sourcePage: info.descriptionurl,
    // What the photo says it shows, for the relevance check on photos found
    // by position or search; removed before results leave the lookup.
    about: [
      title,
      stripHtml(info.extmetadata?.ObjectName?.value),
      stripHtml(info.extmetadata?.ImageDescription?.value),
      stripHtml(info.extmetadata?.Categories?.value),
    ].filter(Boolean).join(' | ').slice(0, 1500) || undefined,
  };
}

/** Commons thumbnail URLs are derivable, which saves an extra API round-trip. */
function buildCommonsThumb(info: CommonsImageInfo, width: number): string | undefined {
  if (!info.thumburl) return undefined;
  return info.thumburl.replace(/\/\d+px-/, `/${standardThumbWidth(width)}px-`);
}

const COMMONS_GATEWAY = 'https://api.wikimedia.org/core/v1/commons/search/page';

/** File titles from Commons' search engine, via the Wikimedia API gateway. */
async function commonsGatewayTitles(query: string, limit: number): Promise<string[]> {
  try {
    const payload = await fetchJson<{ pages?: Array<{ key?: string }> }>(
      `${COMMONS_GATEWAY}?${qs({ q: query, limit: Math.min(Math.max(limit, 1), 100) })}`,
      { timeoutMs: 20_000, retries: 1 },
    );
    commonsGatewayFailing = false;
    return (payload.pages ?? [])
      .map((page) => page.key ?? '')
      // incategory: also returns subcategories and galleries.
      .filter((key) => key.startsWith('File:'))
      .map((key) => key.replace(/_/g, ' '));
  } catch {
    commonsGatewayFailing = true;
    return [];
  }
}

/**
 * The same photos Commons would have given, reached another way.
 *
 * Titles come from the gateway; size, licence and author come from the
 * imageinfo lookup, which falls back to Wikipedia and so survives the block.
 */
export async function commonsFilesViaGateway(
  query: string,
  limit: number,
  source: PlaceImage['source'],
): Promise<PlaceImage[]> {
  if (limit <= 0) return [];

  // Oversampled: some titles are not images, and many fall below the HD bar.
  const titles = await commonsGatewayTitles(query, limit * 3);
  if (titles.length === 0) return [];
  commonsGatewayUsed = true;

  const infos = await commonsImageInfo(titles);
  const images: PlaceImage[] = [];
  for (const title of titles) {
    const image = infos.get(title);
    if (image) images.push({ ...image, source });
  }
  return images;
}

/** Builds the gateway queries, kept pure so their syntax can be tested. */
export const commonsGatewayQuery = {
  search: (text: string) => `filetype:bitmap ${text}`.trim(),
  category: (category: string) => {
    const name = category.replace(/^Category:/, '').replace(/"/g, '').trim();
    return `filetype:bitmap incategory:"${name}"`;
  },
  near: (lat: number, lon: number, radiusKm: number) => {
    // Metres, rounded: the search engine takes whole units.
    const metres = Math.max(1, Math.round(Math.min(radiusKm, 10) * 1000));
    return `filetype:bitmap nearcoord:${metres}m,${lat.toFixed(6)},${lon.toFixed(6)}`;
  },
};

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
        iiurlwidth: SERVE_WIDTH,
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
      const served = scaledOrOriginal(original.source, original.width);
      return {
        url: served,
        downloadUrl: served,
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
    iiurlwidth: SERVE_WIDTH,
    origin: '*',
  });

  // Commons blocked: list the category through its search engine instead.
  if (payload === null) {
    return commonsFilesViaGateway(commonsGatewayQuery.category(title), limit, 'commons-category');
  }

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
    iiurlwidth: SERVE_WIDTH,
    origin: '*',
  });

  if (payload === null) {
    return commonsFilesViaGateway(commonsGatewayQuery.search(query), limit, 'commons');
  }

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
    // Named in its alt text or filename, or the lead image of the page about
    // the place, on the country's own tourism site. Specific, but all rights
    // reserved -- so behind every openly licensed source that is as specific.
    tourism: 5.5,
    'wikipedia-article': 5,
    europeana: 4,
    commons: 3, // free-text search from here down
    openverse: 2,
    unsplash: 1, // generic stock
    brave: 0, // web search: unknown licence, so only ever the fallback
  };

  return unique.sort((a, b) => {
    const aHd = isHdImage(a) ? 1 : 0;
    const bHd = isHdImage(b) ? 1 : 0;
    if (aHd !== bHd) return bHd - aHd;
    if (sourceWeight[a.source] !== sourceWeight[b.source]) {
      return sourceWeight[b.source] - sourceWeight[a.source];
    }
    return (b.width ?? 0) - (a.width ?? 0);
  });
}

/**
 * Whether an image meets the HD bar.
 *
 * Measured on the long edge: a 1200x1800 portrait of a tower is as sharp as
 * a 1800x1200 landscape, and judging width alone would throw it away. An
 * image that does not report its size cannot be shown to meet the bar.
 */
export function isHdImage(image: Pick<PlaceImage, 'width' | 'height'>): boolean {
  return Math.max(image.width ?? 0, image.height ?? 0) >= config.minImageWidth;
}

/** Images that count towards a place's quota under the current policy. */
function countTowardsQuota(images: PlaceImage[]): number {
  return config.requireImages ? images.filter(isHdImage).length : images.length;
}

/**
 * The places to report, when a photo is mandatory.
 *
 * Keeps the ranking order, drops anything without an image, and stops at
 * the requested count -- more candidates are looked up than will be kept,
 * precisely so this still has enough to choose from.
 */
export function selectIllustrated<T extends { id: string }>(
  ranked: T[],
  imagesByPlace: Map<string, PlaceImage[]>,
  limit: number,
): { kept: T[]; withoutImages: number } {
  const illustrated = ranked.filter((place) => (imagesByPlace.get(place.id)?.length ?? 0) > 0);
  return {
    kept: illustrated.slice(0, limit),
    withoutImages: ranked.length - illustrated.length,
  };
}

export interface ImageLookupOptions {
  city: string;
  country: string;
  perPlace?: number;
  /** Set false to skip the (slower) Commons/Unsplash text search. */
  allowTextSearch?: boolean;
  /** ISO country code, for the country's official tourism site. */
  countryCode?: string;
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
  // The tourism site is asked place by place; past this, a search stops
  // starting new crawls there, so a slow site cannot hold the whole search.
  const tourismDeadline = Date.now() + config.crawl.budgetMs;
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
  // Low-resolution hits must not fill the quota: a place holding ten small
  // thumbnails would stop searching and then be dropped for having no HD
  // photo, when a later source had one.
  const needsMore = places.filter((place) => countTowardsQuota(result.get(place.id) ?? []) < perPlace);

  await mapLimitSettled(needsMore, config.imageLookupConcurrency, async (place) => {
    const collected = [...(result.get(place.id) ?? [])];
    const short = () => countTowardsQuota(collected) < perPlace;

    // 2. The article's lead image — guaranteed to depict this place.
    const wikipediaTag = place.tags.wikipedia ?? place.tags['wikipedia:en'];
    const parsed = wikipediaTag ? /^([a-z-]{2,12}):(.+)$/i.exec(wikipediaTag.trim()) : null;
    const lang = parsed ? parsed[1]!.toLowerCase() : 'en';
    const articleTitle = parsed ? parsed[2]! : wikipediaTag?.trim();

    // 3. The whole Commons category — usually the biggest single haul.
    const category = place.tags.wikimedia_commons?.trim();

    // Run Wikipedia lead image and Commons category in parallel (independent sources)
    const parallelResults = await Promise.allSettled([
      short() && wikipediaTag ? wikipediaLeadImage(wikipediaTag) : Promise.resolve(null),
      short() && category ? commonsCategoryImages(category, perPlace) : Promise.resolve([]),
    ]);

    for (const result of parallelResults) {
      if (result.status === 'fulfilled' && result.value) {
        if (Array.isArray(result.value)) {
          collected.push(...result.value);
        } else {
          collected.push(result.value);
        }
      }
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

    // A photo found by position or by a loose search is kept only when its own
    // title, description or categories name the place. Without this, a Shenzhen
    // batch filled museum folders with nearby cars, shops and metro platforms.
    const placeNames = [...new Set([
      ...searchNames,
      ...NAME_TAGS.flatMap((tag) => (place.tags[tag] ?? '').split(';')),
    ].map((name) => name.trim()).filter(Boolean))];
    const aboutPlace = (images: PlaceImage[]) => images.filter((image) => !UNLINKED_SOURCES.has(image.source)
      || describesPlace(image.about ?? image.title ?? '', placeNames, options.city));

    // 4b-6. The independent archives, asked together rather than in turn.
    //
    // These share no state and none can answer for another, so waiting for each
    // before starting the next only added their latencies up: profiling a
    // 12-place lookup showed 141 requests taking 155s, almost all of it spent
    // waiting. Asked at once, a place costs about one round-trip instead of
    // five. Each is still asked only for what is missing, and the quota is
    // re-checked afterwards, so the paid sources below stay a last resort.
    if (short()) {
      const wanted = perPlace - countTowardsQuota(collected);

      // The independent archives, asked together rather than in turn. Asking
      // Commons' own queries one at a time instead was measured slower with no
      // more photos, so they go in the same batch.
      const lookups: Array<Promise<PlaceImage[]>> = [
        // 4b. Photographs taken AT the coordinates. More reliable than any
        // name match — "Bell Tower" exists in a hundred cities, but this bell
        // tower is only at these coordinates.
        commonsGeoSearch(
          place,
          // Most nearby photos are of something else and are dropped below,
          // so ask for more than are wanted.
          Math.min(wanted * 4, 40),
          commonsApi,
          toPlaceImage,
          (limit) => commonsFilesViaGateway(
            commonsGatewayQuery.near(place.lat, place.lon, config.images.geoRadiusKm),
            limit,
            'commons-geo',
          ),
        ),
      ];

      // 4c. Flickr, restricted to reusable licences and searched by position.
      if (config.images.flickrApiKey) lookups.push(flickrGeoSearch(place, options.city, wanted));
      // 4d. Europeana — museums, monuments and archives, open-reuse items only.
      if (config.images.europeanaApiKey) lookups.push(europeanaSearch(place, options.city, wanted));

      if (allowTextSearch) {
        for (const term of searchNames) {
          const query = `${term} ${options.city}`.trim();
          // 5. Commons free-text search.  6. Openverse, CC-licensed, no key.
          lookups.push(commonsSearch(query, wanted));
          lookups.push(openverseSearch(query, wanted));
        }
      }

      for (const outcome of await Promise.allSettled(lookups)) {
        if (outcome.status === 'fulfilled') collected.push(...aboutPlace(outcome.value));
      }
    }

    // 6b. The country's official tourism site, for what the open sources could
    //     not fill. Its photos are all rights reserved and are marked so.
    if (short() && allowTextSearch && options.countryCode) {
      collected.push(...(await tourismImagesForPlace(
        options.countryCode,
        // English sites file places under their English names.
        [...new Set([...searchNames, place.tags['name:en']].filter(Boolean))] as string[],
        perPlace - countTowardsQuota(collected),
        { deadline: tourismDeadline, city: options.city },
      ).catch(() => [])));
    }

    // 7. Unsplash last: generic stock, only if a key is configured.
    if (short() && allowTextSearch && config.unsplashAccessKey) {
      const query = `${place.name} ${options.city} ${options.country}`.trim();
      collected.push(...(await unsplashSearch(query, perPlace - collected.length)));
    }

    // 8. Web image search: only when configured, and only for what the
    //    licensed sources above could not fill. One query per place -- it is
    //    paid per request.
    if (short() && allowTextSearch && config.images.braveApiKey) {
      const query = `${place.name} ${options.city} ${options.country}`.trim();
      collected.push(...(await braveImageSearch(query, perPlace - countTowardsQuota(collected))));
    }

    if (collected.length > 0) result.set(place.id, collected);
  });

  // --- Rank and trim ------------------------------------------------------
  for (const images of result.values()) {
    for (const image of images) delete image.about;
  }
  for (const [placeId, images] of result) {
    const eligible = config.requireImages ? images.filter(isHdImage) : images;
    if (eligible.length === 0) {
      result.delete(placeId);
      continue;
    }
    // Not trimmed yet: a photo another place claims below must leave room for
    // this place's next-best one.
    result.set(placeId, rankImages(eligible));
  }

  dedupeAcrossPlaces(places, result, perPlace);

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
function dedupeAcrossPlaces(places: RawPlace[], result: Map<string, PlaceImage[]>, perPlace: number): void {
  const claimed = new Set<string>();

  // Claim explicitly-linked images first so a text-search hit never displaces
  // the place that actually owns that photo, regardless of iteration order.
  for (const images of result.values()) {
    for (const image of images) {
      if (PLACE_SPECIFIC_SOURCES.has(image.source)) claimed.add(identityKey(image));
    }
  }

  // Iterate in the caller's order so earlier (higher-ranked) places win ties.
  // Each place takes its best unclaimed photos up to the quota, and claims only
  // those. Trimming to the quota first, as before, let an earlier place claim
  // a later one's top photos and left it nothing, though it had more below the
  // cut: a museum with two good photos of its own came back empty.
  for (const place of places) {
    const images = result.get(place.id);
    if (!images) continue;

    const kept: PlaceImage[] = [];
    for (const image of images) {
      if (kept.length >= perPlace) break;
      if (PLACE_SPECIFIC_SOURCES.has(image.source)) {
        kept.push(image);
        continue;
      }
      const key = identityKey(image);
      if (claimed.has(key)) continue;
      claimed.add(key);
      kept.push(image);
    }

    if (kept.length > 0) result.set(place.id, kept);
    else result.delete(place.id);
  }
}

/** Internals exposed for unit tests only -- not part of the service contract. */
export const __testing = { dedupeAcrossPlaces };
