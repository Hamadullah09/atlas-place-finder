/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isHdImage, selectIllustrated } from './images.ts';

describe('isHdImage', () => {
  it('accepts an image whose long edge meets the bar', () => {
    assert.equal(isHdImage({ width: 1920, height: 1080 }), true);
  });

  it('judges the long edge, so a tall portrait counts', () => {
    // Width alone would have thrown this away.
    assert.equal(isHdImage({ width: 1200, height: 1800 }), true);
  });

  it('rejects anything smaller', () => {
    assert.equal(isHdImage({ width: 800, height: 600 }), false);
  });

  it('rejects an image that does not report its size', () => {
    assert.equal(isHdImage({}), false);
  });
});

describe('selectIllustrated', () => {
  const place = (id) => ({ id });
  const photo = { url: 'x', downloadUrl: 'x', thumbUrl: 'x', source: 'commons', width: 2000, height: 1500 };

  it('leaves out places with no photo and keeps the ranking order', () => {
    const ranked = [place('a'), place('b'), place('c'), place('d')];
    const images = new Map([['a', [photo]], ['c', [photo]], ['d', [photo]]]);

    const { kept, withoutImages } = selectIllustrated(ranked, images, 10);

    assert.deepEqual(kept.map((p) => p.id), ['a', 'c', 'd']);
    assert.equal(withoutImages, 1);
  });

  it('stops at the requested count even when more have photos', () => {
    const ranked = [place('a'), place('b'), place('c')];
    const images = new Map(ranked.map((p) => [p.id, [photo]]));

    assert.deepEqual(selectIllustrated(ranked, images, 2).kept.map((p) => p.id), ['a', 'b']);
  });

  it('treats an empty image list the same as none', () => {
    const { kept, withoutImages } = selectIllustrated([place('a')], new Map([['a', []]]), 5);
    assert.equal(kept.length, 0);
    assert.equal(withoutImages, 1);
  });
});
