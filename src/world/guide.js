// src/world/guide.js — the Dreamspace guide: a small glowing wisp that keeps you company, front-left of your view,
// with a canvas speech bubble.
//
//   import { createGuide } from './world/guide.js';
//   const guide = createGuide({ scene, THREE, camera });
//   net: onChat: (e) => { if (e.role === 'guide') guide.say(e.text); }
//        onStatus: (s) => guide.setThinking(s.thinking)
//   loop: guide.update(dt, t)                      // every frame
//
// API: createGuide({ scene, THREE, camera }) → {
//   object3d               THREE.Group (added to `scene`). Additive light only: it never hides what is behind it.
//                          Not raycastable: controller/teleport rays pass through the wisp and its bubble.
//   say(text)              show a speech bubble. Long text pages; a second line queues (max 3) instead of cutting
//                          the first. Also ends "thinking" (SSE order isn't guaranteed).
//   setThinking(bool)      motes gather into two slow counter-rotating rings, halo turns violet and breathes.
//                          Starting a new think fades the old bubble (unless it was said < 2.5 s ago: same turn).
//                          Auto-clears after 65 s so it can never spin forever.
//   setListening(bool)     optional: the wisp leans in a little and brightens while the mic is live
//   setMood(mood)          optional: tint by a guide mood word ('happy', 'curious', …) or a world preset
//                          ('aurora', 'dawn', …, or a Mood object {preset})
//   update(dt, t)          call every frame
//   dispose()
//   thinking               read-only
// }
//
// Placement: reads the viewer's head pose from camera.matrixWorld each frame and never moves the camera. The wisp
// rests 30° left of your heading, 1.1 m away, 10 cm below eye level. It follows lazily: it catches up briskly when
// you turn away, drifts back gently when you turn toward it, and is pushed aside so it is never within 15° of the
// centre of your view (8° while it's talking, so you can turn to read it without it fleeing). A teleport or entering
// XR makes it dissolve and re-form beside you instead of flying across the world.
// Budget: 4 draw calls (core glow, halo, motes, bubble), 6 triangles + 28 points. No lights. No per-frame object
// allocations. The canvas bubble only redraws when the text or page changes.

import {
  FONT_STACK, makeCanvas, makeCanvasTexture, makeUiMaterial, setUiOpacity, cleanText, wrapText, ellipsize,
  whenFontsReady, wrapAngle, clampAngleBand, damp, smoothDampVec3, makeHeadTracker,
} from '../ui/panel3d.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// --- placement (head-centred; + azimuth = to the left of your heading) ---
const REST = 30 * DEG;
const MIN_IDLE = 15 * DEG;
const MIN_TALK = 8 * DEG;
const MAX_REL = 62 * DEG;
const CATCH_UP = 12 * DEG;
const RADIUS = 1.1;
const Y_OFF = -0.1;
const MIN_DIST = 0.8, MAX_DIST = 1.8;
const BLINK_DIST = 2.0;
const THINK_TIMEOUT = 65;

// --- wisp look ---
const N_MOTES = 28;
const CORE_SIZE = 0.085;
const HALO_SIZE = 0.34;
const MOTE_SIZE = 0.021;
const MOOD_COLORS = {
  calm: 0x6fe7ff, neutral: 0x6fe7ff, twilight: 0x6fe7ff, curious: 0x7ff0ff, playful: 0xf2b0ff,
  happy: 0xffd98a, joy: 0xffd98a, warm: 0xffd98a, excited: 0xb8f7ff, proud: 0xffe3a3,
  sad: 0x7fa8ff, gentle: 0x9fd8ff, sleepy: 0x9f8cff, mysterious: 0xb49cff,
  aurora: 0x7dffc4, starfall: 0xffe3a3, deepsea: 0x4fb8ff, dawn: 0xffc2a0,
};
const THINK_HEX = 0xa393ff;
const MOTE_PALETTE = [0x7ff3ff, 0xb9a8ff, 0xffe6a8, 0x9dfcd8, 0x7ff3ff, 0xc9b6ff];

