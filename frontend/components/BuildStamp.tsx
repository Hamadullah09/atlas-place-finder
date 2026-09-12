'use client';

import { useEffect, useState } from 'react';
import { fetchBuildInfo } from '@/lib/api';

/**
 * Shows which build is serving the page.
 *
 * Two PCs running different copies of the exe were indistinguishable, which
 * made "the app behaves differently over here" impossible to diagnose.
 */
export default function BuildStamp() {
  const [build, setBuild] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBuildInfo(controller.signal).then(setBuild);
    return () => controller.abort();
  }, []);

  if (!build) return null;

  return (
    <span
      className="hidden rounded-full border border-slate-200 px-2.5 py-1 text-[14px] font-medium text-mist-500 sm:inline"
      title="The build this app was packaged from. Check it matches on every machine."
    >
      build {build}
    </span>
  );
}
