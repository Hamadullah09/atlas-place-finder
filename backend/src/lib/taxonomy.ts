/**
 * Maps a free-text keyword ("tourist places", "universities", "cafes") onto
 * OpenStreetMap tag selectors for Overpass QL.
 *
 * SECURITY: everything that reaches an Overpass query goes through
 * `escapeOverpassRegex` first. Overpass QL is a real language — unescaped
 * user input would let a caller terminate the statement and run their own.
 */

export interface PlaceCategory {
  id: string;
  label: string;
  /** Lower-case tokens that route a user keyword to this category. */
  match: string[];
  /** Overpass tag filters appended to an `nwr` statement. */
  selectors: string[];
}

export const CATEGORIES: PlaceCategory[] = [
  {
    id: 'tourism',
    label: 'Tourist attraction',
    match: ['tourist place', 'tourist places', 'tourist attraction', 'tourist attractions', 'tourist spot', 'tourism', 'sightseeing', 'places to visit', 'attractions', 'landmarks', 'landmark'],
    selectors: [
      '["tourism"~"^(attraction|museum|gallery|artwork|viewpoint|zoo|theme_park|aquarium|picnic_site|information)$"]',
      '["historic"]',
      '["leisure"~"^(park|garden|nature_reserve)$"]',
    ],
  },
  {
    id: 'historic',
    label: 'Historical site',
    match: ['historical site', 'historical sites', 'historic', 'historical', 'heritage', 'monument', 'monuments', 'fort', 'forts', 'ruins', 'archaeological'],
    selectors: ['["historic"]', '["heritage"]', '["tourism"="museum"]["museum"~"history|local"]'],
  },
  {
    id: 'museum',
    label: 'Museum',
    match: ['museum', 'museums', 'gallery', 'galleries', 'art gallery'],
    selectors: ['["tourism"~"^(museum|gallery)$"]'],
  },
  {
    id: 'cafe',
    label: 'Cafe',
    match: ['cafe', 'cafes', 'coffee', 'coffee shop', 'coffee shops', 'coffeehouse'],
    selectors: ['["amenity"="cafe"]', '["cuisine"~"coffee_shop"]'],
  },
  {
    id: 'restaurant',
    label: 'Restaurant',
    match: ['restaurant', 'restaurants', 'food', 'dining', 'eatery', 'eateries', 'fast food', 'diner'],
    selectors: ['["amenity"~"^(restaurant|fast_food|food_court)$"]'],
  },
  {
    id: 'bar',
    label: 'Bar / nightlife',
    match: ['bar', 'bars', 'pub', 'pubs', 'nightlife', 'nightclub', 'club'],
    selectors: ['["amenity"~"^(bar|pub|nightclub|biergarten)$"]'],
  },
  {
    id: 'hotel',
    label: 'Hotel',
    match: ['hotel', 'hotels', 'accommodation', 'lodging', 'guest house', 'guesthouse', 'hostel', 'resort', 'resorts', 'motel', 'stay'],
    selectors: ['["tourism"~"^(hotel|motel|guest_house|hostel|resort|apartment|chalet)$"]'],
  },
  {
    id: 'university',
    label: 'University',
    match: ['university', 'universities', 'uni', 'higher education'],
    selectors: ['["amenity"="university"]'],
  },
  {
    id: 'college',
    label: 'College',
    match: ['college', 'colleges', 'institute', 'institutes', 'polytechnic'],
    selectors: ['["amenity"~"^(college|university)$"]', '["building"="college"]'],
  },
  {
    id: 'school',
    label: 'School',
    match: ['school', 'schools', 'kindergarten', 'academy'],
    selectors: ['["amenity"~"^(school|kindergarten)$"]'],
  },
  {
    id: 'hospital',
    label: 'Hospital',
    match: ['hospital', 'hospitals', 'clinic', 'clinics', 'medical', 'healthcare', 'health care', 'doctor', 'doctors'],
    selectors: [
      '["amenity"~"^(hospital|clinic|doctors)$"]',
      '["healthcare"~"^(hospital|clinic|centre|doctor)$"]',
    ],
  },
  {
    id: 'pharmacy',
    label: 'Pharmacy',
    match: ['pharmacy', 'pharmacies', 'chemist', 'drugstore', 'medical store'],
    selectors: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]'],
  },
  {
    id: 'company',
    label: 'Company / office',
    match: ['company', 'companies', 'office', 'offices', 'business', 'businesses', 'corporate', 'startup', 'startups', 'it company', 'it companies', 'firm', 'firms', 'agency', 'agencies'],
    selectors: ['["office"]', '["amenity"="coworking_space"]'],
  },
  {
    id: 'bank',
    label: 'Bank',
    match: ['bank', 'banks', 'banking', 'atm', 'atms', 'financial'],
    selectors: ['["amenity"~"^(bank|bureau_de_change)$"]', '["office"~"^(financial|insurance)$"]'],
  },
  {
    id: 'park',
    label: 'Park',
    match: ['park', 'parks', 'garden', 'gardens', 'green space', 'playground', 'recreation'],
    selectors: ['["leisure"~"^(park|garden|nature_reserve|playground|recreation_ground)$"]'],
  },
  {
    id: 'mall',
    label: 'Shopping',
    match: ['mall', 'malls', 'shopping', 'shopping centre', 'shopping center', 'market', 'markets', 'bazaar', 'supermarket', 'grocery', 'store', 'stores'],
    selectors: [
      '["shop"~"^(mall|department_store|supermarket|wholesale)$"]',
      '["amenity"="marketplace"]',
    ],
  },
  {
    id: 'worship',
    label: 'Place of worship',
    match: ['mosque', 'mosques', 'masjid', 'church', 'churches', 'temple', 'temples', 'place of worship', 'places of worship', 'shrine', 'shrines', 'synagogue', 'religious'],
    selectors: ['["amenity"="place_of_worship"]', '["historic"~"^(shrine|tomb|wayside_shrine)$"]'],
  },
  {
    id: 'library',
    label: 'Library',
    match: ['library', 'libraries', 'archive', 'archives'],
    selectors: ['["amenity"~"^(library|archive)$"]'],
  },
  {
    id: 'gym',
    label: 'Gym / fitness',
    match: ['gym', 'gyms', 'fitness', 'fitness centre', 'sports', 'stadium', 'sports club'],
    selectors: ['["leisure"~"^(fitness_centre|sports_centre|stadium|sports_hall|pitch)$"]'],
  },
  {
    id: 'cinema',
    label: 'Cinema / theatre',
    match: ['cinema', 'cinemas', 'movie', 'movies', 'theatre', 'theater', 'theatres', 'entertainment'],
    selectors: ['["amenity"~"^(cinema|theatre|arts_centre)$"]'],
  },
  {
    id: 'beach',
    label: 'Beach',
    match: ['beach', 'beaches', 'waterfront', 'seaside', 'coast'],
    selectors: ['["natural"="beach"]', '["leisure"="beach_resort"]'],
  },
  {
    id: 'transport',
    label: 'Transport hub',
    match: ['airport', 'airports', 'bus station', 'railway', 'railway station', 'train station', 'metro', 'subway', 'transport', 'terminal', 'port', 'seaport'],
    selectors: [
      '["aeroway"~"^(aerodrome|terminal)$"]',
      '["railway"~"^(station|halt)$"]',
      '["amenity"="bus_station"]',
      '["public_transport"="station"]',
    ],
  },
  {
    id: 'fuel',
    label: 'Fuel station',
    match: ['petrol', 'petrol pump', 'gas station', 'fuel', 'filling station', 'charging station'],
    selectors: ['["amenity"~"^(fuel|charging_station)$"]'],
  },
  {
    id: 'government',
    label: 'Government / civic',
    match: ['government', 'civic', 'police', 'police station', 'fire station', 'court', 'embassy', 'consulate', 'town hall', 'municipal', 'public office'],
    selectors: [
      '["amenity"~"^(police|fire_station|townhall|courthouse|embassy|post_office)$"]',
      '["office"~"^(government|diplomatic|administrative)$"]',
    ],
  },
];

