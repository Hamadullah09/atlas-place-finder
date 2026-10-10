import sharp from 'sharp';
import { config } from '../config.js';
import { tourismSourceFor } from '../data/tourismSources.js';
import { createLimiter } from '../lib/concurrency.js';
import { fetchPublicImage } from '../lib/publicUrl.js';
import { isCrawlAllowed } from '../lib/robots.js';
import { cleanText } from '../lib/sanitize.js';
import type { PlaceImage } from '../types.js';
import { crawlForTerms } from './siteCrawl.js';

/**
 * Photographs from the country's official tourism site.
 *
 * Asked only for places the openly licensed sources left short. The same
 * targeted crawl that feeds the write-ups reads the site's pages about the
 * place, and a photo is taken only when it is clearly of that place: its alt
 * text, title or filename names it, or it is the lead image of a page whose
 * title names it. A place called "Taverna" must not collect every taverna on
 * the site, so a one-word name needs both.
 *
 * These photos belong to the site -- all rights reserved, as the source
 * catalogue records for every country -- so each carries the organisation as
 * its credit, that status as its licence and the page it came from, and the
 * export's credits file says so beside every one.
 */

export const TOURISM_IMAGE_LICENSE = 'All rights reserved (official tourism site) - ask permission before reuse';

export interface SiteImage {
  url: string;
  /** Alt text and title, for matching against the place's name. */
  text: string;
  /** The page's own choice of lead image: og:image, twitter:image or JSON-LD. */
  lead: boolean;
  /**
   * Width of the file as the page declares it, from a srcset width or
   * og:image:width. A width attribute is left out: it is the size on screen.
   */
  declaredWidth?: number;
}

/** Not photographs of anything: site furniture, social buttons, trackers. */
const JUNK = /(logo|icon|sprite|avatar|favicon|flag|placeholder|blank|spacer|pixel|loader|spinner|badge|button|banner-?ad|\bqr\b|facebook|twitter|instagram|youtube|tiktok|linkedin|whatsapp|pinterest|captcha|marker|arrow)/i;
const NOT_A_PHOTO = /\.(svg|gif|ico)$/i;

const MAX_IMAGES_PER_PAGE = 150;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/** An absolute https address, or nothing. Plain http is tried over https. */
function resolve(raw: string | undefined, base: string): string | undefined {
  if (!raw || /^(data|javascript|blob):/i.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  url.hash = '';
  const href = url.toString();
  return href.length > 1000 ? undefined : href;
}

/** The widest entry of a srcset, with the width it declares if it declares one. */
export function largestFromSrcset(srcset: string): { url: string; width?: number } | undefined {
  let best: { url: string; width?: number; weight: number } | undefined;
  for (const entry of srcset.split(/,\s+/)) {
    const [url, descriptor = ''] = entry.trim().split(/\s+/);
    if (!url) continue;
    const w = /^(\d+)w$/i.exec(descriptor);
    const x = /^([\d.]+)x$/i.exec(descriptor);
    const width = w ? Number(w[1]) : undefined;
    // Width descriptors outrank density ones; a bare URL counts as 1x.
    const weight = width ?? (x ? Number(x[1]) : 1);
    if (!best || weight > best.weight) best = { url, width, weight };
  }
  return best ? { url: best.url, width: best.width } : undefined;
}

/** Everything a page says it is about: its title, og:title and first heading. */
export function pageTitle(html: string): string {
  const parts = [
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
    /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0],
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1],
  ];
  const ogTitle = parts[1] ? attr(parts[1], 'content') : undefined;
  return [parts[0], ogTitle, parts[2]]
    .filter(Boolean)
    .map((part) => decodeEntities(part!.replace(/<[^>]+>/g, ' ')))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonLdImages(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 20 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) jsonLdImages(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const image = record.image;
  const add = (candidate: unknown) => {
    if (typeof candidate === 'string') out.push(candidate);
    else if (candidate && typeof candidate === 'object') {
      const inner = candidate as Record<string, unknown>;
      const url = inner.contentUrl ?? inner.url;
      if (typeof url === 'string') out.push(url);
    }
  };
  if (Array.isArray(image)) image.forEach(add);
  else add(image);
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'image' && typeof child === 'object') jsonLdImages(child, out, depth + 1);
  }
}

