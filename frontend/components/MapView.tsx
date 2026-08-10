'use client';

import type { GeoArea, Place } from '@/lib/types';

interface MapViewProps {
  places: Place[];
  area: GeoArea | null;
}

export default function MapView({ places, area }: MapViewProps) {
  const bounds =
    places.length > 0
      ? places.reduce(
          (acc, place) => ({
            minLat: Math.min(acc.minLat, place.lat),
            maxLat: Math.max(acc.maxLat, place.lat),
            minLon: Math.min(acc.minLon, place.lon),
            maxLon: Math.max(acc.maxLon, place.lon),
          }),
          { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 },
        )
      : area
      ? {
          minLat: area.bbox[0],
          maxLat: area.bbox[2],
          minLon: area.bbox[1],
          maxLon: area.bbox[3],
        }
      : null;

  const osmEmbed =
    bounds &&
    `https://www.openstreetmap.org/export/embed.html?bbox=${bounds.minLon - 0.02},${bounds.minLat - 0.02},${bounds.maxLon + 0.02},${bounds.maxLat + 0.02}&layer=mapnik`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-900">
      {osmEmbed ? (
        <iframe
          title="OpenStreetMap preview"
          src={osmEmbed}
          className="osm-dark h-full w-full border-0"
        />
      ) : (
        <div className="grid h-full w-full place-items-center px-6">
          <div className="text-center">
            <span aria-hidden className="text-3xl opacity-30">
              🗺
            </span>
            <p className="mt-2 text-[12.5px] text-mist-500">Run a search to plot results here.</p>
          </div>
        </div>
      )}
    </div>
  );
}
