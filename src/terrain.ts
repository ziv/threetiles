/**
 * The tile store: one `THREE.Mesh` per resident tile under a group added to
 * the scene; bookkeeping in maps; frame steps as ordered methods
 * (reconcile → promote → updateDesired → status → rebase → syncRendering).
 * three.js' frustum culling replaces the frustum engine (each per-zoom
 * geometry carries a bounding sphere covering the displaced column).
 */
import * as THREE from 'three';
import {
  MAX_WORLD_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  defaultNetworkConfig,
  defaultRenderingConfig,
  defaultStreamingConfig,
  defaultWorldConfig,
  type NetworkConfig,
  type RenderingConfig,
  type StreamingConfig,
  type TerrainAnchor,
  type TerrainStatus,
  type WorldConfig,
} from './config';
import { groundHeight, type HeightGrids } from './height';
import { desiredTiles, keyId, outOfHorizon, type LodOptions, type TileKey } from './lod';
import { TerrainMaterial, bitmapTexture, dataTexture } from './material';
import { TileSource, type TileDrop, type TilePayload } from './source';
import { defaultNormals } from './synth';

/** Per-tile record attached to each resident mesh. */
export interface Tile {
  /** Anchor-relative identity (also the index / grid map key). */
  key: TileKey;
  /** World size of this tile in meters. */
  size: number;
  /** Absolute tile center X (the user-space position is `abs + worldOffset`). */
  absX: number;
  /** Absolute tile center Z. */
  absZ: number;
  /** The rendered mesh (shared per-zoom geometry, own material + textures). */
  mesh: THREE.Mesh<THREE.BufferGeometry, TerrainMaterial>;
  /** Engine frame counter when the mesh was last drawn (visibility feedback). */
  lastDrawn: number;
}

/** Construction options: any subset of the four configs; the rest defaults. */
export interface TerrainOptions {
  world?: Partial<WorldConfig>;
  streaming?: Partial<StreamingConfig>;
  rendering?: Partial<RenderingConfig>;
  network?: Partial<NetworkConfig>;
}

/** World size (meters) of one tile at `zoom`: halves per level above base. */
export function zoomSize(world: WorldConfig, zoom: number): number {
  return world.tileSize / 2 ** (zoom - world.baseZoom);
}

/**
 * Build the flat tile grid for one zoom: `res`×`res` quads centered on the
 * origin, UV (0,0) at the (−x, −z) corner so the image's top row (north)
 * lands at −z — the same convention as the Rust/Bevy plane.
 */
function gridGeometry(size: number, res: number): THREE.BufferGeometry {
  const n = res + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  let p = 0;
  let t = 0;
  for (let j = 0; j < n; j++) {
    const tz = j / res;
    for (let i = 0; i < n; i++) {
      const tx = i / res;
      positions[p] = (tx - 0.5) * size;
      positions[p + 1] = 0;
      positions[p + 2] = (tz - 0.5) * size;
      normals[p + 1] = 1;
      p += 3;
      uvs[t++] = tx;
      uvs[t++] = tz;
    }
  }
  const indices = new Uint32Array(res * res * 6);
  let q = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // counter-clockwise seen from +y
      indices[q++] = a;
      indices[q++] = c;
      indices[q++] = b;
      indices[q++] = b;
      indices[q++] = c;
      indices[q++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // displacement happens on the GPU: the auto bounds (flat plane) would cull
  // visible mountains. Cover the full height column (Dead Sea −430 m up to
  // Everest, with margin).
  const half = size * 0.5;
  const halfY = MAX_WORLD_HEIGHT * 0.5 + 300;
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, MAX_WORLD_HEIGHT * 0.5 - 250, 0),
    Math.hypot(half, half, halfY),
  );
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-half, MAX_WORLD_HEIGHT * 0.5 - 250 - halfY, -half),
    new THREE.Vector3(half, MAX_WORLD_HEIGHT * 0.5 - 250 + halfY, half),
  );
  return geo;
}

/**
 * The terrain engine. Construct with a camera, add {@link group} to your
 * scene (or pass a parent), and call {@link update} once per frame before
 * rendering.
 */
