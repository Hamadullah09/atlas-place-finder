import { config } from '../config.js';
import { tourismSourceFor, type TourismSource } from '../data/tourismSources.js';
import { cancelSignal } from '../lib/cancel.js';
import { createLimiter } from '../lib/concurrency.js';
import { fetchWithPolicy } from '../lib/http.js';
import { crawlDelayFor, isCrawlAllowed, sitemapsFor } from '../lib/robots.js';
import { htmlToDoc, type ExtraSourceDoc } from './extraSources.js';

/**
 * A small, targeted crawl of one tourism site.
 *
 * Not a spider: it reads the entry page, then follows only links whose anchor
 * text or path names the place being searched, at most one hop, up to a page
 * budget. A site's homepage rarely mentions a particular town, so fetching
 * just that page produced nothing usable -- and following everything would
 * cost hundreds of requests to find the same two pages.
 *
 * The pages read here are reduced to text for the write-ups and, through
 * `onPage`, searched for photographs by services/tourismImages.ts.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files that are plainly not pages worth reducing to text. */
const NON_PAGE = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|rar|gz|mp4|mp3|wav|avi|mov|docx?|xlsx?|pptx?|css|js|json|xml|rss)$/i;

/** Path words that tend to lead to destination write-ups rather than admin pages. */
const PROMISING = /\b(destination|place|city|cities|region|province|attraction|sight|see|do|explore|discover|visit|travel|guide|itinerar|experience|area|town)\b/i;

/** Paths that are never a write-up, however well they match. */
const UNWANTED = /\b(login|signin|register|account|cart|checkout|privacy|cookie|terms|legal|sitemap|search|rss|feed|news|press|release|tender|procurement|vacanc|career|contact|gallery)\b/i;

/**
 * Sitemaps are cheap but can be enormous. They are read once per site per
 * half hour and kept only as lists of addresses, so a search can afford to
 * read several; the children worth reading are chosen first (see rankSitemaps).
 */
const MAX_SITEMAP_FETCHES = 8;
const MAX_SITEMAP_CHARS = 4_000_000;
const MAX_LOCS_PER_SITEMAP = 50_000;

export interface CrawlOptions {
  /** Total pages fetched, entry page included. */
  maxPages?: number;
  /** Wall-clock ceiling for the whole crawl. */
  budgetMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Called with every page read, entry page included, for the photo lookup. */
  onPage?: (url: string, html: string) => void;
}

/**
 * Pages already read, shared by the text crawl and the photo lookup. A search
 * asks the same site about dozens of places, and every one of those crawls
 * starts from the same entry page and sitemap; without this each place re-read
 * them. Failures are remembered too, for less time, so a dead site costs one
 * timeout per search rather than one per place.
 */
interface CachedPage {
  at: number;
  html?: string;
  error?: unknown;
}

const pageCache = new Map<string, CachedPage>();
/** Pages run to a megabyte on some of these sites; this bounds the cache's memory. */
const PAGE_CACHE_MAX = 80;
const PAGE_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const MAX_PAGE_CHARS = 1_500_000;

/**
 * At most two requests in flight to any one site. The photo lookup runs a
 * dozen places at once, and a government web server is not a CDN.
 */
const SITE_CONCURRENCY = 2;
const siteSlots = new Map<string, <T>(task: () => Promise<T>) => Promise<T>>();

function slotFor(host: string): <T>(task: () => Promise<T>) => Promise<T> {
  let slot = siteSlots.get(host);
  if (!slot) {
    slot = createLimiter(() => SITE_CONCURRENCY);
    siteSlots.set(host, slot);
  }
  return slot;
}

/** One page's HTML (or XML), from the cache when it was read recently. */
async function fetchPage(url: string, timeoutMs: number, retries: number): Promise<string> {
  const cached = pageCache.get(url);
  if (cached) {
    const ttl = cached.error === undefined ? PAGE_TTL_MS : FAILURE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.error !== undefined) throw cached.error;
      return cached.html ?? '';
    }
    pageCache.delete(url);
  }

  try {
    const html = await fetchText(url, timeoutMs, retries, MAX_PAGE_CHARS);
    remember(url, { at: Date.now(), html });
    return html;
  } catch (error) {
    remember(url, { at: Date.now(), error });
    throw error;
  }
}

/**
 * Reads at most `maxChars` of a response and lets the rest go. Japan's
 * sitemap is large enough that reading it whole ran past the timeout, and
 * the first few megabytes carry as many addresses as a search needs.
 */
