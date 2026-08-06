export type OsmType = 'node' | 'way' | 'relation';

/** Resolved city/country, either as an Overpass `area` or a plain bounding box. */
export interface GeoArea {
  displayName: string;
  city: string;
  country: string;
  countryCode?: string;
  lat: number;
  lon: number;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  osmType?: OsmType;
  osmId?: number;
  /** Overpass area id (3600000000 + relation id, or 2400000000 + way id). */
  areaId?: number;
}

export type ImageSource =
  | 'wikidata'
  | 'wikipedia'
  | 'commons'
  | 'commons-category'
  | 'wikipedia-article'
  | 'openverse'
  | 'unsplash'
  | 'google';

/** A labelled fact lifted from a Wikidata statement. */
export interface WikidataFact {
  property: string;
  label: string;
  value: string;
}

/**
 * Long-form research gathered per place, used to ground the PDF write-up.
 * Everything here is sourced — nothing is model-generated.
 */
export interface PlaceContent {
  wikipediaExtract?: string;
  wikipediaUrl?: string;
  wikivoyageExtract?: string;
  wikivoyageUrl?: string;
  wikidataDescription?: string;
  commonsCategory?: string;
  facts: WikidataFact[];
  /** Human-readable list of where the above came from, for PDF attribution. */
  sources: Array<{ label: string; url: string }>;
  /** Passages about this place mined from user-supplied source links. */
  extraExtracts?: Array<{ label: string; url: string; text: string }>;
}

/** Multi-section article the LLM writes from a PlaceContent. */
export interface PlaceWriteup {
  overview: string;
  history?: string;
  architecture?: string;
  highlights: string[];
  visiting?: string;
  practical?: string;
  llmGenerated: boolean;
  model?: string;
  /** Sentences removed by the fact-check guard, surfaced in the PDF notes. */
  redactions: string[];
}

export interface PlaceImage {
  /** Best URL for browser display (already capped in size). */
  url: string;
  /** URL the backend fetches when building the ZIP — highest sane resolution. */
  downloadUrl: string;
  thumbUrl: string;
  width?: number;
  height?: number;
  source: ImageSource;
  title?: string;
  credit?: string;
  license?: string;
  /** Human-facing page the image came from, for attribution. */
  sourcePage?: string;
}

export type PlaceSource = 'overpass' | 'wikidata' | 'nominatim' | 'google';

export interface RawPlace {
  id: string;
  osmType: OsmType;
  osmId: number;
  name: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  /** Category id from the taxonomy that matched this element. */
  category: string;
  categoryLabel: string;
  /** Which discovery source surfaced this place. */
  source?: PlaceSource;
}

export interface PlaceContact {
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  openingHours?: string;
}

/** Outbound search link into a travel marketplace. */
export interface TravelLink {
  id: string;
  label: string;
  url: string;
  kind: 'reviews' | 'tours' | 'booking' | 'guide' | 'reference';
  /** True when the site has no search endpoint and this is a portal link. */
  generic?: boolean;
}

export interface Place extends RawPlace {
  summary: string;
  contact: PlaceContact;
  images: PlaceImage[];
  /** Tripadvisor / Viator / GetYourGuide / Trip.com search links. */
  travelLinks: TravelLink[];
  /** Populated at download time, not during search — see services/content.ts. */
  content?: PlaceContent;
  /** 0-100. Below `MIN_QUALITY` the LLM/heuristic drops the entry. */
  qualityScore: number;
  llmProcessed: boolean;
  wikipediaUrl?: string;
  wikidataUrl?: string;
  googleMapsUrl: string;
  osmUrl: string;
}

export interface SearchQuery {
  keyword: string;
  city: string;
  country: string;
  limit?: number;
  useLlm?: boolean;
  includeImages?: boolean;
  /** Which engine answers the search: open-source stack (default) or Google. */
  source?: 'osm' | 'google';
}

export interface SearchStats {
  overpassMatches: number;
  afterDedupe: number;
  afterFilter: number;
  withImages: number;
  llmUsed: boolean;
  llmModel?: string;
  elapsedMs: number;
  warnings: string[];
}

export interface SearchResult {
  searchId: string;
  query: SearchQuery;
  area: GeoArea;
  places: Place[];
  stats: SearchStats;
  cachedAt: string;
}
