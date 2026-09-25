/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { linksFrom, scoreLink } from './siteCrawl.ts';
import { tourismSourceFor, TOURISM_SOURCES } from '../data/tourismSources.ts';

const BASE = new URL('https://www.travelchina.org.cn/en');

describe('linksFrom', () => {
  it('resolves relative links and keeps the anchor text', () => {
    const html = '<a href="/en/destinations/anshan">Anshan City</a>';
    assert.deepEqual(linksFrom(html, BASE), [
      { url: 'https://www.travelchina.org.cn/en/destinations/anshan', anchor: 'Anshan City' },
    ]);
  });

  it('stays on the entry host', () => {
    const html = [
      '<a href="https://www.travelchina.org.cn/a">same</a>',
      '<a href="https://facebook.com/x">social</a>',
      '<a href="https://other.travelchina.org.cn/b">subdomain</a>',
    ].join('');
    assert.deepEqual(linksFrom(html, BASE).map((l) => l.anchor), ['same']);
  });

  it('drops assets, fragments and duplicates', () => {
    const html = [
      '<a href="/photo.jpg">picture</a>',
      '<a href="/brochure.pdf">pdf</a>',
      '<a href="#top">anchor</a>',
      '<a href="/city">one</a>',
      '<a href="/city#section">same page again</a>',
    ].join('');
    const urls = linksFrom(html, BASE).map((l) => l.url);
    assert.deepEqual(urls, ['https://www.travelchina.org.cn/city']);
  });

  it('strips nested markup out of the anchor text', () => {
    const html = '<a href="/x"><span class="i"></span> Visit <b>Anshan</b> </a>';
    assert.equal(linksFrom(html, BASE)[0].anchor, 'Visit Anshan');
  });
});

describe('scoreLink', () => {
  const score = (url, anchor, terms = ['Anshan']) => scoreLink({ url, anchor }, terms);

  it('scores a link that names the place above one that does not', () => {
    const named = score('https://x.org/destinations/anshan', 'Anshan');
    const other = score('https://x.org/destinations/harbin', 'Harbin');
    assert.ok(named > 0, 'a link naming the place should score');
    assert.equal(other, 0, 'an unrelated destination should not be followed');
  });

  it('ignores accents and case when matching', () => {
    assert.ok(score('https://x.org/mesto/kosice', 'Košice', ['Kosice']) > 0);
    assert.ok(score('https://x.org/a', 'KOŠICE', ['košice']) > 0);
  });

  it('matches a multi-word place in a hyphenated path', () => {
    assert.ok(score('https://x.org/destinations/ho-chi-minh-city', 'Read more', ['Ho Chi Minh City']) > 0);
  });

  it('refuses boilerplate pages even when they carry the name', () => {
    assert.equal(score('https://x.org/privacy', 'Anshan privacy policy'), 0);
    assert.equal(score('https://x.org/search?q=anshan', 'Anshan search'), 0);
  });

  it('will not follow a one or two letter term', () => {
    assert.equal(score('https://x.org/a/b', 'Go', ['Go']), 0);
  });
});

describe('tourism source catalogue', () => {
  it('looks a country up by code, case-insensitively', () => {
    assert.equal(tourismSourceFor('cn')?.url, tourismSourceFor('CN')?.url);
    assert.equal(tourismSourceFor(undefined), undefined);
    assert.equal(tourismSourceFor('ZZ'), undefined);
  });

  it('holds only https or http entry points with a country and organisation', () => {
    for (const [iso, source] of Object.entries(TOURISM_SOURCES)) {
      assert.match(iso, /^[A-Z]{2}$/, `${iso} should be an ISO 3166-1 alpha-2 code`);
      assert.ok(source.country, `${iso} should name its country`);
      assert.ok(source.organisation, `${iso} should name its organisation`);
      const url = new URL(source.url);
      assert.ok(['https:', 'http:'].includes(url.protocol), `${iso} should be an http(s) URL`);
    }
  });

  it('covers the large markets a batch run is most likely to hit', () => {
    for (const iso of ['CN', 'US', 'GB', 'FR', 'DE', 'JP', 'IN', 'BR', 'AU', 'ZA']) {
      assert.ok(TOURISM_SOURCES[iso], `${iso} should have an official tourism source`);
    }
  });
});