/** The photographs a page offers, lead images first. Pure, so it can be tested. */
export function imagesFrom(html: string, pageUrl: string): SiteImage[] {
  const found = new Map<string, SiteImage>();
  const add = (raw: string | undefined, image: Omit<SiteImage, 'url'>) => {
    const url = resolve(raw, pageUrl);
    if (!url || found.size >= MAX_IMAGES_PER_PAGE) return;
    const path = new URL(url).pathname;
    if (NOT_A_PHOTO.test(path) || JUNK.test(path) || JUNK.test(image.text)) return;
    const existing = found.get(url);
    if (existing) {
      existing.lead ||= image.lead;
      if (image.text && !existing.text.includes(image.text)) existing.text = `${existing.text} ${image.text}`.trim();
      existing.declaredWidth ??= image.declaredWidth;
      return;
    }
    found.set(url, { url, ...image });
  };

  // Lead images: what the page itself offers when it is shared.
  let ogWidth: number | undefined;
  const leads: string[] = [];
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (!content) continue;
    if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) {
      leads.push(content);
    } else if (key === 'og:image:width' && Number(content) > 0) {
      ogWidth ??= Number(content);
    }
  }
  for (const [, body] of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLdImages(JSON.parse(body!), leads);
    } catch {
      // Malformed JSON-LD is common and costs nothing to skip.
    }
  }
  leads.forEach((url, index) => add(url, { text: '', lead: true, declaredWidth: index === 0 ? ogWidth : undefined }));

  // Images in the page body.
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const srcset = attr(tag, 'srcset') ?? attr(tag, 'data-srcset');
    const widest = srcset ? largestFromSrcset(srcset) : undefined;
    const src = widest?.url
      ?? attr(tag, 'data-src')
      ?? attr(tag, 'data-lazy-src')
      ?? attr(tag, 'data-original')
      ?? attr(tag, 'src');
    const text = [attr(tag, 'alt'), attr(tag, 'title')].filter(Boolean).join(' ');
    add(src, { text, lead: false, declaredWidth: widest?.width });
  }

  return [...found.values()];
}

/** Lowercased and stripped of accents, so "Košice" matches "kosice". */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Whether `haystack` names one of `names` as a whole word or phrase. */
export function mentions(haystack: string, names: string[]): boolean {
  const text = fold(haystack).replace(/[-_+]|%20/g, ' ');
  return names.some((name) => {
    // Hyphens count as spaces on both sides: "Mont-Saint-Michel" in a page
    // title is "Mont Saint-Michel" in OpenStreetMap.
    const needle = fold(name).replace(/[-_+]/g, ' ').trim().replace(/\s+/g, ' ');
    if (needle.length < 4) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
  });
}

/** Words that say what kind of place it is, not which one. */
const GENERIC_WORDS = new Set((
  'the and des del der die das les los las von van city town old new national state royal great saint '
  + 'museum muuseum museo musee muzeum gallery galerie art arts church kirik kirche iglesia chapel cathedral '
  + 'castle palace loss schloss house home hall park garden gardens square plats platz plaza market tower '
  + 'bridge monument memorial theatre theater centre center hotel restaurant cafe bar pub beach lake '
  + 'island hill mountain river street road apartment').split(' '));

