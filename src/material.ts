/**
 * The terrain material: albedo + Terrarium heightmap + normal map, displaced
 * in the vertex shader. One material per tile; parameters are pushed from
 * `RenderingConfig` by the engine. GLSL port of the raytiles shader pair.
 */
import * as THREE from 'three';
import type { RenderingConfig } from './config';

export const TERRAIN_VERTEX_SHADER = /* glsl */ `
uniform sampler2D heightTex;
uniform float heightScale;
uniform float skirtDrop;

varying vec2 vUv;
varying vec3 vWorldPosition;

// Terrarium decode: h = r*256 + g + b/256 - 32768 (channels are 0..1 here).
// Must stay in lockstep with the CPU decoders (synth.ts, height.ts).
float terrariumHeight(vec2 uv) {
  vec3 c = texture2D(heightTex, uv).rgb * 255.0;
  return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}

void main() {
  vec3 pos = position;
  pos.y += terrariumHeight(uv) * heightScale;

  // edge vertices drop by the skirt amount to hide LOD cracks
  float e = 0.000001;
  float edge = clamp(
    step(uv.x, e) + step(1.0 - e, uv.x) + step(uv.y, e) + step(1.0 - e, uv.y),
    0.0, 1.0);
  pos.y -= skirtDrop * heightScale * edge;

  vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPosition.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D albedoTex;
uniform sampler2D normalTex;
uniform vec4 fogColor;
uniform vec4 ambient;
uniform vec3 sunDirection;
uniform float sunScale;
uniform float fogStart;
uniform float fogEnd;
uniform float normalsScale;

varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  vec4 tex = texture2D(albedoTex, vUv);

  vec3 n = texture2D(normalTex, vUv).rgb * 2.0 - 1.0;
  n = vec3(n.xy * normalsScale, n.z);
  n = normalize(n);

  float sun = max(dot(n, normalize(sunDirection)), 0.0) * sunScale;
  vec4 lighting = clamp(ambient + vec4(sun), vec4(0.0), vec4(1.0));
  vec4 lit = tex * lighting;

  float dist = distance(vWorldPosition, cameraPosition);
  float fog = clamp((dist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  gl_FragColor = mix(lit, fogColor, fog);
  #include <colorspace_fragment>
}
`;

/** The three per-tile textures bound by a {@link TerrainMaterial}. */
export interface TerrainTextures {
  /** Satellite imagery (sRGB). */
  albedo: THREE.Texture;
  /** Terrarium heightmap — LINEAR (no color space), or the decode is gamma-warped garbage. */
  heightmap: THREE.Texture;
  /** Normal map — linear as well. */
  normals: THREE.Texture;
}

/** One material per resident tile: the three tile textures plus the parameter block. */
export class TerrainMaterial extends THREE.ShaderMaterial {
  constructor(textures: TerrainTextures, rendering: RenderingConfig) {
    super({
      vertexShader: TERRAIN_VERTEX_SHADER,
      fragmentShader: TERRAIN_FRAGMENT_SHADER,
      uniforms: {
        albedoTex: { value: textures.albedo },
        heightTex: { value: textures.heightmap },
        normalTex: { value: textures.normals },
        fogColor: { value: new THREE.Vector4() },
        ambient: { value: new THREE.Vector4() },
        sunDirection: { value: new THREE.Vector3() },
        sunScale: { value: 1 },
        fogStart: { value: 0 },
        fogEnd: { value: 1 },
        heightScale: { value: 1 },
        normalsScale: { value: 1 },
        skirtDrop: { value: 0 },
      },
      side: THREE.DoubleSide,
    });
    this.applyRendering(rendering);
  }

  /** Push the user-facing config into the uniform block (colors are linear in THREE.Color). */
  applyRendering(cfg: RenderingConfig): void {
    const u = this.uniforms;
    (u.fogColor.value as THREE.Vector4).set(cfg.fogColor.r, cfg.fogColor.g, cfg.fogColor.b, 1);
    (u.ambient.value as THREE.Vector4).set(cfg.ambient.r, cfg.ambient.g, cfg.ambient.b, 1);
    (u.sunDirection.value as THREE.Vector3).copy(cfg.sunDirection);
    u.sunScale.value = cfg.sunScale;
    u.fogStart.value = cfg.fogStart;
    u.fogEnd.value = cfg.fogEnd;
    u.heightScale.value = cfg.heightScale;
    u.normalsScale.value = cfg.normalsScale;
    u.skirtDrop.value = cfg.skirtDrop;
  }
}

function clampLinear(tex: THREE.Texture): void {
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.needsUpdate = true;
}

/** Wrap a decoded bitmap as a texture; `srgb` for color data, false for height/normals. */
export function bitmapTexture(bmp: ImageBitmap, srgb: boolean): THREE.Texture {
  const tex = new THREE.Texture(bmp);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  clampLinear(tex);
  return tex;
}

/** Raw RGBA bytes as a LINEAR texture (heightmaps, synthesized normals). */
export function dataTexture(data: Uint8Array | Uint8ClampedArray, w: number, h: number): THREE.DataTexture {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const tex = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  clampLinear(tex);
  return tex;
}
