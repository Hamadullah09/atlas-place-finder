/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeSelectors } from './overpass.ts';
import { resolveKeyword } from '../lib/taxonomy.ts';

describe('mergeSelectors', () => {
  it('collapses several values on one key into a single term', () => {
    assert.deepEqual(
      mergeSelectors(['["amenity"="cafe"]', '["amenity"~"^(bar|pub)$"]']),
      ['["amenity"~"^(cafe|bar|pub)$"]'],
    );
  });

  it('keeps a lone value as an equality match rather than a regex', () => {
    assert.deepEqual(mergeSelectors(['["amenity"="cafe"]']), ['["amenity"="cafe"]']);
  });

  it('drops duplicates that appear in more than one category', () => {
    // "university" is both its own category and part of the college group.
    assert.deepEqual(
      mergeSelectors(['["amenity"="university"]', '["amenity"~"^(college|university)$"]']),
      ['["amenity"~"^(university|college)$"]'],
    );
  });

  it('lets a presence selector subsume the values for that key', () => {
    assert.deepEqual(
      mergeSelectors(['["historic"="castle"]', '["historic"]']),
      ['["historic"]'],
    );
  });

  it('keeps separate keys separate, in the order first seen', () => {
    assert.deepEqual(
      mergeSelectors(['["tourism"="museum"]', '["amenity"="cafe"]', '["tourism"="zoo"]']),
      ['["tourism"~"^(museum|zoo)$"]', '["amenity"="cafe"]'],
    );
  });

  it('passes compound selectors through untouched', () => {
    // Merging this into ["tourism"] would widen it to every museum.
    const compound = '["tourism"="museum"]["museum"~"history|local"]';
    assert.deepEqual(mergeSelectors([compound]), [compound]);
    assert.deepEqual(
      mergeSelectors(['["tourism"="zoo"]', compound]),
      ['["tourism"="zoo"]', compound],
    );
  });

  it('passes an unanchored regex through rather than mis-parsing it', () => {
    const loose = '["cuisine"~"coffee_shop"]';
    assert.deepEqual(mergeSelectors([loose]), [loose]);
  });

  it('leaves an empty list alone', () => {
    assert.deepEqual(mergeSelectors([]), []);
  });

  it('asks for every value "all" resolves to, in far fewer statements', () => {
    const selectors = resolveKeyword('all').selectors;
    const merged = mergeSelectors(selectors);
    assert.ok(merged.length < selectors.length / 2, 'should more than halve the statement count');

    // Nothing may be narrowed away. A merged term covers a value when it lists
    // it, or when it asks for the whole key -- ["office"] already matches every
    // office, so it subsumes ["office"~"^(financial|insurance)$"].
    const asked = (list) => {
      const byKey = new Map();
      for (const selector of list) {
        const simple = /^\["([a-z_:]+)"(?:="([^"]+)"|~"\^\(([^)]+)\)\$")?\]$/.exec(selector);
        if (!simple) continue;
        const [, key, single, alternatives] = simple;
        const entry = byKey.get(key) ?? { presence: false, values: new Set() };
        if (single !== undefined) entry.values.add(single);
        else if (alternatives !== undefined) for (const v of alternatives.split('|')) entry.values.add(v);
        else entry.presence = true;
        byKey.set(key, entry);
      }
      return byKey;
    };

    const before = asked(selectors);
    const after = asked(merged);
    for (const [key, entry] of before) {
      const now = after.get(key);
      assert.ok(now, `merged query dropped the "${key}" key entirely`);
      if (now.presence) continue; // asks for more than before, not less
      for (const value of entry.values) {
        assert.ok(now.values.has(value), `merged query lost ${key}=${value}`);
      }
    }
  });
});
