/**
 * Run with: npm test
 *
 * Wikimedia's robot policy (wikitech.wikimedia.org/wiki/Robot_policy) allows
 * an unauthenticated client 1 Action API request at a time, 3 REST requests,
 * and 2 media downloads. The app used to run up to 24 downloads at once and
 * drew 429s that cost places their photos. These measure, through a stand-in
 * for fetch, how many requests are really in flight.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { fetchBuffer, fetchJson, resetHttpPolicy, wikimediaLane } from './http.ts';

const realFetch = globalThis.fetch;
let inFlight = 0;
let peak = 0;
let calls = [];

/** A fetch that takes `ms` to answer and remembers the busiest moment. */
function fakeFetch({ ms = 40, status = 200, headers = {}, body = '{"ok":true}' } = {}) {
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight -= 1;
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  };
}

beforeEach(() => {
  resetHttpPolicy();
  inFlight = 0;
  peak = 0;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('wikimediaLane', () => {
  it('sorts requests into the parts of the policy that govern them', () => {
    assert.equal(wikimediaLane('https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg'), 'media');
    assert.equal(wikimediaLane('https://en.wikipedia.org/w/api.php?action=query'), 'action');
    assert.equal(wikimediaLane('https://commons.wikimedia.org/w/api.php?action=query'), 'action');
    assert.equal(wikimediaLane('https://www.wikidata.org/w/api.php?action=wbgetentities'), 'action');
    assert.equal(wikimediaLane('https://api.wikimedia.org/core/v1/commons/search/page?q=x'), 'rest');
    assert.equal(wikimediaLane('https://en.wikipedia.org/api/rest_v1/page/summary/X'), 'rest');
  });

  it('leaves everything else alone', () => {
    assert.equal(wikimediaLane('https://query.wikidata.org/sparql?query=x'), undefined);
    assert.equal(wikimediaLane('https://en.wikipedia.org/wiki/Tartu'), undefined);
    assert.equal(wikimediaLane('https://api.openverse.org/v1/images/'), undefined);
    assert.equal(wikimediaLane('https://notwikipedia.org/w/api.php'), undefined);
    assert.equal(wikimediaLane('not a url'), undefined);
  });
});

describe('Wikimedia robot-policy limits', () => {
  it('runs one Action API request at a time', async () => {
    fakeFetch();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => fetchJson(`https://en.wikipedia.org/w/api.php?i=${i}`, { retries: 0 })),
    );
    assert.equal(peak, 1);
  });

  it('counts every wiki against the same Action API allowance', async () => {
    fakeFetch();
    await Promise.all([
      fetchJson('https://en.wikipedia.org/w/api.php?a=1', { retries: 0 }),
      fetchJson('https://www.wikidata.org/w/api.php?a=2', { retries: 0 }),
      fetchJson('https://commons.wikimedia.org/w/api.php?a=3', { retries: 0 }),
    ]);
    assert.equal(peak, 1, 'the limit is per client, not per wiki');
  });

  it('keeps the Action API under five requests a second', async () => {
    fakeFetch({ ms: 1 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetchJson(`https://en.wikipedia.org/w/api.php?r=${i}`, { retries: 0 })),
    );
    const span = calls.at(-1).at - calls[0].at;
    // Six starts at <= 5/s need at least five gaps of 200ms.
    assert.ok(span >= 950, `six requests started within ${span}ms`);
  });

  it('runs at most two media downloads at a time', async () => {
    fakeFetch({ body: 'x'.repeat(1000) });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetchBuffer(`https://upload.wikimedia.org/wikipedia/commons/a/ab/P${i}.jpg`, { retries: 0 })),
    );
    assert.equal(peak, 2);
  });

  it('runs at most three REST requests at a time', async () => {
    // Slow answers, so the three-at-a-time cap binds before the five-a-second
    // spacing does; with fast answers the spacing alone keeps it to one.
    fakeFetch({ ms: 700 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetchJson(`https://api.wikimedia.org/core/v1/commons/search/page?q=${i}`, { retries: 0 })),
    );
    assert.equal(peak, 3);
  });

  it('does not slow down traffic to anyone else', async () => {
    fakeFetch();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetchJson(`https://api.openverse.org/v1/images/?q=${i}`, { retries: 0 })),
    );
    assert.equal(peak, 6);
  });
});

describe('Retry-After', () => {
  it('holds the whole host, not just the request that was refused', async () => {
    let first = true;
    globalThis.fetch = async (url) => {
      calls.push({ url: String(url), at: Date.now() });
      if (first) {
        first = false;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const refusedAt = Date.now();
    await assert.rejects(fetchJson('https://api.openverse.org/v1/images/?q=a', { retries: 0 }));
    // A different request to the same host must wait out the one-second hold.
    await fetchJson('https://api.openverse.org/v1/images/?q=b', { retries: 0 });
    const waited = calls[1].at - refusedAt;
    assert.ok(waited >= 900, `second request went out after only ${waited}ms`);
  });
});
