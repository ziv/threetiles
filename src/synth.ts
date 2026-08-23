/**
 * Pure terrain synthesis: derive higher-zoom Terrarium heightmaps from
 * native-zoom ancestors, and produce default normal maps. Port of raytiles'
 * `terrain_synth.hpp`. No I/O, no three.js — plain buffers, fully unit-tested.
 *
 * Cardinal rule: NEVER interpolate Terrarium RGB directly. Adjacent heights
 * can be distant in channel space (g wraps 255→0 as r carries), so all
 * resampling goes decode → f32 heights → bilinear → carry-safe re-encode.
 */

/** A decoded RGBA8 image (the browser's native pixel layout). */
export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, `width * height * 4` bytes. */
  data: Uint8Array | Uint8ClampedArray;
}

/** Terrarium: h = r·256 + g + b/256 − 32768 (meters). */
export function decodeTerrariumFloats(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  }
  return out;
}

/**
 * Upsample one quadrant (qx, qz ∈ {0, 1}) of a w×h grid 2× to a full w×h
 * grid. Texel-center aligned: destination texel i samples source coordinate
 * `q·w/2 + (i + 0.5)/2 − 0.5`, so siblings sharing an edge sample adjacent
 * source positions straddling the boundary — continuity by construction.
 * Edges clamp to the source grid.
 */
export function upsampleQuadrant(
  src: ArrayLike<number>,
  w: number,
  h: number,
  qx: number,
  qz: number,
): Float32Array {
  const sample = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
    const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    return src[cy * w + cx];
  };
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const sy = (qz * h) / 2 + (j + 0.5) / 2 - 0.5;
    const y0 = Math.floor(sy);
    const ty = sy - y0;
    for (let i = 0; i < w; i++) {
      const sx = (qx * w) / 2 + (i + 0.5) / 2 - 0.5;
      const x0 = Math.floor(sx);
      const tx = sx - x0;
      const top = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
      const bot = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
      out[j * w + i] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

/**
 * Encode heights (meters) into Terrarium RGBA (alpha 255). Carry-safe:
 * quantize once to 24-bit fixed point and split bytes — never round per
 * channel (that spikes at g-wrap boundaries).
 */
export function encodeTerrarium(heights: ArrayLike<number>, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let fixed = Math.round((heights[i] + 32768) * 256);
    if (fixed < 0) fixed = 0;
    else if (fixed > 0xff_ffff) fixed = 0xff_ffff;
    const o = i * 4;
    data[o] = fixed >>> 16;
    data[o + 1] = (fixed >>> 8) & 0xff;
    data[o + 2] = fixed & 0xff;
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

/**
 * A flat default normal map: solid RGB(128, 128, 255) → up-normal (0, 0, 1).
 * Used whenever a real normals asset is unavailable (above the native zoom,
 * 404, corrupt bytes, ...).
 */
export function defaultNormals(size: number): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data.set([128, 128, 255, 255], i * 4);
  }
  return { width: size, height: size, data };
}
