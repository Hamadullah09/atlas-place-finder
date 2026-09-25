/** Run with: npm test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRobots, robotsAllows } from './robots.ts';

const allows = (text, path, token = 'sma-place-finder') =>
  robotsAllows(parseRobots(text, token), path);

describe('parseRobots', () => {
  it('applies the wildcard group when no group names us', () => {
    const text = 'User-agent: *\nDisallow: /admin/\n';
    assert.equal(allows(text, '/destinations/anshan'), true);
    assert.equal(allows(text, '/admin/users'), false);
  });

  it('prefers the group that names us over the wildcard group', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: sma-place-finder',
      'Disallow: /private/',
    ].join('\n');
    // The wildcard bans everything, but our own group only bans /private/.
    assert.equal(allows(text, '/destinations'), true);
    assert.equal(allows(text, '/private/x'), false);
  });

  it('treats consecutive user-agent lines as one group', () => {
    const text = 'User-agent: googlebot\nUser-agent: *\nDisallow: /nope\n';
    assert.equal(allows(text, '/nope'), false);
    assert.equal(allows(text, '/yes'), true);
  });

  it('reads an empty Disallow as permission, not a ban on everything', () => {
    assert.equal(allows('User-agent: *\nDisallow:\n', '/anything'), true);
  });

  it('lets the longest matching rule win, with Allow breaking a tie', () => {
    const text = 'User-agent: *\nDisallow: /guide/\nAllow: /guide/cities/\n';
    assert.equal(allows(text, '/guide/internal'), false);
    assert.equal(allows(text, '/guide/cities/anshan'), true);

    const tie = 'User-agent: *\nDisallow: /a\nAllow: /a\n';
    assert.equal(allows(tie, '/a'), true);
  });

  it('honours * and $ in patterns', () => {
    const wildcard = 'User-agent: *\nDisallow: /*/print\n';
    assert.equal(allows(wildcard, '/city/print'), false);
    assert.equal(allows(wildcard, '/city/overview'), true);

    const anchored = 'User-agent: *\nDisallow: /*.pdf$\n';
    assert.equal(allows(anchored, '/files/brochure.pdf'), false);
    assert.equal(allows(anchored, '/files/brochure.pdf.html'), true);
  });

  it('ignores comments, blank lines and directives before any user-agent', () => {
    const text = [
      '# a comment',
      'Disallow: /orphan',
      '',
      'User-agent: *   # trailing comment',
      'Disallow: /blocked',
      'Sitemap: https://example.org/sitemap.xml',
    ].join('\n');
    assert.equal(allows(text, '/orphan'), true);
    assert.equal(allows(text, '/blocked'), false);
  });

  it('reads Crawl-delay in seconds and caps an unreasonable one', () => {
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: 2\n').crawlDelayMs, 2000);
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: 9999\n').crawlDelayMs, 30_000);
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: nonsense\n').crawlDelayMs, 0);
  });

  it('allows everything when the file is empty or has no rules', () => {
    assert.equal(allows('', '/anything'), true);
    assert.equal(allows('Sitemap: https://example.org/s.xml', '/anything'), true);
  });
});
