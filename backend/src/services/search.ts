import { randomUUID } from 'node:crypto';import { findTourismSource, tourismSourceByName, type TourismSource } from '../data/tourismSources.js';
import { config } from '../config.js';
import { isMostlyNonLatin } from '../lib/sanitize.js';
import { resolveKeyword } from '../lib/taxonomy.js';
import { buildTravelLinks } from '../lib/travelLinks.js';
import { cacheKeyFor, getStore } from './cache.js';
import { discoverViaNominatim, discoverViaWikidata } from './discovery.js';
import { geocodeCity } from './geocode.js';
import { runGoogleSearch } from './googleSearch.js';
import { fetchImagesForPlaces, selectIllustrated, isCommonsUnreachable, isCommonsViaGateway } from './images.js';
import { enrichPlaces } from './llm.js';
import { dedupePlaces, informationScore, searchOverpass } from './overpass.js';
import { setStage, type SearchProgress } from './progress.js';
import { semanticDedupe } from './semanticDedupe.js';
import { applyEnglishNames } from './translate.js';
import type { Place, PlaceImage, RawPlace, SearchQuery, SearchResult, SourceLink } from '../types.js';

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
  /** Receives stage updates so a long search can show live progress. */
  progress?: SearchProgress;
  /**
   * Abandons the search at the next stage boundary. A whole-city search
   * runs for minutes, so a batch cancel has to be able to interrupt it.
   */
  signal?: AbortSignal;
}

/**
 * Full pipeline: geocode -> Overpass -> LLM filter/clean -> imagery.
 *
 * Filtering runs *before* image lookup so we never spend requests on entries
 * that are about to be discarded.
 */
/**
 * Places looked up for photos per place reported, when photos are mandatory.
 * Enough spare that a city where many places have no HD photo still fills
 * the requested count, without imaging the whole candidate list.
 */
const IMAGE_LOOKUP_OVERSAMPLE = 2;

/** Services every OSM search queries, whatever it finds. */
const DISCOVERY_SOURCES: SourceLink[] = [
  { label: 'OpenStreetMap Overpass', url: 'https://overpass-api.de/', kind: 'discovery' },
  { label: 'Wikidata SPARQL', url: 'https://query.wikidata.org/sparql', kind: 'discovery' },
  { label: 'Nominatim Geocoding', url: 'https://nominatim.openstreetmap.org/', kind: 'discovery' },
];