function wordsOf(text: string): string[] {
  return fold(text).replace(/%20/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A name's own words, without the city it is in or words too short to tell. */
export function nameWords(name: string, city?: string): string[] {
  const cityWords = new Set(city ? wordsOf(city) : []);
  return wordsOf(name).filter((word) => word.length >= 3 && !cityWords.has(word));
}

/** The same word, or one a declension away: "Ericu" is Estonian for Eric's. */
function sameWord(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

/**
 * Whether `text` carries every word of one of the names, in any order, with
 * others between and allowing a declension -- "Adamson-Ericu Muuseum" is the
 * page "Adamson-Eric Museum". The city stays one of the words when the name
 * has it: "A. H. Tammsaare Museum in Tallinn" without it is also the Tammsaare
 * Museum in Vargamäe, and its photos were taken for Tallinn's. At least one
 * word must be distinctive, or "City Museum" would be every city's.
 */
export function coversName(text: string, names: string[]): boolean {
  const have = wordsOf(text);
  return names.some((name) => {
    const words = nameWords(name);
    if (words.length < 2 || !words.some((word) => !GENERIC_WORDS.has(word))) return false;
    return words.every((word) => have.some((candidate) => sameWord(candidate, word)));
  });
}

/** The words of an image's filename, which on these sites often name the subject. */
function filenameWords(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');
  } catch {
    return '';
  }
}

/**
 * Whether a photo found on a page is of this place.
 *
 * The page's lead image counts when the page's title names the place, and so
 * does any photo there whose own text names it. Elsewhere on the site, a photo
 * naming the place needs the city named too: "Raekoja plats" is the town hall
 * square of both Tallinn and Tartu, and Tallinn's Christmas market was taken
 * for Tartu's before this rule. A one-word name is never enough on its own.
 *
 * A title that has the name's words but not the name itself also needs the
 * page to mention the city, when `pageText` is given.
 */
export function isOfPlace(
  image: SiteImage,
  title: string,
  names: string[],
  city?: string,
  pageText?: string,
): boolean {
  const byWords = coversName(title, names) && (!city || pageText === undefined || mentions(pageText, [city]));
  const pageIsAbout = mentions(title, names) || byWords;
  if (image.lead && pageIsAbout) return true;
  const own = `${image.text} ${filenameWords(image.url)}`;
  if (!mentions(own, names) && !(pageIsAbout && coversName(own, names))) return false;
  if (pageIsAbout) return true;
  const specific = names.some((name) => name.trim().split(/\s+/).length > 1);
  if (!specific) return false;
  return !city || mentions(`${own} ${title}`, [city]);
}

/**
 * The full-size file behind a resized copy, where the site's software names
 * its copies in a known way, followed by the copy itself. Pages link copies
 * sized for the layout -- GoTürkiye's are 900x506 -- and the original is
 * often the ultra-HD photo the export wants.
 *
 *   WordPress:        photo-900x506.jpg -> photo.jpg
 *   Adobe Experience: photo.jpg/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg -> photo.jpg
 */
export function originalCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const out: string[] = [];
  const aem = /^(.*\.(?:jpe?g|png|webp|tiff?))\/(?:_jcr_content|jcr:content)\/renditions\/.+$/i.exec(parsed.pathname);
  if (aem) out.push(`${parsed.origin}${aem[1]}`);
  const wordpress = /^(.*)-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|webp))$/i.exec(parsed.pathname);
  if (wordpress) out.push(`${parsed.origin}${wordpress[1]}${wordpress[2]}`);
  out.push(url);
  return [...new Set(out)];
}

/** At most two probes in flight to any one image host. */
const hostSlots = new Map<string, <T>(task: () => Promise<T>) => Promise<T>>();
function slotFor(host: string): <T>(task: () => Promise<T>) => Promise<T> {
  let slot = hostSlots.get(host);
  if (!slot) {
    slot = createLimiter(() => 2);
    hostSlots.set(host, slot);
  }
  return slot;
}

const sizeCache = new Map<string, { width: number; height: number } | null>();
const SIZE_CACHE_MAX = 2000;
/** JPEG and PNG keep their dimensions in the first few hundred bytes. */
const HEAD_BYTES = 64 * 1024;

/**
 * An image's real dimensions, read from the start of the file, or from the
 * whole file when the start was not enough (WebP needs it). Nothing is kept
 * but the numbers; the export downloads the photo again when it is chosen.
 */
