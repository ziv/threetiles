/**
 * The raytiles demo, on three.js: fly over real-world terrain with a loading
 * screen, large-world rebasing, ground-collision crash detection, and
 * sky-matched fog.
 *
 * Keyboard: **A/D** roll, **Q/E** yaw, **W/S** pitch, **+/-** throttle,
 * **R** reset after a crash. Touch: one-finger drag steers (a virtual stick:
 * right = bank right, down = nose up), two-finger pinch is the throttle, tap
 * resets after a crash. The selector (top right) flies to another anchor.
 */
import * as THREE from 'three';
import { Terrain, ZOOM_LEVELS, initialPosition, worldFromLatLon } from '../src';

/** Anchors that look great from the air; the raytiles demo ships similar. */
const PLACES: Record<string, { lat: number; lon: number; altitude: number }> = {
  'Grand Canyon': { lat: 35.97391, lon: -113.76892, altitude: 5_000 },
  'Dolomites': { lat: 46.206889, lon: 9.497194, altitude: 5_000 },
  // the anchor is the summit (8849 m) — spawn well above it
  'Mount Everest': { lat: 27.9881, lon: 86.925, altitude: 12_000 },
};
const DEFAULT_PLACE = 'Grand Canyon';

/** Sky/fog color (raylib's SKYBLUE, for parity with the C++ demo). */
const SKY = new THREE.Color().setRGB(102 / 255, 191 / 255, 255 / 255, THREE.SRGBColorSpace);
/** How quickly the controls ease toward their target rate (1/s). */
const CONTROL_RESPONSE = 5;
/** User-space drift (meters) that triggers a large-world rebase. */
const REBASE_THRESHOLD = 4096;
/** Touch-drag distance (px) for full stick deflection. */
const STEER_RADIUS = 100;

// -- setup -------------------------------------------------------------------

const canvas = document.getElementById('threetiles') as HTMLCanvasElement;
const loadingEl = document.getElementById('loading')!;
const hudEl = document.getElementById('hud')!;
const crashEl = document.getElementById('crash')!;
const helpEl = document.getElementById('help')!;
const placeEl = document.getElementById('place') as HTMLSelectElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(SKY);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 1, 400_000);

let startAltitude = PLACES[DEFAULT_PLACE].altitude;

