/**
 * CPU-side height grids for `groundHeight` queries. 128 KB per 256² tile
 * (uint16) vs 256 KB for a retained RGBA image.
 */
import type { TerrainAnchor, WorldConfig } from './config';
import { keyId, type Vec3Like } from './lod';
import type { RgbaImage } from './synth';

/**
 * `round(height_m) + 32768` per texel — integer-meter resolution (the
 * Terrarium source is only meter-accurate; bilinear sampling smooths it).
 */
export class HeightGrid {
  constructor(
    /** Grid width in texels (matches the source heightmap). */
    public readonly w: number,
    /** Grid height in texels. */
    public readonly h: number,
    /** Row-major samples, encoded `round(height_m) + 32768`. */
    public readonly samples: Uint16Array,
  ) {}

  /**
   * Decode a Terrarium heightmap into a grid (quantized to whole meters — the
   * source data is only meter-accurate; {@link sample} interpolates).
   */
  static fromTerrarium(img: RgbaImage): HeightGrid {
    const n = img.width * img.height;
    const samples = new Uint16Array(n);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const h = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
      const v = Math.round(h) + 32768;
      samples[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
    return new HeightGrid(img.width, img.height, samples);
  }

  /**
   * Bilinear sample at normalized (u, v) ∈ [0, 1]; texel centers at
   * (i + 0.5)/n, edges clamped. Returns meters.
   */
  sample(u: number, v: number): number {
    const w = this.w;
    const h = this.h;
    const s = (x: number, y: number): number => {
      const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
      const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
      return this.samples[cy * w + cx];
    };
    const fx = u * w - 0.5;
    const fy = v * h - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = s(x0, y0) * (1 - tx) + s(x0 + 1, y0) * tx;
    const bot = s(x0, y0 + 1) * (1 - tx) + s(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bot * ty - 32768;
  }
}

/** All resident tiles' height grids, keyed by {@link keyId}. */
export type HeightGrids = Map<string, HeightGrid>;

/**
 * Terrain altitude under `pos` (user space): walks zooms finest→coarsest and
 * samples the first resident grid containing the XZ point. O(zoom levels).
 * Returns `undefined` when no resident tile covers the point.
 */
export function groundHeight(
  grids: HeightGrids,
  world: WorldConfig,
  anchor: TerrainAnchor,
  pos: Vec3Like,
): number | undefined {
  const ax = pos.x - anchor.worldOffset.x;
  const az = pos.z - anchor.worldOffset.z;
  for (let zoom = world.maxZoom; zoom >= world.baseZoom; zoom--) {
    const size = world.tileSize / 2 ** (zoom - world.baseZoom);
    const tx = Math.floor(ax / size);
    const tz = Math.floor(az / size);
    const grid = grids.get(keyId({ zoom, x: tx, z: tz }));
    if (grid) {
      const u = (ax - tx * size) / size;
      const v = (az - tz * size) / size;
      return grid.sample(u, v);
    }
  }
  return undefined;
}
