export type OsmType = 'node' | 'way' | 'relation';
export type ImageSource = 'wikidata' | 'wikipedia' | 'commons' | 'unsplash';

export interface PlaceImage {
  url: string;
  downloadUrl: string;
  thumbUrl: string;
  width?: number;
  height?: number;
  source: ImageSource;
  title?: string;
  credit?: string;
  license?: string;
  sourcePage?: string;
}

export interface PlaceContact {
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  openingHours?: string;
}

export interface TravelLink {
  id: string;
  label: string;
  url: string;
  kind: 'reviews' | 'tours' | 'booking' | 'guide' | 'reference';
  /** True when the site has no search endpoint and this is a portal link. */
  generic?: boolean;
}

export interface Place {
  id: string;
  osmType: OsmType;
  osmId: number;
  name: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  category: string;
  categoryLabel: string;
  summary: string;
  contact: PlaceContact;
  images: PlaceImage[];
  travelLinks?: TravelLink[];
  qualityScore: number;
  llmProcessed: boolean;
  wikipediaUrl?: string;
  wikidataUrl?: string;
  googleMapsUrl: string;
  osmUrl: string;
}

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
  areaId?: number;
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

export type PlaceEngine = 'osm' | 'google';

export interface SearchQuery {
  keyword: string;
  city: string;
  country: string;
  limit?: number;
  useLlm?: boolean;
  includeImages?: boolean;
  /** Which engine answers the search: open-source stack (default) or Google. */
  source?: PlaceEngine;
}

export interface SearchResult {
  searchId: string;
  query: SearchQuery;
  area: GeoArea;
  places: Place[];
  stats: SearchStats;
  cachedAt: string;
}

export interface CategorySuggestion {
  id: string;
  label: string;
  example: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteSummary {
  distanceText: string;
  durationText: string;
  travelMode: google.maps.TravelMode;
  destinationName: string;
}
