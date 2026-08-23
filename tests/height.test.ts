import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultWorldConfig } from '../src/config';
import { HeightGrid, groundHeight } from '../src/height';
import { keyId } from '../src/lod';
import { encodeTerrarium } from '../src/synth';

describe('height', () => {
  it('sample centers, midpoints and edges', () => {
    // 2x1 grid: 100 m and 300 m
    const grid = new HeightGrid(2, 1, Uint16Array.from([32768 + 100, 32768 + 300]));
    expect(grid.sample(0.25, 0.5)).toBeCloseTo(100, 3);
    expect(grid.sample(0.75, 0.5)).toBeCloseTo(300, 3);
    expect(grid.sample(0.5, 0.5)).toBeCloseTo(200, 3);
    expect(grid.sample(0, 0)).toBeCloseTo(100, 3);
    expect(grid.sample(1, 1)).toBeCloseTo(300, 3);
  });

  it('fromTerrarium rounds meters', () => {
    const img = encodeTerrarium([0, 8848, -415, 100.5], 4, 1);
    const grid = HeightGrid.fromTerrarium(img);
    expect(grid.samples[0]).toBe(32768);
    expect(grid.samples[1]).toBe(32768 + 8848);
    expect(grid.samples[2]).toBe(32768 - 415);
    expect([32768 + 100, 32768 + 101]).toContain(grid.samples[3]);
  });

  it('groundHeight prefers the finest resident tile and honors the offset', () => {
    const world = defaultWorldConfig();
    const grids = new Map<string, HeightGrid>();
    grids.set(keyId({ zoom: 9, x: 0, z: 0 }), new HeightGrid(1, 1, Uint16Array.from([32768 + 10])));
    grids.set(keyId({ zoom: 10, x: 1, z: 1 }), new HeightGrid(1, 1, Uint16Array.from([32768 + 20])));
    const anchor = { worldOffset: new THREE.Vector3(1000, 0, 0) };
    const half = world.tileSize / 2;
    // abs (half+1, half+1) lies in z10 tile (1,1)
    expect(groundHeight(grids, world, anchor, { x: half + 1 + 1000, y: 0, z: half + 1 })).toBe(20);
    // abs (1, 1) lies only in the z9 tile
    expect(groundHeight(grids, world, anchor, { x: 1 + 1000, y: 0, z: 1 })).toBe(10);
    expect(groundHeight(grids, world, anchor, { x: -1 + 1000, y: 0, z: 1 })).toBeUndefined();
  });
});