export class Terrain {
  readonly world: WorldConfig;
  readonly streaming: StreamingConfig;
  /** Runtime-mutable; changes are pushed to live materials each frame. */
  readonly rendering: RenderingConfig;
  readonly network: NetworkConfig;
  /** Large-world offset; see {@link rebase}. */
  readonly anchor: TerrainAnchor = { worldOffset: new THREE.Vector3() };
  /** Initial-load status for splash screens. */
  readonly status: TerrainStatus = { loading: true, progress: 0, resident: 0 };
  /** All tile meshes live under this group. */
  readonly group = new THREE.Group();
  /** Resident tiles' height grids, in lockstep with residency. */
  readonly grids: HeightGrids = new Map();
  /** The camera that drives streaming (user space). */
  camera: THREE.Camera;

  private readonly resident = new Map<string, Tile>();
  private desired = new Map<string, TileKey>();
  private readonly loading = new Map<string, TileKey>();
  private readonly pending: TilePayload[] = [];
  private readonly source: TileSource;
  private readonly zoomGeometries: THREE.BufferGeometry[] = [];
  private readonly defaultNormalTex: THREE.DataTexture;
  private lastDesiredPos = new THREE.Vector3(-9_999_999.9, -9_999_999.9, -9_999_999.9);
  private coverageDirty = true;
  private frame = 0;
  private readonly bakedOffset = new THREE.Vector3();
  private lastRendering = '';
  private readonly scratch: TileKey[] = [];
  private readonly readyBuf: TilePayload[] = [];
  private readonly droppedBuf: TileDrop[] = [];
  private readonly tmp = new THREE.Vector3();

  /** @throws if the configured zoom range is outside `[MIN_ZOOM, MAX_ZOOM]` or inverted. */
  constructor(camera: THREE.Camera, opts: TerrainOptions = {}, parent?: THREE.Object3D) {
    this.camera = camera;
    this.world = { ...defaultWorldConfig(), ...opts.world };
    this.streaming = { ...defaultStreamingConfig(), ...opts.streaming };
    this.rendering = { ...defaultRenderingConfig(), ...opts.rendering };
    this.network = { ...defaultNetworkConfig(), ...opts.network };
    const w = this.world;
    if (w.baseZoom < MIN_ZOOM || w.maxZoom > MAX_ZOOM || w.maxZoom < w.baseZoom) {
      throw new Error(`zoom range [${w.baseZoom}, ${w.maxZoom}] outside [${MIN_ZOOM}, ${MAX_ZOOM}]`);
    }

    // shared per-zoom grid geometries: resolution doubles 4 → 256 with zoom;
    // UVs span [0,1] (displacement samples by UV)
    let res = 4;
    for (let zoom = w.baseZoom; zoom <= w.maxZoom; zoom++) {
      const idx = zoom - w.baseZoom;
      const size = zoomSize(w, zoom) * (w.skirtOverlap[idx] ?? 1);
      this.zoomGeometries.push(gridGeometry(size, res));
      res = Math.min(res * 2, 256);
    }
    const flat = defaultNormals(1);
    this.defaultNormalTex = dataTexture(flat.data, flat.width, flat.height);
    this.source = new TileSource(this.network);
    this.group.name = 'threetiles';
    parent?.add(this.group);
  }

  /** Terrain altitude under `pos` (user space), or `undefined` if no tile covers it. */
  groundHeight(pos: THREE.Vector3): number | undefined {
    return groundHeight(this.grids, this.world, this.anchor, pos);
  }

  /**
   * Large-world rebase: shift the world offset by `shift`. The caller must
   * shift the camera and every other user-space object by the same amount
   * (preserving `absolute = user − offset`); tile transforms are rebaked on
   * the next {@link update}.
   */
  rebase(shift: THREE.Vector3): void {
    this.anchor.worldOffset.add(shift);
  }

  /** Number of tiles currently resident. */
  get residentCount(): number {
    return this.resident.size;
  }

  /**
   * One frame of the engine: reconcile → promote → updateDesired → status →
   * rebase → syncRendering. Call before `renderer.render` each frame.
   */
  update(): void {
    this.frame += 1;
    this.reconcile();
    this.promote();
    this.updateDesired();
    this.updateStatus();
    this.rebakeIfMoved();
    this.syncRendering();
  }

  /** Evict every tile, free GPU resources, stop the source. */
  dispose(): void {
    for (const tile of this.resident.values()) this.evict(tile);
    this.resident.clear();
    this.grids.clear();
    for (const p of this.pending) {
      p.albedo.close();
      p.normals?.close();
    }
    this.pending.length = 0;
    this.source.dispose();
    for (const g of this.zoomGeometries) g.dispose();
    this.defaultNormalTex.dispose();
    this.group.removeFromParent();
  }

  // -------------------------------------------------------------------------
  // per-frame steps

