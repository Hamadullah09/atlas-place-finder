/**
 * Run with: npm test
 *
 * Most places in a city have no encyclopedia article — a shop, a cafe, a small
 * museum — and used to get a five-word write-up while the map data already
 * held the address, the operator, the former name and what it serves. These
 * lock in that the map data is used, and that nothing is invented from nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fallbackWriteup } from './writeup.ts';

const place = (tags, extra = {}) => ({
  id: 'n1',
  osmType: 'node',
  osmId: 1,
  name: tags.name ?? 'Test Place',
  categoryLabel: 'Supermarket',
  lat: 0,
  lon: 0,
  tags,
  contact: {},
  images: [],
  qualityScore: 50,
  ...extra,
});

describe('fallbackWriteup — map data', () => {
  it('says where a place is, from the addr:* parts', () => {
    const { overview } = fallbackWriteup(
      place({ name: 'Raatuse Selver', 'addr:street': 'Raatuse', 'addr:housenumber': '20', 'addr:city': 'Tartu' }),
      undefined,
    );
    assert.match(overview, /at Raatuse 20, Tartu/);
  });

  it('prefers a ready-made address tag over the parts', () => {
    const { overview } = fallbackWriteup(
      place({ name: 'Museum', address: 'Riia 12, 51013 Tartu', 'addr:street': 'Ignored' }),
      undefined,
    );
    assert.match(overview, /at Riia 12, 51013 Tartu/);
    assert.doesNotMatch(overview, /Ignored/);
  });

  it('gives the English name when it differs', () => {
    const { overview } = fallbackWriteup(
      place({ name: 'Kaitseväe Akadeemia muuseum', 'name:en': 'Museum of the Estonian Military Academy' }),
      undefined,
    );
    assert.match(overview, /known in English as Museum of the Estonian Military Academy/);
  });

  it('does not repeat the name as its own English name', () => {
    const { overview } = fallbackWriteup(place({ name: 'Pierre', 'name:en': 'pierre' }), undefined);
    assert.doesNotMatch(overview, /known in English/);
  });

  it('reports the operator, but not one already in the name', () => {
    assert.match(fallbackWriteup(place({ name: 'Raatuse ABC', operator: 'Selver AS' }), undefined).overview, /run by Selver AS/);
    assert.doesNotMatch(fallbackWriteup(place({ name: 'Selver ABC', operator: 'Selver' }), undefined).overview, /run by/);
  });

  it('carries the former name, opening date, cuisine and materials', () => {
    const { overview } = fallbackWriteup(
      place({ name: 'X', old_name: 'Raatuse Comarket', start_date: '1876', cuisine: 'crepe;coffee_shop', material: 'red_brick' }),
      undefined,
    );
    assert.match(overview, /previously known as Raatuse Comarket/);
    assert.match(overview, /dates from 1876/);
    assert.match(overview, /serves crepe, coffee shop/);
    assert.match(overview, /built of red brick/);
  });

  it('states admission only when the tag says so', () => {
    assert.match(fallbackWriteup(place({ name: 'X', fee: 'yes' }), undefined).overview, /admission charge/i);
    assert.match(fallbackWriteup(place({ name: 'X', fee: 'no' }), undefined).overview, /Admission is free/);
    assert.doesNotMatch(fallbackWriteup(place({ name: 'X' }), undefined).overview, /admission/i);
  });

  it('lists facilities that are actually tagged', () => {
    const { highlights } = fallbackWriteup(
      place({ name: 'X', wheelchair: 'yes', outdoor_seating: 'yes', internet_access: 'wlan', 'payment:cash': 'yes' }),
      undefined,
    );
    assert.ok(highlights.includes('Step-free access'));
    assert.ok(highlights.includes('Outdoor seating'));
    assert.ok(highlights.includes('Wi-Fi'));
    assert.ok(highlights.some((h) => h.startsWith('Payment: ')));
  });

  it('invents nothing when there is nothing to say', () => {
    const { overview, history, highlights } = fallbackWriteup(place({ name: 'Bare' }), undefined);
    assert.equal(overview, 'Bare is a supermarket.');
    assert.equal(history, undefined);
    assert.deepEqual(highlights, []);
  });
});

describe('fallbackWriteup — sourced article', () => {
  // Paragraphs shorter than 40 characters are dropped as stubs, so the second
  // one here is deliberately longer than that.
  const extract = [
    'One. Two. Three. Four. Five. Six. Seven. Eight. Nine.',
    'A second paragraph follows here, long enough to be kept by the stub filter.',
  ].join('\n\n');

  it('keeps the rest of the lead paragraph instead of discarding it', () => {
    const { overview, history } = fallbackWriteup(place({ name: 'X' }), { wikipediaExtract: extract, facts: [], sources: [] });
    assert.match(overview, /One\. Two\. Three\. Four\. Five\. Six\./);
    // Sentences seven onward used to be thrown away with the slice(0, 6).
    assert.match(history, /Seven\. Eight\. Nine\./);
    assert.match(history, /A second paragraph follows here, long enough/);
  });

  it('still works when the article is a single paragraph', () => {
    const { history } = fallbackWriteup(place({ name: 'X' }), {
      wikipediaExtract: 'One. Two. Three. Four. Five. Six. Seven sentence tail.',
      facts: [],
      sources: [],
    });
    assert.match(history, /Seven sentence tail\./);
  });
});
