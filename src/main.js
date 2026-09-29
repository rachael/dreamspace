// Dreamspace viewer: the calm sci-fi / fantasy world, its guide, and the live link to the server (docs/CONTRACT.md).
// Built on the Vibe XR starter plumbing: renderer, controllers, hands, VR/AR buttons and AR passthrough are unchanged.
// Every feature module is loaded with a dynamic import and created inside try/catch, so one broken module never
// blacks out the world: it logs a warning and the rest keeps running.
import './emulator.js'; // desktop only: emulated Quest 3 so Enter VR works without a headset (must stay first)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const params = new URLSearchParams(location.search);
const EMBED = params.has('embed');           // the phone's live world window: no overlay, no voice, no speech
const GUIDE_NAME = 'Lumen';

// ---------- renderer, camera, scene (plumbing) ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#070b1a'); // the environment takes over background + fog on its first update
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 2.2); // eye height; in XR the headset drives the camera

const orbit = new OrbitControls(camera, renderer.domElement); // desktop only
orbit.target.set(0, 1.1, -1.2);
orbit.enableDamping = true;
orbit.maxDistance = 12;
orbit.update();

// ---------- lights: archetypes use lit materials; tinted to the mood every frame. Never add lights later. ----------
const hemi = new THREE.HemisphereLight('#9fb8ff', '#1a1330', 0.9);
scene.add(hemi);
const key = new THREE.DirectionalLight('#dfe8ff', 1.1);
key.position.set(2, 4, 2);
scene.add(key);

// ---------- the room: everything here is hidden in AR so passthrough shows ----------
const room = new THREE.Group();
room.name = 'room';
scene.add(room);

// ---------- feature modules ----------
function noop() {}
async function load(path) {
  try { return await import(path); } catch (err) { console.warn(`[dreamspace] ${path} failed to load`, err); return null; }
}
function make(label, fn) {
  try { return fn() || null; } catch (err) { console.warn(`[dreamspace] ${label} failed to start`, err); return null; }
}
const [envMod, objMod, guideMod, panelMod, creaMod, tpMod, netMod, voiceMod] = await Promise.all([
  load('./world/environment.js'), load('./world/objects.js'), load('./world/guide.js'), load('./ui/panel3d.js'),
  load('./world/creations.js'), load('./xr/teleport.js'), load('./net/client.js'),
  EMBED ? null : load('./voice/index.js'),
]);

const env = envMod && make('environment', () => envMod.createEnvironment({ scene, room, THREE, renderer, camera }));
const objects = objMod && make('objects', () => objMod.createObjectLayer({ scene, THREE }));
const guide = guideMod && make('guide', () => guideMod.createGuide({ scene, THREE, camera }));
const chat = panelMod && make('chat panel', () => panelMod.createChatPanel({ THREE, camera, scene, renderer, guideName: GUIDE_NAME }));
const creations = creaMod && make('creations', () => creaMod.createCreations({
  THREE, scene, room, onError: ({ slug, message }) => ui.status(`Creation “${slug}” paused: ${message}`, 'warn'),
}));
const grabbables = objects ? objects.pickables : []; // live array of object roots
const teleport = tpMod && make('teleport', () => tpMod.createTeleport({
  THREE, renderer, scene, camera,
  targets: () => (env ? env.teleportTargets : []),
  floorRadius: env ? env.groundRadius : 12,
  blockers: grabbables, // a pinch that starts on a world object is a grab, not a teleport
}));

// ---------- desktop overlay (index.html) ----------
const $ = (id) => document.getElementById(id);
const ui = makeOverlay();

// ---------- live link to the server ----------
const myIds = new Set(); // ids of messages this viewer sent, so only replies to them are spoken here
let firstSnapshot = true;
let voice = null;

function moodOf(o) {
  if (!o || typeof o !== 'object') return null;
  const m = {};
  for (const k of ['preset', 'fog', 'glow']) if (o[k] != null) m[k] = o[k];
  return Object.keys(m).length ? m : null;
}
function applyMood(m) {
  if (!m) return;
  try { env?.setMood(m); } catch (err) { console.warn(err); }
  try { guide?.setMood(m); } catch (err) { console.warn(err); }
}

