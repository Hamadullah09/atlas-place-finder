/**
 * Run with: npm test
 *
 * Every malformed input below is a VERBATIM capture of qwen2.5:1.5b output for
 * "National Museum of Pakistan" — these are the shapes that made the write-up
 * silently fall back before the parser was made tolerant.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from './writeup.ts';

const { parseJsonObject, toProse, toBulletList, stripJsonComments } = __testing;

test('parses a well-formed object', () => {
  const parsed = parseJsonObject('{"overview":"A museum.","highlights":["a","b"]}');
  assert.equal(parsed.overview, 'A museum.');
});

test('strips // comments the model emits inside JSON', () => {
  const raw = `{
    "architecture": ["Frere Hall", // originally located here
    "National Museum"]
  }`;
  const parsed = parseJsonObject(raw);
  assert.ok(parsed, 'should parse despite comments');
  assert.deepEqual(parsed.architecture, ['Frere Hall', 'National Museum']);
});

test('does not mangle // inside a string value', () => {
  const kept = stripJsonComments('{"website":"https://example.com/x"}');
  assert.equal(JSON.parse(kept).website, 'https://example.com/x');
});

test('repairs an object truncated mid-string', () => {
  const raw = '{"overview":"Complete sentence.","practical":"Entrance fees are applicable and can be paid at the ticket cou';
  const parsed = parseJsonObject(raw);
  assert.ok(parsed, 'should recover the complete prefix');
  assert.equal(parsed.overview, 'Complete sentence.');
});

test('tolerates trailing commas', () => {
  const parsed = parseJsonObject('{"overview":"Text.","highlights":["a","b",],}');
  assert.equal(parsed.overview, 'Text.');
});

test('coerces an array-of-objects history into prose', () => {
  const history = [
    { year: '1951', event: 'Established, replacing the Victoria Museum' },
    { year: '1970', event: 'Moved to its current location' },
  ];
  const prose = toProse(history);
  assert.match(prose, /1951/);
  assert.match(prose, /Established/);
  assert.match(prose, /1970/);
});

test('coerces an object visiting field into prose', () => {
  const prose = toProse({ opening_hours: 'Th-Tu: 10:00-17:00', address: 'Shahrah e Kamal Ata Turk' });
  assert.match(prose, /Opening hours: Th-Tu: 10:00-17:00/);
  assert.match(prose, /Address: Shahrah e Kamal Ata Turk/);
});

test('passes plain strings through untouched', () => {
  assert.equal(toProse('A public museum in Karachi.'), 'A public museum in Karachi.');
});

test('highlights: array stays a list', () => {
  assert.deepEqual(toBulletList(['Ancient artifacts', 'Islamic art']), [
    'Ancient artifacts',
    'Islamic art',
  ]);
});

test('highlights: a single blob is split into items', () => {
  const items = toBulletList('Ancient artifacts; Islamic art collections; Modern exhibitions');
  assert.equal(items.length, 3);
  assert.equal(items[2], 'Modern exhibitions');
});

test('highlights: bullet characters are stripped', () => {
  assert.deepEqual(toBulletList('- Ancient artifacts\n- Islamic art'), [
    'Ancient artifacts',
    'Islamic art',
  ]);
});

test('returns null when there is no object at all', () => {
  assert.equal(parseJsonObject('I cannot help with that request.'), null);
});
