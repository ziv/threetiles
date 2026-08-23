import { describe, expect, it } from 'vitest';
import { decodeTerrariumFloats, defaultNormals, encodeTerrarium, upsampleQuadrant } from '../src/synth';

describe('synth', () => {
  it('round trip quarter meter', () => {
    const heights = [0, 8848, -415, 100.5, 1234.25, 255.9961, 256, -0.00390625];
    const img = encodeTerrarium(heights, heights.length, 1);
    const decoded = decodeTerrariumFloats(img);
    heights.forEach((a, i) => expect(Math.abs(a - decoded[i])).toBeLessThanOrEqual(1 / 256 + 1e-4));
  });

  it('carry safe at g wrap', () => {
    // 255.998 sits between two representable values across a g-carry;
    // the encoding must land on one of them exactly
    const img = encodeTerrarium([255.998], 1, 1);
    const d = img.data;
    const fixed = (d[0] << 16) + (d[1] << 8) + d[2];
    expect([8_454_143, 8_454_144]).toContain(fixed);
  });

  it('ramp is exact in the interior', () => {
    const w = 8;
    const h = 8;
    const src = Float32Array.from({ length: w * h }, (_, i) => 16 * (i % w));
    const q0 = upsampleQuadrant(src, w, h, 0, 0);
    expect(Math.abs(q0[2] - 16 * 0.75)).toBeLessThan(1e-4); // sx = 0.75
    expect(Math.abs(q0[3] - 16 * 1.25)).toBeLessThan(1e-4);
    expect(Math.abs(q0[0] - 0)).toBeLessThan(1e-4); // sx = -0.25 clamps
  });

  it('siblings continuous across shared edge', () => {
    const w = 8;
    const h = 8;
    const src = Float32Array.from({ length: w * h }, (_, i) => 16 * (i % w));
    const q0 = upsampleQuadrant(src, w, h, 0, 0);
    const q1 = upsampleQuadrant(src, w, h, 1, 0);
    // adjacent fine samples straddling the boundary: half a source step apart
    expect(Math.abs(q0[w - 1] - 16 * 3.25)).toBeLessThan(1e-4);
    expect(Math.abs(q1[0] - 16 * 3.75)).toBeLessThan(1e-4);
  });

  it('seven level chain survives encode round trip', () => {
    const w = 16;
    const h = 16;
    const src = Float32Array.from({ length: w * h }, (_, i) => (i % w) * 16 + Math.floor(i / w));
    const quads: [number, number][] = [[0, 0], [0, 0], [0, 0], [1, 1], [0, 1], [0, 0], [1, 1]];
    let a: Float32Array = src;
    for (const [qx, qz] of quads) a = upsampleQuadrant(a, w, h, qx, qz);
    const back = decodeTerrariumFloats(encodeTerrarium(a, w, h));
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - back[i])).toBeLessThanOrEqual(1 / 256 + 1e-4);
  });

  it('default normals are flat', () => {
    const img = defaultNormals(4);
    const o = (3 * 4 + 3) * 4;
    expect(Array.from(img.data.slice(o, o + 4))).toEqual([128, 128, 255, 255]);
  });
});