async function fetchText(url: string, timeoutMs: number, retries: number, maxChars: number): Promise<string> {
  return slotFor(new URL(url).hostname)(async () => {
    const response = await fetchWithPolicy(url, { timeoutMs, retries });
    if (!response.body) return (await response.text()).slice(0, maxChars);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    try {
      while (out.length < maxChars) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return out.slice(0, maxChars);
  });
}

function remember(url: string, entry: CachedPage): void {
  if (pageCache.size >= PAGE_CACHE_MAX) {
    // Oldest first: Map keeps insertion order.
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(url, entry);
}

interface Candidate {
  url: string;
  anchor: string;
  score: number;
}

/**
 * Why a fetch failed, in terms an operator can act on. Node reports a bare
 * "fetch failed" and hides the reason in `cause`; the common one here is a
 * site serving an incomplete certificate chain, which a browser papers over by
 * fetching the missing intermediate and Node does not.
 */
function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  if (cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'the site sends an incomplete HTTPS certificate chain';
  }
  if (cause?.code) return cause.code;
  return error instanceof Error ? error.message : String(error);
}

/** Lowercased and stripped of accents, so "Košice" matches "kosice". */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function linksFrom(html: string, base: URL): Array<{ url: string; anchor: string }> {
  const out: Array<{ url: string; anchor: string }> = [];
  const seen = new Set<string>();
  const anchorTag = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorTag.exec(html)) !== null) {
    if (out.length >= 400) break;

    let resolved: URL;
    try {
      resolved = new URL(match[1]!, base);
    } catch {
      continue;
    }

    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') continue;
    // Staying on the entry host keeps a crawl from wandering onto partner
    // sites, ad networks and social media.
    if (resolved.hostname !== base.hostname) continue;
    if (NON_PAGE.test(resolved.pathname)) continue;

    resolved.hash = '';
    const url = resolved.toString();
    if (url.length > 400 || seen.has(url)) continue;
    seen.add(url);

    const anchor = match[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ url, anchor });
  }

  return out;
}

/** Words too common to identify a place by. */
const STOP_WORDS = new Set(['the', 'and', 'des', 'del', 'der', 'die', 'das', 'les', 'los', 'las', 'von', 'van']);

/**
 * How likely a link is to be about one of these terms. Zero means "do not
 * follow" -- a link has to name the place somewhere to be worth a request.
 */
export function scoreLink(link: { url: string; anchor: string }, terms: string[]): number {
  const anchor = fold(link.anchor);
  let path: string;
  try {
    path = fold(decodeURIComponent(new URL(link.url).pathname));
  } catch {
    path = fold(new URL(link.url).pathname);
  }

  if (UNWANTED.test(path)) return 0;

  let score = 0;
  const pathWords = new Set(path.split(/[^\p{L}\p{N}]+/u));
  const anchorWords = new Set(anchor.split(/[^\p{L}\p{N}]+/u));
  for (const term of terms) {
    const needle = fold(term);
    if (needle.length < 3) continue;
    const inAnchor = anchor.includes(needle);
    const inPath = path.includes(needle.replace(/\s+/g, '-')) || path.includes(needle);
    if (inAnchor) score += 100;
    if (inPath) score += 60;
    if (inAnchor || inPath) continue;

    // Every word of a longer name, in any order and with others between:
    // "Wawel Castle" is filed as /wawel-royal-castle.
    const words = needle.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
    if (words.length >= 2) {
      if (words.every((word) => anchorWords.has(word))) score += 50;
      else if (words.every((word) => pathWords.has(word))) score += 40;
    }
  }

  if (score > 0 && PROMISING.test(path)) score += 15;
  // A short path is usually a section landing page; a deep one a specific entry.
  if (score > 0) score += Math.min(path.split('/').filter(Boolean).length, 4);
  return score;
}

/** One sitemap, reduced to the addresses it lists. */
interface SitemapListing {
  /** A sitemap index lists further sitemaps rather than pages. */
  index: boolean;
  locs: string[];
}

const sitemapCache = new Map<string, { at: number; listing: SitemapListing | null }>();
const SITEMAP_CACHE_MAX = 60;

async function readSitemap(url: string, timeoutMs: number): Promise<SitemapListing | null> {
  const cached = sitemapCache.get(url);
  if (cached && Date.now() - cached.at < (cached.listing ? PAGE_TTL_MS : FAILURE_TTL_MS)) return cached.listing;

  let listing: SitemapListing | null = null;
  try {
    const xml = await fetchText(url, timeoutMs, 0, MAX_SITEMAP_CHARS);
    const locs: string[] = [];
    for (const match of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)) {
      locs.push(match[1]!.replace(/&amp;/g, '&'));
      if (locs.length >= MAX_LOCS_PER_SITEMAP) break;
    }
    listing = { index: /<sitemapindex/i.test(xml), locs };
  } catch {
    listing = null;
  }

  if (sitemapCache.size >= SITEMAP_CACHE_MAX) sitemapCache.clear();
  sitemapCache.set(url, { at: Date.now(), listing });
  return listing;
}

