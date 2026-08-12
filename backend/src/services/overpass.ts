import { config } from '../config.js';
import { fetchWithPolicy } from '../lib/http.js';
import { cleanText, isMostlyNonLatin } from '../lib/sanitize.js';
import { labelFromTags, type ResolvedKeyword } from '../lib/taxonomy.js';
import type { GeoArea, OsmType, RawPlace } from '../types.js';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
}

export class OverpassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassError';
  }
}

/**
 * Build an Overpass QL query. Uses an `area` when Nominatim gave us a relation
 * (accurate city outline) and falls back to the bounding box otherwise.
 *
 * `selectors` are produced by `resolveKeyword`, which whitelists user input —
 * nothing unescaped reaches this string.
 */
export function buildOverpassQuery(
  resolved: ResolvedKeyword,
  area: GeoArea,
  limit: number,
): string {
  const timeoutSeconds = Math.max(25, Math.round(config.overpassTimeoutMs / 1000) - 10);
  const useArea = typeof area.areaId === 'number';

  const scope = useArea ? '(area.searchArea)' : '';
  const statements = resolved.selectors
    .map((selector) => `  nwr${selector}${scope};`)
    .join('\n');

  const header = useArea
    ? `[out:json][timeout:${timeoutSeconds}];\narea(id:${area.areaId})->.searchArea;`
    : `[out:json][timeout:${timeoutSeconds}][bbox:${area.bbox[0]},${area.bbox[1]},${area.bbox[2]},${area.bbox[3]}];`;

  return `${header}\n(\n${statements}\n);\nout center tags ${limit};`;
}

async function runQuery(query: string): Promise<OverpassResponse> {
  const errors: string[] = [];

  for (const endpoint of config.overpassEndpoints) {
    try {
      const response = await fetchWithPolicy(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeoutMs: config.overpassTimeoutMs,
        retries: 1,
      });

      const payload = (await response.json()) as OverpassResponse;

      // Overpass reports query/runtime problems in `remark` with HTTP 200.
      if (payload.remark && /error|exceeded|timed out/i.test(payload.remark)) {
        errors.push(`${new URL(endpoint).host}: ${payload.remark}`);
        continue;
      }

      return payload;
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new OverpassError(
    `All Overpass endpoints failed. ${errors.join(' | ')}`,
  );
}

/**
 * Picks a display name. English wins whenever the local name is in a script
 * the export cannot carry (CJK, Arabic, Cyrillic…): those names become
 * unreadable folder names, the PDF core fonts cannot draw them, and the
 * write-up model has nothing to anchor on. The local name is always kept in
 * `name:local` so nothing is lost.
 */
function preferredName(tags: Record<string, string>): { name: string; nameEn?: string } {
  const local = cleanText(tags.name, 160);
  const english = cleanText(tags['name:en'], 160)
    || cleanText(tags['official_name:en'], 160);
  const international = cleanText(tags.int_name, 160);
  const operator = cleanText(tags.operator, 160);
  const brand = cleanText(tags.brand, 160);

  const latinAlternative = english || international;
  const name = isMostlyNonLatin(local) && latinAlternative
    ? latinAlternative
    : local || latinAlternative || operator || brand;

  return { name, nameEn: latinAlternative || undefined };
}

function coordsOf(element: OverpassElement): { lat: number; lon: number } | undefined {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center) return { lat: element.center.lat, lon: element.center.lon };
  return undefined;
}

/** Rough metres between two WGS84 points — good enough for dedupe radii. */
function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How richly described a place is. Drives both dedupe (keep the better record)
 * and the pre-LLM candidate ordering, so a place with a Wikipedia article beats
 * one that merely has many address tags.
 */
export function informationScore(place: RawPlace): number {
  const tags = place.tags;
  let score = Object.keys(tags).length;
  if (tags.wikidata) score += 8;
  if (tags.wikipedia) score += 6;
  if (tags.website || tags['contact:website']) score += 4;
  if (tags.phone || tags['contact:phone']) score += 4;
  if (tags.description) score += 3;
  if (tags['addr:street']) score += 2;
  if (place.osmType !== 'node') score += 1; // ways/relations are mapped in detail
  return score;
}

/**
 * Values that mark a place as one branch of something, where two entries
 * sharing a name really are two different places a user can visit.
 */
const CHAIN_VALUES = new Set([
  'cafe', 'restaurant', 'fast_food', 'bar', 'pub', 'ice_cream', 'bakery',
  'bank', 'atm', 'pharmacy', 'fuel', 'convenience', 'supermarket',
  'clothes', 'hairdresser', 'car_repair', 'hotel', 'motel', 'guest_house',
  'clinic', 'doctors', 'dentist', 'kindergarten', 'post_office', 'toilets',
  'parking', 'bus_station', 'bicycle_parking',
]);

