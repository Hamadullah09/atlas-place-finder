/**
 * Run with: npm test
 *
 * Each country's Wikivoyage guide and Wikipedia article come from the sources
 * sheet; these check the lookup and the page-title parsing, without network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findCountryReference } from '../data/countryReferences.ts';
import { pageOf } from './countryPages.ts';

describe('findCountryReference', () => {
  it('finds a country by the code Nominatim returns', () => {
    const japan = findCountryReference('jp');
    assert.equal(japan?.wikivoyage, 'https://en.wikivoyage.org/wiki/Japan');
    assert.equal(japan?.wikipedia, 'https://en.wikipedia.org/wiki/Japan');
  });

  it('falls back to the name the form collects, including a short form', () => {
    assert.equal(findCountryReference(undefined, 'Japan')?.country, 'Japan');
    // The sheet says "People's Republic of China"; people type "China".
    assert.equal(findCountryReference(undefined, 'China')?.wikivoyage, 'https://en.wikivoyage.org/wiki/China');
  });

  it('returns nothing for an unknown country rather than a guess', () => {
    assert.equal(findCountryReference(undefined, 'Atlantis'), undefined);
    assert.equal(findCountryReference(undefined, 'Ab'), undefined);
  });
});

describe('pageOf', () => {
  it('turns a wiki URL into its host and title', () => {
    assert.deepEqual(pageOf('https://en.wikivoyage.org/wiki/Sri_Lanka'), {
      host: 'en.wikivoyage.org',
      title: 'Sri Lanka',
    });
    assert.deepEqual(pageOf('https://en.wikipedia.org/wiki/C%C3%B4te_d%27Ivoire'), {
      host: 'en.wikipedia.org',
      title: "Côte d'Ivoire",
    });
  });

  it('rejects anything that is not an article link', () => {
    assert.equal(pageOf('https://en.wikivoyage.org/'), undefined);
    assert.equal(pageOf('not a url'), undefined);
  });
});
