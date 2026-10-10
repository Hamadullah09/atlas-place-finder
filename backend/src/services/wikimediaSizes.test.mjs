/**
 * Run with: npm test
 *
 * Wikimedia answers a direct thumbnail request with HTTP 400 unless the width
 * is one of its standard sizes (mediawiki.org/wiki/Common_thumbnail_sizes).
 * A 2560px rendition and a 640px preview were both being refused, which cost
 * places photos they really had. These hold every built URL to the list.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WIKIMEDIA_THUMB_WIDTHS, deriveCommonsThumb, standardThumbWidth } from './images.ts';

const widthIn = (url) => Number(/\/(\d+)px-[^/]+$/.exec(url)?.[1]);

describe('standardThumbWidth', () => {
  it('rounds up to the next standard size', () => {
    assert.equal(standardThumbWidth(2560), 3840, 'the old serve width is not standard');
    assert.equal(standardThumbWidth(640), 960, 'the old preview width is not standard');
    assert.equal(standardThumbWidth(1300), 1920);
  });

  it('keeps a size that is already standard', () => {
    for (const width of WIKIMEDIA_THUMB_WIDTHS) assert.equal(standardThumbWidth(width), width);
  });

  it('never exceeds the largest standard size', () => {
    assert.equal(standardThumbWidth(9000), 3840);
  });

  it('treats 3840 -- 4K Ultra HD -- as the top of the list', () => {
    assert.equal(Math.max(...WIKIMEDIA_THUMB_WIDTHS), 3840);
  });
});

describe('deriveCommonsThumb', () => {
  const original = 'https://upload.wikimedia.org/wikipedia/commons/d/de/Tartu_toomkiriku_kooriosa.jpg';

  it('builds a 4K rendition at a standard size', () => {
    assert.equal(
      deriveCommonsThumb(original, 3840),
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Tartu_toomkiriku_kooriosa.jpg/3840px-Tartu_toomkiriku_kooriosa.jpg',
    );
  });

  it('snaps a non-standard request to a size Wikimedia will serve', () => {
    for (const asked of [2560, 640, 1000, 3000]) {
      const width = widthIn(deriveCommonsThumb(original, asked));
      assert.ok(WIKIMEDIA_THUMB_WIDTHS.includes(width), `${asked}px became ${width}px, which is not standard`);
    }
  });

  it('ignores a tracking query string on the original', () => {
    const url = deriveCommonsThumb(`${original}?utm_source=en.wikipedia.org&utm_content=original`, 3840);
    assert.ok(url && !url.includes('utm_'), 'the query string must not end up in the filename');
  });

  it('leaves files it cannot scale alone', () => {
    assert.equal(deriveCommonsThumb('https://upload.wikimedia.org/wikipedia/commons/a/ab/Map.svg', 3840), undefined);
    assert.equal(deriveCommonsThumb('https://example.org/photo.jpg', 3840), undefined);
  });
});
