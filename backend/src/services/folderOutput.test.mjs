/**
 * Run with: npm test
 *
 * When the operator names a folder the places go straight into it — no ZIP to
 * unpack, and nothing already in that folder is destroyed to make room.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { writePlacesFolder } from './archive.ts';

const roots = [];
const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-folder-'));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const place = (name) => ({
  id: `n-${name}`,
  osmType: 'node',
  osmId: 1,
  name,
  categoryLabel: 'Museum',
  lat: 0,
  lon: 0,
  tags: { name },
  contact: {},
  images: [],
  travelLinks: [],
  qualityScore: 50,
  llmProcessed: false,
  summary: '',
  osmUrl: '',
});

const input = (places) => ({
  country: 'Estonia',
  city: 'Tartu',
  keyword: 'all',
  places,
  options: { includeImages: false, includeSummary: false, detailedWriteups: false },
});

describe('writePlacesFolder', () => {
  it('writes Country/City/Place without a ZIP anywhere', async () => {
    const root = tempRoot();
    const result = await writePlacesFolder(root, input([place('Tartu Toomkirik')]));

    assert.equal(result.path, path.join(root, 'Estonia', 'Tartu'));
    const placeDir = path.join(result.path, 'Tartu Toomkirik');
    assert.ok(fs.existsSync(path.join(placeDir, 'Tartu Toomkirik_details.pdf')), 'the PDF should be on disk');
    assert.ok(fs.existsSync(path.join(result.path, 'README.txt')), 'the README should be on disk');

    const everything = fs.readdirSync(root, { recursive: true }).map(String);
    assert.equal(everything.filter((entry) => entry.endsWith('.zip')).length, 0, 'no ZIP should be produced');
    assert.ok(result.files >= 2 && result.bytes > 0);
  });

  it('skips the Country/City folders when the caller already made them', async () => {
    const root = tempRoot();
    const result = await writePlacesFolder(root, input([place('Kivisild')]), { nest: false });

    assert.equal(result.path, root);
    assert.ok(fs.existsSync(path.join(root, 'Kivisild', 'Kivisild_details.pdf')));
    assert.ok(fs.existsSync(path.join(root, 'README.txt')));
  });

  it('leaves whatever was already in the folder alone', async () => {
    const root = tempRoot();
    const keepMe = path.join(root, 'notes-from-the-user.txt');
    fs.writeFileSync(keepMe, 'do not delete me');
    fs.mkdirSync(path.join(root, 'Estonia', 'Tartu'), { recursive: true });
    const olderRun = path.join(root, 'Estonia', 'Tartu', 'left-over.txt');
    fs.writeFileSync(olderRun, 'from a previous run');

    await writePlacesFolder(root, input([place('Raekoda')]));

    assert.equal(fs.readFileSync(keepMe, 'utf8'), 'do not delete me');
    assert.equal(fs.readFileSync(olderRun, 'utf8'), 'from a previous run');
  });

  it('writes the README last, so its presence means the region finished', async () => {
    const root = tempRoot();
    const result = await writePlacesFolder(root, input([place('Ahhaa')]));

    const readme = fs.statSync(path.join(result.path, 'README.txt')).mtimeMs;
    const pdf = fs.statSync(path.join(result.path, 'Ahhaa', 'Ahhaa_details.pdf')).mtimeMs;
    assert.ok(readme >= pdf, 'README should not predate the places it describes');
  });

  it('leaves out a place whose photos could not be downloaded', async () => {
    const root = tempRoot();
    // A host the image allowlist rejects, so it fails without touching the network.
    const unreachable = {
      ...place('Photo Is Gone'),
      images: [{
        url: 'https://not-an-image-host.invalid/x.jpg',
        downloadUrl: 'https://not-an-image-host.invalid/x.jpg',
        thumbUrl: '',
        width: 3000,
        height: 2000,
        source: 'commons',
      }],
    };

    const result = await writePlacesFolder(root, {
      ...input([unreachable, place('No Photos At All')]),
      options: { includeImages: true, includeSummary: false, detailedWriteups: false },
    });

    const folders = fs.readdirSync(result.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.deepEqual(folders, [], 'neither place should get a folder');

    const readme = fs.readFileSync(path.join(result.path, 'README.txt'), 'utf8');
    assert.match(readme, /left out of the folder/);
    assert.match(readme, /2 place\(s\) were left out/);
    assert.match(readme, /REQUIRE_IMAGES=false/, 'the README should say how to keep them');
  });

  it('still exports a place when photos were not asked for', async () => {
    const root = tempRoot();
    // Turning images off is a deliberate choice, not a missing photo.
    const result = await writePlacesFolder(root, {
      ...input([place('Write-up Only')]),
      options: { includeImages: false, includeSummary: false, detailedWriteups: false },
    });

    assert.ok(fs.existsSync(path.join(result.path, 'Write-up Only', 'Write-up Only_details.pdf')));
  });

  it('runs again over the same folder without complaining', async () => {
    const root = tempRoot();
    await writePlacesFolder(root, input([place('Toomemägi')]));
    const second = await writePlacesFolder(root, input([place('Toomemägi')]));
    assert.ok(fs.existsSync(path.join(second.path, 'Toomemägi', 'Toomemägi_details.pdf')));
  });
});
