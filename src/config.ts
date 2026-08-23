/**
 * Public configuration. Mirrors bevytiles' / raytiles' nested config — every
 * field defaulted; pass partial overrides to {@link Terrain}.
 */
import * as THREE from 'three';

/** Lowest zoom level the engine supports; `WorldConfig.baseZoom` must not go below it. */
export const MIN_ZOOM = 9;
/**
 * Highest zoom level the engine supports; `WorldConfig.maxZoom` must not
 * exceed it. Above `NetworkConfig.nativeTerrainZoom` heightmaps are
 * synthesized, so only imagery needs to exist natively this deep.
 */
export const MAX_ZOOM = 22;
/**
 * Number of zoom levels in `[MIN_ZOOM, MAX_ZOOM]`; sizes every per-zoom array
 * (`thresholds`, `skirtOverlap`). Slot `i` applies to zoom `baseZoom + i`;
 * slots beyond `maxZoom - baseZoom` are ignored.
 */
export const ZOOM_LEVELS = MAX_ZOOM - MIN_ZOOM + 1; // 14

/** Highest terrain elevation the culling bounds must cover (Everest, meters). */
export const MAX_WORLD_HEIGHT = 8848;

const EQUATOR_CIRCUMFERENCE_M = 40_075_016.686;

/** World topology. Effectively immutable once the engine started. */
export interface WorldConfig {
  /** Anchor tile X at `baseZoom`: the world origin sits at this tile's corner. */
  anchorX: number;
  /** Anchor tile Z (slippy-map `y`) at `baseZoom`. */
  anchorZ: number;
  /** Lowest LOD zoom ever loaded (>= MIN_ZOOM). */
  baseZoom: number;
  /**
   * Highest LOD zoom (<= MAX_ZOOM). Defaults to the native terrain ceiling
   * (15); raising it beyond `NetworkConfig.nativeTerrainZoom` opts into
   * synthesized heightmaps and default normals.
   */
  maxZoom: number;
  /** World size (meters) of one tile at `baseZoom`. */
  tileSize: number;
  /** Per-zoom mesh overlap factors, `skirtOverlap[zoom - baseZoom]` (length ZOOM_LEVELS). */
  skirtOverlap: number[];
  /**
   * World-space offset of the anchor point inside its anchor tile; filled by
   * {@link worldFromLatLon} so the origin sits exactly on the coordinate.
   */
  originOffset: THREE.Vector3;
}

export function defaultWorldConfig(): WorldConfig {
  return {
    anchorX: 306,
    anchorZ: 207,
    baseZoom: MIN_ZOOM,
    maxZoom: 15,
    tileSize: 66_400,
    skirtOverlap: new Array(ZOOM_LEVELS).fill(1),
    originOffset: new THREE.Vector3(),
  };
}

/**
 * Anchor the world at a geographic coordinate (degrees): derives the anchor
 * tile, tile size, and origin offset (web-mercator, same math as raytiles).
 */
export function worldFromLatLon(lat: number, lon: number): WorldConfig {
  const n = 2 ** MIN_ZOOM;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const anchorX = Math.floor(x);
  const anchorZ = Math.floor(y);
  const tileSize = (EQUATOR_CIRCUMFERENCE_M * Math.cos(latRad)) / n;
  return {
    ...defaultWorldConfig(),
    anchorX,
    anchorZ,
    tileSize,
    originOffset: new THREE.Vector3((x - anchorX) * tileSize, 0, (y - anchorZ) * tileSize),
  };
}

/** A sensible initial camera position over the anchor, `altitude` m up. */
export function initialPosition(world: WorldConfig, altitude: number): THREE.Vector3 {
  return world.originOffset.clone().add(new THREE.Vector3(0, altitude, 0));
}

/** Which tiles are kept resident and how aggressively the set updates. */
export interface StreamingConfig {
  /** Radius, in base-zoom tiles, of the disc loaded around the camera. */
  radius: number;
  /** Per-zoom subdivision distance thresholds (meters), `thresholds[zoom - baseZoom]`. */
  thresholds: number[];
  /** Camera travel (meters) that triggers a desired-set rebuild. */
  updateDistance: number;
  /** Cap on tile promotions (mesh + texture creation) per frame. */
  maxPromotionsPerFrame: number;
}

