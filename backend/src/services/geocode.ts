import { config } from '../config.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import type { GeoArea, OsmType } from '../types.js';

interface NominatimResult {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  display_name: string;
  /** [south, north, west, east] as strings */
  boundingbox: [string, string, string, string];
  addresstype?: string;
  type?: string;
  class?: string;
  address?: Record<string, string>;
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeError';
  }
}

/**
 * Overpass exposes OSM relations/ways as "areas" with a fixed id offset.
 * Using an area is far more accurate than a bounding box for irregularly
 * shaped cities, so we prefer it whenever Nominatim gives us a relation.
 */
function toAreaId(osmType: string | undefined, osmId: number | undefined): number | undefined {
  if (!osmId) return undefined;
  if (osmType === 'relation') return 3_600_000_000 + osmId;
  if (osmType === 'way') return 2_400_000_000 + osmId;
  return undefined;
}

function toGeoArea(result: NominatimResult, city: string, country: string): GeoArea {
  const [south, north, west, east] = result.boundingbox.map(Number) as [number, number, number, number];

  if (![south, north, west, east].every(Number.isFinite)) {
    throw new GeocodeError(`Nominatim returned an unusable bounding box for "${city}, ${country}"`);
  }

  const osmType = ['node', 'way', 'relation'].includes(result.osm_type ?? '')
    ? (result.osm_type as OsmType)
    : undefined;

  return {
    displayName: cleanText(result.display_name, 300),
    city: cleanText(result.address?.city ?? result.address?.town ?? result.address?.state ?? city, 120) || city,
    country: cleanText(result.address?.country ?? country, 120) || country,
    countryCode: result.address?.country_code?.toUpperCase(),
    lat: Number(result.lat),
    lon: Number(result.lon),
    bbox: [south, west, north, east],
    osmType,
    osmId: result.osm_id,
    areaId: toAreaId(result.osm_type, result.osm_id),
  };
}

/**
 * Resolve "Karachi" + "Pakistan" into coordinates, a bounding box and (when
 * possible) an Overpass area id. Tries the structured Nominatim query first,
 * then a free-form one.
 */
export async function geocodeCity(city: string, country: string): Promise<GeoArea> {
  const base = `${config.nominatimUrl}/search`;
  const common = { format: 'jsonv2', limit: 5, addressdetails: 1 };

  const attempts: string[] = [
    `${base}?${qs({ ...common, city, country })}`,
    `${base}?${qs({ ...common, q: `${city}, ${country}` })}`,
  ];

  const errors: string[] = [];

  for (const url of attempts) {
    try {
      const results = await fetchJson<NominatimResult[]>(url, { timeoutMs: 20_000, retries: 1 });
      if (!Array.isArray(results) || results.length === 0) continue;

      // Prefer administrative boundaries (relations) over stray POIs that
      // happen to share the city's name.
      const ranked = [...results].sort((a, b) => rank(b) - rank(a));
      return toGeoArea(ranked[0]!, city, country);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new GeocodeError(
    `Could not locate "${city}, ${country}". Check the spelling, or try the English name.` +
      (errors.length ? ` (${errors.join('; ')})` : ''),
  );
}

function rank(result: NominatimResult): number {
  let score = 0;
  if (result.osm_type === 'relation') score += 10;
  if (result.class === 'boundary' || result.class === 'place') score += 5;
  if (['city', 'town', 'administrative', 'municipality'].includes(result.type ?? '')) score += 5;
  return score;
}