function createTerrain(place: string): Terrain {
  const { lat, lon, altitude } = PLACES[place];
  startAltitude = altitude;
  const world = worldFromLatLon(lat, lon);
  world.skirtOverlap = new Array(ZOOM_LEVELS).fill(1.01);
  // opt into greater zoom: imagery fetches natively, heightmaps above z15 are
  // synthesized, normals default to flat
  world.maxZoom = 17;
  return new Terrain(
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
}

let terrain = createTerrain(DEFAULT_PLACE);

function resetCamera(): void {
  const start = initialPosition(terrain.world, startAltitude).add(terrain.anchor.worldOffset);
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

// -- flight state ------------------------------------------------------------

const flight = {
  speed: 120,
  /** Current angular velocity (rad/s): x = pitch, y = yaw, z = roll. */
  angVel: new THREE.Vector3(),
  crashed: false,
};

function crash(): void {
  flight.crashed = true;
  crashEl.style.display = 'block';
}

function resetAfterCrash(): void {
  flight.crashed = false;
  flight.angVel.set(0, 0, 0);
  resetCamera(); // reset orientation too — with roll you can crash inverted
  crashEl.style.display = 'none';
}

// -- place selector ----------------------------------------------------------

for (const name of Object.keys(PLACES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  placeEl.appendChild(opt);
}
placeEl.value = DEFAULT_PLACE;
placeEl.addEventListener('change', () => {
  // tear the world down and anchor a fresh one at the new coordinate
  terrain.dispose();
  terrain = createTerrain(placeEl.value);
  flight.speed = 120;
  flight.angVel.set(0, 0, 0);
  flight.crashed = false;
  crashEl.style.display = 'none';
  loadingEl.style.display = 'block';
  loadingEl.textContent = 'Loading... 0%';
  resetCamera();
  placeEl.blur(); // give the keys back to the flight controls
});

// -- input: keyboard ---------------------------------------------------------

const keys = new Set<string>();
const justPressed = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (document.activeElement === placeEl) return;
  if (!keys.has(e.code)) justPressed.add(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// -- input: touch ------------------------------------------------------------

/** Virtual-stick deflection, each axis in [-1, 1] (x: roll, y: pitch). */
const touchSteer = { x: 0, y: 0 };
let steerId: number | null = null;
let steerStart = { x: 0, y: 0 };
let pinchDist = 0;
let tapReset = false;

const touchDist = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

const clearSteer = (): void => {
  steerId = null;
  touchSteer.x = 0;
  touchSteer.y = 0;
};

/** Re-anchor the stick to `t` so steering continues without a jump. */
const anchorSteer = (t: Touch): void => {
  steerId = t.identifier;
  steerStart = { x: t.clientX, y: t.clientY };
  touchSteer.x = 0;
  touchSteer.y = 0;
};

canvas.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
    if (flight.crashed) {
      tapReset = true;
      return;
    }
    if (e.touches.length === 1) {
      anchorSteer(e.touches[0]);
    } else if (e.touches.length === 2) {
      clearSteer(); // both fingers belong to the pinch
      pinchDist = touchDist(e.touches[0], e.touches[1]);
    }
  },
  { passive: false },
);

canvas.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
    if (e.touches.length >= 2) {
      // pinch = throttle: speed scales with the finger distance ratio
      const d = touchDist(e.touches[0], e.touches[1]);
      if (pinchDist > 0) {
        flight.speed = Math.min(Math.max(flight.speed * (d / pinchDist), 20), 3_000);
      }
      pinchDist = d;
      return;
    }
    const t = e.touches[0];
    if (t === undefined || t.identifier !== steerId) return;
    const clamp1 = (v: number): number => Math.min(Math.max(v, -1), 1);
    touchSteer.x = clamp1((t.clientX - steerStart.x) / STEER_RADIUS);
    touchSteer.y = clamp1((t.clientY - steerStart.y) / STEER_RADIUS);
  },
  { passive: false },
);

const touchEnd = (e: TouchEvent): void => {
  e.preventDefault();
  pinchDist = 0;
  if (e.touches.length === 1) {
    anchorSteer(e.touches[0]); // pinch → single finger: back to steering
  } else if (e.touches.length === 0) {
    clearSteer();
  }
};
canvas.addEventListener('touchend', touchEnd, { passive: false });
canvas.addEventListener('touchcancel', touchEnd, { passive: false });

if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  helpEl.textContent = 'drag to steer · pinch for speed · tap to reset · keys: A/D Q/E W/S +/- R';
  crashEl.textContent = 'You crashed! Tap to reset.';
}

// -- systems -----------------------------------------------------------------

/**
 * Airplane-style fly camera, always moving forward. All rotations are around
 * the camera's LOCAL axes, so yawing while banked turns like an aircraft.
 * Keys and the touch stick set a TARGET angular velocity; the actual velocity
 * eases toward it exponentially (frame-rate independent).
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
  // touch stick: drag right = bank right, drag down = nose up (pull back)
  target.z -= 1.2 * touchSteer.x;
  target.x += 0.6 * touchSteer.y;
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

/** Compare the camera altitude against the ground; below ground = crash. R/tap respawns. */
function crashCheck(): void {
  if (flight.crashed) {
    if (justPressed.has('KeyR') || tapReset) resetAfterCrash();
    return;
  }
  const ground = terrain.groundHeight(camera.position) ?? 0;
  if (ground > camera.position.y) crash();
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
  tapReset = false;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// dev convenience: expose live state for debugging in the console
Object.defineProperty(window, '__demo', {
  configurable: true,
  get: () => ({ terrain, flight, camera }),
});
