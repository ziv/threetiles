/**
 * The tile source: background fetching of texture + heightmap + normals per
 * tile, image decoding, heightmap synthesis above the native zoom, and
 * delivery of whole-tile payloads through queues drained once per frame.
 *
 * Browser backend, mirroring bevytiles' wasm source: `fetch` promises with
 * at most {@link NetworkConfig.concurrency} tiles in flight at once. Semantics
 * preserved from the native pool: dedup by key, every request answered
 * exactly once (payload or drop), cancel flags checked between assets. No
 * disk: fetched bytes are not persisted (the browser's HTTP cache applies),
 * but the decoded native-zoom heightmaps that feed synthesis are kept in a
 * small memory cache so the 4–16 descendants of one parent cost one download.
 */
import type { NetworkConfig } from './config';
import { MAX_ZOOM, MIN_ZOOM } from './config';
import { HeightGrid } from './height';
import { keyId, type TileKey } from './lod';
import {
  decodeTerrariumFloats,
  encodeTerrarium,
  upsampleQuadrant,
  type RgbaImage,
} from './synth';

/**
 * One tile fetch: anchor-relative identity + absolute provider coordinates at
 * `key.zoom` (the caller resolves the anchor; the source knows nothing about
 * world anchoring).
 */
export interface TileRequest {
  /** Anchor-relative identity, used for dedup/cancel and echoed in the payload/drop. */
  key: TileKey;
  /** Absolute provider tile column at `key.zoom`. */
  x: number;
  /** Absolute provider tile row at `key.zoom`. */
  z: number;
}

/** A completed tile: all three assets decoded, plus the CPU height grid. */
export interface TilePayload {
  /** The request's anchor-relative key. */
  key: TileKey;
  /** Decoded satellite imagery, ready for upload as a texture. */
  albedo: ImageBitmap;
  /** Decoded (or synthesized) Terrarium heightmap, raw RGBA. */
  height: RgbaImage;
  /** Decoded normal map, or `null` for the flat default. */
  normals: ImageBitmap | null;
  /** CPU height grid derived from `height`. */
  grid: HeightGrid;
}

/**
 * A tile that will not arrive. Every {@link TileSource.request} is answered by
 * exactly one {@link TilePayload} or one of these.
 */
export type TileDrop =
  /** Cancelled before completing. If wanted again, re-request immediately. */
  | { kind: 'cancelled'; key: TileKey }
  /** Fetch or decode failed; wait for the next desired rebuild rather than hot-retrying. */
  | { kind: 'failed'; key: TileKey; reason: string };

const CANCELLED = '\u0000cancelled';

/** Expand a `:zoom:/:x:/:y:` URL template. */
export function expandUrl(template: string, zoom: number, x: number, z: number): string {
  return template.replace(':zoom:', String(zoom)).replace(':x:', String(x)).replace(':y:', String(z));
}

/**
 * Synthesize the heightmap for (`zoom`, `x`, `z`) from its decoded native
 * ancestor's float heights (`w`×`h`): quadrant-chain upsample from
 * `native + 1` up to `zoom`.
 */
export function synthesizeHeightmap(
  parentFloats: Float32Array,
  w: number,
  h: number,
  native: number,
  zoom: number,
  x: number,
  z: number,
): RgbaImage {
  let floats: Float32Array = parentFloats;
  for (let level = native + 1; level <= zoom; level++) {
    const shift = zoom - level;
    const qx = (x >> shift) & 1;
    const qz = (z >> shift) & 1;
    floats = upsampleQuadrant(floats, w, h, qx, qz);
  }
  return encodeTerrarium(floats, w, h);
}

/** Decoded float heights of one native-zoom heightmap, shared between descendants. */
interface ParentHeights {
  floats: Float32Array;
  w: number;
  h: number;
}

/**
 * Parent cache cap: when exceeded the cache is flushed wholesale (a moving
 * camera outruns any smarter policy's gain; 64 × 256 KB ≈ 16 MB at most).
 */
const PARENT_CACHE_CAP = 64;

interface Job {
  req: TileRequest;
  cancelled: boolean;
}

/** Decode image bytes to a bitmap with no color/alpha tampering. */
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    imageOrientation: 'none',
  });
}

