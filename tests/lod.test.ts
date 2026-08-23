import { describe, expect, it } from 'vitest';
import { defaultStreamingConfig } from '../src/config';
import { desiredTiles, keyId, type LodOptions, type TileKey, type Vec3Like } from '../src/lod';

function defaults(): LodOptions {
  return {
    baseZoom: 9,
    maxZoom: 15,
    baseTileSize: 66_400,
    radius: 6,
    thresholds: defaultStreamingConfig().thresholds,
  };
}

function run(opts: LodOptions, cam: Vec3Like): TileKey[] {
  const out: TileKey[] = [];
  desiredTiles(opts, cam, out);
  return out;
}

function probes(): Vec3Like[] {
  const ts = 66_400;
  const xz: [number, number][] = [
    [0, 0],
    [0.5 * ts, 0.5 * ts],
    [0.25 * ts, 0.75 * ts],
    [3.3 * ts, -2.7 * ts],
    [-ts, -ts],
  ];
  const alts = [2, 500, 5_000, 60_000];
  return xz.flatMap(([x, z]) => alts.map((y) => ({ x, y, z })));
}

describe('lod', () => {
  it('structural invariants', () => {
    const opts = defaults();
    for (const cam of probes()) {
      const keys = run(opts, cam);
      const set = new Set(keys.map(keyId));
      expect(set.size, `duplicates at ${JSON.stringify(cam)}`).toBe(keys.length);
      for (const k of keys) {
        expect(k.zoom).toBeGreaterThanOrEqual(opts.baseZoom);
        expect(k.zoom).toBeLessThanOrEqual(opts.maxZoom);
        // no key together with an ancestor
        let x = k.x;
        let z = k.z;
        for (let zoom = k.zoom - 1; zoom >= opts.baseZoom; zoom--) {
          x >>= 1;
          z >>= 1;
          expect(set.has(keyId({ zoom, x, z })), `${keyId(k)} has resident ancestor at ${zoom}`).toBe(false);
        }
      }
    }
  });

  // These values are identical to the C++ raytiles and Rust bevytiles
  // snapshot suites — cross-language behavioral equivalence.
  it('snapshots', () => {
    const opts = defaults();
    const a = run(opts, { x: 0, y: 500, z: 0 });
    const b = run(opts, { x: 33_200, y: 5_000, z: 33_200 });
    const c = run(opts, { x: 0, y: 60_000, z: 0 });
    const count = (keys: TileKey[], zoom: number) => keys.filter((k) => k.zoom === zoom).length;
    const summary = [a.length, count(a, 15), b.length, count(b, 9), c.length, count(c, 15)];
    expect(summary).toEqual([252, 64, 252, 36, 117, 0]);
  });

  it('high zoom reachable when low over tile center', () => {
    const opts = { ...defaults(), maxZoom: 17 };
    const keys = run(opts, { x: 33_200, y: 500, z: 33_200 });
    expect(keys.some((k) => k.zoom > 15)).toBe(true);
  });
});
