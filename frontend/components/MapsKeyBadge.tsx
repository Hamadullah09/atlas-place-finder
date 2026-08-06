'use client';

import { useEffect, useState } from 'react';
import { fetchEngineInfo } from '@/lib/api';

/**
 * "Maps key missing" header chip. Shown only where it is actionable:
 * never in the open-source edition (OpenStreetMap IS its map), and not when
 * a key is baked in at build time or served by the backend at runtime.
 */
export default function MapsKeyBadge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) return;
    const controller = new AbortController();
    void fetchEngineInfo(controller.signal).then((info) => {
      setShow(info.mode !== 'osm' && !info.mapsBrowserKey);
    });
    return () => controller.abort();
  }, []);

  if (!show) return null;

  return (
    <span className="hidden items-center gap-1.5 rounded-full border border-ember-500/25 bg-ember-500/10 px-2.5 py-1 text-[11px] font-medium text-ember-300 sm:flex">
      <span className="h-1.5 w-1.5 rounded-full bg-ember-400" />
      Maps key missing
    </span>
  );
}
