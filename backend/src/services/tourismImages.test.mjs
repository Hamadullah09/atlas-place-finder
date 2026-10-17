/**
 * Run with: npm test
 *
 * Photos from the official tourism sites are taken only when they are clearly
 * of the place: named in their own alt text, title or filename, or the lead
 * image of a page whose title names it. These hold that line, and check that
 * the site is not re-read for every place.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { crawlForTerms, preferLanguageOf, resetTourismCrawlCache } from './siteCrawl.ts';
import { resetRobotsCache } from '../lib/robots.ts';
import { coversName, imagesFrom, isOfPlace, largestFromSrcset, mentions, originalCandidates, pageTitle } from './tourismImages.ts';
import { rankSitemaps, scoreLink } from './siteCrawl.ts';

const PAGE = 'https://www.visitestonia.com/en/where-to-go/tartu/tartu-town-hall';

const html = `<!doctype html><html><head>
  <title>Tartu Town Hall | Visit Estonia</title>
  <meta property="og:image" content="/media/town-hall-hero.jpg">
  <meta property="og:image:width" content="2400">
  <script type="application/ld+json">{"@type":"TouristAttraction","image":{"url":"https://cdn.visitestonia.com/jsonld.jpg"}}</script>
</head><body>
  <img src="/static/logo.svg" alt="Visit Estonia">
  <img src="/static/facebook-share.png" alt="Share">
  <img alt="Tartu Town Hall at night" srcset="/m/th-800.jpg 800w, /m/th-2560.jpg 2560w, /m/th-1600.jpg 1600w">
  <img data-src="http://cdn.visitestonia.com/m/kissing-students.jpg" alt="Kissing Students fountain">
  <img src="data:image/gif;base64,R0lGOD" alt="pixel">
</body></html>`;

describe('imagesFrom', () => {
  const images = imagesFrom(html, PAGE);
  const urls = images.map((image) => image.url);

  it('finds lead images and body photos, resolved to https', () => {
    assert.ok(urls.includes('https://www.visitestonia.com/media/town-hall-hero.jpg'));
    assert.ok(urls.includes('https://cdn.visitestonia.com/jsonld.jpg'));
    assert.ok(urls.includes('https://www.visitestonia.com/m/th-2560.jpg'), 'the widest srcset entry');
    assert.ok(urls.includes('https://cdn.visitestonia.com/m/kissing-students.jpg'), 'lazy-loaded, upgraded to https');
  });

  it('leaves out logos, share buttons, SVGs and inline data', () => {
    assert.ok(!urls.some((url) => /logo|facebook|data:/.test(url)));
  });

  it('marks lead images and keeps declared widths', () => {
    const hero = images.find((image) => image.url.endsWith('town-hall-hero.jpg'));
    assert.equal(hero.lead, true);
    assert.equal(hero.declaredWidth, 2400);
    assert.equal(images.find((image) => image.url.endsWith('th-2560.jpg')).declaredWidth, 2560);
  });
});

describe('largestFromSrcset', () => {
  it('prefers width descriptors, then density', () => {
    assert.deepEqual(largestFromSrcset('a.jpg 640w, b.jpg 1920w'), { url: 'b.jpg', width: 1920 });
    assert.equal(largestFromSrcset('a.jpg 1x, b.jpg 2x').url, 'b.jpg');
  });
});

describe('pageTitle and mentions', () => {
  it('reads the title of the page', () => {
    assert.match(pageTitle(html), /Tartu Town Hall/);
  });

  it('matches whole words, ignoring accents and case', () => {
    assert.ok(mentions('Raekoja plats in TARTU', ['Raekoja plats']));
    assert.ok(mentions('Košice old town', ['Kosice']));
    assert.ok(!mentions('Tavernas of the coast', ['Taverna']), 'a longer word is not the name');
    assert.ok(mentions('tartu-town-hall-2560.jpg', ['Tartu Town Hall']), 'filename words count');
    assert.ok(mentions('Mont-Saint-Michel: A Timeless Wonder', ['Mont Saint-Michel']), 'hyphens and spaces alike');
  });
});

describe('isOfPlace', () => {
  const title = pageTitle(html);
  const images = imagesFrom(html, PAGE);
  const find = (end) => images.find((image) => image.url.endsWith(end));

  it('takes the lead image of the page about the place', () => {
    assert.ok(isOfPlace(find('town-hall-hero.jpg'), title, ['Tartu Town Hall']));
  });

  it('takes a photo whose alt text names the place', () => {
    assert.ok(isOfPlace(find('th-2560.jpg'), title, ['Tartu Town Hall']));
  });

  it('does not take a photo of something else on the same page', () => {
    assert.ok(!isOfPlace(find('kissing-students.jpg'), title, ['Tartu Town Hall']));
  });

  it('does not take the lead image of a page about something else', () => {
    assert.ok(!isOfPlace(find('town-hall-hero.jpg'), title, ['Kissing Students']));
  });

  it('needs the page to agree before trusting a one-word name', () => {
    const photo = { url: 'https://x.ee/m/taverna.jpg', text: 'Taverna', lead: false };
    assert.ok(!isOfPlace(photo, 'Best restaurants in Estonia', ['Taverna']));
    assert.ok(isOfPlace(photo, 'Taverna | Visit Tartu', ['Taverna']));
  });
});

describe('a place found off its own page', () => {
  // Seen live: Visit Estonia's home page, a photo of Tallinn's square.
  const tallinn = {
    url: 'https://visitestonia.com/images/3736444/raekoja_plats_jouludel_toomas_tuul_1.jpeg',
    text: 'Tallinn Christmas Market with a touch of a fairy tale',
    lead: false,
  };

  it('needs the city named as well as the place', () => {
    assert.ok(!isOfPlace(tallinn, 'Visit Estonia', ['Raekoja plats'], 'Tartu'));
    assert.ok(isOfPlace(tallinn, 'Visit Estonia', ['Raekoja plats'], 'Tallinn'));
  });
});

describe('preferLanguageOf', () => {
  const base = new URL('https://www.france.fr/en/');
  const pick = (urls) => preferLanguageOf(base, urls.map((url) => ({ url, score: 1 }))).map((c) => c.url);

  it('keeps pages in the entry page language, first', () => {
    assert.deepEqual(
      pick(['https://www.france.fr/ar/article/mont', 'https://www.france.fr/press', 'https://www.france.fr/en/article/mont']),
      ['https://www.france.fr/en/article/mont', 'https://www.france.fr/press'],
    );
  });

  it('changes nothing for a site without language paths', () => {
    const urls = ['https://visit.example.ee/tartu', 'https://visit.example.ee/en/tartu'];
    assert.deepEqual(preferLanguageOf(new URL('https://visit.example.ee/'), urls.map((url) => ({ url, score: 1 }))).map((c) => c.url), urls);
  });
});

describe('crawl page cache', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetTourismCrawlCache();
    resetRobotsCache();
  });

  it('reads a site entry page once, however many places ask', async () => {
    const hits = new Map();
    globalThis.fetch = async (url) => {
      const href = String(url);
      hits.set(href, (hits.get(href) ?? 0) + 1);
      if (href.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      return new Response('<html><title>Visit</title><a href="/tartu">Tartu</a></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    const pages = [];
    for (const term of ['Tartu', 'Tartu', 'Tartu']) {
      await crawlForTerms('https://visit.example.ee/', [term], { maxPages: 2, onPage: (url) => pages.push(url) });
    }
    assert.equal(hits.get('https://visit.example.ee/'), 1, 'the entry page was fetched again');
    assert.equal(hits.get('https://visit.example.ee/tartu'), 1);
    assert.equal(pages.length, 6, 'every crawl still sees both pages');
  });
});

describe('originalCandidates', () => {
  it('tries the original behind a WordPress copy first', () => {
    assert.deepEqual(originalCandidates('https://cdn2.goturkiye.com/istanbul-1920x1080-13-900x506.jpg?1775158686153'), [
      'https://cdn2.goturkiye.com/istanbul-1920x1080-13.jpg',
      'https://cdn2.goturkiye.com/istanbul-1920x1080-13-900x506.jpg?1775158686153',
    ]);
  });

  it('tries the asset behind an Adobe Experience Manager rendition', () => {
    assert.equal(
      originalCandidates('https://www.x.com/content/dam/a/b/photo.jpg/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg')[0],
      'https://www.x.com/content/dam/a/b/photo.jpg',
    );
  });

  it('leaves an ordinary address as it is', () => {
    assert.deepEqual(originalCandidates('https://visitestonia.com/images/682855/tartu-raekoda.jpg'), [
      'https://visitestonia.com/images/682855/tartu-raekoda.jpg',
    ]);
  });
});

describe('rankSitemaps', () => {
  it('reads the wanted language first and other languages last', () => {
    const urls = ['https://goturkiye.com/sitemap-ar.xml', 'https://goturkiye.com/sitemap-de.xml', 'https://goturkiye.com/sitemap-en.xml'];
    assert.equal(rankSitemaps(urls, undefined)[0], 'https://goturkiye.com/sitemap-en.xml');
    assert.equal(rankSitemaps(urls, 'de')[0], 'https://goturkiye.com/sitemap-de.xml');
  });

  it('prefers places to blog posts', () => {
    const urls = ['https://x.pl/en/post-sitemap.xml', 'https://x.pl/en/page-sitemap.xml'];
    assert.equal(rankSitemaps(urls, 'en')[0], 'https://x.pl/en/page-sitemap.xml');
  });
});

describe('scoreLink word matching', () => {
  it('finds a page filed under a longer name', () => {
    assert.ok(scoreLink({ url: 'https://x.pl/en/wawel-royal-castle', anchor: '' }, ['Wawel Castle']) > 0);
    assert.equal(scoreLink({ url: 'https://x.pl/en/royal-castle', anchor: '' }, ['Wawel Castle']), 0);
  });
});

describe('matching by the words of a name', () => {
  const photo = { url: 'https://visitestonia.com/images/1/img_6371.jpg', text: '', lead: true };

  it('finds a page filed under a declension or a fuller name', () => {
    assert.ok(coversName('Adamson-Eric Museum | Visit Estonia', ['Adamson-Ericu Muuseum', 'Adamson-Eric Museum']));
    assert.ok(isOfPlace(photo, 'Adamson-Eric Museum | Visit Estonia', ['Adamson-Ericu Muuseum', 'Adamson-Eric Museum'], 'Tallinn', 'Kadriorg, Tallinn'));
  });

  it('does not take a museum of the same name in another town', () => {
    // Seen live: Tallinn's Tammsaare museum was given Vargamae's photos.
    const title = 'A.H. Tammsaare Museum in Vargamäe | Visit Estonia';
    assert.ok(!isOfPlace(photo, title, ['A. H. Tammsaare Museum in Tallinn'], 'Tallinn', 'Vargamäe, Järva County'));
  });

  it('never matches on generic words alone', () => {
    assert.ok(!coversName('Tartu City Museum', ['City Museum']));
  });
});
