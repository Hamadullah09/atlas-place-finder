/**
 * Run with: npm test
 *
 * A batch must not export a place twice: not for two overlapping regions, not
 * for two runs into one folder, and not when the second search found it
 * through a different source under a different id.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlaceRegistry, nameKey } from './placeRegistry.ts';

const place = (id, name, lat, lon, tags = {}) => ({
  id, osmType: 'node', osmId: 1, name, lat, lon, tags: { name, ...tags }, category: 'museum',
});

const kumu = place('way/42', 'Kumu Art Museum', 59.4358, 24.7963, { wikidata: 'Q1752130', 'name:local': 'Kumu kunstimuuseum' });

describe('PlaceRegistry', () => {
  const registry = new PlaceRegistry();
  registry.add(kumu, 'Estonia/Tallinn/museums');

  it('knows a place it has by id', () => {
    assert.equal(registry.match(place('way/42', 'Anything', 0, 0))?.where, 'Estonia/Tallinn/museums');
  });

  it('knows it under another id by its Wikidata item', () => {
    assert.ok(registry.match(place('wikidata/Q1752130', 'KUMU', 59.4, 24.8, { wikidata: 'Q1752130' })));
  });

  it('knows it under another id by name and position, in any of its names', () => {
    assert.ok(registry.match(place('node/7', 'Kumu kunstimuuseum', 59.4360, 24.7965)), 'the local name, 25 m away');
    assert.ok(registry.match(place('node/8', 'KUMU ART-MUSEUM', 59.4359, 24.7960)), 'case and punctuation');
  });

  it('does not take a namesake elsewhere for the same place', () => {
    assert.equal(registry.match(place('node/9', 'Kumu Art Museum', 58.3780, 26.7290)), undefined, 'same name, another city');
  });

  it('does not merge two places Wikidata says are different', () => {
    assert.equal(registry.match(place('node/10', 'Kumu Art Museum', 59.4358, 24.7963, { wikidata: 'Q999' })), undefined);
  });

  it('survives being saved and read back', () => {
    const copy = PlaceRegistry.from(JSON.parse(JSON.stringify(registry.toJSON())));
    assert.equal(copy.size, 1);
    assert.ok(copy.match(place('node/7', 'Kumu kunstimuuseum', 59.4360, 24.7965)));
  });

  it('reads an old id-only entry without failing', () => {
    const legacy = PlaceRegistry.from([{ id: 'node/1', names: [] }]);
    assert.ok(legacy.match(place('node/1', 'X', 0, 0)));
    assert.equal(legacy.match(place('node/2', 'X', 0, 0)), undefined);
  });
});

describe('nameKey', () => {
  it('ignores case, accents and punctuation', () => {
    assert.equal(nameKey('Tartu Raekoda'), nameKey('TARTU-raekoda'));
    assert.equal(nameKey('Košice'), nameKey('Kosice'));
  });

  it('keeps non-Latin scripts', () => {
    assert.equal(nameKey('故宫 博物院'), '故宫博物院');
  });
});
