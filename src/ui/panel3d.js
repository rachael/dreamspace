// src/ui/panel3d.js — Dreamspace in-XR chat log (a small floating glass panel, low-left of the viewer),
// plus the canvas-text helpers that src/world/guide.js shares.
//
//   import { createChatPanel } from './ui/panel3d.js';
//   const chat = createChatPanel({ THREE, camera, scene, renderer });   // scene/renderer optional, see below
//   net: onChat: (evt) => chat.add(evt)          // the SSE `chat` payload {id, role, from, text} works as-is
//        onStatus: (s) => chat.setThinking(s.thinking)
//   loop: chat.update(dt, t)                      // EVERY frame: it places, fades and redraws the panel
//
// API: createChatPanel({ THREE, camera, scene?, renderer?, guideName?, xrOnly? }) → {
//   object3d            THREE.Group. Added to `scene` if you pass one; otherwise scene.add(chat.object3d) yourself.
//                       Not raycastable, so teleport/grab rays pass through it.
//   add(evt) | add(role, text, from?)   role 'user' | 'guide' (| 'system'). Same id+role+text twice is ignored.
//   setStatus(text|null) a small pill in the header ('thinking', 'listening', …); null clears it
//   setThinking(bool)   shorthand for setStatus('thinking') / clearing it
//   clear()             drop all lines
//   setVisible(bool)    manual show/hide (default shown)
//   update(dt, t)       call every frame
//   dispose()
// }
// Visibility: with `renderer` given (and xrOnly !== false) the panel only shows while an XR session is presenting,
// since the desktop overlay already has its own chat. Without `renderer` it shows whenever it has content.
//
// Comfort + readability (Quest 3 ≈ 25 px/degree): the panel is 0.72 m wide at ~1.26 m, 24° below the horizon and
// 12° left. It lazily follows your body yaw (it holds still while you glance around or read), faces you, and dims
// to 45% when idle; looking at it brings it back to full. The canvas is sized ~1:1 with headset pixels at that
// distance so text stays crisp; body text is 30 px ≈ 28 mm tall ≈ 1.3°.

const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------
// Shared helpers (also used by src/world/guide.js). Pure canvas/three utilities: no DOM besides a canvas.
// ------------------------------------------------------------------------------------------------

export const FONT_STACK = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** A 2D canvas: a DOM canvas in the page, an OffscreenCanvas elsewhere. */
export function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('panel3d: no canvas available');
}

/** Canvas texture tuned for UI text: sRGB, premultiplied (clean edges and mips), trilinear. */
export function makeCanvasTexture(THREE, canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.premultiplyAlpha = true;             // canvas pixels are premultiplied; keeps glow edges free of dark fringes
  tex.generateMipmaps = true;              // near 1:1 in the headset (level 0), smooth when minified on desktop
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;                      // three clamps this to what the GPU supports
  return tex;
}

