'use client';

import { useEffect, useState } from 'react';
import type { SearchProgress as Progress, SearchStage } from '@/lib/api';

/**
 * A whole-city search runs for minutes. Showing which stage it is in, and that
 * the clock is still moving, is the difference between "working" and "frozen".
 */

const STEPS: Array<{ stage: SearchStage; label: string; hint: string }> = [
  { stage: 'geocoding', label: 'Locate city', hint: 'Finding the search area' },
  { stage: 'discovering', label: 'Find places', hint: 'OpenStreetMap, Wikidata, Nominatim' },
  { stage: 'naming', label: 'Translate names', hint: 'Non-English names into English' },
  { stage: 'filtering', label: 'Check relevance', hint: 'Each place judged individually' },
  { stage: 'imagery', label: 'Find photos', hint: 'Wikimedia Commons and Openverse' },
];

const ORDER: SearchStage[] = ['starting', ...STEPS.map((s) => s.stage), 'done', 'failed'];

function elapsed(from: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export default function SearchProgressView({
  progress,
  startedAt,
  onCancel,
}: {
  progress: Progress | null;
  startedAt: number;
  onCancel: () => void;
}) {
  // Local tick so the elapsed clock advances between server updates.
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const currentIndex = progress ? ORDER.indexOf(progress.stage) : 0;
  const isFailed = progress?.stage === 'failed';

  return (
    <div className="rounded-2xl border border-slate-200 bg-ink-900/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className={`text-[15.5px] font-semibold ${isFailed ? 'text-red-700' : 'text-mist-100'}`}>
          {isFailed
            ? (progress?.message ?? 'Search failed')
            : (progress?.message ?? 'Starting…')
          }
        </p>
        <span className={`shrink-0 font-mono text-[16px] tabular-nums ${isFailed ? 'text-red-700' : 'text-mist-400'}`}>
          {elapsed(startedAt)}
        </span>
      </div>

      <ol className="mt-3 space-y-1.5">
        {STEPS.map((step, index) => {
          const stepIndex = ORDER.indexOf(step.stage);
          const done = currentIndex > stepIndex;
          const active = currentIndex === stepIndex;

          return (
            <li key={step.stage} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className={`mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${
                  done
                    ? 'bg-emerald-500/20 text-emerald-700'
                    : active && isFailed
                      ? 'bg-red-500/20 text-red-700'
                      : active
                        ? 'bg-aqua-500/20 text-aqua-300'
                        : 'bg-slate-50 text-mist-600'
                }`}
              >
                {done ? '✓' : active && isFailed ? '✕' : index + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-[17px] font-medium ${
                    active && isFailed
                      ? 'text-red-700'
                      : active
                        ? 'text-aqua-300'
                        : done
                          ? 'text-mist-300'
                          : 'text-mist-500'
                  }`}
                >
                  {step.label}
                  {active && progress?.total ? (
                    <span className="ml-1.5 font-normal text-mist-400">
                      ({progress.total} places)
                    </span>
                  ) : null}
                </span>
                {active && (
                  <span className="block text-[15.5px] leading-snug text-mist-500">{step.hint}</span>
                )}
              </span>
              {active && (
                <span
                  aria-hidden
                  className={`ml-auto mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    isFailed ? 'bg-red-400' : 'animate-pulse bg-aqua-400'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-3 border-t border-slate-200 pt-2.5 text-[15.5px] leading-snug text-mist-500">
        {progress?.error ? (
          <span className="text-red-700">{progress.error}</span>
        ) : (
          'Relevance checking and translation run on your local AI model, so a large '
            + 'city can take several minutes. You can leave this running.'
        )}
      </p>

      <button
        type="button"
        onClick={onCancel}
        className="mt-2.5 w-full rounded-xl border border-slate-300 px-3 py-1.5 text-[14.5px] font-semibold text-mist-300 transition hover:border-slate-400 hover:bg-slate-100"
      >
        Stop search
      </button>
    </div>
  );
}
