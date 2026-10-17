/**
 * Run with: npm test
 *
 * On a network that blocks commons.wikimedia.org, imageinfo lookups fall back
 * to Wikipedia. The block used to be forgotten whenever that fallback worked,
 * so every lookup tried the blocked host first, in an API queue that runs one
 * request at a time. And Wikimedia rate-limits a User-Agent without contact
 * details as an anonymous client, which stalled lookups on 429s.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { SAFE_DEFAULT_USER_AGENT, hasContactInfo } from '../config.ts';
import { resetHttpPolicy } from '../lib/http.ts';
import { commonsFilesViaGateway } from './images.ts';

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

describe('a blocked Commons host', () => {
  it('is tried once, not on every lookup', async () => {
    resetHttpPolicy();
    const hits = { commons: 0, wikipedia: 0 };
    globalThis.fetch = async (url) => {
      const { hostname, searchParams } = new URL(String(url));
      if (hostname === 'api.wikimedia.org') {
        return Response.json({ pages: [{ key: 'File:Tartu_town_hall.jpg' }] });
      }
      if (hostname === 'commons.wikimedia.org') {
        hits.commons += 1;
        throw new TypeError('fetch failed'); // a connection reset, as on the blocked network
      }
      hits.wikipedia += 1;
      const title = searchParams.get('titles');
      return Response.json({
        query: {
          pages: {
            '-1': {
              title,
              imageinfo: [{
                url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tartu_town_hall.jpg',
                width: 3000,
                height: 2000,
                mime: 'image/jpeg',
              }],
            },
          },
        },
      });
    };

    const first = await commonsFilesViaGateway('Tartu town hall', 1, 'commons');
    // One failed lookup may include its own retry of the connection.
    const triedFirst = hits.commons;
    assert.ok(triedFirst >= 1);
    const second = await commonsFilesViaGateway('Tartu town hall', 1, 'commons');
    assert.equal(first.length, 1, 'the photo still arrives through Wikipedia');
    assert.equal(second.length, 1);
    assert.equal(hits.commons, triedFirst, 'the blocked host was tried again after it failed');
    assert.equal(hits.wikipedia, 2);
  });
});

describe('User-Agent contact details', () => {
  it('accepts a website, an email address or a wiki user', () => {
    assert.ok(hasContactInfo('Bot/1.0 (https://my.site/bot)'));
    assert.ok(hasContactInfo('Bot/1.0 (ops@my.site)'));
    assert.ok(hasContactInfo('Bot/1.0 (wikipedia:en; User:SomeBot)'));
  });

  it('rejects one with nothing to contact', () => {
    assert.ok(!hasContactInfo('PlaceFinder/1.0 (self-hosted; set HTTP_USER_AGENT to your contact URL)'));
    assert.ok(!hasContactInfo('PlaceFinder/1.0 (self-hosted)'));
  });

  it('has a default that complies', () => {
    assert.ok(hasContactInfo(SAFE_DEFAULT_USER_AGENT));
  });
});