/** Unlit UI material for a premultiplied canvas texture. Fade it with setUiOpacity(), not .opacity alone. */
export function makeUiMaterial(THREE, map) {
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Premultiplied fade: scale colour and alpha together. */
export function setUiOpacity(mat, a) {
  mat.opacity = a;
  mat.color.setScalar(a);
}

/** Make text safe and speakable-looking: no control chars, no markdown symbols, collapsed spaces, capped length. */
export function cleanText(input, max = 600) {
  let t = String(input ?? '');
  t = t.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/\*\*|__|`+/g, '')
    .replace(/^[ \t]*(?:#{1,6}|[-*•]|\d{1,2}[.)])[ \t]+/gm, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
  }
  return t;
}

/** Greedy word wrap with measureText. Honours '\n'. Breaks words that are wider than a whole line. */
export function wrapText(ctx, text, maxWidth) {
  const out = [];
  const paras = String(text).split('\n');
  for (let p = 0; p < paras.length; p++) {
    const words = paras[p].split(' ');
    let line = '';
    for (let i = 0; i < words.length; i++) {
      let w = words[i];
      if (!w) continue;
      while (ctx.measureText(w).width > maxWidth && w.length > 1) {
        if (line) { out.push(line); line = ''; }
        // longest prefix that fits (binary search)
        let lo = 1, hi = w.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (ctx.measureText(w.slice(0, mid)).width <= maxWidth) lo = mid; else hi = mid - 1;
        }
        out.push(w.slice(0, lo));
        w = w.slice(lo);
      }
      const test = line ? line + ' ' + w : w;
      if (!line || ctx.measureText(test).width <= maxWidth) line = test;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Trim a line (by words, then characters) until line + '…' fits. */
export function ellipsize(ctx, line, maxWidth) {
  const E = '…';
  let s = String(line).replace(/[\s,;:.-]+$/, '');
  if (ctx.measureText(s + E).width <= maxWidth) return s + E;
  while (s.length > 0) {
    const sp = s.lastIndexOf(' ');
    const next = sp > 0 ? s.slice(0, sp) : s.slice(0, -1);
    s = next.replace(/[\s,;:.-]+$/, '');
    if (ctx.measureText(s + E).width <= maxWidth) return s + E;
  }
  return E;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Redraw once the page's web fonts (Inter, loaded by theme/pico.css) are ready. Harmless offline. */
export function whenFontsReady(fonts, cb) {
  try {
    const fs = typeof document !== 'undefined' ? document.fonts : null;
    if (!fs || !fs.load) return;
    Promise.all(fonts.map((f) => fs.load(f))).then(() => cb(), () => {});
  } catch { /* no font loading API: system fonts are fine */ }
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Clamp an angle into [lo, hi]; when outside, snap to whichever bound is nearer around the circle. */
export function clampAngleBand(a, lo, hi) {
  if (a >= lo && a <= hi) return a;
  return Math.abs(wrapAngle(a - lo)) <= Math.abs(wrapAngle(a - hi)) ? lo : hi;
}

/** Frame-rate independent exponential approach factor for a time constant `tau` (seconds). */
export function damp(dt, tau) {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

/** Critically damped spring (Unity SmoothDamp) on a Vector3; `vel` is a Float64Array(3). Allocation-free. */
export function smoothDampVec3(cur, target, vel, smoothTime, dt) {
  if (!(dt > 0)) return cur;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let c = cur.x - target.x, tmp = (vel[0] + omega * c) * dt;
  vel[0] = (vel[0] - omega * tmp) * e; cur.x = target.x + (c + tmp) * e;
  c = cur.y - target.y; tmp = (vel[1] + omega * c) * dt;
  vel[1] = (vel[1] - omega * tmp) * e; cur.y = target.y + (c + tmp) * e;
  c = cur.z - target.z; tmp = (vel[2] + omega * c) * dt;
  vel[2] = (vel[2] - omega * tmp) * e; cur.z = target.z + (c + tmp) * e;
  return cur;
}

/**
 * Reads the viewer's head pose from `camera.matrixWorld` (in XR, three copies the headset pose into the user camera
 * during render, so this is last frame's pose: fine for lazy-follow UI). Never writes the camera's position/rotation.
 * yaw: heading on the floor plane, 0 = looking down -Z, positive = turned left. Stable when looking straight up/down.
 */
export function makeHeadTracker(THREE) {
  const pos = new THREE.Vector3(0, 1.6, 0);
  const fwd = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 1, 0);
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
  const head = { pos, fwd, yaw: 0, valid: false };
  head.read = (camera) => {
    camera.updateWorldMatrix(true, false);
    camera.matrixWorld.decompose(_p, _q, _s);
    if (!Number.isFinite(_p.x + _p.y + _p.z + _q.x + _q.y + _q.z + _q.w)) return head; // keep last good pose
    pos.copy(_p);
    fwd.set(0, 0, -1).applyQuaternion(_q);
    up.set(0, 1, 0).applyQuaternion(_q);
    // Horizontal heading: forward, blended with the up vector so it stays defined when looking up or down.
    const hx = fwd.x - up.x * fwd.y, hz = fwd.z - up.z * fwd.y;
    if (hx * hx + hz * hz > 1e-8) head.yaw = Math.atan2(-hx, -hz);
    head.valid = true;
    return head;
  };
  return head;
}

// ------------------------------------------------------------------------------------------------
// The chat panel
// ------------------------------------------------------------------------------------------------

const CW = 768, CH = 256;                  // canvas px (fixed: WebGL2 texture storage is immutable)
const PANEL_W = 0.72;                      // metres
const M = 10;                              // outer margin for the border glow
const BOX_R = 26;
const HEAD_Y = M + 34;                     // header text centre line
const DIVIDER_Y = M + 56;
const LINES_TOP = M + 64;
const LH = 40;                             // line height
const BODY_PX = 30;
const MARK_X = M + 30;                     // role marker centre
const TEXT_X = M + 52;
const TEXT_W = CW - M - 28 - TEXT_X;       // 678 px ≈ 42 characters
const BODY_FONT = `500 ${BODY_PX}px ${FONT_STACK}`;
const HEAD_FONT = `600 19px ${FONT_STACK}`;
const PILL_FONT = `600 18px ${FONT_STACK}`;
const KEEP = 24;                           // messages kept in memory

const COLORS = {
  guide: '#e7f9ff', user: '#dcd3ff', system: '#9fb4c9',
  guideMark: '#7ff3ff', userMark: '#b9a8ff', systemMark: '#6f86a0',
};

export function createChatPanel(opts = {}) {
  const { THREE, camera } = opts;
  if (!THREE || !camera) throw new Error('createChatPanel({ THREE, camera }): both are required');
  const scene = opts.scene ?? null;
  const renderer = opts.renderer ?? null;
  const xrOnly = opts.xrOnly ?? true;
  const guideName = cleanText(opts.guideName ?? 'guide', 24) || 'guide';
  const maxLines = Math.max(1, Math.min(4, Math.round(opts.maxLines ?? 4)));
  const REST = (opts.azimuthDeg ?? 12) * DEG;              // + = left of your heading
  const DIST = opts.distance ?? 1.15;                        // horizontal metres
  const Y_OFF = Math.tan((opts.elevationDeg ?? -24) * DEG) * DIST;   // -24° → 0.51 m below the eyes
  const FOLLOW_START = 20 * DEG, FOLLOW_STOP = 4 * DEG;

  // --- canvas, texture, mesh ---
  const canvas = makeCanvas(CW, CH);
  const ctx = canvas.getContext('2d');
  const tex = makeCanvasTexture(THREE, canvas);
  const mat = makeUiMaterial(THREE, tex);
  setUiOpacity(mat, 0);
  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(PANEL_W, PANEL_W * CH / CW, 1);
  mesh.renderOrder = 20;
  mesh.name = 'chat-panel-surface';
  mesh.raycast = () => {};                 // not pickable: teleport/grab rays aimed at the floor pass through it
  const object3d = new THREE.Group();
  object3d.name = 'chat-panel';
  object3d.visible = false;
  object3d.add(mesh);
  if (scene) scene.add(object3d);

  // --- state ---
  const messages = [];
  let status = null, statusSince = 0;
  let userVisible = true;
  let dirty = true;
  let clock = 0, lastActivity = -1e9;
  let opacity = 0;
  let placed = false, following = false, yawA = 0;
  let warned = false;
  const head = makeHeadTracker(THREE);
  const P = new THREE.Vector3(), T = new THREE.Vector3(), vel = new Float64Array(3);
  const toPanel = new THREE.Vector3();

  whenFontsReady([BODY_FONT, HEAD_FONT], () => { dirty = true; });

  function add(a, b, c) {
    let role, text, from, id;
    if (a && typeof a === 'object') ({ role, text, from, id } = a);
    else { role = a; text = b; from = c; }
    role = role === 'user' ? 'user' : (role === 'system' || role === 'error') ? 'system' : 'guide';
    const clean = cleanText(text, 400);
    if (!clean) return;
    const key = id != null ? `${id}|${role}|${clean}` : null;
    if (key) for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) if (messages[i].key === key) return;
    messages.push({ key, role, from: from ?? null, text: clean });
    if (messages.length > KEEP) messages.splice(0, messages.length - KEEP);
    if (role === 'guide' && status === 'thinking') status = null;   // a reply ends thinking, whatever the SSE order
    lastActivity = clock;
    dirty = true;
  }

  function setStatus(s) {
    const next = s ? cleanText(s, 24).toLowerCase() : null;
    if (next === status) return;
    status = next || null;
    statusSince = clock;
    if (status) lastActivity = clock;
    dirty = true;
  }

  function setThinking(on) {
    if (on) setStatus('thinking');
    else if (status === 'thinking') setStatus(null);
  }

  function clear() { messages.length = 0; dirty = true; }
  function setVisible(v) { userVisible = !!v; }

  // Newest message is always shown (up to maxLines, ellipsised); older ones fill the lines above it.
  function layoutLines() {
    ctx.font = BODY_FONT;
    const out = [];
    let remaining = maxLines;
    for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
      const m = messages[i];
      let lines = wrapText(ctx, m.text, TEXT_W);
      if (!lines.length) continue;
      if (lines.length > remaining) {
        lines = lines.slice(0, remaining);
        lines[remaining - 1] = ellipsize(ctx, lines[remaining - 1], TEXT_W);
      }
      for (let j = lines.length - 1; j >= 0; j--) {
        out.push({ text: lines[j], role: m.role, first: j === 0, newest: i === messages.length - 1 });
      }
      remaining -= lines.length;
    }
    return out.reverse();
  }

  function drawMarker(role, x, y, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (role === 'guide') {                         // a small glowing diamond: the wisp
      ctx.shadowColor = 'rgba(127,243,255,0.8)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = COLORS.guideMark;
      ctx.beginPath();
      ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 7, y);
      ctx.closePath();
      ctx.fill();
    } else if (role === 'user') {                   // a soft ring: you
      ctx.strokeStyle = COLORS.userMark;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = COLORS.systemMark;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.save();
    // glass body
    roundRectPath(ctx, M, M, CW - 2 * M, CH - 2 * M, BOX_R);
    const bg = ctx.createLinearGradient(0, M, 0, CH - M);
    bg.addColorStop(0, 'rgba(10, 26, 42, 0.86)');
    bg.addColorStop(1, 'rgba(22, 17, 48, 0.86)');
    ctx.fillStyle = bg;
    ctx.fill();
    // rim: teal → violet, with a faint outer glow
    const rim = ctx.createLinearGradient(M, 0, CW - M, 0);
    rim.addColorStop(0, 'rgba(127, 243, 255, 0.55)');
    rim.addColorStop(1, 'rgba(163, 147, 255, 0.55)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(111, 231, 255, 0.35)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // header: guide name, status pill
    ctx.textBaseline = 'middle';
    ctx.font = HEAD_FONT;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillStyle = 'rgba(160, 236, 255, 0.75)';
    ctx.fillText(guideName.toUpperCase(), M + 24, HEAD_Y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    if (status) {
      ctx.font = PILL_FONT;
      const tw = ctx.measureText(status).width;
      const dots = status === 'thinking' ? 30 : 0;
      const pw = tw + 30 + dots, ph = 30;
      const px = CW - M - 20 - pw, py = HEAD_Y - ph / 2;
      const violet = status === 'thinking';
      roundRectPath(ctx, px, py, pw, ph, ph / 2);
      ctx.fillStyle = violet ? 'rgba(163, 147, 255, 0.20)' : 'rgba(127, 243, 255, 0.16)';
      ctx.fill();
      ctx.strokeStyle = violet ? 'rgba(163, 147, 255, 0.60)' : 'rgba(127, 243, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = violet ? '#d3c9ff' : '#bff6ff';
      ctx.fillText(status, px + 15, HEAD_Y + 1);
      if (dots) for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.45 + i * 0.25;
        ctx.beginPath(); ctx.arc(px + 15 + tw + 8 + i * 9, HEAD_Y + 1, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // divider
    const dv = ctx.createLinearGradient(M + 20, 0, CW - M - 20, 0);
    dv.addColorStop(0, 'rgba(127, 243, 255, 0.28)');
    dv.addColorStop(1, 'rgba(163, 147, 255, 0.06)');
    ctx.fillStyle = dv;
    ctx.fillRect(M + 20, DIVIDER_Y, CW - 2 * M - 40, 1.5);

    // lines
    const lines = layoutLines();
    ctx.font = BODY_FONT;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const y = LINES_TOP + (i + 0.5) * LH;
      const a = ln.newest ? 1 : 0.68;
      if (ln.first) drawMarker(ln.role, MARK_X, y, a);
      ctx.globalAlpha = a;
      ctx.fillStyle = COLORS[ln.role] ?? COLORS.guide;
      ctx.fillText(ln.text, TEXT_X, y + 1);
    }
    ctx.globalAlpha = 1;
    if (!lines.length) {
      ctx.fillStyle = 'rgba(180, 200, 220, 0.5)';
      ctx.fillText('Say hello to your guide', TEXT_X, LINES_TOP + LH * 0.5 + 1);
    }
    ctx.restore();
    tex.needsUpdate = true;
  }

  // Yaw error to correct this frame: zero inside the ±20° dead zone, then follow until within 4° (hysteresis).
  function followError() {
    const err = wrapAngle(REST - wrapAngle(yawA - head.yaw));
    if (!following && Math.abs(err) > FOLLOW_START) following = true;
    if (following && Math.abs(err) < FOLLOW_STOP) following = false;
    return following ? err : 0;
  }

  function update(dt = 0, t = 0) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    clock += dt;
    if (status === 'thinking' && clock - statusSince > 65) setStatus(null);   // never spin forever (brain timeout is 60 s)
    if (dirty) { draw(); dirty = false; }
    if (!object3d.parent && !warned) { warned = true; console.warn('[panel3d] add chat.object3d to your scene (or pass { scene })'); }

    head.read(camera);
    // lazy follow on yaw: holds still inside ±20°, then glides back to rest
    if (!placed) yawA = head.yaw + REST;
    yawA += followError() * damp(dt, 0.55);
    T.set(head.pos.x - Math.sin(yawA) * DIST, head.pos.y + Y_OFF, head.pos.z - Math.cos(yawA) * DIST);
    if (!placed || P.distanceToSquared(T) > 4) {   // first frame, entering XR, or a teleport: jump, don't fly
      P.copy(T); vel.fill(0); placed = true;
    } else {
      smoothDampVec3(P, T, vel, 0.3, dt);
    }
    object3d.position.copy(P);
    object3d.lookAt(head.pos);                         // upright, facing the eyes

    // fade: hidden without content; full when active or looked at; dim when idle
    const presenting = !!(renderer && renderer.xr && renderer.xr.isPresenting);
    const allowed = userVisible && (!renderer || !xrOnly || presenting) && (messages.length > 0 || !!status);
    let target = 0;
    if (allowed) {
      toPanel.copy(P).sub(head.pos);
      const len = toPanel.length();
      const gazed = len > 1e-6 && toPanel.dot(head.fwd) / len > Math.cos(20 * DEG);
      const active = !!status || clock - lastActivity < 14;
      target = active || gazed ? 1 : 0.45;
    }
    opacity += (target - opacity) * damp(dt, 0.3);
    if (Math.abs(target - opacity) < 0.002) opacity = target;
    setUiOpacity(mat, opacity);
    object3d.visible = opacity > 0.004;
  }

  function dispose() {
    object3d.removeFromParent();
    geo.dispose(); mat.dispose(); tex.dispose();
  }

  return { object3d, add, setStatus, setThinking, clear, setVisible, update, dispose };
}