const net = netMod ? make('network', () => netMod.connect({
  from: () => (renderer.xr.isPresenting ? 'xr' : 'desktop'),
  onSnapshot(world) {
    objects?.sync(world);
    applyMood(moodOf(world?.mood));
    creations?.setWorld(world);
    if (firstSnapshot) {
      firstSnapshot = false;
      if (creations) net.creations().then((r) => { if (r && r.ok) creations.sync(r); });
    }
  },
  onOp(op) {
    if (objects && !objects.apply(op)) net.refresh(); // an op the layer can't render alone: refetch the world
    if (op.type === 'mood') applyMood(moodOf(op.mood) || moodOf(op));
    if (op.type === 'guide') { const gm = op.guide?.mood ?? op.mood; if (typeof gm === 'string') guide?.setMood(gm); }
    creations?.setWorld(net.world());
  },
  onChat(m) {
    if (!m || typeof m.text !== 'string') return;
    chat?.add(m);
    ui.addLine(m);
    if (m.role !== 'guide') return;
    guide?.say(m.text);
    const mine = m.from === 'desktop' || m.from === 'xr' || myIds.has(m.replyTo) || myIds.has(m.id);
    if (mine && !EMBED) speak(m.text);
  },
  onStatus(s) {
    guide?.setThinking(!!s.thinking);
    chat?.setThinking(!!s.thinking);
    ui.thinking(s);
  },
  onCreation(c) { creations?.load(c); },
  onError(e) {
    if (e?.source === 'auth') return; // shown by onConnection('unauthorized')
    ui.status(e?.message || 'Something went wrong', 'warn');
  },
  onConnection(state) { ui.connection(state); },
})) : null;
if (!net) ui.connection('closed');

function speak(text) {
  if (voice) { voice.speak(text); return; }
  try { // voice module missing: plain speechSynthesis
    const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; speechSynthesis.speak(u);
  } catch { /* no speech here */ }
}

async function submit(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!text || !net) return false;
  const r = ui.vibeOn ? await net.vibe(text) : await net.send(text);
  if (r && r.ok && r.id) { myIds.add(r.id); if (myIds.size > 200) myIds.delete(myIds.values().next().value); }
  if (r && !r.ok) {
    if (r.status === 503 && ui.vibeOn) ui.status('Vibe mode isn’t running on the server.', 'warn');
    else if (r.status === 429) ui.status(ui.vibeOn ? 'Claude is still building the last thing.' : 'The guide is busy; try again in a moment.', 'warn');
  }
  return !!(r && r.ok);
}

// ---------- voice (desktop / headset browser; never in the phone's embed) ----------
if (voiceMod && !EMBED) {
  voice = make('voice', () => voiceMod.createVoice({
    handsFree: ui.handsFree,
    ignoreHiddenWhile: () => renderer.xr.isPresenting, // keep the mic if the page reports "hidden" in VR
    onFinal: (text) => { ui.interim(''); submit(text); },
    onInterim: (text) => ui.interim(text),
    onState: (state) => { ui.mic(state); guide?.setListening?.(state === 'listening' || state === 'hearing'); },
    onError: (e) => ui.status(e?.message || 'Voice problem', e?.recovered ? 'info' : 'warn'),
  }));
}
ui.voiceReady(voice);

