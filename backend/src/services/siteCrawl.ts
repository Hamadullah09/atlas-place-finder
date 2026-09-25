import { config } from '../config.js';
import { tourismSourceFor, type TourismSource } from '../data/tourismSources.js';
import { cancelSignal } from '../lib/cancel.js';
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
 * Text only. These sites are government-run and their photographs are all
 * rights reserved, so nothing here touches images; the picture pipeline stays
 * on Commons, Openverse and the other openly licensed sources.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files that are plainly not pages worth reducing to text. */
const NON_PAGE = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|rar|gz|mp4|mp3|wav|avi|mov|docx?|xlsx?|pptx?|css|js|json|xml|rss)$/i;

/** Path words that tend to lead to destination write-ups rather than admin pages. */
const PROMISING = /\b(destination|place|city|cities|region|province|attraction|sight|see|do|explore|discover|visit|travel|guide|itinerar|experience|area|town)\b/i;

/** Paths that are never a write-up, however well they match. */
const UNWANTED = /\b(login|signin|register|account|cart|checkout|privacy|cookie|terms|legal|sitemap|search|rss|feed|news|press|release|tender|procurement|vacanc|career|contact|gallery)\b/i;

/** Sitemaps are cheap but can be enormous; two hops and a few MB is plenty. */
const MAX_SITEMAP_FETCHES = 3;
const MAX_SITEMAP_CHARS = 2_000_000;

export interface CrawlOptions {
  /** Total pages fetched, entry page included. */
  maxPages?: number;
  /** Wall-clock ceiling for the whole crawl. */
  budgetMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
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
  for (const term of terms) {
    const needle = fold(term);
    if (needle.length < 3) continue;
    if (anchor.includes(needle)) score += 100;
    if (path.includes(needle.replace(/\s+/g, '-')) || path.includes(needle)) score += 60;
  }

  if (score > 0 && PROMISING.test(path)) score += 15;
  // A short path is usually a section landing page; a deep one a specific entry.
  if (score > 0) score += Math.min(path.split('/').filter(Boolean).length, 4);
  return score;
}

/**
 * Pages a site advertises in its sitemap whose address names one of the terms.
 *
 * Many tourism sites build their menus in JavaScript, so the entry page's HTML
 * links to nothing useful. A sitemap is the route those sites publish for
 * exactly this purpose and costs one request to read.
 */
async function sitemapCandidates(base: URL, terms: string[], timeoutMs: number): Promise<Candidate[]> {
  const queue = (await sitemapsFor(base.toString())).slice(0, 2);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_SITEMAP_FETCHES) {
    const url = queue.shift()!;
    if (seen.has(url) || !(await isCrawlAllowed(url))) continue;
    seen.add(url);
    fetches += 1;

    let xml: string;
    try {
      const response = await fetchWithPolicy(url, { timeoutMs, retries: 0 });
      xml = (await response.text()).slice(0, MAX_SITEMAP_CHARS);
    } catch {
      continue;
    }

    // A sitemap index lists more sitemaps rather than pages.
    const isIndex = /<sitemapindex/i.test(xml);
    for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = match[1]!;
      if (isIndex) {
        if (queue.length < MAX_SITEMAP_FETCHES) queue.push(loc);
        continue;
      }

      let resolved: URL;
      try {
        resolved = new URL(loc);
      } catch {
        continue;
      }
      if (resolved.hostname !== base.hostname || NON_PAGE.test(resolved.pathname)) continue;

      const candidate = { url: resolved.toString(), anchor: '' };
      const score = scoreLink(candidate, terms);
      if (score > 0) out.push({ ...candidate, score });
    }
  }

  return out.sort((a, b) => b.score - a.score);
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
    const response = await fetchWithPolicy(startUrl, { timeoutMs, retries: 1 });
    entryHtml = await response.text();
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

  if (candidates.length === 0) {
    candidates = (await sitemapCandidates(base, terms, timeoutMs)).filter((c) => c.url !== startUrl);
  }

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
    if (politeDelay > 0) await sleep(politeDelay);

    try {
      const response = await fetchWithPolicy(candidate.url, { timeoutMs, retries: 0 });
      const doc = htmlToDoc(await response.text(), candidate.url);
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
}
