import { describe, expect, it } from 'vitest';
import { expandUrl, synthesizeHeightmap } from '../src/source';
import { decodeTerrariumFloats, upsampleQuadrant } from '../src/synth';

describe('source helpers', () => {
  it('expands url templates', () => {
    expect(expandUrl('https://h/:zoom:/:y:/:x:', 12, 3, 4)).toBe('https://h/12/4/3');
  });

  it('synthesizes the matching quadrant chain', () => {
    const w = 8;
    const h = 8;
    const src = Float32Array.from({ length: w * h }, (_, i) => i);
    // z17 tile (x=5, z=6) under native z15 parent (1, 1): quadrants (0,1) then (1,0)
    const img = synthesizeHeightmap(src, w, h, 15, 17, 5, 6);
    let expected = upsampleQuadrant(src, w, h, 0, 1);
    expected = upsampleQuadrant(expected, w, h, 1, 0);
    const got = decodeTerrariumFloats(img);
    for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - expected[i])).toBeLessThanOrEqual(1 / 256 + 1e-4);
  });
});
