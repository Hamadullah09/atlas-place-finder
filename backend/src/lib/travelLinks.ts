/**
 * Deep links from a place into the major travel marketplaces.
 *
 * WHY LINKS AND NOT AN API INTEGRATION
 * ------------------------------------
 * None of these can act as a place-retrieval source for this app:
 *   - Viator          partner-approval + API certification required
 *   - GetYourGuide    partner access token required
 *   - Trip.com        affiliate/partner programme
 *   - TripAdvisor     Content API is self-serve, but its terms cap caching at
 *                     ONE HOUR and forbid pre-fetching your whole inventory —
 *                     incompatible with an offline PDF/ZIP export.
 *
 * Constructing a search URL is none of those things. It is not their content,
 * needs no key, breaks no terms, and gives the user a one-click route to
 * reviews and bookings for every result. Affiliate parameters can be layered on
 * later via TRAVEL_AFFILIATE_* without touching this shape.
 */

import { config } from '../config.js';

export interface TravelLink {
  id: string;
  label: string;
  url: string;
  /** What the user gets there — shown as a tooltip. */
  kind: 'reviews' | 'tours' | 'booking' | 'guide' | 'reference';
  /** True when the link is a general portal, not a search for this place. */
  generic?: boolean;
}

export interface TravelLinkInput {
  name: string;
  city: string;
  country: string;
  /** ISO alpha-2, used to gate country-specific providers. */
  countryCode?: string;
}

/** Marketplaces index by name, not coordinates, so the query is name + city. */
function searchTerm(input: TravelLinkInput): string {
  return [input.name, input.city].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function withAffiliate(url: string, providerId: string): string {
  const tag = config.travel.affiliateTags[providerId];
  if (!tag) return url;
  const parsed = new URL(url);
  // Each network names its parameter differently; the configured value is
  // "param=value" so operators can express whatever their programme needs.
  const [key, ...rest] = tag.split('=');
  if (key && rest.length > 0) parsed.searchParams.set(key, rest.join('='));
  return parsed.toString();
}

type Builder = (query: string, input: TravelLinkInput) => string;

interface Provider {
  id: string;
  label: string;
  kind: TravelLink['kind'];
  build: Builder;
  /**
   * ISO alpha-2 codes this provider covers. Omit for worldwide. A China-only
   * guide rendered against a Karachi result is pure noise, so regional
   * providers are hidden outside their coverage.
   */
  countries?: string[];
  /** Set when the site has no search endpoint and the link is a portal. */
  generic?: boolean;
}

const PROVIDERS: Provider[] = [
  {
    id: 'tripadvisor',
    label: 'Tripadvisor',
    kind: 'reviews',
    build: (query) => `https://www.tripadvisor.com/Search?q=${encodeURIComponent(query)}`,
  },
  {
    id: 'viator',
    label: 'Viator',
    kind: 'tours',
    build: (query) => `https://www.viator.com/searchResults/all?text=${encodeURIComponent(query)}`,
  },
  {
    id: 'getyourguide',
    label: 'GetYourGuide',
    kind: 'tours',
    build: (query) => `https://www.getyourguide.com/s/?q=${encodeURIComponent(query)}`,
  },
  {
    id: 'tripcom',
    label: 'Trip.com',
    kind: 'booking',
    // `my.trip.com` is simply Trip.com's Malaysia storefront — the site uses
    // country-code subdomains (us./uk./sg./my.). One provider, configurable
    // domain, rather than a duplicate entry per region.
    // /things-to-do/list is the live search path (verified 200);
    // /things-to-do/search 404s and /search/ returns 502.
    build: (query) =>
      `https://${config.travel.tripcomDomain}/things-to-do/list?keyword=${encodeURIComponent(query)}`,
  },
  {
    id: 'chinahighlights',
    label: 'China Highlights',
    kind: 'guide',
    countries: ['CN', 'HK', 'MO'],
    // The site's own search box posts to a Google Custom Search endpoint at
    // /search-result/ (verified 200); the `cx` parameter is optional there.
    build: (query) =>
      `https://www.chinahighlights.com/search-result/?q=${encodeURIComponent(query)}`,
  },
  {
    id: 'travelchina',
    label: 'Travel China',
    kind: 'reference',
    countries: ['CN', 'HK', 'MO'],
    // travelchina.org.cn is the official overseas promotion portal and is a
    // static CMS — it exposes no search form or query parameter at all, so this
    // can only ever be a link to the portal, not a per-place lookup.
    generic: true,
    build: () => 'https://www.travelchina.org.cn/en/',
  },
];

export function buildTravelLinks(input: TravelLinkInput): TravelLink[] {
  const query = searchTerm(input);
  if (!query) return [];

  const enabled = new Set(config.travel.providers);
  const countryCode = input.countryCode?.toUpperCase();

  return PROVIDERS.filter((provider) => {
    if (!enabled.has(provider.id)) return false;
    if (!provider.countries) return true;
    // Without a resolved country code, keep worldwide providers only.
    return Boolean(countryCode) && provider.countries.includes(countryCode!);
  }).map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    url: withAffiliate(provider.build(query, input), provider.id),
    ...(provider.generic ? { generic: true } : {}),
  }));
}

/** Provider ids this build knows about — surfaced by GET /api/categories. */
export function knownTravelProviders(): Array<{ id: string; label: string }> {
  return PROVIDERS.map(({ id, label }) => ({ id, label }));
}