  private absCamera(): THREE.Vector3 {
    return this.tmp.copy(this.camera.position).sub(this.anchor.worldOffset);
  }

  /**
   * Evict resident tiles that are no longer needed: not desired AND
   * (base-zoom stale | off-screen last frame | beyond the horizon | covered by
   * a resident parent / all four children). The covered-by rule protects
   * against holes in the ground; its checks are gated on `coverageDirty`.
   */
  private reconcile(): void {
    const abs = this.absCamera();
    const w = this.world;
    const evict: Tile[] = [];
    for (const [id, tile] of this.resident) {
      if (this.desired.has(id)) continue;
      const key = tile.key;
      let remove: boolean;
      if (key.zoom === w.baseZoom) {
        // stale base tiles are the horizon — drop without thinking
        remove = true;
      } else if (tile.lastDrawn < this.frame - 1) {
        // not on screen last frame
        remove = true;
      } else if (outOfHorizon(abs, zoomSize(w, key.zoom), key)) {
        remove = true;
      } else if (!this.coverageDirty) {
        remove = false;
      } else {
        // visible and in range: evict only if parent/children cover the
        // area, otherwise keep it to avoid holes in the ground
        remove = this.covered(key);
      }
      if (remove) evict.push(tile);
    }
    for (const tile of evict) {
      const id = keyId(tile.key);
      this.evict(tile);
      this.resident.delete(id);
      this.grids.delete(id);
    }
    this.coverageDirty = false;
  }

  private covered(key: TileKey): boolean {
    const w = this.world;
    const has = (zoom: number, x: number, z: number): boolean => this.resident.has(keyId({ zoom, x, z }));
    if (key.zoom > w.baseZoom && has(key.zoom - 1, key.x >> 1, key.z >> 1)) return true;
    if (key.zoom < w.maxZoom) {
      const cx = key.x * 2;
      const cz = key.z * 2;
      if (
        has(key.zoom + 1, cx, cz) &&
        has(key.zoom + 1, cx + 1, cz) &&
        has(key.zoom + 1, cx, cz + 1) &&
        has(key.zoom + 1, cx + 1, cz + 1)
      ) {
        return true;
      }
    }
    // grandparent / grandchildren: rare, but happens when zoom levels are
    // skipped by distance-based loading during fast movement
    if (key.zoom > w.baseZoom + 1 && has(key.zoom - 2, key.x >> 2, key.z >> 2)) return true;
    if (key.zoom + 1 < w.maxZoom) {
      const cx = key.x * 4;
      const cz = key.z * 4;
      for (let ox = 0; ox < 4; ox++) {
        for (let oz = 0; oz < 4; oz++) {
          if (!has(key.zoom + 2, cx + ox, cz + oz)) return false;
        }
      }
      return true;
    }
    return false;
  }

  private evict(tile: Tile): void {
    const mesh = tile.mesh;
    this.group.remove(mesh);
    const u = mesh.material.uniforms;
    for (const name of ['albedoTex', 'heightTex', 'normalTex'] as const) {
      const tex = u[name].value as THREE.Texture;
      if (tex === this.defaultNormalTex) continue;
      const img = tex.image as unknown;
      if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
      tex.dispose();
    }
    mesh.material.dispose();
  }

  /**
   * Drain the source (one non-blocking sweep) and promote finished tiles:
   * build the three textures (albedo sRGB; heightmap/normals LINEAR), one
   * material, the height grid, and the tile mesh. Capped at
   * `maxPromotionsPerFrame` per frame; the remainder waits in `pending`.
   * Failed drops wait for the next desired rebuild; cancelled-but-desired-
   * again keys re-request immediately.
   */
  private promote(): void {
    this.readyBuf.length = 0;
    this.droppedBuf.length = 0;
    this.source.drain(this.readyBuf, this.droppedBuf);
    for (const d of this.droppedBuf) {
      const id = keyId(d.key);
      this.loading.delete(id);
      if (d.kind === 'failed') {
        console.warn(`threetiles: tile ${id} failed: ${d.reason} - dropping until the next desired rebuild`);
      } else if (this.desired.has(id) && !this.resident.has(id)) {
        // wanted again by the time the drop arrived — re-request now
        this.requestTile(d.key);
      }
    }
    this.pending.push(...this.readyBuf);

    // budgeted promotion: mesh + texture creation staggered per frame
    for (let n = 0; n < this.streaming.maxPromotionsPerFrame; n++) {
      const payload = this.pending.shift();
      if (!payload) break;
      const key = payload.key;
      const id = keyId(key);
      this.loading.delete(id);
      if (!this.desired.has(id) || this.resident.has(id)) {
        // no longer wanted (payload data just drops)
        payload.albedo.close();
        payload.normals?.close();
        continue;
      }

      const albedo = bitmapTexture(payload.albedo, true);
      const heightmap = dataTexture(payload.height.data, payload.height.width, payload.height.height);
      const normals = payload.normals ? bitmapTexture(payload.normals, false) : this.defaultNormalTex;
      const material = new TerrainMaterial({ albedo, heightmap, normals }, this.rendering);

      const w = this.world;
      const idx = key.zoom - w.baseZoom;
      const size = zoomSize(w, key.zoom);
      const absX = (key.x + 0.5) * size;
      const absZ = (key.z + 0.5) * size;
      const mesh = new THREE.Mesh(this.zoomGeometries[idx], material);
      mesh.position.set(absX + this.anchor.worldOffset.x, 0, absZ + this.anchor.worldOffset.z);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const tile: Tile = { key, size, absX, absZ, mesh, lastDrawn: this.frame };
      mesh.onBeforeRender = () => {
        tile.lastDrawn = this.frame;
      };
      this.group.add(mesh);
      this.resident.set(id, tile);
      this.grids.set(id, payload.grid);
      this.coverageDirty = true; // a new resident can cover parent/children
    }
  }

