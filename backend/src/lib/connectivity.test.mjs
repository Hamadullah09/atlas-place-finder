import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  confirmConnectivity,
  connectivityState,
  isOffline,
  noteUpstreamFailure,
  noteUpstreamSuccess,
} from './connectivity.ts';

const realFetch = globalThis.fetch;

/** Makes every probe fail, as a dead link does. */
function breakNetwork() {
  globalThis.fetch = async () => {
    const error = new Error('fetch failed');
    error.code = 'ENOTFOUND';
    throw error;
  };
}

function restoreNetwork() {
  globalThis.fetch = realFetch;
}

function networkError(code = 'ENOTFOUND') {
  const error = new Error('fetch failed');
  error.code = code;
  return error;
}

afterEach(() => {
  restoreNetwork();
  noteUpstreamSuccess();
});

describe('connectivity', () => {
  it('starts out believing the link is up', () => {
    noteUpstreamSuccess();
    assert.equal(isOffline(), false);
    assert.deepEqual(connectivityState(), { online: true });
  });

  it('declares an outage only once a probe confirms it', async () => {
    breakNetwork();
    const online = await confirmConnectivity();

    assert.equal(online, false);
    assert.equal(isOffline(), true);

    const state = connectivityState();
    assert.equal(state.online, false);
    assert.ok(state.offlineSince, 'records when the outage began');
  });

  it('clears the outage as soon as anything upstream answers', async () => {
    breakNetwork();
    await confirmConnectivity();
    assert.equal(isOffline(), true);

    noteUpstreamSuccess();
    assert.equal(isOffline(), false);
  });

  it('ignores failures that are not connectivity problems', () => {
    noteUpstreamSuccess();

    // A 404 or a parse error says nothing about the link.
    for (let i = 0; i < 5; i += 1) noteUpstreamFailure(new Error('404 Not Found'));

    assert.equal(isOffline(), false);
  });

  it('does not treat a single unreachable host as an outage', async () => {
    noteUpstreamSuccess();

    // One flaky upstream: below the threshold, nothing is probed or declared.
    noteUpstreamFailure(networkError());
    noteUpstreamFailure(networkError());

    assert.equal(isOffline(), false);
  });
});