/** ISO 639-1 codes as sites put them in sitemap names: sitemap-de.xml, sitemap_cs_1.xml, /ja/. */
const LANGUAGE_CODES = new Set(('ar bg bn bs ca cs da de el en es et eu fa fi fr ga gl he hi hr hu hy id is it ja ka kk km ko lo '
  + 'lt lv mk mn ms mt my ne nl no pl pt ro ru si sk sl sq sr sv sw ta te th tl tr uk ur uz vi zh').split(' '));

const GOOD_SITEMAP = /(place|attraction|destination|entry|entries|poi|page|article|sight|thing|todo|explore|region|city|cities|location|venue|museum|nature|culture)/;
const POOR_SITEMAP = /(post|category|categories|tag|author|event|news|press|blog|offer|deal|job|product|video|image|media|user|faq)/;

/**
 * Child sitemaps in the order worth reading: the entry page's language (or
 * English) first, other languages last; place-like collections before blog
 * posts and tag lists. Turkey's index lists Arabic and German before English,
 * and the old code read the first three it saw.
 */
export function rankSitemaps(urls: string[], language: string | undefined): string[] {
  const wanted = (language ?? 'en').toLowerCase().split(/[-_]/)[0]!;
  const score = (url: string): number => {
    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      return -100;
    }
    const tokens = path.split(/[/_.-]+/).filter(Boolean);
    const languages = tokens.filter((token) => LANGUAGE_CODES.has(token));
    let value = 0;
    if (languages.includes(wanted)) value += 10;
    else if (languages.length > 0) value -= 10;
    if (GOOD_SITEMAP.test(path)) value += 3;
    if (POOR_SITEMAP.test(path)) value -= 2;
    return value;
  };
  return [...new Set(urls)]
    .map((url, order) => ({ url, order, value: score(url) }))
    .sort((a, b) => b.value - a.value || a.order - b.order)
    .map((entry) => entry.url);
}

/** Same site, give or take a www. */
function sameSite(url: string, base: URL): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

/**
 * Pages a site advertises in its sitemap whose address names one of the terms.
 *
 * Many tourism sites build their menus in JavaScript, so the entry page's HTML
 * links to nothing useful. A sitemap is the route those sites publish for
 * exactly this purpose. Only this site's own sitemaps are read -- Visit Sweden
 * lists visitsweden.de's too -- and /sitemap.xml is tried when robots.txt
 * names none.
 */
