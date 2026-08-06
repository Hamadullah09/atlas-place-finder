import { config } from '../config.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import { escapeOverpassRegex, type ResolvedKeyword } from '../lib/taxonomy.js';
import type { GeoArea, RawPlace } from '../types.js';

/**
 * Extra place-discovery sources layered on top of Overpass.
 *
 * OSM is excellent for amenities but patchy for notable landmarks — plenty of
 * museums and monuments exist in Wikidata with coordinates and no OSM node at
 * all. These sources fill that gap; results are merged and de-duplicated
 * against the Overpass set by the caller.
 */

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** Maps our taxonomy ids onto Wikidata "instance of" classes. */
const WIKIDATA_CLASSES: Record<string, string[]> = {
  tourism: ['Q570116', 'Q33506', 'Q839954', 'Q2065736'], // tourist attraction, museum, archaeological site, cultural property
  historic: ['Q839954', 'Q2065736', 'Q570116', 'Q4989906'], // archaeological site, cultural property, attraction, monument
  museum: ['Q33506', 'Q207694'], // museum, art museum
  worship: ['Q1370598', 'Q32815', 'Q16970', 'Q842402'], // place of worship, mosque, church, temple
  university: ['Q3918', 'Q875538'], // university, public university
  college: ['Q189004', 'Q3918'], // college, university
  school: ['Q3914'],
  hospital: ['Q16917'],
  park: ['Q22698'],
  library: ['Q7075'],
  cinema: ['Q41253', 'Q24354'], // movie theater, theater
  hotel: ['Q27686'],
  transport: ['Q1248784', 'Q55488'], // airport, train station
  beach: ['Q40080'],
  mall: ['Q11315'], // shopping mall
};

interface SparqlBinding {
  item?: { value?: string };
  itemLabel?: { value?: string };
  itemDescription?: { value?: string };
  coord?: { value?: string };
  typeLabel?: { value?: string };
  website?: { value?: string };
  commons?: { value?: string };
}

/** `Point(67.017 24.852)` -> {lat, lon} */
function parsePoint(wkt: string | undefined): { lat: number; lon: number } | null {
  if (!wkt) return null;
  const match = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Finds places of the requested type inside the city's bounding box.
 *
 * Uses the `wikibase:box` geospatial service rather than P131 administrative
 * containment: administrative hierarchies are inconsistent across countries,
 * whereas a bounding box behaves the same everywhere.
 */
export async function discoverViaWikidata(
  resolved: ResolvedKeyword,
  area: GeoArea,
  limit: number,
): Promise<RawPlace[]> {
  if (!config.discovery.wikidata) return [];

  const categoryId = resolved.categories[0]?.id;
  const classes = categoryId ? WIKIDATA_CLASSES[categoryId] : undefined;
  if (!classes || classes.length === 0) return [];

  const [south, west, north, east] = area.bbox;
  const values = classes.map((qid) => `wd:${qid}`).join(' ');

  const query = `
SELECT ?item ?itemLabel ?itemDescription ?coord ?typeLabel ?website ?commons WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  VALUES ?class { ${values} }
  ?item wdt:P31/wdt:P279* ?class .
  ?item wdt:P31 ?type .
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P373 ?commons }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${Math.min(limit * 3, 120)}`.trim();

  try {
    const url = `${SPARQL_ENDPOINT}?${qs({ query, format: 'json' })}`;
    const payload = await fetchJson<{ results?: { bindings?: SparqlBinding[] } }>(url, {
      timeoutMs: 45_000,
      retries: 1,
      headers: { Accept: 'application/sparql-results+json' },
    });

    const places: RawPlace[] = [];
    for (const binding of payload.results?.bindings ?? []) {
      const qid = binding.item?.value?.split('/').pop();
      const name = cleanText(binding.itemLabel?.value, 160);
      const coords = parsePoint(binding.coord?.value);

      // A label that is just the Q-id means Wikidata has no English name.
      if (!qid || !name || !coords || /^Q\d+$/.test(name)) continue;

      const tags: Record<string, string> = { name, wikidata: qid };
      const description = cleanText(binding.itemDescription?.value, 400);
      if (description) tags.description = description;
      const website = binding.website?.value;
      if (website) tags.website = website;
      const commons = cleanText(binding.commons?.value, 200);
      if (commons) tags.wikimedia_commons = `Category:${commons.replace(/^Category:/i, '')}`;

      places.push({
        id: `wikidata/${qid}`,
        // These aren't OSM elements; `node` keeps the shape uniform and the
        // numeric id is only used for filename fallbacks.
        osmType: 'node',
        osmId: Number(qid.slice(1)) || 0,
        name,
        lat: coords.lat,
        lon: coords.lon,
        tags,
        category: categoryId ?? 'custom',
        categoryLabel: cleanText(binding.typeLabel?.value, 80) || resolved.label,
        source: 'wikidata',
      });
    }

    return places;
  } catch {
    // Wikidata's SPARQL endpoint throttles aggressively; never fail the search.
    return [];
  }
}

interface NominatimPlace {
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  extratags?: Record<string, string>;
  address?: Record<string, string>;
}

/**
 * Nominatim free-text search restricted to the city's bounding box. Catches
 * places whose OSM tagging doesn't match our selectors but whose *name* does.
 */
export async function discoverViaNominatim(
  keyword: string,
  area: GeoArea,
  limit: number,
): Promise<RawPlace[]> {
  if (!config.discovery.nominatim) return [];

  const safe = escapeOverpassRegex(keyword);
  if (!safe) return [];

  const [south, west, north, east] = area.bbox;
  const url = `${config.nominatimUrl}/search?${qs({
    q: `${safe} ${area.city}`,
    format: 'jsonv2',
    limit: Math.min(limit, 40),
    bounded: 1,
    viewbox: `${west},${north},${east},${south}`,
    extratags: 1,
    addressdetails: 1,
  })}`;

  try {
    const results = await fetchJson<NominatimPlace[]>(url, { timeoutMs: 25_000, retries: 1 });
    const places: RawPlace[] = [];

    for (const entry of Array.isArray(results) ? results : []) {
      const lat = Number(entry.lat);
      const lon = Number(entry.lon);
      const name = cleanText(entry.name ?? entry.display_name?.split(',')[0], 160);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!entry.osm_id || !['node', 'way', 'relation'].includes(entry.osm_type ?? '')) continue;

      const tags: Record<string, string> = { name, ...(entry.extratags ?? {}) };
      if (entry.category && entry.type) tags[entry.category] = entry.type;
      for (const [key, value] of Object.entries(entry.address ?? {})) {
        if (['road', 'suburb', 'city', 'postcode', 'state'].includes(key)) {
          tags[`addr:${key === 'road' ? 'street' : key}`] = value;
        }
      }

      places.push({
        id: `${entry.osm_type}/${entry.osm_id}`,
        osmType: entry.osm_type as RawPlace['osmType'],
        osmId: entry.osm_id,
        name,
        lat,
        lon,
        tags,
        category: 'custom',
        categoryLabel: cleanText(entry.type?.replace(/_/g, ' '), 80) || 'Place',
        source: 'nominatim',
      });
    }

    return places;
  } catch {
    return [];
  }
}