// ---------- XR input: controllers + hands; grab a world object, release to move it ----------
const raycaster = new THREE.Raycaster();
raycaster.camera = camera; // needed if any hit object is a Sprite
const controllerModels = new XRControllerModelFactory();
const handModels = new XRHandModelFactory();
const held = [null, null]; // per controller: {root, id}
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const r3 = (v) => Math.round(v * 1000) / 1000;

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i); // target ray; also fires select on hand pinch
  controller.addEventListener('selectstart', () => {
    if (!objects || held[i] || teleport?.aiming) return;
    raycaster.setFromXRController(controller);
    const hit = raycaster.intersectObjects(grabbables, true).find((h) => objects.idOf(h.object) != null);
    if (!hit) return;
    const id = objects.idOf(hit.object);
    const root = objects.get(id);
    if (!root || held.some((h) => h && h.root === root)) return;
    held[i] = { root, id };
    controller.attach(root);
  });
  controller.addEventListener('selectend', () => {
    const h = held[i];
    if (!h) return;
    held[i] = null;
    if (h.root.parent === controller) scene.attach(h.root); // the object layer re-adopts it where it was dropped
    h.root.getWorldPosition(tmpPos);
    h.root.getWorldQuaternion(tmpQuat);
    tmpEuler.setFromQuaternion(tmpQuat, 'YXZ');
    net?.op({ type: 'move', id: h.id, position: [r3(tmpPos.x), r3(Math.max(0, tmpPos.y)), r3(tmpPos.z)], rotationY: r3(tmpEuler.y) });
  });
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: '#9ff3ff', transparent: true, opacity: 0.45 }));
  ray.scale.z = 3;
  ray.raycast = noop; // never a grab or teleport target
  controller.add(ray);
  scene.add(controller);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModels.createControllerModel(grip));
  scene.add(grip);

  const hand = renderer.xr.getHand(i);
  hand.add(handModels.createHandModel(hand, 'mesh'));
  scene.add(hand);
  // hide the ray when this input is a tracked hand (the pinch still fires select)
  controller.addEventListener('connected', (e) => { ray.visible = !e.data.hand; });
}

// ---------- VR / AR buttons + AR passthrough handling ----------
if (!EMBED) {
  // Both three.js buttons call navigator.xr.offerSession (and again after every session), and each new offer
  // supersedes the last one (IWER warns). Keep a single VR offer open: other calls get a promise that never
  // settles, so the buttons still work as plain clicks and the one open offer still starts VR when taken.
  const xr = navigator.xr;
  if (xr?.offerSession) {
    const offer = xr.offerSession.bind(xr);
    let open = false;
    xr.offerSession = (mode, init) => {
      if (mode !== 'immersive-vr' || open) return new Promise(() => {});
      open = true;
      const p = offer(mode, init);
      p.then(() => { open = false; }, () => { open = false; });
      return p;
    };
  }
  $('xr-buttons')?.append(
    VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }),
    ARButton.createButton(renderer, { optionalFeatures: ['hand-tracking', 'hit-test'] }));
}
renderer.xr.addEventListener('sessionstart', () => {
  const ar = renderer.xr.getSession().environmentBlendMode !== 'opaque';
  room.visible = !ar;          // in AR the real room is the room; world objects (in scene) stay
  env?.setAR(ar);              // AR: the environment clears background + fog so passthrough shows
});
renderer.xr.addEventListener('sessionend', () => {
  room.visible = true;
  env?.setAR(false);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- the animation loop (72-90 fps in the headset) ----------
function tick(label, fn) { try { fn(); } catch (err) { console.warn(`[dreamspace] ${label} update failed`, err); } }
const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1), t = timer.getElapsed();
  if (!renderer.xr.isPresenting) orbit.update();
  if (teleport) tick('teleport', () => teleport.update(dt, t));
  if (env) tick('environment', () => {
    env.update(dt, t);
    const p = env.palette;
    if (p?.ambientSky?.isColor) hemi.color.copy(p.ambientSky);
    if (p?.ambientGround?.isColor) hemi.groundColor.copy(p.ambientGround);
    if (p?.key?.isColor) key.color.copy(p.key);
  });
  if (objects) tick('objects', () => objects.update(dt, t));
  if (creations) tick('creations', () => creations.update(dt, t));
  if (guide) tick('guide', () => guide.update(dt, t));
  if (chat) tick('chat panel', () => chat.update(dt, t));
  renderer.render(scene, camera);
});