  /**
   * Movement-gated desired-set rebuild: runs the pure LOD policy, cancels
   * loading keys that fell out of the set (once, here — the set only changes
   * in this method), and requests missing keys.
   */
  private updateDesired(): void {
    const abs = this.absCamera();
    const ud = this.streaming.updateDistance;
    if (abs.distanceToSquared(this.lastDesiredPos) <= ud * ud) return;
    this.lastDesiredPos.copy(abs);

    this.scratch.length = 0;
    const opts: LodOptions = {
      baseZoom: this.world.baseZoom,
      maxZoom: this.world.maxZoom,
      baseTileSize: this.world.tileSize,
      radius: this.streaming.radius,
      thresholds: this.streaming.thresholds,
    };
    desiredTiles(opts, abs, this.scratch);
    this.desired = new Map(this.scratch.map((k) => [keyId(k), k]));
    this.coverageDirty = true;

    // cancel once, here — the desired set only changes in this method
    for (const [id, key] of this.loading) {
      if (!this.desired.has(id)) this.source.cancel(key);
    }
    for (const [id, key] of this.desired) {
      if (!this.resident.has(id) && !this.loading.has(id)) this.requestTile(key);
    }
  }

  private requestTile(key: TileKey): void {
    const scale = 2 ** (key.zoom - this.world.baseZoom);
    this.source.request({
      key,
      x: key.x + this.world.anchorX * scale,
      z: key.z + this.world.anchorZ * scale,
    });
    this.loading.set(keyId(key), key);
  }

  /**
   * Initial-loading contract: `loading` flips only once a desired set EXISTS
   * and is fully serviced. Must run after `updateDesired`.
   */
  private updateStatus(): void {
    const st = this.status;
    st.resident = this.resident.size;
    if (this.desired.size === 0) {
      st.progress = 0;
      return;
    }
    let have = 0;
    for (const id of this.desired.keys()) if (this.resident.has(id)) have++;
    st.progress = have / this.desired.size;
    if (st.loading && this.loading.size === 0 && this.pending.length === 0) {
      st.loading = false;
      console.info(`threetiles: initial load complete: ${this.resident.size} tiles resident`);
    }
  }

  /** Rebake every tile transform after a large-world rebase. */
  private rebakeIfMoved(): void {
    const off = this.anchor.worldOffset;
    if (this.bakedOffset.equals(off)) return;
    this.bakedOffset.copy(off);
    for (const tile of this.resident.values()) {
      tile.mesh.position.set(tile.absX + off.x, 0, tile.absZ + off.z);
      tile.mesh.updateMatrix();
    }
  }

  /** Push RenderingConfig changes to every live material. */
  private syncRendering(): void {
    const r = this.rendering;
    const sig = [
      r.fogStart, r.fogEnd, r.skirtDrop, r.sunScale, r.heightScale, r.normalsScale,
      r.fogColor.getHex(), r.ambient.getHex(),
      r.sunDirection.x, r.sunDirection.y, r.sunDirection.z,
    ].join(',');
    if (sig === this.lastRendering) return;
    this.lastRendering = sig;
    for (const tile of this.resident.values()) tile.mesh.material.applyRendering(r);
  }
}
