import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient cancellation for one unit of work.
 *
 * A batch row fans out into hundreds of calls — Overpass, Wikipedia, the LLM,
 * every image — across a dozen modules. Threading an AbortSignal through all of
 * them by hand would touch every signature for a flag that only one caller ever
 * sets, so it rides in async context instead: `runCancellable` marks the scope
 * and the HTTP layer picks the signal up on its own.
 */
const storage = new AsyncLocalStorage<AbortSignal>();

export function runCancellable<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return storage.run(signal, fn);
}

/** The signal for the work in flight, if it was started inside a scope. */
export function cancelSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/** Throws the standard AbortError when the surrounding scope was cancelled. */
export function throwIfCancelled(): void {
  storage.getStore()?.throwIfAborted();
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
