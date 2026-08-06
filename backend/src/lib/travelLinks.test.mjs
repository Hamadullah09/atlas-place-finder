/** Run with: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTravelLinks } from './travelLinks.ts';

const KARACHI = { name: 'Mohatta Palace', city: 'Karachi', country: 'Pakistan', countryCode: 'PK' };
const BEIJING = { name: 'Great Wall', city: 'Beijing', country: 'China', countryCode: 'CN' };

test('worldwide providers appear everywhere', () => {
  const ids = buildTravelLinks(KARACHI).map((l) => l.id);
  assert.ok(ids.includes('tripadvisor'));
  assert.ok(ids.includes('viator'));
  assert.ok(ids.includes('getyourguide'));
  assert.ok(ids.includes('tripcom'));
});

test('China-only providers are hidden outside China', () => {
  const ids = buildTravelLinks(KARACHI).map((l) => l.id);
  assert.equal(ids.includes('chinahighlights'), false);
  assert.equal(ids.includes('travelchina'), false);
});

test('China-only providers appear for CN results', () => {
  const ids = buildTravelLinks(BEIJING).map((l) => l.id);
  assert.ok(ids.includes('chinahighlights'), 'chinahighlights should show for CN');
  assert.ok(ids.includes('travelchina'), 'travelchina should show for CN');
});

test('Hong Kong and Macau also get the China providers', () => {
  for (const code of ['HK', 'MO']) {
    const ids = buildTravelLinks({ ...BEIJING, countryCode: code }).map((l) => l.id);
    assert.ok(ids.includes('chinahighlights'), `expected chinahighlights for ${code}`);
  }
});

test('an unresolved country code keeps worldwide providers only', () => {
  const ids = buildTravelLinks({ ...KARACHI, countryCode: undefined }).map((l) => l.id);
  assert.ok(ids.includes('tripadvisor'));
  assert.equal(ids.includes('chinahighlights'), false);
});

test('the place name is URL-encoded into the query', () => {
  const links = buildTravelLinks(KARACHI);
  const ta = links.find((l) => l.id === 'tripadvisor');
  assert.match(ta.url, /Mohatta%20Palace%20Karachi|Mohatta\+Palace\+Karachi/);
});

test('names with characters that would break a URL are encoded safely', () => {
  const links = buildTravelLinks({
    name: 'Café & Bar "Le Toit" / Terrace?',
    city: 'Paris',
    country: 'France',
    countryCode: 'FR',
  });
  for (const link of links) {
    // Must still parse, and must not have injected stray query params.
    const url = new URL(link.url);
    assert.ok(url.protocol === 'https:');
    assert.equal(url.searchParams.getAll('q').length <= 1, true);
  }
});

test('non-Latin names survive encoding', () => {
  const links = buildTravelLinks({
    name: 'جزیرہ شمس پیر',
    city: 'Karachi',
    country: 'Pakistan',
    countryCode: 'PK',
  });
  assert.ok(links.length > 0);
  for (const link of links) assert.doesNotThrow(() => new URL(link.url));
});

test('travelchina is flagged generic because it has no search endpoint', () => {
  const link = buildTravelLinks(BEIJING).find((l) => l.id === 'travelchina');
  assert.equal(link.generic, true);
  assert.equal(link.url, 'https://www.travelchina.org.cn/en/');
});

test('chinahighlights builds a real per-place search URL', () => {
  const link = buildTravelLinks(BEIJING).find((l) => l.id === 'chinahighlights');
  assert.equal(link.generic, undefined);
  assert.match(link.url, /search-result\/\?q=/);
  assert.match(link.url, /Great(%20|\+)Wall/);
});

test('Trip.com uses the /things-to-do/list path that actually resolves', () => {
  // /things-to-do/search 404s and /search/ 502s — regression guard.
  const link = buildTravelLinks(BEIJING).find((l) => l.id === 'tripcom');
  assert.match(link.url, /\/things-to-do\/list\?keyword=/);
});

test('an empty name yields no links rather than a bare search page', () => {
  assert.deepEqual(buildTravelLinks({ name: '', city: '', country: '', countryCode: 'PK' }), []);
});
