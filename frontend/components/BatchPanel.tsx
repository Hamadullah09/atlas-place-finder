'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE_URL,
  browseFolder,
  cancelBatch,
  fetchBatchJob,
  fetchRunningBatchJob,
  fetchSourceCatalogue,
  fetchWithTimeout,
  getNetworkStatus,
  isOffline,
  NetworkError,
  onNetworkStatusChange,
  refreshNetworkStatus,
  previewBatchCsv,
  retryBatchRows,
  startBatch,
  type BatchJob,
  type BatchPreview,
  type BatchRowStatus,
  type NetworkStatus,
} from '@/lib/api';
import type { SourceLink } from '@/lib/types';
import { ALL_PLACES, QUICK_PICKS, SourceAnchor, SourcesDisclosure, Toggle, isAll, keywordParts } from './SearchForm';
import { formatDuration } from '@/lib/format';
import { ALL_COLOUR, PRIMARY_BUTTON, pickColour } from '@/lib/palette';

const POLL_MS = 3_000;

const STATUS_META: Record<BatchRowStatus, { label: string; className: string }> = {
  pending: { label: 'Queued', className: 'text-mist-500' },
  searching: { label: 'Searching…', className: 'text-aqua-300' },
  exporting: { label: 'Saving…', className: 'text-aqua-300' },
  done: { label: 'Done', className: 'text-emerald-700' },
  skipped: { label: 'Skipped', className: 'text-mist-400' },
  failed: { label: 'Failed', className: 'text-red-700' },
};