/**
 * True when repeated names are expected — chains and utilities. Everything
 * else (a wall, a park, a temple, a museum) is treated as a single landmark
 * that OSM may simply have split into pieces.
 */
function isChainLike(place: RawPlace): boolean {
  const tags = place.tags;
  if (tags.brand || tags['brand:wikidata'] || tags.operator) return true;
  for (const key of ['shop', 'amenity', 'tourism', 'healthcare', 'office']) {
    const value = tags[key];
    if (value && CHAIN_VALUES.has(value)) return true;
  }
  return false;
}

/**
 * OSM holds one real-world place in several ways: as a node *and* a building
 * way, and — for anything long or large — as dozens of separate segments that
 * all carry the same name. A search of Baoding returned the Great Wall of
 * China twenty-five times for exactly that reason.
 *
 * So: entries sharing a name collapse into the richest single record. Distance
 * is only consulted for chain-like places (two branches of the same cafe are
 * genuinely two places); for landmarks, a shared name anywhere in the search
 * area means one destination. `segments` records how many pieces were folded
 * together so the export can say so.
 */
export function dedupePlaces(places: RawPlace[]): RawPlace[] {
  const byName = new Map<string, RawPlace[]>();

  for (const place of places) {
    // Normalising to letters/digits also folds "Great Wall (Jinshanling)"-style
    // punctuation variants onto the same key.
    const key = place.name.toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, '');
    const bucket = byName.get(key);
    if (bucket) bucket.push(place);
    else byName.set(key, [place]);
  }

  const output: RawPlace[] = [];
  for (const bucket of byName.values()) {
    const kept: RawPlace[] = [];
    const mergedInto = new Map<number, number>();

    for (const candidate of bucket) {
      const chain = isChainLike(candidate);
      const matchIndex = kept.findIndex((existing) => (
        chain || isChainLike(existing)
          ? distanceMeters(existing, candidate) < 250
          : true // same-named landmark: one place, however far the pieces sit
      ));

      if (matchIndex === -1) {
        kept.push(candidate);
        continue;
      }

      mergedInto.set(matchIndex, (mergedInto.get(matchIndex) ?? 1) + 1);
      const existing = kept[matchIndex]!;
      if (informationScore(candidate) > informationScore(existing)) {
        kept[matchIndex] = { ...candidate, tags: { ...existing.tags, ...candidate.tags } };
      } else {
        kept[matchIndex] = { ...existing, tags: { ...candidate.tags, ...existing.tags } };
      }
    }

    kept.forEach((place, index) => {
      const count = mergedInto.get(index);
      if (count && count > 1) place.tags['x:segments'] = String(count);
    });

    output.push(...kept);
  }

  return output;
}

export interface OverpassSearchResult {
  places: RawPlace[];
  rawCount: number;
  query: string;
}

export async function searchOverpass(
  resolved: ResolvedKeyword,
  area: GeoArea,
  limit: number,
): Promise<OverpassSearchResult> {
  // Over-fetch: most elements are unnamed and get dropped below, and same-named
  // segments then collapse, so the raw pull must be far larger than the target.
  // The 3000 ceiling is Overpass politeness, not a product decision.
  const fetchLimit = Math.min(3000, Math.max(limit * 6, 150));
  const query = buildOverpassQuery(resolved, area, fetchLimit);
  const payload = await runQuery(query);
  const elements = payload.elements ?? [];

  const places: RawPlace[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const coords = coordsOf(element);
    if (!coords) continue;

    const { name } = preferredName(tags);
    if (!name) continue; // anonymous geometry is useless to an end user

    const categoryLabel = labelFromTags(tags, resolved.label);

    // Keep the original script name when English has been promoted, so the
    // PDF and the write-up sources can still cite it.
    const localName = cleanText(tags.name, 160);
    const enrichedTags = localName && localName !== name
      ? { ...tags, 'name:local': localName }
      : tags;

    places.push({
      id: `${element.type}/${element.id}`,
      osmType: element.type as OsmType,
      osmId: element.id,
      name,
      lat: coords.lat,
      lon: coords.lon,
      tags: enrichedTags,
      category: resolved.categories[0]?.id ?? 'custom',
      categoryLabel,
      source: 'overpass',
    });
  }

  const deduped = dedupePlaces(places).sort(
    (a, b) => informationScore(b) - informationScore(a),
  );

  return { places: deduped, rawCount: elements.length, query };
}