// --- speech bubble (canvas px; the used part is cropped with UVs, so the canvas never resizes) ---
// 768 px ↔ 0.56 m. At 1.1 m that's ~28° ≈ 715 Quest 3 pixels: close to 1:1, so the text stays crisp.
// 34 px text ≈ 25 mm ≈ 1.3° tall.
const BW = 768, BH = 352;
const BUBBLE_W = 0.56;
const MPP = BUBBLE_W / BW;
const BM = 14, PADX = 26, PADY = 20, FS = 34, BLH = 45, TAIL_H = 22, BOX_R = 24;
const MAX_LINES = 5, MAX_PAGES = 4, MIN_BOX_W = 132, QUEUE_MAX = 3;
const TEXT_MAX_W = BW - 2 * BM - 2 * PADX;
const BUBBLE_FONT = `500 ${FS}px ${FONT_STACK}`;

function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function makeGlowTexture(THREE) {
  const S = 128;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // a soft, roughly exponential falloff: bright centre, long gentle skirt, zero at the edge
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.1, 'rgba(255,255,255,0.72)');
  grd.addColorStop(0.24, 'rgba(255,255,255,0.36)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.13)');
  grd.addColorStop(0.68, 'rgba(255,255,255,0.035)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGuide({ scene, THREE, camera } = {}) {
  if (!THREE || !camera) throw new Error('createGuide({ scene, THREE, camera }): THREE and camera are required');

  // ---------------------------------------------------------------- the wisp
  const root = new THREE.Group();
  root.name = 'guide';
  const body = new THREE.Group();
  body.name = 'guide-wisp';
  root.add(body);

  const glowTex = makeGlowTexture(THREE);

  // all light, no solid surface: a tight overbright core glow inside a wide soft halo
  const lightSprite = (color) => new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, fog: false,
  });
  const coreMat = lightSprite(0xffffff);
  const core = new THREE.Sprite(coreMat);
  core.name = 'guide-core';
  core.scale.setScalar(CORE_SIZE);
  core.renderOrder = 21;
  body.add(core);

  const haloMat = lightSprite(MOOD_COLORS.calm);
  const halo = new THREE.Sprite(haloMat);
  halo.name = 'guide-halo';
  halo.scale.setScalar(HALO_SIZE);
  halo.renderOrder = 21;
  body.add(halo);

  // motes: one Points, orbiting on tilted circles; while thinking they gather into two rings (an astrolabe)
  const rand = mulberry32(0x5eed);
  const mR = new Float32Array(N_MOTES), mTheta = new Float32Array(N_MOTES), mOmega = new Float32Array(N_MOTES);
  const mU = new Float32Array(N_MOTES * 3), mV = new Float32Array(N_MOTES * 3), mBase = new Float32Array(N_MOTES * 3);
  const mTwF = new Float32Array(N_MOTES), mTwP = new Float32Array(N_MOTES), mLag = new Float32Array(N_MOTES);
  const mDelay = new Float32Array(N_MOTES), mWob = new Float32Array(N_MOTES);
  const _c = new THREE.Color();
  const _n = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
  for (let i = 0; i < N_MOTES; i++) {
    mR[i] = 0.055 + rand() * 0.075;
    mTheta[i] = rand() * TAU;
    mOmega[i] = (0.35 + rand() * 0.55) * (rand() < 0.3 ? -1 : 1);
    _n.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (_n.lengthSq() < 1e-4) _n.set(0, 1, 0);
    _n.normalize();
    _u.set(0, 1, 0).cross(_n);
    if (_u.lengthSq() < 1e-4) _u.set(1, 0, 0).cross(_n);
    _u.normalize();
    _v.copy(_n).cross(_u).normalize();
    mU[i * 3] = _u.x; mU[i * 3 + 1] = _u.y; mU[i * 3 + 2] = _u.z;
    mV[i * 3] = _v.x; mV[i * 3 + 1] = _v.y; mV[i * 3 + 2] = _v.z;
    _c.setHex(MOTE_PALETTE[i % MOTE_PALETTE.length]);
    mBase[i * 3] = _c.r; mBase[i * 3 + 1] = _c.g; mBase[i * 3 + 2] = _c.b;
    mTwF[i] = 0.35 + rand() * 0.9;
    mTwP[i] = rand() * TAU;
    mLag[i] = 0.05 + rand() * 0.2;
    mDelay[i] = rand();
    mWob[i] = rand() * TAU;
  }
  const motePos = new Float32Array(N_MOTES * 3);
  const moteCol = new Float32Array(N_MOTES * 3);
  const moteGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(motePos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(moteCol, 3).setUsage(THREE.DynamicDrawUsage);
  moteGeo.setAttribute('position', posAttr);
  moteGeo.setAttribute('color', colAttr);
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.45);
  const moteMat = new THREE.PointsMaterial({
    size: MOTE_SIZE, map: glowTex, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false, fog: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.name = 'guide-motes';
  motes.renderOrder = 22;
  body.add(motes);

  // ---------------------------------------------------------------- the speech bubble
  const bCanvas = makeCanvas(BW, BH);
  const bctx = bCanvas.getContext('2d');
  const bTex = makeCanvasTexture(THREE, bCanvas);
  const bMat = makeUiMaterial(THREE, bTex);
  setUiOpacity(bMat, 0);
  const bGeo = new THREE.PlaneGeometry(1, 1);
  const bMesh = new THREE.Mesh(bGeo, bMat);
  bMesh.name = 'guide-bubble-surface';
  bMesh.renderOrder = 20;                        // before the wisp's additive light, after the world's glass
  const bubble = new THREE.Group();
  bubble.name = 'guide-bubble';
  bubble.position.set(0, 0.075, 0);              // tail tip sits just above the wisp; the box extends toward view centre
  bubble.visible = false;
  bubble.add(bMesh);
  root.add(bubble);

  // Not pickable: teleport/grab rays pass straight through the guide. (Sprite.raycast would also throw on an XR
  // controller ray, which has no raycaster.camera, and Points' default 1 m threshold would swallow nearby rays.)
  const noRaycast = () => {};
  core.raycast = noRaycast; halo.raycast = noRaycast; motes.raycast = noRaycast; bMesh.raycast = noRaycast;

  if (scene) scene.add(root);

  // ---------------------------------------------------------------- state
  const head = makeHeadTracker(THREE);
  const P = new THREE.Vector3(), T = new THREE.Vector3(), vel = new Float64Array(3);
  const prev = new THREE.Vector3();
  const trail = new THREE.Vector3();
  const moodColor = new THREE.Color(MOOD_COLORS.calm);
  const haloColor = new THREE.Color(MOOD_COLORS.calm);
  const thinkColor = new THREE.Color(THINK_HEX);
  const white = new THREE.Color(0xffffff);
  const tmpColor = new THREE.Color();

  let clock = 0;
  let placed = false, yawA = 0;
  let presence = 0, blink = 0, blinkIn = 1.2;     // blink: -1 dissolving, +1 re-forming, 0 steady
  let thinking = false, thinkingSince = 0, thinkLvl = 0;
  let listening = false, listenLvl = 0;
  let talkUntil = 0, talkLvl = 0, speakLvl = 0, lastSayAt = -1e9;
  let ringAng = 0;

  // bubble state machine: hidden → in → hold → (swap → in …) → out → hidden
  let phase = 'hidden', alpha = 0, hold = 0, outRate = 1;
  let pages = null, pageIdx = 0, currentText = '';
  const queue = [];

  // ---------------------------------------------------------------- bubble drawing
  function paginate(text) {
    bctx.font = BUBBLE_FONT;
    const lines = wrapText(bctx, text, TEXT_MAX_W);
    if (!lines.length) return null;
    const count = Math.min(MAX_PAGES, Math.ceil(lines.length / MAX_LINES));
    const per = Math.ceil(Math.min(lines.length, MAX_PAGES * MAX_LINES) / count);   // balanced: 6 lines → 3 + 3
    const out = [];
    for (let i = 0; i < count; i++) out.push(lines.slice(i * per, (i + 1) * per));
    if (lines.length > count * per) {
      const last = out[out.length - 1];
      last[last.length - 1] = ellipsize(bctx, last[last.length - 1], TEXT_MAX_W);
    }
    return out.filter((p) => p.length);
  }

  function bubblePath(x, y, w, h, r, tipX, tipY) {
    const tx0 = tipX + 10, tx1 = tipX + 48;       // tail base on the bottom edge, just right of the tip
    const c = bctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(tx1, y + h);
    c.quadraticCurveTo(tx0 + 8, y + h + 3, tipX, tipY);        // a soft curved tail, pointing down-left at the wisp
    c.quadraticCurveTo(tx0 - 2, y + h + 10, tx0, y + h);
    c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
    c.closePath();
  }

  function drawPage() {
    const lines = pages[pageIdx];
    const multi = pages.length > 1;
    const c = bctx;
    c.clearRect(0, 0, BW, BH);
    c.save();
    c.font = BUBBLE_FONT;
    let maxW = 0;
    for (let i = 0; i < lines.length; i++) maxW = Math.max(maxW, c.measureText(lines[i]).width);
    const boxW = Math.min(BW - 2 * BM, Math.max(MIN_BOX_W, Math.ceil(maxW) + 2 * PADX));
    const boxH = 2 * PADY + lines.length * BLH + (multi ? 10 : 0);
    // tail ~28% along the box: the bubble sits over the wisp, leaning toward the centre of your view
    const x = BM, y = BM, tipX = x + Math.round(clamp(boxW * 0.28, 40, boxW - BOX_R - 60)), tipY = y + boxH + TAIL_H;

    bubblePath(x, y, boxW, boxH, BOX_R, tipX, tipY);
    const bg = c.createLinearGradient(0, y, 0, tipY);
    bg.addColorStop(0, 'rgba(12, 30, 50, 0.86)');
    bg.addColorStop(1, 'rgba(26, 19, 58, 0.86)');
    c.fillStyle = bg;
    c.fill();
    const rim = c.createLinearGradient(x, 0, x + boxW, 0);
    rim.addColorStop(0, 'rgba(127, 243, 255, 0.75)');
    rim.addColorStop(1, 'rgba(163, 147, 255, 0.65)');
    c.strokeStyle = rim;
    c.lineWidth = 2.5;
    c.shadowColor = 'rgba(111, 231, 255, 0.45)';
    c.shadowBlur = 12;
    c.stroke();
    c.shadowBlur = 0;
    c.stroke();

    c.textBaseline = 'middle';
    c.fillStyle = '#ecf8ff';
    c.shadowColor = 'rgba(120, 230, 255, 0.28)';
    c.shadowBlur = 6;
    for (let i = 0; i < lines.length; i++) c.fillText(lines[i], x + PADX, y + PADY + (i + 0.5) * BLH + 1);
    c.shadowBlur = 0;

    if (multi) {                                  // page dots, bottom right
      for (let i = 0; i < pages.length; i++) {
        const cx = x + boxW - PADX - (pages.length - 1 - i) * 14;
        c.globalAlpha = i === pageIdx ? 0.95 : 0.3;
        c.fillStyle = i === pageIdx ? '#7ff3ff' : '#b9a8ff';
        c.beginPath(); c.arc(cx, y + boxH - 11, 3.5, 0, TAU); c.fill();
      }
      c.globalAlpha = 1;
    }
    c.restore();

    // crop to the used area and anchor the tail tip at the bubble group's origin
    const UW = Math.min(BW, x + boxW + BM), UH = Math.min(BH, tipY + 8);
    bTex.repeat.set(UW / BW, UH / BH);
    bTex.offset.set(0, 1 - UH / BH);
    bTex.needsUpdate = true;
    bMesh.scale.set(UW * MPP, UH * MPP, 1);
    bMesh.position.set((UW / 2 - tipX) * MPP, (tipY - UH / 2) * MPP, 0);
  }

  function readTime(lines) {
    let n = 0;
    for (let i = 0; i < lines.length; i++) n += lines[i].length + 1;
    return clamp(1.3 + n / 13, 2.4, 14);
  }

  function beginText(text) {
    const p = paginate(text);
    if (!p || !p.length) { phase = 'hidden'; return; }
    currentText = text; pages = p; pageIdx = 0;
    drawPage();
    phase = 'in';
  }

  function nextContent() {
    if (pages && pageIdx + 1 < pages.length) { pageIdx++; drawPage(); phase = 'in'; return; }
    if (queue.length) { beginText(queue.shift()); if (phase !== 'hidden') return; }
    phase = 'hidden'; pages = null; currentText = '';
  }

  function hideBubble(seconds) {
    queue.length = 0;
    pages = null;
    if (phase !== 'hidden') { phase = 'out'; outRate = 1 / seconds; }
  }

  whenFontsReady([BUBBLE_FONT], () => {           // Inter arrived: re-wrap with the real metrics
    if (!pages || !currentText) return;
    const p = paginate(currentText);
    if (!p) return;
    pages = p; pageIdx = Math.min(pageIdx, pages.length - 1);
    drawPage();
  });

  function stepBubble(dt) {
    switch (phase) {
      case 'in':
        alpha += dt / 0.28;
        if (alpha >= 1) { alpha = 1; phase = 'hold'; hold = readTime(pages[pageIdx]); }
        break;
      case 'hold':
        hold -= dt * (queue.length ? 2 : 1);      // someone's waiting: give this one half its remaining time
        if (hold <= 0) {
          if ((pages && pageIdx + 1 < pages.length) || queue.length) phase = 'swap';
          else { phase = 'out'; outRate = 1 / 0.9; }
        }
        break;
      case 'swap':
        alpha -= dt / 0.16;
        if (alpha <= 0) { alpha = 0; nextContent(); }
        break;
      case 'out':
        if (queue.length) outRate = Math.max(outRate, 1 / 0.16);
        alpha -= dt * outRate;
        if (alpha <= 0) { alpha = 0; nextContent(); }
        break;
      default:
        alpha = 0;
    }
  }

  // ---------------------------------------------------------------- public API
  function say(text) {
    const clean = cleanText(text, 600);
    if (!clean) return;
    thinking = false;                              // a reply means the thinking is over, whatever order SSE used
    lastSayAt = clock;
    talkUntil = Math.max(talkUntil, clock) + Math.min(20, 0.6 + clean.length / 14);
    if (phase === 'hidden') beginText(clean);
    else { queue.push(clean); if (queue.length > QUEUE_MAX) queue.shift(); }
  }

  function setThinking(on) {
    on = !!on;
    if (on && !thinking) {
      thinkingSince = clock;
      // A new turn: the previous answer steps aside. But a line said in the last 2.5 s is from this same turn
      // (e.g. the brain spoke via MCP `say`, then kept working and sent another status) so leave it up.
      if (clock - lastSayAt > 2.5) { talkUntil = clock; hideBubble(0.35); }
    }
    thinking = on;
  }

  function setListening(on) { listening = !!on; }

  function setMood(mood) {
    let key = mood && typeof mood === 'object' ? (mood.preset ?? mood.mood) : mood;
    key = String(key ?? '').toLowerCase().trim();
    let hex = MOOD_COLORS[key];
    if (hex == null && key) {
      for (const k in MOOD_COLORS) if (key.includes(k)) { hex = MOOD_COLORS[k]; break; }
    }
    moodColor.setHex(hex ?? MOOD_COLORS.calm);
  }

  // ---------------------------------------------------------------- per frame
  function update(dt = 0, t) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    clock += dt;
    if (!Number.isFinite(t)) t = clock;

    head.read(camera);
    const hp = head.pos;

    // levels
    if (thinking && clock - thinkingSince > THINK_TIMEOUT) thinking = false;
    thinkLvl += ((thinking ? 1 : 0) - thinkLvl) * damp(dt, thinking ? 0.35 : 0.6);
    listenLvl += ((listening ? 1 : 0) - listenLvl) * damp(dt, 0.3);
    talkLvl += ((clock < talkUntil ? 1 : 0) - talkLvl) * damp(dt, 0.25);
    speakLvl += ((phase !== 'hidden' || clock < talkUntil ? 1 : 0) - speakLvl) * damp(dt, 0.6);
    const minRel = MIN_IDLE + (MIN_TALK - MIN_IDLE) * speakLvl;

    // anchor yaw: lazy, asymmetric follow, then a hard keep-out band. While talking, the drift back from the near
    // side slows to ~8 s so turning your head to read the bubble doesn't send the wisp off.
    if (!placed) yawA = head.yaw + REST;
    let rel = wrapAngle(yawA - head.yaw);
    const rate = rel > REST + CATCH_UP ? 1 / 0.9 : rel < REST ? (1 - 0.6 * speakLvl) / 3.2 : 1 / 3.2;
    yawA += wrapAngle(head.yaw + REST - yawA) * (1 - Math.exp(-dt * rate));
    rel = wrapAngle(yawA - head.yaw);
    const relC = clampAngleBand(rel, minRel, MAX_REL);
    if (relC !== rel) yawA = head.yaw + relC;

    const rr = RADIUS - 0.08 * listenLvl;
    T.set(hp.x - Math.sin(yawA) * rr, hp.y + Y_OFF + 0.02 * listenLvl, hp.z - Math.cos(yawA) * rr);

    // appear / teleport: dissolve, jump, re-form
    let snapped = false;
    if (!placed) {
      placed = true; P.copy(T); vel.fill(0); presence = 0; blink = 1; blinkIn = 1.2; snapped = true;
    } else if (blink === 0 && P.distanceToSquared(T) > BLINK_DIST * BLINK_DIST) {
      blink = -1;
    }
    if (blink < 0) {
      presence -= dt / 0.2;
      if (presence <= 0) { presence = 0; P.copy(T); vel.fill(0); blink = 1; blinkIn = 0.55; snapped = true; }
    } else if (blink > 0) {
      presence += dt / blinkIn;
      if (presence >= 1) { presence = 1; blink = 0; }
    }
    if (blink >= 0) {                              // while dissolving it stays put (no streak across the world)
      if (!snapped) smoothDampVec3(P, T, vel, 0.32, dt);

      // keep-out on the actual position (walking or strafing can drag the spring toward your view centre)
      const dx = P.x - hp.x, dz = P.z - hp.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const relP = d > 1e-5 ? wrapAngle(Math.atan2(-dx, -dz) - head.yaw) : REST;
      const relPC = clampAngleBand(relP, minRel, MAX_REL);
      const dC = clamp(d, MIN_DIST, MAX_DIST);
      if (relPC !== relP || dC !== d) {
        const a = head.yaw + relPC;
        P.x = hp.x - Math.sin(a) * dC;
        P.z = hp.z - Math.cos(a) * dC;
      }
      P.y = clamp(P.y, hp.y - 0.6, hp.y + 0.45);
    }

    // gentle float
    root.position.set(
      P.x + 0.012 * Math.sin(t * 0.7),
      P.y + 0.022 * Math.sin(t * TAU * 0.31) + 0.007 * Math.sin(t * TAU * 0.83 + 1),
      P.z + 0.01 * Math.cos(t * 0.53),
    );
    if (snapped || !(dt > 0)) prev.copy(root.position);
    if (dt > 0) {
      const k = damp(dt, 0.12);
      trail.x += ((root.position.x - prev.x) / dt - trail.x) * k;
      trail.y += ((root.position.y - prev.y) / dt - trail.y) * k;
      trail.z += ((root.position.z - prev.z) / dt - trail.z) * k;
      prev.copy(root.position);
    }

    // ---- look
    const pe = smooth01(presence);
    body.scale.setScalar(Math.max(1e-3, pe));
    const pulse = 0.5 + 0.5 * Math.sin(t * TAU * 0.9);                            // 0.9 Hz: breathing, not flashing
    const flick = 0.5 + 0.5 * Math.sin(t * TAU * 2.4 + 1.8 * Math.sin(t * TAU * 0.55));
    core.scale.setScalar(CORE_SIZE * (1 + 0.05 * Math.sin(t * TAU * 0.25) + 0.14 * thinkLvl * pulse + 0.1 * talkLvl * flick));

    tmpColor.copy(moodColor).lerp(thinkColor, 0.85 * thinkLvl);
    haloColor.lerp(tmpColor, damp(dt, 0.6));
    const glow = (0.9 + 0.08 * Math.sin(t * TAU * 0.21)) * (1 + 0.18 * listenLvl + 0.12 * talkLvl * flick);
    haloMat.color.copy(haloColor).multiplyScalar(glow);
    haloMat.opacity = pe;
    halo.scale.setScalar(HALO_SIZE * (1 + 0.06 * Math.sin(t * TAU * 0.2) + 0.12 * listenLvl + 0.1 * thinkLvl * pulse));
    coreMat.color.copy(white).lerp(haloColor, 0.3).multiplyScalar(1.3);             // overbright: centre saturates to white
    coreMat.opacity = pe;

    // motes
    ringAng += dt * 2.1;
    const spin = 1 + 1.6 * thinkLvl - 0.35 * listenLvl;
    const spread = 1 + (1 - pe) * 1.2;                                              // swirl in as it forms
    const gam = t * 0.35;
    const cg = Math.cos(gam), sg = Math.sin(gam);
    const speed = Math.sqrt(trail.x * trail.x + trail.y * trail.y + trail.z * trail.z);
    if (ringAng > TAU) ringAng -= TAU;
    for (let i = 0; i < N_MOTES; i++) {
      let th = mTheta[i] + mOmega[i] * spin * dt;
      if (th > TAU) th -= TAU; else if (th < 0) th += TAU;                       // keep Float32 angles precise
      mTheta[i] = th;
      const r = mR[i] * spread;
      const ct = Math.cos(th) * r, st = Math.sin(th) * r, i3 = i * 3;
      let x = mU[i3] * ct + mV[i3] * st;
      let y = mU[i3 + 1] * ct + mV[i3 + 1] * st + 0.008 * Math.sin(t * 1.3 + mWob[i]);
      let z = mU[i3 + 2] * ct + mV[i3 + 2] * st;

      // thinking: two tilted, counter-rotating rings
      const w = smooth01(thinkLvl * 1.5 - mDelay[i] * 0.5);
      if (w > 0) {
        const ring = i & 1, slot = i >> 1, count = N_MOTES >> 1;
        const a = (ring ? -ringAng : ringAng) + TAU * slot / count;
        const R = ring ? 0.072 : 0.09;
        const beta = ring ? -1.15 : 1.15;
        const rx = Math.cos(a) * R, rz0 = Math.sin(a) * R;
        const ry = rz0 * Math.sin(beta), rz = rz0 * Math.cos(beta);
        const gx = ring ? -sg : cg, gz = ring ? cg : sg;                              // ring 2 is turned 90°
        const qx = rx * gx + rz * gz, qz = -rx * gz + rz * gx;
        x += (qx - x) * w; y += (ry - y) * w; z += (qz - z) * w;
      }

      // trail behind motion a little, like a comet
      if (speed > 1e-4) {
        const lag = Math.min(mLag[i], 0.09 / speed);
        x -= trail.x * lag; y -= trail.y * lag; z -= trail.z * lag;
      }
      motePos[i3] = x; motePos[i3 + 1] = y; motePos[i3 + 2] = z;

      const tw = 0.62 + 0.38 * Math.sin(mTwP[i] + t * mTwF[i] * TAU);             // slow twinkle, never fully out
      const b = (tw + (0.95 - tw) * w) * (1 + 0.2 * listenLvl);
      moteCol[i3] = mBase[i3] * b; moteCol[i3 + 1] = mBase[i3 + 1] * b; moteCol[i3 + 2] = mBase[i3 + 2] * b;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    moteMat.opacity = pe;

    // bubble
    stepBubble(dt);
    const ba = alpha * pe;
    setUiOpacity(bMat, ba);
    bubble.visible = ba > 0.002;
    if (bubble.visible) {
      bubble.scale.setScalar(0.94 + 0.06 * alpha);
      bubble.lookAt(hp);
    }
  }

  function dispose() {
    root.removeFromParent();
    coreMat.dispose();
    haloMat.dispose();
    moteGeo.dispose(); moteMat.dispose();
    glowTex.dispose();
    bGeo.dispose(); bMat.dispose(); bTex.dispose();
    queue.length = 0;
  }

  return {
    object3d: root, say, setThinking, setListening, setMood, update, dispose,
    get thinking() { return thinking; },
  };
}