/** Read a bitmap's raw RGBA pixels (for data we must decode on the CPU). */
function readPixels(bmp: ImageBitmap): RgbaImage {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * The background tile fetcher. Hand out requests and drain results once per
 * frame. {@link dispose} lets in-flight fetches finish and discard their
 * results.
 */
export class TileSource {
  private readonly cfg: NetworkConfig;
  private readonly maxActive: number;
  private readonly inFlight = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly parents = new Map<string, Promise<ParentHeights>>();
  private readonly payloads: TilePayload[] = [];
  private readonly drops: TileDrop[] = [];
  private disposed = false;

  /** @throws if `cfg.nativeTerrainZoom` lies outside `[MIN_ZOOM, MAX_ZOOM]`. */
  constructor(cfg: NetworkConfig) {
    if (cfg.nativeTerrainZoom < MIN_ZOOM || cfg.nativeTerrainZoom > MAX_ZOOM) {
      throw new Error(`nativeTerrainZoom ${cfg.nativeTerrainZoom} outside supported range`);
    }
    this.cfg = { ...cfg };
    this.maxActive = Math.max(1, cfg.concurrency);
  }

  /**
   * Queue one tile fetch. Dedup by key: a no-op while the key is in flight (a
   * cancelled-but-uncollected job counts). Every request is answered exactly
   * once — payload or drop.
   */
  request(req: TileRequest): void {
    const id = keyId(req.key);
    if (this.inFlight.has(id)) return;
    const job: Job = { req, cancelled: false };
    this.inFlight.set(id, job);
    this.queue.push(job);
    this.pump();
  }

  /** Flag a job for cancellation (checked at pickup and between assets). */
  cancel(key: TileKey): void {
    const job = this.inFlight.get(keyId(key));
    if (job) job.cancelled = true;
  }

  /** Collect everything finished since the last drain (non-blocking). */
  drain(ready: TilePayload[], dropped: TileDrop[]): void {
    ready.push(...this.payloads);
    dropped.push(...this.drops);
    this.payloads.length = 0;
    this.drops.length = 0;
  }

  /** Stop answering; in-flight fetches complete and are discarded. */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.inFlight.clear();
    this.parents.clear();
    for (const p of this.payloads) {
      p.albedo.close();
      p.normals?.close();
    }
    this.payloads.length = 0;
    this.drops.length = 0;
  }

  /**
   * Start queued jobs while below the concurrency cap. Cancelled jobs are
   * answered immediately without occupying a slot.
   */
  private pump(): void {
    while (this.active < this.maxActive) {
      const job = this.queue.shift();
      if (!job) return;
      if (job.cancelled) {
        this.inFlight.delete(keyId(job.req.key));
        this.drops.push({ kind: 'cancelled', key: job.req.key });
        continue;
      }
      this.active += 1;
      void this.handle(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async handle(job: Job): Promise<void> {
    const key = job.req.key;
    let payload: TilePayload | undefined;
    let error: string | undefined;
    try {
      const albedoBlob = await this.fetchBlob(this.cfg.textureUrl, key.zoom, job.req.x, job.req.z);
      const albedo = await decodeImage(albedoBlob);
      if (job.cancelled) {
        albedo.close();
        throw new Error(CANCELLED);
      }
      const height = await this.fetchHeightmap(job.req);
      if (job.cancelled) {
        albedo.close();
        throw new Error(CANCELLED);
      }
      const normals = await this.fetchNormals(job.req);
      const grid = HeightGrid.fromTerrarium(height);
      payload = { key, albedo, height, normals, grid };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (this.disposed) {
      payload?.albedo.close();
      payload?.normals?.close();
      return;
    }
    this.inFlight.delete(keyId(key));
    if (job.cancelled || error === CANCELLED) {
      payload?.albedo.close();
      payload?.normals?.close();
      this.drops.push({ kind: 'cancelled', key });
    } else if (payload) {
      this.payloads.push(payload);
    } else {
      this.drops.push({ kind: 'failed', key, reason: error ?? 'unknown' });
    }
  }

  // -- assets ---------------------------------------------------------------

  private async fetchBlob(template: string, zoom: number, x: number, z: number): Promise<Blob> {
    const url = expandUrl(template, zoom, x, z);
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`GET ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) throw new Error(`GET ${url}: HTTP ${resp.status} ${resp.statusText}`);
    return resp.blob();
  }

  /**
   * Heightmaps above the native zoom are synthesized from the native ancestor
   * (memory-cached); no HTTP above the native zoom.
   */
  private async fetchHeightmap(req: TileRequest): Promise<RgbaImage> {
    const native = this.cfg.nativeTerrainZoom;
    if (req.key.zoom <= native) {
      const blob = await this.fetchBlob(this.cfg.heightmapUrl, req.key.zoom, req.x, req.z);
      const bmp = await decodeImage(blob);
      const px = readPixels(bmp);
      bmp.close();
      return px;
    }
    const dz = req.key.zoom - native;
    const parent = await this.parentHeights(req.x >> dz, req.z >> dz);
    return synthesizeHeightmap(parent.floats, parent.w, parent.h, native, req.key.zoom, req.x, req.z);
  }

  private parentHeights(ax: number, az: number): Promise<ParentHeights> {
    const id = `${ax}/${az}`;
    const cached = this.parents.get(id);
    if (cached) return cached;
    const native = this.cfg.nativeTerrainZoom;
    const p = (async (): Promise<ParentHeights> => {
      const blob = await this.fetchBlob(this.cfg.heightmapUrl, native, ax, az);
      const bmp = await decodeImage(blob);
      const px = readPixels(bmp);
      bmp.close();
      return { floats: decodeTerrariumFloats(px), w: px.width, h: px.height };
    })();
    if (this.parents.size >= PARENT_CACHE_CAP) this.parents.clear();
    this.parents.set(id, p);
    // a failed parent must not poison the cache
    p.catch(() => {
      if (this.parents.get(id) === p) this.parents.delete(id);
    });
    return p;
  }

  /**
   * Normals never fail a tile: above the native zoom no HTTP is attempted;
   * below it, any failure falls back to the flat default (`null`).
   */
  private async fetchNormals(req: TileRequest): Promise<ImageBitmap | null> {
    if (req.key.zoom > this.cfg.nativeTerrainZoom) return null;
    try {
      const blob = await this.fetchBlob(this.cfg.normalsUrl, req.key.zoom, req.x, req.z);
      return await decodeImage(blob);
    } catch {
      return null;
    }
  }
}