/** Keys we probe when a keyword doesn't match any curated category. */
const GENERIC_KEYS = [
  'amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare',
  'historic', 'craft', 'building', 'club', 'landuse',
];

/**
 * Whitelist to alphanumerics/space/hyphen before interpolating into Overpass
 * QL. Nothing that survives this can escape a quoted regex literal.
 */
export function escapeOverpassRegex(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function normaliseKeyword(keyword: string): string {
  return keyword.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface ResolvedKeyword {
  categories: PlaceCategory[];
  /** True when we fell back to generic tag probing instead of a curated set. */
  generic: boolean;
  selectors: string[];
  label: string;
}

/**
 * Resolve a user keyword into Overpass selectors. Exact/substring matches
 * against the curated taxonomy win; otherwise we probe the generic keys with
 * the sanitised keyword as a case-insensitive regex.
 */
export function resolveKeyword(keyword: string): ResolvedKeyword {
  const normalised = normaliseKeyword(keyword);
  const matched: PlaceCategory[] = [];

  for (const category of CATEGORIES) {
    const hit = category.match.some(
      (token) => normalised === token || normalised.includes(token) || token.includes(normalised),
    );
    if (hit) matched.push(category);
  }

  if (matched.length > 0) {
    // Prefer the most specific match: the category whose token is longest.
    const scored = matched
      .map((category) => {
        const best = category.match
          .filter((token) => normalised.includes(token) || token.includes(normalised))
          .reduce((longest, token) => Math.max(longest, token.length), 0);
        return { category, score: best };
      })
      .sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 2).map((entry) => entry.category);
    return {
      categories: top,
      generic: false,
      selectors: dedupe(top.flatMap((category) => category.selectors)),
      label: top[0]!.label,
    };
  }

  const safe = escapeOverpassRegex(normalised);
  if (!safe) {
    // Nothing usable — fall back to broad points of interest.
    const fallback = CATEGORIES[0]!;
    return { categories: [fallback], generic: false, selectors: fallback.selectors, label: fallback.label };
  }

  const pattern = safe.replace(/ /g, '.*');
  const selectors = GENERIC_KEYS.map((key) => `["${key}"~"${pattern}",i]`);
  // Also catch places whose *name* contains the keyword (e.g. "Serena Hotel").
  selectors.push(`["name"~"${pattern}",i]`);

  return {
    categories: [],
    generic: true,
    selectors,
    label: toTitleCase(normalised),
  };
}

/** Derives a readable type label from an element's raw OSM tags. */
export function labelFromTags(tags: Record<string, string>, fallback: string): string {
  const keys = ['amenity', 'tourism', 'historic', 'shop', 'leisure', 'office', 'healthcare', 'aeroway', 'railway', 'natural', 'craft'];
  for (const key of keys) {
    const value = tags[key];
    if (value && value !== 'yes') return toTitleCase(value.replace(/_/g, ' '));
  }
  return fallback;
}

export function toTitleCase(input: string): string {
  return input.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/** Suggestions surfaced by `GET /api/categories` for the search UI. */
export function categorySuggestions(): Array<{ id: string; label: string; example: string }> {
  return CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    example: category.match[0]!,
  }));
}