async function imageSize(url: string, referer?: string): Promise<{ width: number; height: number } | null> {
  if (sizeCache.has(url)) return sizeCache.get(url)!;

  const read = async (headBytes?: number) => {
    const { buffer } = await fetchPublicImage(url, { headBytes, referer });
    const meta = await sharp(buffer).metadata();
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
  };

  let size: { width: number; height: number } | null = null;
  try {
    size = await slotFor(new URL(url).hostname)(async () => {
      try {
        return await read(HEAD_BYTES);
      } catch {
        return await read();
      }
    });
  } catch {
    size = null;
  }

  if (sizeCache.size >= SIZE_CACHE_MAX) sizeCache.clear();
  sizeCache.set(url, size);
  return size;
}

export interface TourismImageOptions {
  /** The city or region searched, which a photo found off the place's own page must name. */
  city?: string;
  /** Stop starting new crawls after this moment, so one search stays bounded. */
  deadline?: number;
}

/**
 * Up to `limit` photographs of a place from its country's official tourism
 * site. `names` are the place's names, English first; at least one is needed.
 */
export async function tourismImagesForPlace(
  countryCode: string | undefined,
  names: string[],
  limit: number,
  options: TourismImageOptions = {},
): Promise<PlaceImage[]> {
  if (!config.crawl.tourismSources || !config.crawl.tourismImages || limit <= 0) return [];
  if (options.deadline && Date.now() > options.deadline) return [];
  const source = tourismSourceFor(countryCode);
  const terms = names.map((name) => name.trim()).filter((name) => name.length >= 4);
  if (!source || terms.length === 0) return [];

  // Pages are looked for under each name and under its own words without the
  // city ("Tammsaare Museum"); photos are still matched against the full names.
  const crawlTerms = [...new Set([
    ...terms,
    ...terms
      .map((name) => nameWords(name, options.city))
      .filter((words) => words.length >= 2 && words.some((word) => !GENERIC_WORDS.has(word)))
      .map((words) => words.join(' ')),
  ])];

  const matches = new Map<string, { image: SiteImage; pageUrl: string; title: string }>();
  await crawlForTerms(source.url, crawlTerms, {
    maxPages: config.crawl.tourismImagePages,
    budgetMs: config.crawl.tourismImageBudgetMs,
    timeoutMs: 15_000,
    onPage: (pageUrl, html) => {
      const title = pageTitle(html);
      const text = html
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      for (const image of imagesFrom(html, pageUrl)) {
        if (!matches.has(image.url) && isOfPlace(image, title, terms, options.city, text)) {
          matches.set(image.url, { image, pageUrl, title });
        }
      }
    },
  }).catch(() => undefined);

  // Lead images first, then the widest the pages admit to; only a few are
  // measured, since each costs a request to the site.
  const ranked = [...matches.values()]
    // A file the page itself declares too small is not worth a request.
    .filter(({ image }) => !image.declaredWidth || image.declaredWidth >= config.minImageWidth)
    .sort((a, b) => Number(b.image.lead) - Number(a.image.lead)
      || (b.image.declaredWidth ?? 0) - (a.image.declaredWidth ?? 0))
    .slice(0, Math.min(limit * 2, 8));

  const images: PlaceImage[] = [];
  const taken = new Set<string>();
  for (const { image, pageUrl, title } of ranked) {
    if (images.length >= limit) break;

    // The original if it can be had, else the copy the page shows.
    let chosen: string | undefined;
    let size: { width: number; height: number } | null = null;
    for (const candidate of originalCandidates(image.url)) {
      if (taken.has(candidate) || !(await isCrawlAllowed(candidate))) continue;
      size = await imageSize(candidate, pageUrl);
      if (size) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen || !size) continue;
    taken.add(chosen);

    images.push({
      url: image.url,
      downloadUrl: chosen,
      thumbUrl: image.url,
      width: size.width,
      height: size.height,
      source: 'tourism',
      title: cleanText(image.text || title, 160) || undefined,
      credit: cleanText(`© ${source.organisation}`, 300),
      license: TOURISM_IMAGE_LICENSE,
      sourcePage: pageUrl,
    });
  }
  return images;
}

/** Test seam -- forgets measured sizes and host slots. */
export function resetTourismImageCache(): void {
  sizeCache.clear();
  hostSlots.clear();
}
