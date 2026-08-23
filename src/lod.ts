/**
 * Pure LOD policy: computes the desired tile set for a camera position. Port
 * of raytiles' `lod.hpp` — no three.js dependencies beyond a vector shape, no
 * I/O, no state; the unit tests (including exact snapshots) depend on that.
 */
import { ZOOM_LEVELS } from './config';

/** Anchor-relative tile identity. */
export interface TileKey {
  /** Zoom level in `[baseZoom, maxZoom]`. */
  zoom: number;
  /** Tile column, relative to the world anchor at this zoom. */
  x: number;
  /** Tile row (slippy-map `y`, world `z`), anchor-relative. */
  z: number;
}

/** Stable string identity of a key, for `Map`/`Set` membership. */
export function keyId(k: TileKey): string {
  return `${k.zoom}/${k.x}/${k.z}`;
}

/** Minimal vector shape the policy reads (any `THREE.Vector3` qualifies). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * The subset of the configuration the desired-set policy needs. Derived
 * values (per-zoom sizes, squared thresholds, horizon radius) are computed
 * inside {@link desiredTiles} so the policy stays stateless.
 */
export interface LodOptions {
  /** Lowest zoom in the quadtree (the disc scan runs at this level). */
  baseZoom: number;
  /** Highest zoom; recursion accepts unconditionally when it reaches it. */
  maxZoom: number;
  /** World size (meters) of one tile at `baseZoom`. */
  baseTileSize: number;
  /** Radius, in base-zoom tiles, of the disc scanned around the camera. */
  radius: number;
  /** Plain meters; squared internally. */
  thresholds: number[];
}

/** Distance to the horizon from height h: d ≈ 3.57 km · √h  ⇒  d² = ratio²·h. */
const HORIZON_RATIO_M = 3570;

function horizonSq(camY: number): number {
  return HORIZON_RATIO_M * HORIZON_RATIO_M * Math.max(camY, 1);
}

/**
 * Squared distance from the camera to a tile center, including the camera
 * height — the altitude term is what collapses LOD when flying high.
 */
function distSqToTile(cam: Vec3Like, zoomSize: number, x: number, z: number): number {
  const cx = (x + 0.5) * zoomSize;
  const cz = (z + 0.5) * zoomSize;
  const dx = cam.x - cx;
  const dz = cam.z - cz;
  return dx * dx + dz * dz + cam.y * cam.y;
}

/**
 * Appends the desired tile keys for `cam` (absolute space) into `out`. Does
 * not clear `out`; the produced keys are duplicate-free. Reuse the array
 * across calls so steady-state rebuilds allocate little.
 */
export function desiredTiles(opts: LodOptions, cam: Vec3Like, out: TileKey[]): void {
  const levels = opts.maxZoom - opts.baseZoom + 1;
  const sizes = new Float64Array(ZOOM_LEVELS);
  const thresholdsSq = new Float64Array(ZOOM_LEVELS);
  for (let i = 0; i < levels; i++) {
    sizes[i] = opts.baseTileSize / 2 ** i;
    const th = opts.thresholds[i] ?? 0;
    thresholdsSq[i] = th * th;
  }

  const baseSize = opts.baseTileSize;
  const camTileX = Math.floor(cam.x / baseSize);
  const camTileZ = Math.floor(cam.z / baseSize);
  const r = opts.radius;
  const allowedRadius = (r - 1) * (r - 1);
  const renderRadiusSq = horizonSq(cam.y);

  const build = (zoom: number, x: number, z: number): void => {
    if (zoom === opts.maxZoom) {
      out.push({ zoom, x, z });
      return;
    }
    const idx = zoom - opts.baseZoom;
    const d = distSqToTile(cam, sizes[idx], x, z);
    // beyond the horizon: not worth requesting at all
    if (d > renderRadiusSq) return;
    // far enough for this zoom: accept, don't subdivide
    if (d >= thresholdsSq[idx]) {
      out.push({ zoom, x, z });
      return;
    }
    for (let oz = 0; oz < 2; oz++) {
      for (let ox = 0; ox < 2; ox++) {
        build(zoom + 1, x * 2 + ox, z * 2 + oz);
      }
    }
  };

  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz < allowedRadius) {
        build(opts.baseZoom, camTileX + dx, camTileZ + dz);
      }
    }
  }
}

/** XZ-only squared distance (used by eviction's beyond-horizon rule). */
export function distSqToTileXz(cam: Vec3Like, zoomSize: number, x: number, z: number): number {
  const cx = (x + 0.5) * zoomSize;
  const cz = (z + 0.5) * zoomSize;
  const dx = cam.x - cx;
  const dz = cam.z - cz;
  return dx * dx + dz * dz;
}

/**
 * True when `key`'s center lies beyond the horizon for the camera's altitude
 * (XZ distance only) — used by eviction's beyond-horizon rule.
 */
export function outOfHorizon(cam: Vec3Like, zoomSize: number, key: TileKey): boolean {
  return distSqToTileXz(cam, zoomSize, key.x, key.z) > horizonSq(cam.y);
}
