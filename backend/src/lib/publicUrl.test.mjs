/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkPublicHttpsUrl, fetchPublicImage, isPrivateAddress } from './publicUrl.ts';

describe('isPrivateAddress', () => {
  it('rejects every address that stays inside a network', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', // cloud metadata service
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:192.168.0.10', // IPv4 hiding in IPv6
    ]) {
      assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '151.101.1.69', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, `${address} should be public`);
    }
  });

  it('treats something that is not an address as unsafe', () => {
    assert.equal(isPrivateAddress('not-an-ip'), true);
  });
});

describe('checkPublicHttpsUrl', () => {
  it('accepts a normal https image URL', () => {
    assert.equal(checkPublicHttpsUrl('https://example.org/photo.jpg').hostname, 'example.org');
  });

  it('refuses anything that is not https', () => {
    assert.throws(() => checkPublicHttpsUrl('http://example.org/photo.jpg'), /https/);
    assert.throws(() => checkPublicHttpsUrl('file:///etc/passwd'), /https/);
  });

  it('refuses private address literals, including the metadata service', () => {
    assert.throws(() => checkPublicHttpsUrl('https://169.254.169.254/latest/meta-data/'), /non-public/);
    assert.throws(() => checkPublicHttpsUrl('https://192.168.1.1/admin.png'), /non-public/);
    assert.throws(() => checkPublicHttpsUrl('https://[::1]/x.png'), /non-public/);
  });

  it('refuses names that only mean something on a local network', () => {
    assert.throws(() => checkPublicHttpsUrl('https://localhost/x.png'), /local hostname/);
    assert.throws(() => checkPublicHttpsUrl('https://printer.local/x.png'), /local hostname/);
    assert.throws(() => checkPublicHttpsUrl('https://router.home.arpa/x.png'), /local hostname/);
  });

  it('refuses credentials smuggled into the URL', () => {
    assert.throws(() => checkPublicHttpsUrl('https://user:pass@example.org/x.png'), /credentials/);
  });
});

describe('fetchPublicImage', () => {
  it('refuses before connecting when the URL itself is unsafe', async () => {
    await assert.rejects(fetchPublicImage('https://127.0.0.1/secret.png'), /non-public/);
  });

  it('refuses a hostname that resolves to a private address', async (t) => {
    // localtest.me is public DNS that answers loopback for every name --
    // exactly the trick a hostile page would use. The guard runs inside the
    // socket's own lookup, so the connection is never made.
    try {
      await fetchPublicImage('https://anything.localtest.me/x.png');
      assert.fail('the request should have been refused');
    } catch (error) {
      // Without DNS there is nothing to prove; say so rather than pass.
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
        t.skip('DNS unavailable, so the guard could not be exercised');
        return;
      }
      assert.equal(error.code, 'EPRIVATE');
      assert.match(error.message, /non-public address/);
    }
  });
});