/** Where imagery can come from, keyed by the tag each image carries. */
const IMAGE_SOURCES: Record<string, { label: string; url: string }> = {
  wikidata: { label: 'Wikimedia Commons (Wikidata)', url: 'https://www.wikidata.org/' },
  wikipedia: { label: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  commons: { label: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
  'commons-category': { label: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
  'commons-geo': { label: 'Wikimedia Commons (Geo)', url: 'https://commons.wikimedia.org/' },
  'wikipedia-article': { label: 'Wikipedia Articles', url: 'https://www.wikipedia.org/' },
  flickr: { label: 'Flickr (CC-licensed)', url: 'https://www.flickr.com/' },
  europeana: { label: 'Europeana', url: 'https://www.europeana.eu/' },
  openverse: { label: 'Openverse', url: 'https://openverse.org/' },
  unsplash: { label: 'Unsplash', url: 'https://unsplash.com/' },
  brave: { label: 'Brave Image Search (licence unknown)', url: 'https://search.brave.com/images' },
  google: { label: 'Google Places', url: 'https://maps.google.com/' },
};

/**
 * Everything this install can draw on, for the form to show up front.
 *
 * A finished search reports what it actually used; this is the menu.
 */
export function sourceCatalogue(country?: string): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];

  // The country's own tourism site, once the form knows which country. It is
  // listed first because it is the most specific source in the list.
  const tourism = tourismSourceByName(country);
  if (tourism) {
    seen.add(tourism.url.toLowerCase());
    out.push({ label: `${tourism.organisation} (official)`, url: tourism.url, kind: 'extra' });
  }

  for (const source of DISCOVERY_SOURCES) {
    seen.add(source.url.toLowerCase());
    out.push(source);
  }

  for (const [key, info] of Object.entries(IMAGE_SOURCES)) {
    // Google imagery only exists in the Google edition.
    if (key === 'google' && config.placeSource === 'osm') continue;
    // Web image search is only a source when the operator has enabled it.
    if (key === 'brave' && !config.images.braveApiKey) continue;
    if (seen.has(info.url.toLowerCase())) continue;
    seen.add(info.url.toLowerCase());
    out.push({ label: info.label, url: info.url, kind: 'image' });
  }

  return out;
}

/** Collect unique sources used during the search. */
function collectSources(
  places: Place[],
  includeImages: boolean,
  extraSources?: string | string[],
  tourism?: TourismSource,
): SourceLink[] {
  const seen = new Set<string>();
  const sources: SourceLink[] = [];

  function add(label: string, url: string, kind: SourceLink['kind']): void {
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ label, url, kind });
  }

  // The country's official tourism site, read for the write-ups and, when the
  // open sources fell short, for photos. Those are the site's own, so say so.
  if (tourism) {
    const photos = includeImages && places.some((place) => place.images.some((image) => image.source === 'tourism'));
    add(`${tourism.organisation} (official${photos ? '; its photos are all rights reserved' : ''})`, tourism.url, 'extra');
  }

  // Discovery sources — every search hits all three.
  for (const source of DISCOVERY_SOURCES) add(source.label, source.url, source.kind);

  // Image sources
  if (includeImages) {
    const imageSources = new Set<string>();
    for (const place of places) {
      for (const image of place.images) {
        imageSources.add(image.source);
      }
    }
    const IMAGE_SOURCE_MAP = IMAGE_SOURCES;
    for (const source of imageSources) {
      const info = IMAGE_SOURCE_MAP[source];
      if (info) add(info.label, info.url, 'image');
    }

    // Add Wikipedia article source pages from place images
    for (const place of places) {
      for (const image of place.images) {
        if (image.sourcePage) {
          add(
            image.title ?? `${image.source} image`,
            image.sourcePage,
            'image',
          );
        }
      }
    }
  }

  // Reference sources (Wikipedia articles for places)
  for (const place of places) {
    if (place.wikipediaUrl) {
      add(`Wikipedia — ${place.name}`, place.wikipediaUrl, 'reference');
    }
    if (place.osmUrl) {
      add(`OpenStreetMap — ${place.name}`, place.osmUrl, 'reference');
    }
  }

  // Extra user-provided sources
  if (extraSources) {
    const urls = Array.isArray(extraSources)
      ? extraSources
      : extraSources.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        add(parsed.hostname, url, 'extra');
      } catch {
        // Invalid URL — skip
      }
    }
  }

  return sources;
}

