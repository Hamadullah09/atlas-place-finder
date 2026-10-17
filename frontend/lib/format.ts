/** 45 s · 7 min 30 s · 1 h 05 min */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "C:\a\b\Places" -> "…\b\Places": the end of a path is the part that tells folders apart. */
export function shortPath(full: string): string {
  const parts = full.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? full : `…\\${parts.slice(-2).join('\\')}`;
}

/** Places per hour for `places` done in `ms`, rounded; 0 when it cannot be worked out. */
export function placesPerHour(places: number, ms: number): number {
  return places > 0 && ms > 0 ? Math.round(places / (ms / 3_600_000)) : 0;
}
