import { config } from '../config.js';
import { fetchWithPolicy, HttpError } from './http.js';

/**
 * robots.txt, consulted before any page of a third-party site is fetched.
 *
 * Reading one page a user pasted in is one thing; walking a site is another,
 * and a crawler that ignores robots.txt gets blocked and deserves to be. Rules
 * are cached per origin so a crawl costs one extra request per host, not one
 * per page.
 *
 * Follows RFC 9309: the group whose User-agent names us wins over the `*`
 * group, the longest matching path wins within a group, and Allow beats
 * Disallow on an equal-length tie.
 */

interface Rule {
  allow: boolean;
  /** Original pattern, whose length decides which rule is more specific. */
  pattern: string;
  matcher: RegExp;
}

interface Robots {
  rules: Rule[];
  crawlDelayMs: number;
  /** Sitemap URLs the file advertises. Site-wide, not tied to a group. */
  sitemaps: string[];
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelayMs?: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A site that asks for longer than this is telling us not to bother. */
const MAX_CRAWL_DELAY_MS = 30_000;

const ALLOW_EVERYTHING: Robots = { rules: [], crawlDelayMs: 0, sitemaps: [] };
const ALLOW_NOTHING: Robots = {
  rules: [{ allow: false, pattern: '/', matcher: /^\// }],
  crawlDelayMs: 0,
  sitemaps: [],
};

const cache = new Map<string, { at: number; robots: Robots }>();
const inFlight = new Map<string, Promise<Robots>>();

/** The product token a robots.txt would name us by, e.g. "sma-place-finder". */
function agentToken(): string {
  return (config.userAgent.split(/[\s/]/)[0] ?? '').toLowerCase();
}

/**
 * A robots path pattern as a regex. `*` matches any run of characters and a
 * trailing `$` anchors the end; everything else is literal.
 */
function toMatcher(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  // Consecutive User-agent lines share one group; the first directive after
  // them closes the header, so a later User-agent starts a new group.
  let inHeader = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !inHeader) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inHeader = true;
      continue;
    }

    if (!current) continue; // A directive before any User-agent binds to nothing.
    inHeader = false;

    if (field === 'disallow') {
      // "Disallow:" with no value is the documented way to allow everything,
      // so it must not become a rule that matches every path.
      if (value) current.rules.push({ allow: false, pattern: value, matcher: toMatcher(value) });
    } else if (field === 'allow') {
      if (value) current.rules.push({ allow: true, pattern: value, matcher: toMatcher(value) });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        current.crawlDelayMs = Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS);
      }
    }
  }

  return groups;
}

/** Sitemap lines, which belong to the file rather than to any one group. */
function sitemapsIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^sitemap\s*:\s*(\S+)$/i.exec(line);
    if (match && out.length < 10) out.push(match[1]!);
  }
  return out;
}

function selectGroup(groups: Group[], token: string): Robots {
  const named = groups.find((group) =>
    group.agents.some((agent) => agent !== '*' && token.startsWith(agent)),
  );
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const chosen = named ?? wildcard;
  if (!chosen) return { ...ALLOW_EVERYTHING };
  return { rules: chosen.rules, crawlDelayMs: chosen.crawlDelayMs ?? 0, sitemaps: [] };
}

export function parseRobots(text: string, token = agentToken()): Robots {
  return { ...selectGroup(parseGroups(text), token), sitemaps: sitemapsIn(text) };
}

/** Whether these rules permit a path. Longest match wins; Allow breaks ties. */
export function robotsAllows(robots: Robots, path: string): boolean {
  let best: Rule | undefined;
  for (const rule of robots.rules) {
    if (!rule.matcher.test(path)) continue;
    if (
      !best
      || rule.pattern.length > best.pattern.length
      || (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

async function loadRobots(origin: string): Promise<Robots> {
  try {
    const response = await fetchWithPolicy(`${origin}/robots.txt`, {
      timeoutMs: 10_000,
      retries: 0,
    });
    const text = (await response.text()).slice(0, 500_000);
    return parseRobots(text);
  } catch (error) {
    // 4xx means there are no rules to follow. 5xx means the site is unwell and
    // RFC 9309 says to stay off it. Anything else (DNS, timeout) will stop the
    // page fetch on its own, so it need not also ban the host.
    if (error instanceof HttpError) {
      return error.status >= 500 ? ALLOW_NOTHING : ALLOW_EVERYTHING;
    }
    return ALLOW_EVERYTHING;
  }
}

async function robotsFor(url: URL): Promise<Robots> {
  const origin = url.origin;
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.robots;

  const pending = inFlight.get(origin);
  if (pending) return pending;

  const request = loadRobots(origin)
    .then((robots) => {
      cache.set(origin, { at: Date.now(), robots });
      return robots;
    })
    .finally(() => inFlight.delete(origin));

  inFlight.set(origin, request);
  return request;
}

/** True when this site's robots.txt permits us to fetch this URL. */
export async function isCrawlAllowed(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const robots = await robotsFor(parsed);
  return robotsAllows(robots, `${parsed.pathname}${parsed.search}`);
}

/** The Crawl-delay this site asks for, in milliseconds (0 when it asks none). */
export async function crawlDelayFor(url: string): Promise<number> {
  try {
    return (await robotsFor(new URL(url))).crawlDelayMs;
  } catch {
    return 0;
  }
}

/** Sitemaps this site advertises in robots.txt, if any. */
export async function sitemapsFor(url: string): Promise<string[]> {
  try {
    return (await robotsFor(new URL(url))).sitemaps;
  } catch {
    return [];
  }
}

/** Test seam — drops cached rules so a test can change a site's robots.txt. */
export function resetRobotsCache(): void {
  cache.clear();
  inFlight.clear();
}
