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

test('keeps an article the model wrote as formatted text instead of JSON', () => {
  // Seen live: qwen3:8b answered the Forbidden City in Markdown, and the place
  // fell back to source extracts although the article was good.
  const article = [
    'The Forbidden City, known as **Zijin Cheng** in Chinese, is a monumental symbol of imperial China, at the heart of Beijing.',
    '',
    '## History',
    'Built between 1406 and 1420 under the Yongle Emperor, it was home to 24 emperors of the Ming and Qing dynasties.',
    '',
    '## Architecture',
    'Its 980 buildings follow a strict north-south axis, with yellow glazed roofs reserved for the emperor.',
    '',
    '## Highlights',
    '- **Hall of Supreme Harmony**, the largest wooden hall in China',
    '- The Imperial Garden',
    '',
    '## Visiting',
    'Visitors enter through the Meridian Gate in the south and leave by the Gate of Divine Prowess.',
  ].join('\n');
  const sections = __testing.sectionsFromProse(article);
  assert.ok(sections, 'a substantial article is kept');
  assert.match(sections.overview, /monumental symbol/);
  assert.ok(!sections.overview.includes('**'), 'Markdown emphasis is removed');
  assert.match(sections.history, /Yongle Emperor/);
  assert.match(sections.architecture, /980 buildings/);
  assert.deepEqual(sections.highlights, ['Hall of Supreme Harmony, the largest wooden hall in China', 'The Imperial Garden']);
  assert.match(sections.visiting, /Meridian Gate/);
});

test('does not keep a scrap of text as an article', () => {
  assert.equal(__testing.sectionsFromProse('Sorry, I cannot help with that.'), null);
});
