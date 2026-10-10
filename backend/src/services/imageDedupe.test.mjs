/**
 * Run with: npm test
 *
 * A photo found by free-text or nearby search may go to one place only. Each
 * place used to be cut to its quota before that rule ran, so an earlier place
 * could claim a later one's top photos and leave it with nothing, though it
 * had more below the cut.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing } from './images.ts';

const { dedupeAcrossPlaces } = __testing;

const photo = (name, source = 'commons-geo') => ({
  url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`,
  downloadUrl: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`,
  thumbUrl: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`,
  width: 4000,
  height: 3000,
  source,
});
const names = (images) => images.map((image) => image.url.split('/').pop());

describe('dedupeAcrossPlaces', () => {
  it('gives a later place its next-best photos when its best are taken', () => {
    const places = [{ id: 'first' }, { id: 'second' }];
    const result = new Map([
      ['first', [photo('A'), photo('B')]],
      ['second', [photo('A'), photo('B'), photo('C'), photo('D')]],
    ]);
    dedupeAcrossPlaces(places, result, 2);
    assert.deepEqual(names(result.get('first')), ['A.jpg', 'B.jpg']);
    assert.deepEqual(names(result.get('second')), ['C.jpg', 'D.jpg']);
  });

  it('still never repeats a searched photo across places', () => {
    const places = [{ id: 'first' }, { id: 'second' }];
    const result = new Map([
      ['first', [photo('A')]],
      ['second', [photo('A')]],
    ]);
    dedupeAcrossPlaces(places, result, 6);
    assert.deepEqual(names(result.get('first')), ['A.jpg']);
    assert.equal(result.has('second'), false, 'a place left with nothing is dropped');
  });

  it('keeps a photo linked to the place itself even when shared', () => {
    const places = [{ id: 'first' }, { id: 'second' }];
    const result = new Map([
      ['first', [photo('A')]],
      ['second', [photo('A', 'wikidata')]],
    ]);
    dedupeAcrossPlaces(places, result, 6);
    assert.deepEqual(names(result.get('second')), ['A.jpg']);
    assert.equal(result.has('first'), false, 'the linked place owns the photo');
  });

  it('holds each place to the quota', () => {
    const result = new Map([['only', ['A', 'B', 'C', 'D'].map((n) => photo(n))]]);
    dedupeAcrossPlaces([{ id: 'only' }], result, 3);
    assert.equal(result.get('only').length, 3);
  });
});
