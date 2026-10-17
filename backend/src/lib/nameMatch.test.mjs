/**
 * Run with: npm test
 *
 * Photos found near a place, or by a loose search, are kept only when their
 * own words name it. The cases are the Shenzhen museum batch of 17 October
 * 2026, whose folders were filled with nearby cars, shops and metro stations.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describesPlace } from './nameMatch.ts';

const city = 'Shenzhen';

describe('describesPlace', () => {
  it('rejects the nearby photos that filled the Shenzhen folders', () => {
    const wrong = [
      ['MAZDA3 HATCHBACK (BK) China.jpg', 'Shenzhen Art Academy'],
      ['National (Panasonic) AIR CONDITIONER OUTDOOR UNIT CU-HC912KW.jpg', 'Shenzhen Archives Center'],
      ['CBD SHENZHEN BOOK CITY (81).jpg', 'Shenzhen Industrial Museum'],
      ['Guangming Station Branch Line 6 platform 12-10-2026(6).jpg', 'Shenzhen Science & Technology Museum'],
      ['Longbei () Concourse L1 F2 (2023-03-04).webp', 'Shenzhen Natural History Museum'],
      ['SZ Shenzhen Nanshan Shenzhen Bay MixC mall shop Valerie May 2026', 'Shenzhen Bay Cultural Plaza'],
      ['Shenzhen Lianhuashan Park-20101231-RM-134111.jpg', 'Shenzhen Museum'],
    ];
    for (const [title, place] of wrong) assert.equal(describesPlace(title, [place], city), false, `${place} took "${title}"`);
  });

  it('keeps photos that name the place', () => {
    assert.ok(describesPlace('SZ Shenzhen Museum entrance building name Aug-2010.jpg', ['Shenzhen Museum'], city));
    assert.ok(describesPlace('Shenzhen Science and Technology Museum (3).jpg', ['Shenzhen Science & Technology Museum'], city));
    assert.ok(describesPlace('File:Shenzhen_Bay_Cultural_Plaza_2024.jpg', ['Shenzhen Bay Cultural Plaza'], city));
  });

  it('reads the description and categories too', () => {
    const about = 'IMG_2231.jpg | Main hall | Categories: Shenzhen Natural History Museum';
    assert.ok(describesPlace(about, ['Shenzhen Natural History Museum'], city));
  });

  it('matches a Chinese name as written', () => {
    assert.ok(describesPlace('深圳博物馆 历史民俗馆 正门.jpg', ['Shenzhen Museum', '深圳博物馆'], city));
    assert.equal(describesPlace('深圳图书馆.jpg', ['深圳博物馆'], city), false);
  });

  it('has nothing to match without text', () => {
    assert.equal(describesPlace('', ['Shenzhen Museum'], city), false);
  });
});