export default function BatchPanel({ engine = 'osm' }: { engine?: 'osm' | 'google' }) {
  const [csvName, setCsvName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [attribute, setAttribute] = useState('all');
  const [outputPath, setOutputPath] = useState('');
  const [sources, setSources] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);

  const [job, setJob] = useState<BatchJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(getNetworkStatus);
  const [pollFailures, setPollFailures] = useState(0);

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

  // Track network status changes
  useEffect(() => {
    const unsubscribe = onNetworkStatusChange((status) => {
      setNetworkStatus(status);
      if (status === 'online') {
        setPollFailures(0);
        setError(null);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!job || job.status !== 'running') {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return undefined;
    }

    pollRef.current = setInterval(() => {
      // Keep polling through an outage: the job lives on this machine, and
      // this is also how the UI finds out the connection is back.
      void refreshNetworkStatus();

      fetchWithTimeout(`${API_BASE_URL}/api/batch/${encodeURIComponent(job.id)}`, {
        timeoutMs: 10_000,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`${response.status}`);
          const payload = (await response.json()) as { job: BatchJob };
          if (payload.job) {
            setJob(payload.job);
            setPollFailures(0);
            if (payload.job.networkDown) {
              setNetworkStatus('offline');
              setError('No internet connection. Waiting for connection to return…');
            } else {
              // The server is working again, so clear the outage notice.
              setError((previous) => (previous?.startsWith('No internet') ? null : previous));
            }
          }
        })
        .catch((error: unknown) => {
          setPollFailures((prev) => {
            const next = prev + 1;
            if (error instanceof NetworkError) {
              if (error.kind === 'no-internet') {
                setError('No internet connection. Waiting for connection to return…');
              } else if (error.kind === 'timeout') {
                setError('Batch polling timed out. The server may be overloaded.');
              } else {
                setError(`Connection error: ${error.message}`);
              }
            } else if (next >= 3) {
              setError('Lost connection to the server. Check your network and try again.');
            }
            return next;
          });
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
    if (isOffline()) {
      setError('No internet connection. Please check your network and try again.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const started = await startBatch({
        csv: csvText,
        attribute: attribute.trim() || ALL_PLACES,
        outputPath: outputPath.trim(),
        extraSources: sources,
        overwrite,
        allowDuplicates,
        source: engine,
      });
      setJob(started);
    } catch (caught) {
      if (caught instanceof NetworkError) {
        if (caught.kind === 'no-internet') {
          setError('No internet connection. Please check your network and try again.');
        } else if (caught.kind === 'timeout') {
          setError('Request timed out. The server may be overloaded — try again shortly.');
        } else {
          setError(`Failed to start batch: ${caught.message}`);
        }
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }

      // Most likely cause: a run from another tab or an earlier session is
      // still going. Adopt it so the operator can watch or cancel it here
      // instead of being told "already running" with nothing on screen.
      const running = await fetchRunningBatchJob().catch(() => null);
      if (running) setJob(running);
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
    setCancelling(true);
    try {
      await cancelBatch(job.id);
    } catch {
      // Already finished — the next poll will reflect that.
    }
  }, [job]);

  // Reset once the server confirms the job is no longer running.
  useEffect(() => {
    if (job?.status !== 'running') setCancelling(false);
  }, [job?.status]);

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
    && outputPath.trim().length >= 3
    && !running
    && !starting;

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl">
      <div className="text-center">
        <h1 className="text-balance text-[26px] font-semibold tracking-tight text-mist-50 sm:text-[32px]">
          Search a whole list of cities
        </h1>
        <p className="mx-auto mt-1.5 max-w-xl text-[18px] leading-relaxed text-mist-400 sm:text-[18px]">
          Add a CSV, choose what to find and where to save, then leave it running.
        </p>
      </div>

      {/* Setup reads left-to-right: the sheet, then what to do with it. */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
      {/* ---- Step 1: CSV -------------------------------------------------- */}
      <section className="min-w-0 rounded-2xl border border-slate-200 border-t-4 border-t-teal-600 bg-white p-4 shadow-sm">
        <SectionTitle step="1" title="Your list of cities" tone="bg-teal-100 text-teal-800" />
        <p className="mt-1 text-[17px] leading-snug text-mist-500">
          A CSV with Country, City and Province/State columns. Anything else the
          sheet holds (search term, folder, links) is filled in for you.
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
          className={`mt-3 flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 transition sm:py-6 disabled:cursor-not-allowed disabled:opacity-50 ${
            dragging
              ? 'border-aqua-400 bg-aqua-500/10'
              : csvName
                ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                : 'border-slate-300 bg-slate-50 hover:border-teal-600 hover:bg-teal-50/60'
          }`}
        >
          <span aria-hidden className="text-xl opacity-70">
            {csvName ? '✓' : '⬆'}
          </span>
          <span className="text-[18px] font-semibold text-mist-100">
            {csvName ?? 'Choose a CSV file, or drop it here'}
          </span>
          <span className="text-[17px] text-mist-500">
            {csvName ? 'Tap to replace' : '.csv files only'}
          </span>
        </button>

        {preview && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-[17px]">
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
          <p key={warning} className="mt-1.5 text-[19px] text-amber-700">
            {warning}
          </p>
        ))}
        {previewError && <p className="mt-1.5 text-[19px] text-red-700">{previewError}</p>}
      </section>

      {/* ---- Step 2: session inputs -------------------------------------- */}
      <section className="min-w-0 rounded-2xl border border-slate-200 border-t-4 border-t-teal-600 bg-white p-4 shadow-sm">
        <SectionTitle step="2" title="What to find and where to save" tone="bg-teal-100 text-teal-800" />

        <label className="mt-2.5 block">
          <FieldLabel>What to find in every city</FieldLabel>
          <input
            className={fieldClass}
            placeholder="all"
            value={attribute}
            disabled={running}
            onChange={(event) => setAttribute(event.target.value)}
          />
          <div className="chip-row mt-2 flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
            <button
              type="button"
              disabled={running}
              onClick={() => setAttribute(ALL_PLACES)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[18px] font-semibold transition disabled:opacity-50 ${
                isAll(attribute) ? ALL_COLOUR.on : ALL_COLOUR.idle
              }`}
            >
              All places
            </button>

            {QUICK_PICKS.map((pick) => (
              <button
                key={pick}
                type="button"
                disabled={running}
                onClick={() => {
                  const current = isAll(attribute) ? [] : keywordParts(attribute);
                  const next = current.includes(pick)
                    ? current.filter((part) => part !== pick)
                    : [...current, pick];
                  setAttribute(next.length > 0 ? next.join(', ') : ALL_PLACES);
                }}
                className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[18px] font-medium transition disabled:opacity-50 ${
                  !isAll(attribute) && keywordParts(attribute).includes(pick)
                    ? pickColour(pick).on
                    : pickColour(pick).idle
                }`}
              >
                {!isAll(attribute) && keywordParts(attribute).includes(pick) ? `✓ ${pick}` : pick}
              </button>
            ))}
          </div>
        </label>

        <label className="mt-2.5 block">
          <FieldLabel>Save to folder</FieldLabel>
          <div className="mt-1 flex gap-1.5">
            <input
              className={`${fieldClass} mt-0 flex-1`}
              placeholder="e.g. D:\Places"
              value={outputPath}
              disabled={running}
              onChange={(event) => setOutputPath(event.target.value)}
            />
            <button
              type="button"
              onClick={() => void handleBrowse()}
              disabled={running || browsing}
              className="shrink-0 rounded-xl border border-slate-300 bg-slate-100 px-3.5 text-[18px] font-semibold text-mist-200 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {browsing ? 'Choosing…' : 'Browse…'}
            </button>
          </div>
          {hintVisible && (
            <span className="mt-1 block text-[18px] leading-snug text-aqua-300">
              A folder window is open — it may be behind your browser.
            </span>
          )}
        </label>

        {/* Rarely changed settings, folded away so the main path is two steps. */}
        <details className="group/options mt-3 rounded-xl border border-slate-200 bg-slate-50">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[18px] font-semibold text-mist-300 marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="shrink-0 whitespace-nowrap">More options</span>
            <span className="truncate font-normal text-mist-500">
              {[
                overwrite ? 'redo saved cities' : null,
                allowDuplicates ? 'repeats allowed' : null,
                sources.trim() ? 'links added' : null,
              ].filter(Boolean).join(' · ')}
            </span>
            <span aria-hidden className="ml-auto transition group-open/options:rotate-180">⌄</span>
          </summary>

          <div className="space-y-3 border-t border-slate-200 bg-white p-3.5">
            <Toggle
              label="Skip places already saved"
              hint="A place already in the folder, from this run or an earlier one, is not searched again."
              checked={!allowDuplicates}
              disabled={running}
              onChange={(checked) => setAllowDuplicates(!checked)}
            />
            <Toggle
              label="Redo cities that already have a folder"
              hint="Off: those cities are skipped."
              checked={overwrite}
              disabled={running}
              onChange={setOverwrite}
            />

            <label className="block">
              <FieldLabel>Extra source links</FieldLabel>
              <textarea
                className={`${fieldClass} min-h-[64px] resize-y`}
                placeholder="https://www.travelchina.org.cn/en, https://…"
                value={sources}
                disabled={running}
                onChange={(event) => setSources(event.target.value)}
              />
              <span className="mt-1 block text-[17px] text-mist-500">Separated by commas.</span>
            </label>

            <BatchSources
              countries={(preview?.targets ?? job?.rows ?? []).map((target) => target.country)}
              sheetLinks={preview?.sourceLinks ?? []}
              typed={sources}
            />
          </div>
        </details>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={!canStart}
            title={canStart || running ? undefined : 'Add a CSV with cities and choose the folder to save in'}
            className={`w-full rounded-xl px-5 py-2.5 text-[19px] font-semibold sm:w-auto ${PRIMARY_BUTTON}`}
          >
            {starting ? 'Starting…' : cancelling ? 'Stopping after this place…' : running ? 'Batch running…' : 'Start batch'}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={cancelling}
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-[19px] font-semibold sm:w-auto text-mist-200 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancelling ? 'Stopping…' : 'Cancel'}
            </button>
          )}
        </div>
        {error && (
          <div className="mt-2 rounded-xl border border-red-500/25 bg-red-500/[0.07] p-3">
            <p className="text-[18px] font-semibold text-red-700">{error}</p>
            {pollFailures >= 3 && running && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPollFailures(0);
                  // Force re-poll by updating job reference
                  setJob((prev) => prev ? { ...prev } : null);
                }}
                className="mt-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-[17px] font-semibold text-red-700 transition hover:bg-red-500/10"
              >
                Retry connection
              </button>
            )}
          </div>
        )}
      </section>
      </div>

      {/* ---- Step 3: progress — full width, it is the long-lived view ----- */}
      {job && progress && (
        <section className="mt-4 flex min-h-0 flex-col rounded-2xl border border-slate-200 border-t-4 border-t-teal-600 bg-white p-4 shadow-sm">
          <SectionTitle step="3" title="Progress" tone="bg-teal-100 text-teal-800" />

          {networkStatus === 'offline' && (
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[18px] font-medium text-amber-700">
                No internet connection — batch will resume when the connection returns.
              </span>
            </div>
          )}

          {networkStatus === 'checking' && (
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-aqua-500/25 bg-aqua-500/10 px-3 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-aqua-400 animate-pulse" />
              <span className="text-[18px] font-medium text-aqua-300">
                Reconnecting…
              </span>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[17px] text-mist-300">
            <span>
              {progress.finished} / {progress.total} regions ·{' '}
              <span className="text-mist-100">{progress.places}</span> places
              {progress.failed > 0 && (
                <span className="text-red-700"> · {progress.failed} failed</span>
              )}
              {(() => {
                // Time so far, and the rate the finished cities work out to. The
                // rate stops at the last city to finish: counting the time a city
                // still in progress has taken, but none of its places, made a run
                // look about half as fast as it was.
                const startedAt = Date.parse(job.startedAt);
                const elapsed = (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - startedAt;
                if (!(elapsed > 0)) return null;
                const lastFinished = Math.max(0, ...job.rows.map((r) => (r.finishedAt ? Date.parse(r.finishedAt) : 0)));
                const measured = job.finishedAt ? elapsed : lastFinished - startedAt;
                const rate = progress.places > 0 && measured > 0 ? Math.round(progress.places / (measured / 3_600_000)) : 0;
                return (
                  <span className="text-mist-400">
                    {' '}· {formatDuration(elapsed)}{rate > 0 ? ` · about ${rate} places/hour` : ''}
                  </span>
                );
              })()}
            </span>
            <span
              className={
                job.status === 'completed'
                  ? 'font-semibold text-emerald-700'
                  : job.status === 'failed' || job.status === 'cancelled'
                    ? 'font-semibold text-red-700'
                    : 'font-semibold text-aqua-300'
              }
            >
              {job.status}
            </span>
          </div>

          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-teal-600 transition-all"
              style={{ width: `${progress.total ? (progress.finished / progress.total) * 100 : 0}%` }}
            />
          </div>

          {/* A CSV of 70+ cities is unreadable as one long column at this
              width; three columns keeps the whole run visible at once. */}
          <ul className="mt-3 grid max-h-[22rem] grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto scroll-region pr-1 text-[17px] sm:grid-cols-2 xl:grid-cols-3">
            {job.rows.map((row, index) => {
              const meta = STATUS_META[row.status];
              // Two cities can be active at once: one searched while another is written.
              const active = job.status === 'running' && (row.status === 'searching' || row.status === 'exporting');
              return (
                <li
                  key={`${row.country}-${row.kind}-${row.region}`}
                  className={`rounded-lg px-2 py-1 ${
                    active ? 'bg-aqua-500/10 ring-1 ring-aqua-500/30' : ''
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-mist-200">
                    {row.region}
                    <span className="text-mist-500"> · {row.country}</span>
                    {row.kind === 'province' && (
                      <span className="ml-1 rounded bg-ink-800 px-1 text-[15px] text-mist-400">
                        province
                      </span>
                    )}
                  </span>
                  {row.status === 'failed' && job.id && (
                    <button
                      type="button"
                      onClick={() => {
                        void retryBatchRows(job.id, index)
                          .then(() => fetchBatchJob(job.id))
                          .then((next) => { if (next) setJob(next); })
                          .catch(() => undefined);
                      }}
                      className="shrink-0 rounded-md border border-slate-300 px-2 py-0.5 text-[17px] font-semibold text-mist-300 transition hover:border-aqua-500 hover:text-aqua-300"
                    >
                      Retry
                    </button>
                  )}
                  <span
                    className={`shrink-0 ${meta.className}`}
                    title={
                      row.error
                      ?? (row.duplicatesSkipped
                        ? `${row.duplicatesSkipped} place(s) already exported were skipped`
                        : undefined)
                    }
                  >
                    {row.status === 'done' && row.placeCount !== undefined
                      ? `${row.placeCount} places${row.duplicatesSkipped ? ` (${row.duplicatesSkipped} already saved)` : ''}`
                      : meta.label}
                  </span>
                  </div>

                  {row.durationMs !== undefined ? (
                    <p className="mt-0.5 truncate text-[16px] text-mist-500">
                      Took {formatDuration(row.durationMs)}
                      {row.searchMs !== undefined && ` · search ${formatDuration(row.searchMs)}`}
                      {row.exportMs !== undefined && ` · write-ups & photos ${formatDuration(row.exportMs)}`}
                    </p>
                  ) : active && row.startedAt ? (
                    <p className="mt-0.5 text-[16px] text-mist-500">
                      Running for {formatDuration(Date.now() - Date.parse(row.startedAt))}
                    </p>
                  ) : null}

                  {active && row.progress && (
                    <p className="mt-0.5 truncate text-[16px] text-aqua-700">
                      {row.progress.message}
                      {row.progress.total !== undefined && (
                        <span className="text-mist-500">
                          {' '}
                          {row.progress.done !== undefined
                            ? `${row.progress.done} of ${row.progress.total}`
                            : `${row.progress.total} found`}
                        </span>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {job.notes.length > 0 && (
            <details className="mt-2 text-[17px] text-mist-400">
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

/**
 * Every source a batch reads, the way single search lists them: the links in
 * the sheet and the box above, each country's official tourism site, and the
 * map, encyclopedia and photo services every city is searched against.
 */
function BatchSources({ countries, sheetLinks, typed }: { countries: string[]; sheetLinks: string[]; typed: string }) {
  const countryKey = [...new Set(countries.map((country) => country.trim()).filter(Boolean))].sort().join('|');
  const [catalogue, setCatalogue] = useState<SourceLink[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const list = countryKey ? countryKey.split('|') : [''];
    void Promise.all(list.map((country) => fetchSourceCatalogue(controller.signal, country || undefined)))
      .then((lists) => {
        const seen = new Set<string>();
        const merged: SourceLink[] = [];
        for (const source of lists.flat()) {
          const key = source.url.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(source);
        }
        setCatalogue(merged);
      });
    return () => controller.abort();
  }, [countryKey]);

  const added = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of [...sheetLinks, ...typed.split(/[,\n]+/)]) {
      const value = raw.trim();
      if (!value) continue;
      try {
        const href = new URL(value).href;
        if (!seen.has(href.toLowerCase())) {
          seen.add(href.toLowerCase());
          out.push(href);
        }
      } catch {
        // Half-typed or not a link: nothing to show yet.
      }
    }
    return out;
  }, [sheetLinks, typed]);

  if (catalogue.length === 0 && added.length === 0) return null;

  return (
    <SourcesDisclosure
      count={catalogue.length + added.length}
      extra={added.length > 0 ? `${added.length} from your sheet and links` : undefined}
      footer="Read for every city in the sheet."
    >
      {added.map((url) => (
        <li key={`added-${url}`} className="flex items-baseline gap-1.5">
          <span className="shrink-0 rounded bg-aqua-500/10 px-1.5 text-[16px] font-semibold text-aqua-300">yours</span>
          <SourceAnchor source={{ label: new URL(url).hostname, url }} />
        </li>
      ))}
      {catalogue.map((source) => (
        <li key={source.url}>
          <SourceAnchor source={source} />
        </li>
      ))}
    </SourcesDisclosure>
  );
}

const fieldClass =
  'mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[18px] text-mist-50 outline-none transition placeholder:text-mist-500/60 focus:border-aqua-500/50 disabled:opacity-60';

function SectionTitle({ step, title, tone }: { step: string; title: string; tone: string }) {
  return (
    <h3 className="flex items-center gap-2 text-[20px] font-semibold text-mist-100">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[17px] font-bold ${tone}`}>
        {step}
      </span>
      {title}
    </h3>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[18px] font-semibold text-mist-300">
      {children}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-mist-300">
      {children}
    </span>
  );
}
