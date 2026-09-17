/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commonsGatewayQuery } from './images.ts';

// Each expected string matches a form checked against the live gateway
// (api.wikimedia.org/core/v1/commons/search/page) before this was written.

describe('commonsGatewayQuery', () => {
  it('restricts a text search to images', () => {
    assert.equal(commonsGatewayQuery.search('Anshan museum'), 'filetype:bitmap Anshan museum');
  });

  it('lists a category with incategory:, with or without the prefix', () => {
    assert.equal(commonsGatewayQuery.category('Anshan'), 'filetype:bitmap incategory:"Anshan"');
    assert.equal(commonsGatewayQuery.category('Category:Anshan'), 'filetype:bitmap incategory:"Anshan"');
  });

  it('cannot be broken out of the category name by a quote', () => {
    // A stray quote would otherwise end the name and inject search syntax.
    assert.equal(
      commonsGatewayQuery.category('Bad" OR insource:"x'),
      'filetype:bitmap incategory:"Bad OR insource:x"',
    );
  });

  it('searches by position in whole metres', () => {
    assert.equal(
      commonsGatewayQuery.near(41.1087, 122.9946, 1),
      'filetype:bitmap nearcoord:1000m,41.108700,122.994600',
    );
  });

  it('caps the radius so a bad setting cannot search a whole region', () => {
    assert.match(commonsGatewayQuery.near(0, 0, 500), /nearcoord:10000m,/);
  });

  it('never asks for a zero radius', () => {
    assert.match(commonsGatewayQuery.near(0, 0, 0), /nearcoord:1m,/);
  });
});
