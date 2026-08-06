import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { isMostlyNonLatin } from '../lib/sanitize.js';
import { resolveKeyword } from '../lib/taxonomy.js';
import { buildTravelLinks } from '../lib/travelLinks.js';
import { cacheKeyFor, getStore } from './cache.js';
import { discoverViaNominatim, discoverViaWikidata } from './discovery.js';
import { geocodeCity } from './geocode.js';
import { runGoogleSearch } from './googleSearch.js';
import { fetchImagesForPlaces, isCommonsUnreachable } from './images.js';
import { enrichPlaces } from './llm.js';
import { dedupePlaces, informationScore, searchOverpass } from './overpass.js';
import { applyEnglishNames } from './translate.js';
import type { Place, PlaceImage, RawPlace, SearchQuery, SearchResult } from '../types.js';

function wikipediaUrl(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const match = /^([a-z-]{2,12}):(.+)$/i.exec(tag.trim());
  const lang = match ? match[1]!.toLowerCase() : 'en';
  const title = match ? match[2]! : tag.trim();
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function wikidataUrl(tag: string | undefined): string | undefined {
  if (!tag || !/^Q\d+$/.test(tag.trim())) return undefined;
  return `https://www.wikidata.org/wiki/${tag.trim()}`;
}

export function googleMapsUrl(place: Pick<RawPlace, 'name' | 'lat' | 'lon'>): string {
  const query = encodeURIComponent(`${place.name} ${place.lat},${place.lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

export interface RunSearchOptions {
  /** Bypass the cache and re-query the upstream APIs. */
  refresh?: boolean;
}

/**
 * Full pipeline: geocode -> Overpass -> LLM filter/clean -> imagery.
 *
 * Filtering runs *before* image lookup so we never spend requests on entries
 * that are about to be discarded.
 */
export async function runSearch(query: SearchQuery, options: RunSearchOptions = {}): Promise<SearchResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const keyword = query.keyword.trim();
  const city = query.city.trim();
  const country = query.country.trim();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), config.maxResults);
  const useLlm = query.useLlm !== false;
  const includeImages = query.includeImages !== false;
  const source: 'osm' | 'google' = query.source === 'google' ? 'google' : 'osm';

  const store = await getStore();
  const cacheKey = cacheKeyFor(keyword, city, country, limit, useLlm, source);

  if (!options.refresh) {
    const cached = await store.get(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  // The Google engine is a self-contained pipeline; only caching is shared.
  if (source === 'google') {
    const result = await runGoogleSearch({ keyword, city, country, limit, includeImages });
    await store.save(cacheKey, result).catch((error: unknown) => {
      console.warn('[search] failed to cache result:', error instanceof Error ? error.message : error);
    });
    return result;
  }

  const resolved = resolveKeyword(keyword);
  if (resolved.generic) {
    warnings.push(
      `"${keyword}" is not a known category, so OpenStreetMap tags and names were matched directly. `
        + 'Results may be broader than expected.',
    );
  }

  const area = await geocodeCity(city, country);

  // Overpass is the primary source; Wikidata and Nominatim run alongside it to
  // catch landmarks that are notable but thinly mapped in OSM.
  const [overpassResult, wikidataPlaces, nominatimPlaces] = await Promise.all([
    searchOverpass(resolved, area, limit),
    discoverViaWikidata(resolved, area, limit).catch(() => [] as RawPlace[]),
    discoverViaNominatim(keyword, area, limit).catch(() => [] as RawPlace[]),
  ]);

  const { places: overpassPlaces, rawCount } = overpassResult;

  // dedupePlaces merges by name + 250 m proximity, so a place present in both
  // OSM and Wikidata collapses into one richer record. Rank by informationScore
  // (not raw tag count) so a place with a Wikipedia article outranks one that
  // merely carries a lot of address tags.
  const rawPlaces = dedupePlaces([...overpassPlaces, ...wikidataPlaces, ...nominatimPlaces]).sort(
    (a, b) => informationScore(b) - informationScore(a),
  );

  const extraFound = rawPlaces.length - overpassPlaces.length;
  if (extraFound > 0) {
    warnings.push(
      `${extraFound} additional place(s) came from Wikidata/Nominatim rather than OpenStreetMap.`,
    );
  }

  if (rawPlaces.length === 0) {
    warnings.push(`No named "${keyword}" entries exist in OpenStreetMap for ${area.city}.`);
  }

  // Send more candidates than requested so the filter has something to reject.
  const candidates = rawPlaces.slice(0, Math.min(rawPlaces.length, Math.ceil(limit * 1.8)));

  // Give non-Latin names an English form before anything downstream uses them:
  // the LLM filter, the image queries and the PDF all read `place.name`.
  const naming = await applyEnglishNames(candidates).catch(() => ({ translated: 0, note: undefined }));
  if (naming.note) warnings.push(naming.note);

  const enrichment = await enrichPlaces(candidates, { keyword, city: area.city, country: area.country, useLlm });
  warnings.push(...enrichment.warnings);

  const enrichedById = new Map(enrichment.places.map((entry) => [entry.placeId, entry]));
  const kept = candidates
    .filter((place) => enrichedById.get(place.id)?.keep !== false)
    .sort((a, b) => (enrichedById.get(b.id)?.qualityScore ?? 0) - (enrichedById.get(a.id)?.qualityScore ?? 0))
    .slice(0, limit);

  let imagesByPlace = new Map<string, PlaceImage[]>();
  if (includeImages && kept.length > 0) {
    try {
      imagesByPlace = await fetchImagesForPlaces(kept, {
        city: area.city,
        country: area.country,
        perPlace: config.imagesPerPlace,
      });
    } catch (error) {
      warnings.push(`Image lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isCommonsUnreachable()) {
      warnings.push(
        'Wikimedia Commons is unreachable from this server, so category and Commons-search '
          + 'imagery was skipped (Wikipedia and Openverse still worked). Some networks block '
          + 'commons.wikimedia.org by SNI — set COMMONS_HOSTS to a reachable mirror.',
      );
    }
  }

  const places: Place[] = kept.map((place) => {
    const enriched = enrichedById.get(place.id);
    // The cleaner sees the raw OSM tags, so it happily echoes the original
    // script name back. Never let that undo a resolved English name.
    const enrichedName = enriched?.name && !(isMostlyNonLatin(enriched.name) && !isMostlyNonLatin(place.name))
      ? enriched.name
      : '';
    return {
      ...place,
      name: enrichedName || place.name,
      summary: enriched?.summary ?? '',
      contact: enriched?.contact ?? {},
      qualityScore: enriched?.qualityScore ?? 50,
      llmProcessed: enriched?.llmProcessed ?? false,
      images: imagesByPlace.get(place.id) ?? [],
      travelLinks: buildTravelLinks({
        name: enriched?.name || place.name,
        city: area.city,
        country: area.country,
        countryCode: area.countryCode,
      }),
      wikipediaUrl: wikipediaUrl(place.tags.wikipedia),
      wikidataUrl: wikidataUrl(place.tags.wikidata),
      googleMapsUrl: googleMapsUrl(place),
      osmUrl: `https://www.openstreetmap.org/${place.osmType}/${place.osmId}`,
    };
  });

  const result: SearchResult = {
    searchId: randomUUID(),
    query: { keyword, city, country, limit, useLlm, includeImages },
    area,
    places,
    stats: {
      overpassMatches: rawCount,
      afterDedupe: rawPlaces.length,
      afterFilter: places.length,
      withImages: places.filter((place) => place.images.length > 0).length,
      llmUsed: enrichment.llmUsed,
      llmModel: enrichment.llmUsed ? config.llm.model : undefined,
      elapsedMs: Date.now() - startedAt,
      warnings,
    },
    cachedAt: new Date().toISOString(),
  };

  await store.save(cacheKey, result).catch((error: unknown) => {
    console.warn('[search] failed to cache result:', error instanceof Error ? error.message : error);
  });

  return result;
}
