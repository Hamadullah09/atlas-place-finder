import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  confirmConnectivity,
  isOffline,
  noteUpstreamSuccess,
} from '../lib/connectivity.ts';

const realFetch = globalThis.fetch;

function breakNetwork() {
  globalThis.fetch = async () => {
    const error = new Error('fetch failed');
    error.code = 'ENOTFOUND';
    throw error;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  noteUpstreamSuccess();
});

describe('recovering from an outage', () => {
  it('reports the link as up again once a probe succeeds', async () => {
    breakNetwork();
    await confirmConnectivity();
    assert.equal(isOffline(), true, 'outage is recorded');

    // The link returns: the next probe answers, which is what the parked batch
    // runner and the browser poll are both waiting on.
    globalThis.fetch = async () => new Response('', { status: 200 });
    const online = await confirmConnectivity(true);

    assert.equal(online, true);
    assert.equal(isOffline(), false, 'the outage clears without a restart');
  });

  it('keeps reporting the outage while the link is still down', async () => {
    breakNetwork();
    await confirmConnectivity();

    // A second look changes nothing while the link is genuinely gone.
    await confirmConnectivity(true);
    assert.equal(isOffline(), true);
  });
});