export async function runSearch(query: SearchQuery, options: RunSearchOptions = {}): Promise<SearchResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const keyword = query.keyword.trim();
  const city = query.city.trim();
  const country = query.country.trim();
  // No limit given means "everything this city has", not a sample of 20.
  const limit = Math.min(Math.max(query.limit ?? config.maxResults, 1), config.maxResults);
  const useLlm = query.useLlm !== false;
  const includeImages = query.includeImages !== false;
  const source: 'osm' | 'google' = query.source === 'google' ? 'google' : 'osm';

  const store = await getStore();
  const cacheKey = cacheKeyFor(keyword, city, country, limit, useLlm, source)
    + (query.extraSources?.trim() ? `|${query.extraSources.trim()}` : '');

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

  options.signal?.throwIfAborted();
  setStage(options.progress, 'geocoding', { message: `Locating ${city}, ${country}` });
  const area = await geocodeCity(city, country);

  // Overpass is the primary source; Wikidata and Nominatim run alongside it to
  // catch landmarks that are notable but thinly mapped in OSM.
  options.signal?.throwIfAborted();
  setStage(options.progress, 'discovering');
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
  options.signal?.throwIfAborted();
  setStage(options.progress, 'naming', { total: candidates.length });
  const naming = await applyEnglishNames(candidates).catch(() => ({ translated: 0, note: undefined }));
  if (naming.note) warnings.push(naming.note);

  // Translation can make two differently-spelled originals collide on one
  // English name, so collapse again now that the final names are known.
  const exact = naming.translated > 0 ? dedupePlaces(candidates) : candidates;

  // Then the semantic pass, which catches what string equality cannot:
  // transposed characters, translated-vs-transliterated pairs, added articles.
  const semantic = await semanticDedupe(exact).catch(() => ({ places: exact, merged: 0, note: undefined }));
  if (semantic.note) warnings.push(semantic.note);
  const named = semantic.places;

  options.signal?.throwIfAborted();
  setStage(options.progress, 'filtering', {
    total: named.length,
    message: `Checking ${named.length} places are relevant`,
  });
  const enrichment = await enrichPlaces(named, {
    keyword,
    city: area.city,
    country: area.country,
    useLlm,
    onBatch: (done, total) => {
      setStage(options.progress, 'filtering', {
        done: Math.min(done, total),
        total,
        message: `Checking ${Math.min(done, total)} of ${total} places are relevant`,
      });
    },
  });
  warnings.push(...enrichment.warnings);

  const enrichedById = new Map(enrichment.places.map((entry) => [entry.placeId, entry]));
  // A place without an HD photo is not worth exporting, so it is left out --
  // unless the operator turned photos off, when there is nothing to require.
  const requireImages = includeImages && config.requireImages;
  const kept = named
    .filter((place) => enrichedById.get(place.id)?.keep !== false)
    .sort((a, b) => (enrichedById.get(b.id)?.qualityScore ?? 0) - (enrichedById.get(a.id)?.qualityScore ?? 0))
    // When a photo is mandatory some of these will be dropped, so look up
    // more than the limit and keep the first that have one.
    .slice(0, requireImages ? limit * IMAGE_LOOKUP_OVERSAMPLE : limit);

  let imagesByPlace = new Map<string, PlaceImage[]>();
  if (includeImages && kept.length > 0) {
    options.signal?.throwIfAborted();
    setStage(options.progress, 'imagery', {
      total: kept.length,
      message: `Finding photographs for ${kept.length} places`,
    });
    try {
      imagesByPlace = await fetchImagesForPlaces(kept, {
        city: area.city,
        country: area.country,
        countryCode: area.countryCode,
        perPlace: config.imagesPerPlace,
      });
    } catch (error) {
      warnings.push(`Image lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isCommonsUnreachable()) {
      warnings.push(
        'Wikimedia Commons could not be reached, directly or through the Wikimedia API '
          + 'gateway, so its photos were skipped (Wikipedia and Openverse still worked).',
      );
    } else if (isCommonsViaGateway()) {
      warnings.push(
        'commons.wikimedia.org is blocked on this network, so Commons photos were fetched '
          + 'through the Wikimedia API gateway instead. Results are complete but slower.',
      );
    }
  }

  let reported = kept;
  if (requireImages) {
    const { kept: illustrated, withoutImages } = selectIllustrated(kept, imagesByPlace, limit);
    reported = illustrated;
    if (withoutImages > 0) {
      warnings.push(
        `${withoutImages} place(s) had no HD photo (${config.minImageWidth}px or larger) and were left out.`,
      );
    }
  }

  const places: Place[] = reported.map((place) => {
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

  const sources = collectSources(
    places,
    includeImages,
    query.extraSources,
    config.crawl.tourismSources ? findTourismSource(area.countryCode, area.country) : undefined,
  );

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
    sources,
    cachedAt: new Date().toISOString(),
  };

  await store.save(cacheKey, result).catch((error: unknown) => {
    console.warn('[search] failed to cache result:', error instanceof Error ? error.message : error);
  });

  setStage(options.progress, 'done', {
    message: `Found ${result.places.length} places`,
    done: result.places.length,
    total: result.places.length,
  });
  return result;
}