// ================================================================================================================
// Desktop overlay: title, chat log, text + mic, hands-free, vibe, brain picker, phone hint. Hidden with ?embed=1.
// ================================================================================================================
function makeOverlay() {
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dreamspace.' + k); return v == null ? d : v === '1'; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dreamspace.' + k, v ? '1' : '0'); } catch { /* private mode */ } },
  };
  const el = {
    log: $('log'), status: $('status'), form: $('ask'), text: $('text'), mic: $('mic'), send: $('send'),
    handsfree: $('handsfree'), vibe: $('vibe'), brain: $('brain'), conn: $('conn'), phone: $('phone-hint'),
    copy: $('copy-phone'), interim: $('interim'),
  };
  const state = { handsFree: store.get('handsfree', false), vibe: store.get('vibe', false), micOn: false, health: null };
  const seen = new Set();
  let statusTimer = null;
  let thinking = false;

  if (EMBED || !el.log) {
    return {
      handsFree: false, vibeOn: false, addLine: noop, status: noop, thinking: noop, connection: noop,
      interim: noop, mic: noop, voiceReady: noop,
    };
  }

  const LABEL = { phone: 'phone', xr: 'headset', desktop: 'desktop', mcp: 'Claude', 'claude.ai': 'Claude' };
  function addLine(m) {
    const k = (m.role === 'user' ? 'u:' : 'g:') + (m.id || m.text);
    if (seen.has(k)) return;
    seen.add(k);
    if (seen.size > 400) seen.clear();
    const row = document.createElement('p');
    row.className = 'line ' + (m.role === 'user' ? 'user' : 'guide') + (m.mode === 'vibe' ? ' vibe' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.role === 'user' ? (m.from && m.from !== 'desktop' ? `you · ${LABEL[m.from] || m.from}` : 'you') : GUIDE_NAME;
    const body = document.createElement('span');
    body.textContent = m.text;
    row.append(who, body);
    el.log.append(row);
    while (el.log.children.length > 60) el.log.firstElementChild.remove();
    el.log.scrollTop = el.log.scrollHeight;
    el.log.hidden = false;
  }
  function status(text, tone = 'info', ms = 6000) {
    clearTimeout(statusTimer);
    el.status.textContent = text || '';
    el.status.dataset.tone = tone;
    if (text && ms) statusTimer = setTimeout(() => { el.status.textContent = thinking ? `${GUIDE_NAME} is thinking…` : ''; }, ms);
  }
  function setThinking(s) {
    thinking = !!s.thinking;
    const d = String(s.detail || '').replace(/^vibe:\s*/i, '');
    if (thinking) status(s.mode === 'vibe' ? `Building${d ? ': ' + d : '…'}` : `${GUIDE_NAME} is thinking…`, 'info', 0);
    else if (/thinking|Building/.test(el.status.textContent)) status('');
  }
  const CONN = {
    connecting: ['Connecting…', 'wait'], open: ['Live', 'ok'], reconnecting: ['Reconnecting…', 'wait'],
    unauthorized: ['Needs the world key', 'bad'], closed: ['Offline', 'bad'],
  };
  function connection(s) {
    const [text, tone] = CONN[s] || [s, 'wait'];
    el.conn.textContent = text;
    el.conn.dataset.tone = tone;
    if (s === 'unauthorized') status('Open the link printed by “npm run up” (it ends in ?t=…) to join the world.', 'warn', 0);
    else if (s === 'open' && /world key/.test(el.status.textContent)) status('');
  }
  function paintToggles() {
    el.handsfree.setAttribute('aria-pressed', String(state.handsFree));
    el.vibe.setAttribute('aria-pressed', String(state.vibe));
    document.body.classList.toggle('vibe', state.vibe);
    el.text.placeholder = state.vibe ? 'Describe something to build…' : `Say something to ${GUIDE_NAME}…`;
  }
  function mic(s) {
    if (s === 'error' || (s === 'idle' && !state.handsFree)) state.micOn = false;
    el.mic.dataset.state = s;
    el.mic.setAttribute('aria-pressed', String(state.micOn || s === 'listening' || s === 'hearing'));
    const LAB = { listening: 'Listening', hearing: 'Hearing you', transcribing: 'Transcribing', speaking: 'Speaking', paused: 'Paused' };
    el.mic.title = LAB[s] || 'Talk';
  }
  function voiceReady(v) {
    if (!v || !v.supported?.stt) {
      el.mic.disabled = true;
      el.mic.title = 'Voice input isn’t available in this browser. Type instead.';
      el.handsfree.disabled = true;
    }
  }

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    try { voice?.unlock(); } catch { /* */ }
    const t = el.text.value;
    if (!t.trim()) return;
    el.text.value = '';
    submit(t);
  });
  el.mic.addEventListener('click', () => {
    if (!voice) return;
    const live = ['listening', 'hearing', 'transcribing', 'paused'].includes(voice.state);
    if (!voice.speaking && (state.micOn || live)) { state.micOn = false; voice.stop(); mic('idle'); return; }
    state.micOn = voice.start() !== false; // synchronous inside the click (mic + audio unlock); also barge-in while speaking
    mic(state.micOn ? 'listening' : (voice.state || 'error'));
  });
  el.handsfree.addEventListener('click', () => {
    state.handsFree = !state.handsFree;
    store.set('handsfree', state.handsFree);
    voice?.setHandsFree(state.handsFree);
    paintToggles();
    status(state.handsFree ? 'Hands-free: tap the mic once and keep talking.' : 'Hands-free off: tap the mic for each message.');
  });
  el.vibe.addEventListener('click', () => {
    if (!state.vibe && state.health && state.health.vibe === false) { status('Vibe mode isn’t running on the server.', 'warn'); return; }
    state.vibe = !state.vibe;
    store.set('vibe', state.vibe);
    paintToggles();
    status(state.vibe ? 'Vibe mode: describe something and Claude builds it into the world.' : `Back to talking with ${GUIDE_NAME}.`);
  });
  el.brain.addEventListener('change', async () => {
    const b = el.brain.value;
    const r = net ? await net.setBrain(b) : { ok: false, error: 'offline' };
    if (r.ok) status(b === 'auto' ? 'The guide will use the best brain available.' : `The guide now thinks with ${el.brain.selectedOptions[0].dataset.name}.`);
    else { status(`Couldn’t switch brains: ${r.error || 'server error'}`, 'warn'); refreshHealth(); }
  });

  async function refreshHealth() {
    if (!net) return;
    const h = await net.health();
    if (!h || h.ok === false) return;
    state.health = h;
    for (const opt of el.brain.options) {
      if (opt.value === 'auto') continue;
      const ok = !h.brains || h.brains[opt.value] !== false;
      opt.textContent = opt.dataset.label + (ok ? '' : ' (not running)');
      opt.disabled = !ok;
    }
    if (typeof h.brain === 'string' && [...el.brain.options].some((o) => o.value === h.brain)) el.brain.value = h.brain;
    el.vibe.disabled = h.vibe === false && !state.vibe;
  }
  setTimeout(refreshHealth, 0);
  setInterval(refreshHealth, 30000);

  // Phone hint: a phone can only use an https origin (mic + WebXR need a secure context; localhost is this Mac).
  const https = location.protocol === 'https:';
  const phoneUrl = location.origin + '/phone/';
  if (https) {
    el.phone.querySelector('.url').textContent = phoneUrl.replace(/^https:\/\//, '');
    el.copy.hidden = false;
    el.copy.addEventListener('click', async () => {
      const tok = net?.token?.();
      const link = phoneUrl + (tok ? '?t=' + encodeURIComponent(tok) : '');
      try { await navigator.clipboard.writeText(link); status('Phone link copied. Open it on your iPhone, then Add to Home Screen.'); }
      catch { status('Couldn’t copy. The phone link is printed by “npm run up”.', 'warn'); }
    });
  } else {
    el.phone.querySelector('.url').textContent = 'run “npm run up” and scan its QR code';
  }

  paintToggles();
  return {
    get handsFree() { return state.handsFree; },
    get vibeOn() { return state.vibe; },
    addLine, status, thinking: setThinking, connection, mic, voiceReady,
    interim(t) { el.interim.textContent = t || ''; el.interim.hidden = !t; },
  };
}