async function sitemapCandidates(base: URL, terms: string[], timeoutMs: number): Promise<Candidate[]> {
  const language = languageOf(base.pathname);
  const advertised = (await sitemapsFor(base.toString())).filter((url) => sameSite(url, base));
  let queue = rankSitemaps(advertised.length > 0 ? advertised : [`${base.origin}/sitemap.xml`], language);

  const out: Candidate[] = [];
  const seenPages = new Set<string>();
  const seen = new Set<string>();
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_SITEMAP_FETCHES) {
    const url = queue.shift()!;
    if (seen.has(url) || !(await isCrawlAllowed(url))) continue;
    seen.add(url);
    fetches += 1;

    const listing = await readSitemap(url, timeoutMs);
    if (!listing) continue;

    if (listing.index) {
      const children = listing.locs.filter((loc) => sameSite(loc, base) && !seen.has(loc));
      queue = rankSitemaps([...queue, ...children], language);
      continue;
    }

    for (const loc of listing.locs) {
      let resolved: URL;
      try {
        resolved = new URL(loc);
      } catch {
        continue;
      }
      if (!sameSite(resolved.href, base) || NON_PAGE.test(resolved.pathname)) continue;
      const pageUrl = resolved.toString();
      if (seenPages.has(pageUrl)) continue;
      seenPages.add(pageUrl);

      const candidate = { url: pageUrl, anchor: '' };
      const score = scoreLink(candidate, terms);
      if (score > 0) out.push({ ...candidate, score });
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

/** The language segment a path starts with, such as "en" in /en/where-to-go. */
function languageOf(pathname: string): string | undefined {
  return /^\/([a-z]{2}(?:[-_][a-z]{2})?)(?:\/|$)/i.exec(pathname)?.[1]?.toLowerCase();
}

/**
 * Pages in the entry page's language first, and pages in another one dropped.
 * A sitemap lists every translation: France's offered the Arabic article on
 * Mont-Saint-Michel ahead of the English one, and nothing on it could be
 * matched to the English name the search used.
 */
export function preferLanguageOf<T extends { url: string; score: number }>(base: URL, candidates: T[]): T[] {
  const wanted = languageOf(base.pathname);
  if (!wanted) return candidates;
  const same = candidates.filter((c) => languageOf(new URL(c.url).pathname) === wanted);
  const neutral = candidates.filter((c) => languageOf(new URL(c.url).pathname) === undefined);
  return [...same, ...neutral];
}

/**
 * Reads `startUrl` and up to `maxPages - 1` pages it links to that mention one
 * of `terms`. Pages robots.txt disallows are skipped, not fetched.
 */
export async function crawlForTerms(
  startUrl: string,
  terms: string[],
  options: CrawlOptions = {},
): Promise<{ docs: ExtraSourceDoc[]; warnings: string[] }> {
  const maxPages = Math.max(1, options.maxPages ?? config.crawl.maxPagesPerSite);
  const budgetMs = options.budgetMs ?? config.crawl.budgetMs;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + budgetMs;

  const docs: ExtraSourceDoc[] = [];
  const warnings: string[] = [];
  const cancel = cancelSignal();

  let base: URL;
  try {
    base = new URL(startUrl);
  } catch {
    return { docs, warnings: [`${startUrl} is not a usable address.`] };
  }

  if (!(await isCrawlAllowed(startUrl))) {
    return { docs, warnings: [`${base.hostname} asks crawlers not to read that page (robots.txt).`] };
  }

  const politeDelay = await crawlDelayFor(startUrl);

  let entryHtml = '';
  try {
    entryHtml = await fetchPage(startUrl, timeoutMs, 1);
    options.onPage?.(startUrl, entryHtml);
    const doc = htmlToDoc(entryHtml, startUrl);
    if (doc) docs.push(doc);
  } catch (error) {
    return { docs, warnings: [`${base.hostname} could not be read: ${describeFetchError(error)}.`] };
  }

  if (maxPages <= 1 || !entryHtml) return { docs, warnings };

  let candidates: Candidate[] = linksFrom(entryHtml, base)
    .map((link) => ({ ...link, score: scoreLink(link, terms) }))
    .filter((link) => link.score > 0 && link.url !== startUrl)
    .sort((a, b) => b.score - a.score);

  // The sitemap fills in what the entry page does not link to. It is read once
  // per site per half hour, so asking it for every place costs nothing more.
  if (candidates.length < maxPages - 1) {
    const linked = new Set(candidates.map((c) => c.url));
    const listed = (await sitemapCandidates(base, terms, timeoutMs))
      .filter((c) => c.url !== startUrl && !linked.has(c.url));
    candidates = [...candidates, ...listed];
  }
  candidates = preferLanguageOf(base, candidates);

  if (candidates.length === 0) {
    warnings.push(
      `${base.hostname} offers no page about ${terms[0] ?? 'that place'} in its entry page or sitemap.`,
    );
    return { docs, warnings };
  }

  for (const candidate of candidates) {
    if (docs.length >= maxPages) break;
    if (Date.now() > deadline) {
      warnings.push(`Stopped reading ${base.hostname} after ${Math.round(budgetMs / 1000)}s.`);
      break;
    }
    cancel?.throwIfAborted();

    if (!(await isCrawlAllowed(candidate.url))) continue;
    // A page already in the cache costs the site nothing, so it waits for nothing.
    if (politeDelay > 0 && !pageCache.has(candidate.url)) await sleep(politeDelay);

    try {
      const html = await fetchPage(candidate.url, timeoutMs, 0);
      options.onPage?.(candidate.url, html);
      const doc = htmlToDoc(html, candidate.url);
      if (doc) docs.push(doc);
    } catch {
      // One dead link should not end the crawl; the entry page still counts.
    }
  }

  return { docs, warnings };
}

export interface TourismCrawlResult {
  /** The catalogue entry used, absent when the country has none. */
  source?: TourismSource;
  docs: ExtraSourceDoc[];
  warnings: string[];
}

/**
 * A batch sheet lists many cities per country, and province rows overlap the
 * city rows below them, so the same site would otherwise be re-read for every
 * row. One crawl per country-and-region is enough.
 */
const crawled = new Map<string, TourismCrawlResult>();
const CRAWL_CACHE_MAX = 200;

/** Reads the official tourism site of `countryCode` for pages about `region`. */
export async function crawlTourismSource(
  countryCode: string | undefined,
  region: string,
  options: CrawlOptions = {},
): Promise<TourismCrawlResult> {
  const source = tourismSourceFor(countryCode);
  if (!source) return { docs: [], warnings: [] };

  const key = `${countryCode?.toUpperCase()}|${region.trim().toLowerCase()}`;
  const cached = crawled.get(key);
  if (cached) return cached;

  const { docs, warnings } = await crawlForTerms(source.url, [region], options);
  const result: TourismCrawlResult = { source, docs, warnings };

  if (crawled.size >= CRAWL_CACHE_MAX) crawled.clear();
  crawled.set(key, result);
  return result;
}

/** Test seam — forgets which sites have already been read. */
export function resetTourismCrawlCache(): void {
  crawled.clear();
  pageCache.clear();
  sitemapCache.clear();
  siteSlots.clear();
}
