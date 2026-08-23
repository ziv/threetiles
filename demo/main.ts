/**
 * The raytiles demo, on three.js: fly over real-world terrain with a loading
 * screen, large-world rebasing, ground-collision crash detection, and
 * sky-matched fog.
 *
 * Controls: **A/D** roll, **Q/E** yaw, **W/S** pitch, **+/-** throttle,
 * **R** reset after a crash. Change `LAT`/`LON` to fly anywhere.
 */
import * as THREE from 'three';
import { Terrain, ZOOM_LEVELS, initialPosition, worldFromLatLon } from '../src';

/** World anchor: the Grand Canyon. (The raytiles demo also ships anchors for
 * the Negev, the Dolomites, and London — any lat/lon works.) */
const LAT = 35.97391;
const LON = -113.76892;

/** Sky/fog color (raylib's SKYBLUE, for parity with the C++ demo). */
const SKY = new THREE.Color().setRGB(102 / 255, 191 / 255, 255 / 255, THREE.SRGBColorSpace);
/** How quickly the controls ease toward their target rate (1/s). */
const CONTROL_RESPONSE = 5;
/** User-space drift (meters) that triggers a large-world rebase. */
const REBASE_THRESHOLD = 4096;

// -- setup -------------------------------------------------------------------

const canvas = document.getElementById('threetiles') as HTMLCanvasElement;
const loadingEl = document.getElementById('loading')!;
const hudEl = document.getElementById('hud')!;
const crashEl = document.getElementById('crash')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(SKY);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 1, 400_000);

const world = worldFromLatLon(LAT, LON);
world.skirtOverlap = new Array(ZOOM_LEVELS).fill(1.01);
// opt into greater zoom: imagery fetches natively, heightmaps above z15 are
// synthesized, normals default to flat
world.maxZoom = 17;

const terrain = new Terrain(
  camera,
  {
    world,
    rendering: {
      fogColor: SKY,
      // skirtDrop: 1000,
      ambient: new THREE.Color().setRGB(200 / 255, 200 / 255, 200 / 255, THREE.SRGBColorSpace),
    },
    network: { concurrency: 8 },
  },
  scene,
);

function resetCamera(): void {
  const start = initialPosition(world, 5_000).add(terrain.anchor.worldOffset);
  camera.position.copy(start);
  camera.up.set(0, 1, 0);
  camera.lookAt(start.clone().add(new THREE.Vector3(-1000, -300, -1000)));
}
resetCamera();

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// -- input -------------------------------------------------------------------

const keys = new Set<string>();
const justPressed = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (!keys.has(e.code)) justPressed.add(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// -- flight state ------------------------------------------------------------

const flight = {
  speed: 120,
  /** Current angular velocity (rad/s): x = pitch, y = yaw, z = roll. */
  angVel: new THREE.Vector3(),
  crashed: false,
};

/**
 * Airplane-style fly camera, always moving forward. All rotations are around
 * the camera's LOCAL axes, so yawing while banked turns like an aircraft.
 * Keys set a TARGET angular velocity; the actual velocity eases toward it
 * exponentially (frame-rate independent).
 */
const target = new THREE.Vector3();
const forward = new THREE.Vector3();
function fly(dt: number): void {
  if (flight.crashed) return;
  target.set(0, 0, 0);
  if (keys.has('KeyA')) target.z += 1.2; // bank left
  if (keys.has('KeyD')) target.z -= 1.2; // bank right
  if (keys.has('KeyQ')) target.y += 0.8; // nose left
  if (keys.has('KeyE')) target.y -= 0.8; // nose right
  if (keys.has('KeyW')) target.x -= 0.6; // nose down
  if (keys.has('KeyS')) target.x += 0.6; // nose up
  if (keys.has('Equal') || keys.has('NumpadAdd')) flight.speed = Math.min(flight.speed * (1 + dt), 3_000);
  if (keys.has('Minus') || keys.has('NumpadSubtract')) flight.speed = Math.max(flight.speed * (1 - dt), 20);

  const blend = 1 - Math.exp(-CONTROL_RESPONSE * dt);
  flight.angVel.lerp(target, blend);

  camera.rotateZ(flight.angVel.z * dt);
  camera.rotateY(flight.angVel.y * dt);
  camera.rotateX(flight.angVel.x * dt);
  camera.getWorldDirection(forward);
  camera.position.addScaledVector(forward, flight.speed * dt);
}

/**
 * Keep the user-space camera near the origin: when it drifts past the
 * threshold, shift the camera AND the world offset by the same amount —
 * preserving `absolute = user − offset`. The engine rebakes tile transforms.
 */
const shift = new THREE.Vector3();
function rebaseLargeWorld(): void {
  shift.set(0, 0, 0);
  if (Math.abs(camera.position.x) > REBASE_THRESHOLD) shift.x = -Math.sign(camera.position.x) * REBASE_THRESHOLD;
  if (Math.abs(camera.position.z) > REBASE_THRESHOLD) shift.z = -Math.sign(camera.position.z) * REBASE_THRESHOLD;
  if (shift.x !== 0 || shift.z !== 0) {
    camera.position.add(shift);
    terrain.rebase(shift);
  }
}

/** Compare the camera altitude against the ground; below ground = crash. R respawns. */
function crashCheck(): void {
  if (flight.crashed) {
    if (justPressed.has('KeyR')) {
      flight.crashed = false;
      flight.angVel.set(0, 0, 0);
      resetCamera(); // reset orientation too — with roll you can crash inverted
      crashEl.style.display = 'none';
    }
    return;
  }
  const ground = terrain.groundHeight(camera.position) ?? 0;
  if (ground > camera.position.y) {
    flight.crashed = true;
    crashEl.style.display = 'block';
  }
}

function loadingUi(): void {
  if (terrain.status.loading) {
    loadingEl.textContent = `Loading... ${(terrain.status.progress * 100).toFixed(1)}%`;
  } else {
    loadingEl.style.display = 'none';
  }
}

function hud(): void {
  const p = camera.position;
  const o = terrain.anchor.worldOffset;
  hudEl.textContent =
    `A/D roll  Q/E yaw  W/S pitch  +/- throttle (${flight.speed.toFixed(0)} m/s)\n` +
    `user P ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}   offset ${o.x.toFixed(0)} ${o.z.toFixed(0)}\n` +
    `tiles resident: ${terrain.status.resident}`;
}

// -- frame loop --------------------------------------------------------------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  fly(dt);
  rebaseLargeWorld();
  crashCheck();
  terrain.update();
  loadingUi();
  hud();
  justPressed.clear();

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