export function defaultStreamingConfig(): StreamingConfig {
  return {
    radius: 6,
    thresholds: [
      100_000, 80_000, 40_000, 20_000, 10_000, 5_000, 2_500, 1_250, 625, 312, 156, 78, 39, 20,
    ],
    updateDistance: 500,
    maxPromotionsPerFrame: 8,
  };
}

/**
 * Rendering / shader parameters. All runtime-mutable: mutate the object held
 * by the engine and it pushes the change to every live material.
 */
export interface RenderingConfig {
  /** Distance (meters) at which atmospheric fog starts blending in. */
  fogStart: number;
  /** Distance (meters) at which fog fully replaces the terrain color. */
  fogEnd: number;
  /** Vertical drop (meters) of skirt geometry below tile edges; 0 disables. */
  skirtDrop: number;
  /** Match this to your sky color for a seamless horizon. */
  fogColor: THREE.Color;
  /** World ambient light color; drives day/night/weather changes. */
  ambient: THREE.Color;
  /** Normalized internally; magnitude is irrelevant. */
  sunDirection: THREE.Vector3;
  /** Sun light intensity — contrast between lit and shaded slopes. */
  sunScale: number;
  /** Terrain relief exaggeration (drama factor). */
  heightScale: number;
  /**
   * Normal-map contrast multiplier. Higher looks bumpier; too high causes
   * lighting artifacts on steep encoded normals.
   */
  normalsScale: number;
}

export function defaultRenderingConfig(): RenderingConfig {
  return {
    fogStart: 100_000,
    fogEnd: 150_000,
    skirtDrop: 0,
    fogColor: new THREE.Color(0, 0, 1),
    ambient: new THREE.Color(1, 1, 1),
    sunDirection: new THREE.Vector3(0.1, 1, 0.1),
    sunScale: 1,
    heightScale: 1,
    normalsScale: 1,
  };
}

/** Tile download parameters. */
export interface NetworkConfig {
  /**
   * Max number of tiles fetched concurrently (the browser analogue of worker
   * threads: browsers cap connections per host, and an unbounded fan-out
   * would starve the tiles the camera actually needs).
   */
  concurrency: number;
  /**
   * Provider URL templates with `:zoom:`/`:x:`/`:y:` tokens. The Esri texture
   * default uses `zoom/y/x` order — that swap is intentional.
   */
  textureUrl: string;
  /** Terrarium heightmap URL template (`zoom/x/y` order). */
  heightmapUrl: string;
  /** Normal-map URL template (`zoom/x/y` order). */
  normalsUrl: string;
  /**
   * Highest zoom the terrain providers serve natively (Mapzen: 15). Above it
   * heightmaps are synthesized from ancestors and normals default; no HTTP is
   * attempted for either.
   */
  nativeTerrainZoom: number;
}

export function defaultNetworkConfig(): NetworkConfig {
  return {
    concurrency: 4,
    textureUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/:zoom:/:y:/:x:',
    heightmapUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/:zoom:/:x:/:y:.png',
    normalsUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/normal/:zoom:/:x:/:y:.png',
    nativeTerrainZoom: 15,
  };
}

/**
 * Large-world shifting input: `absolute = user − worldOffset`. The app owns
 * rebasing (shift camera + everything + this offset together); the engine
 * rebakes tile transforms whenever it changes.
 */
export interface TerrainAnchor {
  /**
   * The current user-space offset of the world origin. Mutate only as part
   * of a rebase that shifts the camera and every user-space object by the
   * same amount.
   */
  worldOffset: THREE.Vector3;
}

/**
 * Initial-load status for splash screens. `loading` starts true and flips
 * only once a desired set exists and is fully serviced.
 */
export interface TerrainStatus {
  /** True during the initial load only. */
  loading: boolean;
  /** Fraction of the desired set that is resident, [0, 1]. */
  progress: number;
  /** Resident tile count (debug convenience). */
  resident: number;
}
