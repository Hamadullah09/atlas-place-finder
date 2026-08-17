'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseFolder,
  cancelBatch,
  fetchBatchJob,
  fetchRunningBatchJob,
  previewBatchCsv,
  startBatch,
  type BatchJob,
  type BatchPreview,
  type BatchRowStatus,
} from '@/lib/api';

const POLL_MS = 3_000;

const STATUS_META: Record<BatchRowStatus, { label: string; className: string }> = {
  pending: { label: 'Queued', className: 'text-mist-500' },
  searching: { label: 'Searching…', className: 'text-aqua-300' },
  exporting: { label: 'Exporting…', className: 'text-aqua-300' },
  done: { label: 'Done', className: 'text-emerald-300' },
  skipped: { label: 'Skipped', className: 'text-mist-400' },
  failed: { label: 'Failed', className: 'text-red-300' },
};

export default function BatchPanel({ engine = 'osm' }: { engine?: 'osm' | 'google' }) {
  const [csvName, setCsvName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [attribute, setAttribute] = useState('tourist places');
  const [outputPath, setOutputPath] = useState('');
  const [sources, setSources] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);

  const [job, setJob] = useState<BatchJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reattach to a job that is still running server-side after a page reload.
  useEffect(() => {
    const controller = new AbortController();
    void fetchRunningBatchJob(controller.signal).then((running) => {
      if (running) setJob(running);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!job || job.status !== 'running') {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return undefined;
    }

    pollRef.current = setInterval(() => {
      void fetchBatchJob(job.id).then((next) => {
        if (next) setJob(next);
      });
    }, POLL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [job]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setPreviewError(null);
    setPreview(null);
    setCsvName(file.name);

    const text = await file.text();
    setCsvText(text);

    try {
      const parsed = await previewBatchCsv(text);
      setPreview(parsed);
      if (parsed.attribute) setAttribute(parsed.attribute);
      if (parsed.outputPath) setOutputPath(parsed.outputPath);
      if (parsed.sourceLinks.length > 0) setSources(parsed.sourceLinks.join(',\n'));
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!csvText) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startBatch({
        csv: csvText,
        attribute: attribute.trim(),
        outputPath: outputPath.trim(),
        extraSources: sources,
        overwrite,
        allowDuplicates,
        source: engine,
      });
      setJob(started);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }, [csvText, attribute, outputPath, sources, overwrite, allowDuplicates, engine]);

  const handleBrowse = useCallback(async () => {
    setBrowsing(true);
    setError(null);
    try {
      const picked = await browseFolder();
      if (picked) setOutputPath(picked);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBrowsing(false);
    }
  }, []);

  // The dialog is a separate OS window and can land behind the browser.
  useEffect(() => {
    if (!browsing) return undefined;
    const timer = setTimeout(() => setHintVisible(true), 2_500);
    return () => {
      clearTimeout(timer);
      setHintVisible(false);
    };
  }, [browsing]);

  const handleCancel = useCallback(async () => {
    if (!job) return;
    try {
      await cancelBatch(job.id);
    } catch {
      // Already finished — the next poll will reflect that.
    }
  }, [job]);

  const progress = useMemo(() => {
    if (!job) return null;
    const total = job.rows.length;
    const finished = job.rows.filter((row) =>
      row.status === 'done' || row.status === 'skipped' || row.status === 'failed',
    ).length;
    const failed = job.rows.filter((row) => row.status === 'failed').length;
    const places = job.rows.reduce((sum, row) => sum + (row.placeCount ?? 0), 0);
    return { total, finished, failed, places };
  }, [job]);

  const running = job?.status === 'running';
  const canStart =
    Boolean(csvText)
    && Boolean(preview && preview.targets.length > 0)
    && attribute.trim().length >= 2
    && outputPath.trim().length >= 3
    && !running
    && !starting;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="text-center">
        <h1 className="text-[24px] font-semibold tracking-tight text-mist-50 sm:text-[28px]">
          Work through a whole list of cities
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-mist-400">
          Upload a CSV, set three things once, and leave it running. One ZIP of
          illustrated PDFs is saved per city.
        </p>
      </div>

      {/* Setup reads left-to-right: the sheet, then what to do with it. */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
      {/* ---- Step 1: CSV -------------------------------------------------- */}
      <section className="rounded-2xl border border-white/[0.08] bg-ink-850/70 p-4">
        <SectionTitle step="1" title="Location CSV" />
        <p className="mt-1 text-[11px] leading-snug text-mist-500">
          Columns: Country, City, Province/State. Country may appear once and is
          carried down. Attribute, save path and source links are pre-filled
          from the sheet when present.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = '';
          }}
        />

        {/* Drop target: dragging a sheet in is the obvious gesture, and the
            whole area is clickable rather than just a small button. */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={running}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
          className={`mt-3 flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 transition disabled:cursor-not-allowed disabled:opacity-50 ${
            dragging
              ? 'border-aqua-400 bg-aqua-500/10'
              : csvName
                ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                : 'border-white/15 bg-white/[0.02] hover:border-aqua-500/40 hover:bg-aqua-500/[0.06]'
          }`}
        >
          <span aria-hidden className="text-xl opacity-70">
            {csvName ? '✓' : '⬆'}
          </span>
          <span className="text-[13px] font-semibold text-mist-100">
            {csvName ?? 'Drop your CSV here, or click to choose'}
          </span>
          <span className="text-[11px] text-mist-500">
            {csvName ? 'Click to replace' : '.csv files only'}
          </span>
        </button>

        {preview && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
            <Chip>
              {preview.targets.filter((target) => target.kind === 'city').length} cities
            </Chip>
            <Chip>
              {preview.targets.filter((target) => target.kind === 'province').length} provinces
            </Chip>
            {preview.sourceLinks.length > 0 && (
              <Chip>{preview.sourceLinks.length} source links found</Chip>
            )}
          </div>
        )}
        {preview?.warnings.map((warning) => (
          <p key={warning} className="mt-1.5 text-[11px] text-amber-300/90">
            {warning}
          </p>
        ))}
        {previewError && <p className="mt-1.5 text-[11px] text-red-300">{previewError}</p>}
      </section>

      {/* ---- Step 2: session inputs -------------------------------------- */}
      <section className="rounded-2xl border border-white/[0.08] bg-ink-850/70 p-4">
        <SectionTitle step="2" title="What & where to save" />

        <label className="mt-2.5 block">
          <FieldLabel>Attribute — what to search in every city</FieldLabel>
          <input
            className={fieldClass}
            placeholder="tourist places, universities, hospitals…"
            value={attribute}
            disabled={running}
            onChange={(event) => setAttribute(event.target.value)}
          />
        </label>

        <label className="mt-2.5 block">
          <FieldLabel>Save path — folder on this computer for the ZIPs</FieldLabel>
          <div className="mt-1 flex gap-1.5">
            <input
              className={`${fieldClass} mt-0 flex-1`}
              placeholder="C:\Users\you\Documents\PlaceFinder"
              value={outputPath}
              disabled={running}
              onChange={(event) => setOutputPath(event.target.value)}
            />
            <button
              type="button"
              onClick={() => void handleBrowse()}
              disabled={running || browsing}
              className="shrink-0 rounded-xl border border-white/10 px-3 text-[12px] font-semibold text-mist-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {browsing ? 'Choosing…' : 'Browse…'}
            </button>
          </div>
          {hintVisible && (
            <span className="mt-1 block text-[10.5px] leading-snug text-aqua-300">
              A “Browse For Folder” window is open — check your taskbar if you
              cannot see it (it may be behind this window).
            </span>
          )}
          <span className="mt-1 block text-[10.5px] leading-snug text-mist-500">
            Saved as [path]\[Country]\[City]\[attribute].zip — already-exported
            cities are skipped, so a stopped run can be resumed.
          </span>
        </label>

        <label className="mt-2.5 block">
          <FieldLabel>Additional source links (comma separated)</FieldLabel>
          <textarea
            className={`${fieldClass} min-h-[64px] resize-y`}
            placeholder="https://www.travelchina.org.cn/en, https://…"
            value={sources}
            disabled={running}
            onChange={(event) => setSources(event.target.value)}
          />
        </label>

        <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-mist-300">
          <input
            type="checkbox"
            checked={overwrite}
            disabled={running}
            onChange={(event) => setOverwrite(event.target.checked)}
            className="h-3.5 w-3.5 accent-aqua-400"
          />
          Re-export cities that already have a ZIP
        </label>

        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[12px] text-mist-300">
          <input
            type="checkbox"
            checked={allowDuplicates}
            disabled={running}
            onChange={(event) => setAllowDuplicates(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-aqua-400"
          />
          <span>
            Allow the same place in several regions
            <span className="block text-[10.5px] leading-snug text-mist-500">
              Off by default: a province and the cities inside it return the same
              landmarks, so each place is exported once per run.
            </span>
          </span>
        </label>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={!canStart}
            className="rounded-xl bg-gradient-to-b from-aqua-400 to-aqua-600 px-4 py-2 text-[13px] font-semibold text-ink-950 shadow-lg shadow-aqua-500/25 transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:from-ink-700 disabled:to-ink-700 disabled:text-mist-500 disabled:shadow-none"
          >
            {starting ? 'Starting…' : running ? 'Batch running…' : 'Start batch'}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="rounded-xl border border-white/10 px-3.5 py-2 text-[12.5px] font-semibold text-mist-200 transition hover:border-white/20 hover:bg-white/5"
            >
              Cancel
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-[11.5px] text-red-300">{error}</p>}
      </section>
      </div>

      {/* ---- Step 3: progress — full width, it is the long-lived view ----- */}
      {job && progress && (
        <section className="mt-4 flex min-h-0 flex-col rounded-2xl border border-white/[0.08] bg-ink-850/70 p-4">
          <SectionTitle step="3" title="Progress" />

          <div className="mt-2 flex items-center justify-between text-[12px] text-mist-300">
            <span>
              {progress.finished} / {progress.total} regions ·{' '}
              <span className="text-mist-100">{progress.places}</span> places
              {progress.failed > 0 && (
                <span className="text-red-300"> · {progress.failed} failed</span>
              )}
            </span>
            <span
              className={
                job.status === 'completed'
                  ? 'font-semibold text-emerald-300'
                  : job.status === 'failed' || job.status === 'cancelled'
                    ? 'font-semibold text-red-300'
                    : 'font-semibold text-aqua-300'
              }
            >
              {job.status}
            </span>
          </div>

          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-gradient-to-r from-aqua-400 to-aqua-600 transition-all"
              style={{ width: `${progress.total ? (progress.finished / progress.total) * 100 : 0}%` }}
            />
          </div>

          {/* A CSV of 70+ cities is unreadable as one long column at this
              width; three columns keeps the whole run visible at once. */}
          <ul className="mt-3 grid max-h-[22rem] grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto scroll-region pr-1 text-[12px] sm:grid-cols-2 xl:grid-cols-3">
            {job.rows.map((row, index) => {
              const meta = STATUS_META[row.status];
              const active = index === job.currentIndex && job.status === 'running';
              return (
                <li
                  key={`${row.country}-${row.kind}-${row.region}`}
                  className={`flex items-baseline justify-between gap-2 rounded-lg px-2 py-1 ${
                    active ? 'bg-aqua-500/10 ring-1 ring-aqua-500/30' : ''
                  }`}
                >
                  <span className="truncate text-mist-200">
                    {row.region}
                    <span className="text-mist-500"> · {row.country}</span>
                    {row.kind === 'province' && (
                      <span className="ml-1 rounded bg-white/[0.06] px-1 text-[10px] text-mist-400">
                        province
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 ${meta.className}`}
                    title={
                      row.error
                      ?? (row.duplicatesSkipped
                        ? `${row.duplicatesSkipped} duplicate place(s) skipped`
                        : undefined)
                    }
                  >
                    {row.status === 'done' && row.placeCount !== undefined
                      ? `${row.placeCount} places${row.duplicatesSkipped ? ` (+${row.duplicatesSkipped} dup)` : ''}`
                      : meta.label}
                  </span>
                </li>
              );
            })}
          </ul>

          {job.notes.length > 0 && (
            <details className="mt-2 text-[11px] text-mist-400">
              <summary className="cursor-pointer select-none text-mist-300">
                {job.notes.length} note(s)
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {job.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

const fieldClass =
  'mt-1 w-full rounded-xl border border-white/[0.09] bg-ink-900/80 px-3 py-2 text-[13px] text-mist-50 outline-none transition placeholder:text-mist-500/60 focus:border-aqua-500/50 disabled:opacity-60';

function SectionTitle({ step, title }: { step: string; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-mist-100">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-aqua-500/15 text-[11px] font-bold text-aqua-300">
        {step}
      </span>
      {title}
    </h3>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">
      {children}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-mist-300">
      {children}
    </span>
  );
}
