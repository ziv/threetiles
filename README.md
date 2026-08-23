<div align="center">
    <img src="assets/icon.png" alt="logo" width="150"/>
    <br />
    <strong>3D geospatial engine for three.js</strong>
    <br />
    <br />
</div>

**Threetiles** is a 3D geospatial engine 🌎 for [three.js](https://threejs.org/) — a TypeScript port of
[bevytiles](https://github.com/ziv/bevytiles) (itself a port of the raytiles C++ engine). It streams satellite
imagery, [Terrarium](https://registry.opendata.aws/terrain-tiles/) heightmaps, and normal maps around a moving
camera and renders them as GPU-displaced terrain, letting you visualize any location on Earth in the browser.

It provides precise, ground-truth altitude data (`terrain.groundHeight`) for collision detection, spawning, and
topographical analysis.

## Run the demo

```sh
npm install
npm run dev          # opens the Vite dev server
```

Flies over the Grand Canyon. **A/D** roll, **Q/E** yaw, **W/S** pitch, **+/-** throttle, **R** reset after
crashing into the terrain. Tiles come straight from the providers via `fetch` (the browser's HTTP cache applies;
Esri imagery serves JPEG despite the endpoint name — decoding handles both).

`npm run build` produces a static, deployable bundle of the demo in `dist-demo/`.

## Use as a library

```sh
npm install threetiles three
```

```ts
import * as THREE from 'three';
import { Terrain, initialPosition, worldFromLatLon } from 'threetiles';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 1, 400_000);
const terrain = new Terrain(camera, { world: worldFromLatLon(46.206889, 9.497194) }, scene); // the Dolomites
camera.position.copy(initialPosition(terrain.world, 5000));

function frame() {
  terrain.update();            // reconcile → promote → update-desired → status
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
```

Configuration mirrors bevytiles: `WorldConfig`, `StreamingConfig`, `RenderingConfig` (runtime mutable — mutate
`terrain.rendering` and the engine syncs materials), `NetworkConfig` (`concurrency` replaces worker threads).
`world.maxZoom` defaults to 15; raising it (≤ 22) opts into heightmaps synthesized from the native-zoom ancestors
and flat default normals. Large worlds use the rebase convention via `terrain.anchor` / `terrain.rebase(shift)`
(`absolute = user − worldOffset`); see the demo's `rebaseLargeWorld`.

## Layout

| module                 | role                                                                                                   |
|------------------------|--------------------------------------------------------------------------------------------------------|
| `src/lod.ts`           | pure desired-set policy (snapshot-tested — values match the C++ and Rust engines exactly)              |
| `src/source.ts`        | tile fetching: `fetch` with a concurrency cap + memory cache of native heightmaps; decode + synthesis   |
| `src/terrain.ts`       | the engine: reconcile / promote / updateDesired / status; one mesh per tile                            |
| `src/material.ts`      | `ShaderMaterial` + GLSL: displacement, lighting, fog                                                    |
| `src/synth.ts`         | Terrarium float decode / quadrant upsample / carry-safe encode                                          |
| `src/height.ts`        | uint16 height grids + bilinear `groundHeight`                                                           |

## Notes

- Data: imagery © Esri; elevation/normals from the Mapzen/AWS terrain tiles. Mind their terms. Custom providers
  must send permissive CORS headers.
- `npm test` runs the offline suite (lod snapshots, synthesis math, height grids).
- Requires WebGL2 (three.js r163+).

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please): merge
[Conventional Commits](https://www.conventionalcommits.org/) to `main`, release-please opens/updates a release PR
(version bump + `CHANGELOG.md`), and merging that PR tags a GitHub release and publishes the package to npm with
provenance (`.github/workflows/release-please.yml`). Publishing uses npm trusted publishing (OIDC); set the repo up
as a trusted publisher for `threetiles` on npmjs.com, or add an `NPM_TOKEN` secret and wire it in the workflow.

## License

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or https://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or https://opensource.org/licenses/MIT)
