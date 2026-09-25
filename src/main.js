// Vibe XR starter: one three.js scene that runs on desktop and in the PICO browser (VR + AR).
// Claude Code edits this file live. Look for the ✏️ REMIX HERE markers.
import './emulator.js'; // desktop only: emulated Quest 3 so Enter VR works without a headset
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { PICO, applyPicoFog, picoMaterial } from '../theme/pico-theme.js';

// ---------- renderer, camera, scene (plumbing: rarely needs editing) ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
applyPicoFog(scene, THREE); // PICO background + fog (cleared automatically in AR, see below)
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.7, 2.6); // eye height; in XR the headset drives the camera

const orbit = new OrbitControls(camera, renderer.domElement); // desktop only
orbit.target.set(0, 0.95, -0.6); // aim low so the hero sits above the 2D overlay
orbit.enableDamping = true;
orbit.update();

// ---------- ✏️ REMIX HERE: lights ----------
scene.add(new THREE.HemisphereLight(PICO.ink, PICO.bg, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(2, 4, 2);
scene.add(key);
const heroLight = new THREE.PointLight(PICO.glow, 5, 4); // the glow that spills onto the floor
heroLight.position.set(0, 1.3, -0.6);
scene.add(heroLight);

// ---------- ✏️ REMIX HERE: the room (hidden in AR so passthrough shows) ----------
const room = new THREE.Group();
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), picoMaterial(THREE, 'matte', { color: PICO.surface }));
floor.rotation.x = -Math.PI / 2;
room.add(floor);
const grid = new THREE.GridHelper(12, 24, PICO.accent, PICO.accent2);
grid.material.transparent = true;
grid.material.opacity = 0.5;
grid.position.y = 0.002;
room.add(grid);
scene.add(room);

// ---------- ✏️ REMIX HERE: the hero object (grab it, poke it, click it) ----------
const hero = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1),
  picoMaterial(THREE, 'matte', { color: PICO.accent, emissive: PICO.accent, emissiveIntensity: 0.5, flatShading: true }));
hero.position.set(0, 1.3, -0.6);
const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.012, 12, 96), picoMaterial(THREE, 'glow'));
hero.add(halo);
scene.add(hero);
const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.9, 48), picoMaterial(THREE, 'glass'));
plinth.position.set(0, 0.45, -0.6); // a glass stand under the hero
room.add(plinth);
const grabbables = [hero]; // anything in this list can be grabbed with a controller or a pinch

// ---------- ✏️ REMIX HERE: add more objects below ----------
// e.g. load a GLB from assets/ (see CLAUDE.md, Recipes: "Add a GLB model"), or add pillars, particles, text...

// ---------- interaction state ----------
let spin = 0.4;          // radians/sec; poke and click add to it
let held = null;         // the object a controller is holding, if any
const HOME = hero.position.clone(); // where the hero floats; a release moves it
const heroPos = new THREE.Vector3();

function poke() {        // ✏️ REMIX HERE: what happens when the hero is poked or clicked
  spin += 6;
  hero.material.emissive.set(PICO.accent2);
  setTimeout(() => hero.material.emissive.set(PICO.accent), 250);
}

// ---------- XR input: controllers + hands (plumbing) ----------
const raycaster = new THREE.Raycaster();
const controllerModels = new XRControllerModelFactory();
const handModels = new XRHandModelFactory();
const hands = [];

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i); // target ray; also fires select on hand pinch
  controller.addEventListener('selectstart', () => {
    raycaster.setFromXRController(controller);
    let obj = raycaster.intersectObjects(grabbables, true)[0]?.object;
    while (obj && !grabbables.includes(obj)) obj = obj.parent; // grab the whole model, not one sub-mesh
    if (obj) { held = obj; controller.attach(held); }
  });
  controller.addEventListener('selectend', () => {
    if (held && held.parent === controller) {
      scene.attach(held);
      if (held === hero) HOME.copy(hero.position); // it floats where you let go
      held = null;
    }
  });
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: PICO.accent, transparent: true, opacity: 0.6 }));
  ray.scale.z = 3;
  controller.add(ray);
  scene.add(controller);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModels.createControllerModel(grip));
  scene.add(grip);

  const hand = renderer.xr.getHand(i);
  hand.add(handModels.createHandModel(hand, 'mesh'));
  scene.add(hand);
  hands.push(hand);
  // hide the ray when this input is a tracked hand (the pinch still fires select)
  controller.addEventListener('connected', (e) => { ray.visible = !e.data.hand; });
}

// poke: an index fingertip touching the hero counts as a poke
const tip = new THREE.Vector3();
let pokeCooldown = 0;
function checkPokes(dt) {
  pokeCooldown -= dt;
  for (const hand of hands) {
    const joint = hand.joints?.['index-finger-tip'];
    if (!joint || pokeCooldown > 0) continue;
    joint.getWorldPosition(tip);
    if (tip.distanceTo(hero.getWorldPosition(heroPos)) < 0.26) { poke(); pokeCooldown = 0.5; }
  }
}

// ---------- desktop: click the hero to poke it ----------
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.intersectObject(hero, false).length) poke();
});

// ---------- VR / AR buttons + AR passthrough handling ----------
const xrButtons = document.getElementById('xr-buttons');
xrButtons.append(
  VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }),
  ARButton.createButton(renderer, { optionalFeatures: ['hand-tracking', 'hit-test'] }));
renderer.xr.addEventListener('sessionstart', () => {
  const ar = renderer.xr.getSession().environmentBlendMode !== 'opaque';
  room.visible = !ar;                         // in AR the real floor is the floor
  applyPicoFog(scene, THREE, { ar });         // AR: clear background + fog so passthrough shows
});
renderer.xr.addEventListener('sessionend', () => {
  room.visible = true;
  applyPicoFog(scene, THREE);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- ✏️ REMIX HERE: the animation loop (runs every frame, 72-90 fps in the headset) ----------
const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1), t = timer.getElapsed();
  spin += (0.4 - spin) * dt * 1.5;            // spin decays back to idle
  hero.rotation.y += spin * dt;
  halo.rotation.x = Math.sin(t * 0.8) * 0.6;
  if (held !== hero) hero.position.y = HOME.y + Math.sin(t * 1.4) * 0.04; // idle bob
  heroLight.position.copy(hero.getWorldPosition(heroPos));
  if (renderer.xr.isPresenting) checkPokes(dt); else orbit.update();
  renderer.render(scene, camera);
});
