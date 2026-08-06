/**
 * Run with:  npm test        (node --import tsx --test)
 *
 * Cases 1-4 are the exact failures observed from qwen2.5:1.5b on a real
 * "tourist places in Karachi" run; the rest guard against over-stripping.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripUnsupportedHoursClaims, daysCoveredByTag, daysClaimedInText } from './factCheck.ts';

test('strips a reworded day range that excludes a closed day', () => {
  // Tag covers Th,Fr,Sa,Su,Mo,Tu — Wednesday is closed.
  const result = stripUnsupportedHoursClaims(
    'Museum in Karachi, Pakistan. Open Monday to Friday from 10:00-17:00.',
    'Th-Tu 10:00-17:00',
  );
  assert.equal(result.summary, 'Museum in Karachi, Pakistan.');
  assert.equal(result.removed.length, 1);
});

test('strips hours invented for a place with no opening_hours tag', () => {
  const result = stripUnsupportedHoursClaims(
    'Attraction in Karachi, Pakistan. Open Monday to Friday.',
    undefined,
  );
  assert.equal(result.summary, 'Attraction in Karachi, Pakistan.');
  assert.equal(result.removed.length, 1);
});

test('strips fully fabricated hours for an archaeological site', () => {
  const result = stripUnsupportedHoursClaims(
    'Chaukandi Tombs is a historic site. Open daily from 09:00 to 23:00.',
    undefined,
  );
  assert.equal(result.summary, 'Chaukandi Tombs is a historic site.');
});

test('keeps a faithful rendering of a bare time span', () => {
  // "10:00-23:00" has no day restriction, so "daily" is accurate.
  const result = stripUnsupportedHoursClaims(
    'A theme park in Karachi. Open daily from 10:00 to 23:00.',
    '10:00-23:00',
  );
  assert.equal(result.summary, 'A theme park in Karachi. Open daily from 10:00 to 23:00.');
  assert.equal(result.removed.length, 0);
});

test('keeps a claim that matches the tag exactly', () => {
  const result = stripUnsupportedHoursClaims(
    'A museum. Open Monday to Friday from 09:00 to 17:00.',
    'Mo-Fr 09:00-17:00',
  );
  assert.equal(result.removed.length, 0);
});

test('strips a claim citing a time absent from the tag', () => {
  const result = stripUnsupportedHoursClaims(
    'A cafe. Open Monday to Friday from 08:00 to 22:00.',
    'Mo-Fr 09:00-17:00',
  );
  assert.equal(result.summary, 'A cafe.');
});

test('leaves summaries with no schedule claim untouched', () => {
  const text = 'Empress Market is a marketplace in Karachi, Pakistan. It is well mapped.';
  assert.equal(stripUnsupportedHoursClaims(text, undefined).summary, text);
});

test('does not strip the word "open" without a time reference', () => {
  const text = 'A park in Karachi with open green space.';
  assert.equal(stripUnsupportedHoursClaims(text, undefined).summary, text);
});

test('24/7 covers every day', () => {
  assert.equal(daysCoveredByTag('24/7').size, 7);
});

test('wrap-around ranges expand correctly', () => {
  const days = daysCoveredByTag('Th-Tu 10:00-17:00');
  assert.equal(days.has(2), false, 'Wednesday must be excluded');
  assert.equal(days.size, 6);
});

test('comma-separated day lists parse', () => {
  const days = daysCoveredByTag('Mo,We,Fr 09:00-12:00');
  assert.deepEqual([...days].sort(), [0, 2, 4]);
});

test('"weekends" claims Saturday and Sunday', () => {
  assert.deepEqual([...daysClaimedInText('Open weekends only')].sort(), [5, 6]);
});

test('empty tag yields null, not an empty set', () => {
  assert.equal(daysCoveredByTag(undefined), null);
  assert.equal(daysCoveredByTag('  '), null);
});
