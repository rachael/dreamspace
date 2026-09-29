// Dreamspace world model: the single source of truth for what exists in the world.
// Pure and synchronous. No network, no asset generation: server/app.mjs resolves assets
// (via server/assets/index.mjs) before handing an `add` op to apply().
//
//   const world = createWorld({ file: '.data/world.json' });
//   world.apply({ type: 'add', name: 'crystal', description: 'a violet crystal', asset })
//     -> { ok: true, world, op, object }   or   { ok: false, world, error }
//   world.get()       deep copy of the World
//   world.describe()  short natural-language summary with [ids], for brains
//   world.on(fn)      fn(op, world) after every applied op; returns an unsubscribe function
//
// Limits (clamp, don't crash): 40 objects, x/z in [-15, 15], y in [0, 8], scale in [0.1, 4],
// name <= 60 chars, description <= 300 chars, <= 24 parts per `parts` asset.
// Spacing: an add without a position spawns on a clear spot of a front arc; an add whose position crowds an
// existing object (closer than 1.2 x the combined radii, or 2 m between two large things such as portals) is
// nudged outward along an arc. Moves (she grabbed it) and asset swaps keep their exact place.

import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LIMITS = Object.freeze({
  maxObjects: 40, x: [-15, 15], y: [0, 8], z: [-15, 15], scale: [0.1, 4],
  name: 60, description: 300, parts: 24, guideMood: 40,
});

export const MOOD_PRESETS = Object.freeze(['twilight', 'aurora', 'starfall', 'deepsea', 'dawn']);

export const ARCHETYPES = Object.freeze([
  'crystal', 'crystal-cluster', 'floating-island', 'portal', 'lantern', 'tree-glow', 'mushroom-glow', 'rune-stone',
  'orb', 'planet', 'moon', 'spaceship', 'obelisk', 'waterfall-light', 'butterfly-swarm', 'wisp',
]);

export const PART_SHAPES = Object.freeze(['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosahedron', 'capsule', 'octahedron']);
export const PART_MATERIALS = Object.freeze(['matte', 'glow', 'glass']);

export const DEFAULT_MOOD = Object.freeze({ preset: 'twilight', fog: 0.35, glow: 0.6 });
export const DEFAULT_GUIDE = Object.freeze({ position: [-0.7, 1.5, -1.3], mood: 'calm' });

// Things that hover when placed by the default spawn; everything else stands on the ground (y = 0).
const FLOATING = new Set(['orb', 'wisp', 'planet', 'moon', 'floating-island', 'butterfly-swarm', 'lantern', 'spaceship']);

// Forgiving names for mood presets (small local models and voice users say these).
const MOOD_ALIASES = {
  night: 'twilight', dusk: 'twilight', evening: 'twilight', calm: 'twilight', default: 'twilight',
  aurora: 'aurora', 'northern lights': 'aurora', 'northern-lights': 'aurora', borealis: 'aurora',
  stars: 'starfall', starry: 'starfall', 'star fall': 'starfall', 'shooting stars': 'starfall', snow: 'starfall', meteor: 'starfall',
  ocean: 'deepsea', sea: 'deepsea', underwater: 'deepsea', 'deep sea': 'deepsea', 'deep-sea': 'deepsea', abyss: 'deepsea',
  sunrise: 'dawn', morning: 'dawn', day: 'dawn', daytime: 'dawn', sunset: 'dawn',
};

// Semantic placement some brains/tools use instead of raw coordinates (see the local-llm research notes).
const WHERE_POSITIONS = {
  beside_user: [1.0, 1.0, -0.6], far: [0, 1, -8], above_user: [0, 3, -1.5], sky: [0, 6, -10],
};

// ------------------------------------------------------------------------------------------------ helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 3) => { const k = 10 ** d; return Math.round(v * k) / k; };

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** [x,y,z] or {x,y,z} of finite numbers (numeric strings allowed) -> [x,y,z], else null. */
function vec3(v) {
  let a = v;
  if (v && !Array.isArray(v) && typeof v === 'object') a = [v.x, v.y, v.z];
  if (!Array.isArray(a) || a.length !== 3) return null;
  const out = a.map(num);
  return out.every((n) => n !== null) ? out : null;
}

function clampPosition(p) {
  return [
    round(clamp(p[0], LIMITS.x[0], LIMITS.x[1])),
    round(clamp(p[1], LIMITS.y[0], LIMITS.y[1])),
    round(clamp(p[2], LIMITS.z[0], LIMITS.z[1])),
  ];
}

// C0/C1 control characters plus the two Unicode line/paragraph separators
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
/** Plain single-line text: no control characters, collapsed whitespace, cut to `max` code points. */
function text(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

function normAngle(a) {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return round(r, 4);
}

const HEX6 = /^#[0-9a-f]{6}$/i;
function color(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (HEX6.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  return null;
}

function moodPreset(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (MOOD_PRESETS.includes(s)) return s;
  return MOOD_ALIASES[s] || MOOD_ALIASES[s.replace(/[_-]+/g, ' ')] || null;
}

const clone = (v) => structuredClone(v);

// ------------------------------------------------------------------------------------------------ assets

function sanitizeParams(params) {
  const out = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  let budget = 40; // keep params small: they travel on every snapshot
  for (const [k, v] of Object.entries(params)) {
    if (budget-- <= 0) break;
    if (typeof k !== 'string' || k.length > 40 || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k === 'color') { const c = color(v); if (c) out.color = c; continue; }
    if (k === 'variant') { const n = num(v); if (n !== null) out.variant = clamp(Math.round(n), 0, 99); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = text(v, 200);
    else if (v && typeof v === 'object' && JSON.stringify(v).length <= 400) out[k] = clone(v);
  }
  return out;
}

function sanitizePart(p) {
  if (!p || typeof p !== 'object') return null;
  const shape = typeof p.shape === 'string' ? p.shape.trim().toLowerCase() : '';
  if (!PART_SHAPES.includes(shape)) return null;
  const size = vec3(p.size);
  if (!size) return null;
  const position = vec3(p.position) || [0, size[1] / 2, 0];
  const rotation = vec3(p.rotation) || [0, 0, 0];
  const material = PART_MATERIALS.includes(p.material) ? p.material : 'matte';
  const part = {
    shape,
    size: size.map((v) => round(clamp(Math.abs(v), 0.01, 4))),
    position: position.map((v) => round(clamp(v, -4, 4))),
    rotation: rotation.map((v) => normAngle(v)),
    color: color(p.color) || (material === 'glow' ? '#9fe8ff' : '#6d7fb3'),
    material,
  };
  const em = num(p.emissive);
  if (em !== null) part.emissive = round(clamp(em, 0, 1));
  if (typeof p.role === 'string' && p.role.trim()) part.role = text(p.role, 40);
  return part;
}

/** Validate an Asset. Anything unusable becomes the 'wisp' archetype, so an add never fails because of its asset. */
export function sanitizeAsset(asset) {
  const wisp = { type: 'archetype', archetype: 'wisp', params: {} };
  if (!asset || typeof asset !== 'object') return wisp;
  if (asset.type === 'archetype') {
    const name = typeof asset.archetype === 'string' ? asset.archetype.trim().toLowerCase() : '';
    if (!ARCHETYPES.includes(name)) return { ...wisp, params: sanitizeParams(asset.params) };
    return { type: 'archetype', archetype: name, params: sanitizeParams(asset.params) };
  }
  if (asset.type === 'parts') {
    const parts = (Array.isArray(asset.parts) ? asset.parts : []).map(sanitizePart).filter(Boolean).slice(0, LIMITS.parts);
    if (!parts.length) return wisp;
    return { type: 'parts', parts };
  }
  if (asset.type === 'glb') {
    const url = typeof asset.url === 'string' ? asset.url.trim() : '';
    const okUrl = url.length > 0 && url.length <= 2048 && !/[\s"'<>\\]/.test(url)
      && (/^https:\/\//i.test(url) || /^\/(assets|creations|media)\//.test(url) || /^(assets|creations|media)\//.test(url));
    if (!okUrl) return wisp;
    const out = { type: 'glb', url };
    if (asset.params && typeof asset.params === 'object') out.params = sanitizeParams(asset.params);
    return out;
  }
  return wisp;
}

function isFloating(asset) {
  return asset?.type === 'archetype' && FLOATING.has(asset.archetype);
}

// ------------------------------------------------------------------------------------------------ describe

const f1 = (v) => { const r = Math.round(v * 10) / 10; return Object.is(r, -0) ? '0' : String(r); };

function direction([x, , z]) {
  const d = Math.hypot(x, z);
  if (d < 0.4) return 'right at the centre';
  // bearing from the user's starting view (facing -z): 0 = ahead, +90 = right
  const deg = (Math.atan2(x, -z) * 180) / Math.PI;
  const a = Math.abs(deg);
  let dir;
  if (a <= 22.5) dir = 'ahead';
  else if (a <= 67.5) dir = deg > 0 ? 'ahead-right' : 'ahead-left';
  else if (a <= 112.5) dir = deg > 0 ? 'to the right' : 'to the left';
  else if (a <= 157.5) dir = deg > 0 ? 'behind-right' : 'behind-left';
  else dir = 'behind';
  return `${f1(d)} m ${dir}`;
}

/** Pure: a short summary of a World, with [ids], for brains ("[o1] portal at (0, 0, -2.2), 2.2 m ahead: ..."). */
export function describeWorld(world) {
  if (!world || typeof world !== 'object') return 'The world could not be read.';
  const m = world.mood || DEFAULT_MOOD;
  const objs = Array.isArray(world.objects) ? world.objects : [];
  const head = `Mood: ${m.preset} (fog ${f1(m.fog)}, glow ${f1(m.glow)}).`;
  if (!objs.length) return `${head} No objects yet: just the sky, the floating islands and the fireflies.`;
  const items = objs.map((o) => {
    const p = o.position || [0, 0, 0];
    const high = p[1] >= 2.5 ? ', high up' : '';
    const sc = Math.abs((o.scale ?? 1) - 1) > 0.05 ? `, scale ${f1(o.scale)}` : '';
    const desc = o.description && o.description !== o.name ? `: ${text(o.description, 80)}` : '';
    return `[${o.id}] ${o.name} at (${p.map(f1).join(', ')}), ${direction(p)}${high}${sc}${desc}`;
  });
  return `${head} ${objs.length} object${objs.length === 1 ? '' : 's'} (max ${LIMITS.maxObjects}): ${items.join('; ')}.`;
}

// ------------------------------------------------------------------------------------------------ spacing

// Rough ground-plane radius (m, at scale 1) of each archetype as the viewer draws it. A portal is ~1.5 m wide.
const ARCH_RADIUS = {
  crystal: 0.3, 'crystal-cluster': 0.5, 'floating-island': 1.1, portal: 0.8, lantern: 0.25, 'tree-glow': 0.7,
  'mushroom-glow': 0.4, 'rune-stone': 0.4, orb: 0.3, planet: 0.9, moon: 0.6, spaceship: 0.9, obelisk: 0.45,
  'waterfall-light': 0.8, 'butterfly-swarm': 0.6, wisp: 0.2,
};
// Big things that must keep at least LARGE_GAP m (centre to centre) from each other.
const LARGE = new Set(['portal', 'floating-island', 'planet', 'spaceship', 'waterfall-light', 'tree-glow']);
const LARGE_GAP = 2.0;
const GAP_FACTOR = 1.2; // keep centres at least 1.2 x the combined radii apart

function assetRadius(asset) {
  if (asset?.type === 'archetype') return ARCH_RADIUS[asset.archetype] ?? 0.4;
  if (asset?.type === 'parts' && Array.isArray(asset.parts) && asset.parts.length) {
    let r = 0;
    for (const p of asset.parts) r = Math.max(r, Math.hypot(p.position[0], p.position[2]) + Math.max(p.size[0], p.size[2]) / 2);
    return clamp(r, 0.2, 2);
  }
  return 0.6; // glb and anything else
}
const radiusOf = (asset, scale) => assetRadius(asset) * (scale || 1);
const isLarge = (asset, scale) => (asset?.type === 'archetype' && LARGE.has(asset.archetype)) || radiusOf(asset, scale) >= 0.9;

/**
 * How much room a candidate spot (x, y, z) leaves against every existing object: the smallest (distance - required)
 * over the objects at a similar height (a moon high in the sky doesn't crowd a crystal on the ground).
 * Required = max(1.2 x combined radii, 2 m when both are large). >= 0 means clear.
 */
function clearanceAt(objects, x, y, z, asset, scale) {
  const r = radiusOf(asset, scale);
  const big = isLarge(asset, scale);
  let worst = Infinity;
  for (const o of objects) {
    const p = o.position;
    const ro = radiusOf(o.asset, o.scale);
    if (Math.abs(p[1] - y) > 1.6 + r + ro) continue;
    let need = GAP_FACTOR * (r + ro);
    if (big && isLarge(o.asset, o.scale)) need = Math.max(need, LARGE_GAP);
    const gap = Math.hypot(p[0] - x, p[2] - z) - need;
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * A requested spot that crowds something already there is pushed outward along an arc around the origin:
 * 1.8 m steps, alternating right and left, then a ring further back (depth -2 .. -5 m and beyond), until it's clear.
 * Returns the original position when it is already clear.
 */
function clearSpot(objects, position, asset, scale) {
  const [x0, y, z0] = position;
  if (clearanceAt(objects, x0, y, z0, asset, scale) >= 0) return position;
  const d0 = Math.hypot(x0, z0);
  const r0 = clamp(d0, 2, 12);
  const a0 = d0 < 0.4 ? 0 : Math.atan2(x0, -z0); // bearing from the start view (0 = ahead, + = right)
  // Candidates: rings every 1.5 m further out, 1.8 m arc steps alternating right/left. Cheapest clear one wins:
  // small swings first, then a step back, and anything beside or behind her only as a last resort.
  const cands = [];
  for (let ring = 0; ring <= 6; ring++) {
    const rr = r0 + 1.5 * ring;
    const step = 1.8 / rr;
    for (let k = 0; k <= 12; k++) {
      for (const side of k === 0 ? [0] : [1, -1]) {
        const a = a0 + side * k * step;
        if (Math.abs(a) > (120 * Math.PI) / 180) continue;
        const cost = Math.abs(a - a0) / (Math.PI / 4) + ring * 0.7 + (Math.abs(a) > Math.PI / 2 ? 3 : 0) + k * 0.001 + (side < 0 ? 0.0005 : 0);
        cands.push({ a, rr, cost });
      }
    }
  }
  cands.sort((p, q) => p.cost - q.cost);
  let roomiest = null;
  for (const { a, rr } of cands) {
    const cand = clampPosition([rr * Math.sin(a), y, -rr * Math.cos(a)]);
    const c = clearanceAt(objects, cand[0], y, cand[2], asset, scale);
    if (c >= 0) return cand;
    if (!roomiest || c > roomiest.c) roomiest = { pos: cand, c };
  }
  return roomiest ? roomiest.pos : position;
}

// ------------------------------------------------------------------------------------------------ spawn

// Default spawn: candidates on a gentle arc in front of the origin (the user starts at the origin facing -z),
// 1.6-5 m out and up to +-72 degrees. The cheapest candidate that clears every existing object (by the spacing
// rules above) wins: centre and ~2.3 m first, then outwards, so a series of adds fills a spread arc, not a pile.
function spawnPosition(objects, { asset = null, scale = 1, floating = false, rand = Math.random } = {}) {
  const extra = Math.max(0, scale - 1) * 0.6; // big things sit a little further back
  const y = floating ? 0.9 + rand() * 0.5 : 0;
  let best = null, bestCost = Infinity;
  for (let r = 1.6; r <= 5.001; r += 0.28) {
    for (let deg = -72; deg <= 72; deg += 6) {
      const a = (deg * Math.PI) / 180, rr = r + extra;
      const x = rr * Math.sin(a), z = -rr * Math.cos(a);
      // leave a little slack for the jitter below
      const c = clearanceAt(objects, x, y, z, asset, scale) - 0.06;
      const cost = (deg / 45) ** 2 + ((r - 2.3) / 0.7) ** 2 + rand() * 0.2;
      if (c >= 0 && cost < bestCost) { best = { x, z }; bestCost = cost; }
    }
  }
  let pos;
  if (best) pos = clampPosition([best.x + (rand() - 0.5) * 0.08, y, best.z + (rand() - 0.5) * 0.08]);
  else pos = clearSpot(objects, clampPosition([0, y, -2.3 - extra]), asset, scale); // a crowded front: go wider
  const rotationY = normAngle(Math.atan2(-pos[0], -pos[2])); // face the origin, where the user starts
  return { position: pos, rotationY };
}

// ------------------------------------------------------------------------------------------------ objects

function sanitizeObject(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id) return null;
  const name = text(o.name, LIMITS.name) || 'wisp';
  const pos = vec3(o.position);
  return {
    id: text(o.id, 40),
    name,
    description: text(o.description, LIMITS.description) || name,
    asset: sanitizeAsset(o.asset),
    position: clampPosition(pos || [0, 0, -2]),
    rotationY: normAngle(num(o.rotationY) ?? 0),
    scale: round(clamp(num(o.scale) ?? 1, LIMITS.scale[0], LIMITS.scale[1])),
    createdBy: o.createdBy === 'user' ? 'user' : 'guide',
    createdAt: num(o.createdAt) ?? Date.now(),
  };
}

function freshWorld() {
  return { version: 0, mood: { ...DEFAULT_MOOD }, objects: [], guide: clone(DEFAULT_GUIDE) };
}

function loadFile(file, log) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log(`world: could not read ${file}: ${e.message}`);
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not an object');
    const w = freshWorld();
    w.version = Math.max(0, Math.floor(num(data.version) ?? 0));
    const m = data.mood || {};
    w.mood = {
      preset: moodPreset(m.preset) || DEFAULT_MOOD.preset,
      fog: round(clamp(num(m.fog) ?? DEFAULT_MOOD.fog, 0, 1)),
      glow: round(clamp(num(m.glow) ?? DEFAULT_MOOD.glow, 0, 1)),
    };
    const seen = new Set();
    for (const o of Array.isArray(data.objects) ? data.objects : []) {
      const s = sanitizeObject(o);
      if (s && !seen.has(s.id) && w.objects.length < LIMITS.maxObjects) { seen.add(s.id); w.objects.push(s); }
    }
    const gp = vec3(data.guide?.position);
    w.guide = { position: gp ? clampPosition(gp) : [...DEFAULT_GUIDE.position], mood: text(data.guide?.mood, LIMITS.guideMood) || DEFAULT_GUIDE.mood };
    return { world: w, nextId: Math.floor(num(data.nextId) ?? 1) };
  } catch (e) {
    const bad = `${file}.corrupt-${Date.now()}`;
    try { copyFileSync(file, bad); } catch { /* best effort */ }
    log(`world: ${file} was unreadable (${e.message}); kept a copy at ${bad} and started fresh`);
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ createWorld

export function createWorld({ file = null, log = (...a) => console.log(...a), rand = Math.random, saveDelayMs = 150 } = {}) {
  const loaded = file ? loadFile(file, log) : null;
  const w = loaded?.world || freshWorld();
  let nextId = Math.max(loaded?.nextId || 1, 1 + Math.max(0, ...w.objects.map((o) => Number(/^o(\d+)$/.exec(o.id)?.[1] || 0))));
  const aliases = new Map(); // old id -> new id, after an asset swap
  const autoPlaced = new Set(); // ids placed by the default spawn and not moved since (their height follows the asset)
  const listeners = new Set();
  let saveTimer = null;

  // --- persistence (atomic: write a temp file, then rename)
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...w, nextId }, null, 1));
      renameSync(tmp, file);
    } catch (e) { log(`world: save failed: ${e.message}`); }
  }
  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, saveDelayMs);
    saveTimer.unref?.();
  }

  function get() { return clone(w); }

  function emit(op) {
    w.version += 1;
    scheduleSave();
    const snapshot = get();
    for (const fn of listeners) {
      try { fn(op, snapshot); } catch (e) { log(`world: listener failed: ${e.message}`); }
    }
    return snapshot;
  }

  const fail = (error) => ({ ok: false, world: get(), error });

  /** Find an object by id; follows swap aliases and, as a courtesy, a unique-ish name match (newest first). */
  function find(idOrName) {
    if (typeof idOrName !== 'string' && typeof idOrName !== 'number') return null;
    let id = String(idOrName).trim().replace(/^\[|\]$/g, '');
    if (!id) return null;
    for (let hops = 0; aliases.has(id) && hops < 10; hops++) id = aliases.get(id);
    const exact = w.objects.find((o) => o.id === id);
    if (exact) return exact;
    if (/^o\d+$/i.test(id)) return null; // an id that no longer exists: never guess by name
    const low = id.toLowerCase();
    const newestFirst = [...w.objects].reverse();
    return newestFirst.find((o) => o.name.toLowerCase() === low)
      || newestFirst.find((o) => o.name.toLowerCase().includes(low) || (low.length >= 4 && low.includes(o.name.toLowerCase())))
      || null;
  }

  function positionFrom(op) {
    const p = vec3(op.position);
    if (p) return clampPosition(p);
    if (typeof op.where === 'string' && WHERE_POSITIONS[op.where]) return clampPosition(WHERE_POSITIONS[op.where]);
    return null;
  }

  const ops = {
    add(op, meta) {
      if (w.objects.length >= LIMITS.maxObjects) {
        return fail(`The world is full (${LIMITS.maxObjects} objects). Remove something first.`);
      }
      let name = text(op.name, LIMITS.name);
      let description = text(op.description, LIMITS.description);
      if (!name && description) name = text(description.split(/[,.;:]/)[0], LIMITS.name);
      if (!name) return fail('add needs a name');
      if (!description) description = name;
      let asset = op.asset ? sanitizeAsset(op.asset) : null;
      if (!asset && typeof op.archetype === 'string' && ARCHETYPES.includes(op.archetype.trim().toLowerCase())) {
        asset = { type: 'archetype', archetype: op.archetype.trim().toLowerCase(), params: {} };
      }
      if (!asset) asset = { type: 'archetype', archetype: 'wisp', params: {} };
      const scale = round(clamp(num(op.scale) ?? 1, LIMITS.scale[0], LIMITS.scale[1]));
      let position = positionFrom(op);
      let rotationY = num(op.rotationY);
      const spawned = !position;
      if (spawned) {
        const s = spawnPosition(w.objects, { asset, scale, floating: isFloating(asset), rand });
        position = s.position;
        if (rotationY === null) rotationY = s.rotationY;
      } else if (!meta.replaces && !meta.exact) {
        // A requested spot that crowds an existing object is nudged outward (an asset swap keeps its exact place).
        position = clearSpot(w.objects, position, asset, scale);
      }
      if (rotationY === null) rotationY = Math.atan2(-position[0], -position[2]);
      const createdBy = meta.createdBy === 'user' || meta.createdBy === 'guide' ? meta.createdBy
        : (op.createdBy === 'user' ? 'user' : 'guide');
      const id = `o${nextId++}`;
      const object = { id, name, description, asset, position, rotationY: normAngle(rotationY), scale, createdBy, createdAt: Date.now() };
      w.objects.push(object);
      if (spawned || meta.autoPlaced) autoPlaced.add(id);
      const out = { type: 'add', ...clone(object), object: clone(object) };
      if (meta.replaces) out.replaces = meta.replaces;
      const world = emit(out);
      return { ok: true, world, op: out, object: clone(object) };
    },

    move(op) {
      const obj = find(op.id);
      if (!obj) return fail(`no object with id "${text(op.id, 40)}"`);
      const position = positionFrom(op);
      const rot = num(op.rotationY);
      const scale = num(op.scale);
      if (!position && rot === null && scale === null) return fail('move needs a position (or rotationY)');
      if (position) { obj.position = position; autoPlaced.delete(obj.id); }
      if (rot !== null) obj.rotationY = normAngle(rot);
      if (scale !== null) obj.scale = round(clamp(scale, LIMITS.scale[0], LIMITS.scale[1]));
      const out = { type: 'move', id: obj.id, position: [...obj.position], rotationY: obj.rotationY, scale: obj.scale, object: clone(obj) };
      const world = emit(out);
      return { ok: true, world, op: out, object: clone(obj) };
    },

    remove(op, meta) {
      const obj = find(op.id);
      if (!obj) return fail(`no object with id "${text(op.id, 40)}"`);
      w.objects = w.objects.filter((o) => o !== obj);
      autoPlaced.delete(obj.id);
      const out = { type: 'remove', id: obj.id };
      if (meta.replacedBy) out.replacedBy = meta.replacedBy;
      const world = emit(out);
      return { ok: true, world, op: out };
    },

    clear() {
      const ids = w.objects.map((o) => o.id);
      w.objects = [];
      aliases.clear();
      autoPlaced.clear();
      const out = { type: 'clear', ids };
      const world = emit(out);
      return { ok: true, world, op: out };
    },

    mood(op) {
      const next = { ...w.mood };
      let changed = false;
      if (op.preset !== undefined && op.preset !== null && op.preset !== '') {
        const p = moodPreset(op.preset);
        if (!p) return fail(`unknown mood preset "${text(op.preset, 30)}" (use ${MOOD_PRESETS.join(', ')})`);
        next.preset = p; changed = true;
      }
      for (const k of ['fog', 'glow']) {
        const n = num(op[k]);
        if (n !== null) { next[k] = round(clamp(n, 0, 1)); changed = true; }
      }
      if (!changed) return fail('mood needs a preset, fog or glow');
      w.mood = next;
      const out = { type: 'mood', ...next, mood: { ...next } };
      const world = emit(out);
      return { ok: true, world, op: out };
    },

    guide(op) {
      let changed = false;
      const p = vec3(op.position);
      if (p) { w.guide.position = clampPosition(p); changed = true; }
      const m = text(op.mood, LIMITS.guideMood);
      if (m) { w.guide.mood = m; changed = true; }
      if (!changed) return fail('guide needs a position or a mood');
      const out = { type: 'guide', position: [...w.guide.position], mood: w.guide.mood, guide: clone(w.guide) };
      const world = emit(out);
      return { ok: true, world, op: out };
    },
  };

  /** Apply one Op. Never throws. meta.createdBy ('user'|'guide') marks who added an object. */
  function apply(op, meta = {}) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return fail('op must be an object');
    const type = typeof op.type === 'string' ? op.type.trim().toLowerCase() : '';
    const fn = Object.hasOwn(ops, type) ? ops[type] : null;
    if (!fn) return fail(`unknown op type "${text(op.type, 30)}" (use add, move, remove, clear, mood, guide)`);
    try { return fn(op, meta || {}); } catch (e) {
      log(`world: ${type} failed: ${e.stack || e.message}`);
      return fail(`could not apply ${type}`);
    }
  }

  /**
   * Swap an object's asset once a slow provider finishes: emits `remove` (old id) then `add` (new id, same place),
   * so any client that understands the basic ops morphs the placeholder into the real thing. The old id keeps
   * working as an alias for move/remove.
   */
  function replaceAsset(id, asset) {
    const obj = w.objects.find((o) => o.id === id);
    if (!obj) return fail(`no object with id "${id}"`);
    const newId = `o${nextId}`;
    const clean = sanitizeAsset(asset);
    const keep = { name: obj.name, description: obj.description, position: [...obj.position], rotationY: obj.rotationY, scale: obj.scale };
    // Auto-placed and never moved: re-seat it for the new asset (a floating wisp placeholder -> a grounded model).
    const wasAuto = autoPlaced.has(id);
    if (wasAuto && isFloating(clean) !== isFloating(obj.asset)) keep.position[1] = isFloating(clean) ? round(0.9 + rand() * 0.5) : 0;
    const createdBy = obj.createdBy;
    const idx = w.objects.indexOf(obj);
    ops.remove({ id }, { replacedBy: newId });
    const res = ops.add({ ...keep, asset: clean }, { createdBy, replaces: id, autoPlaced: wasAuto });
    if (res.ok) {
      aliases.set(id, res.object.id);
      // keep the list order stable: the replacement takes the old object's slot
      const i = w.objects.findIndex((o) => o.id === res.object.id);
      if (i >= 0 && idx >= 0 && idx < w.objects.length - 1) { const [o] = w.objects.splice(i, 1); w.objects.splice(idx, 0, o); scheduleSave(); }
    }
    return res;
  }

  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return {
    get,
    apply,
    describe: () => describeWorld(w),
    on,
    find: (id) => { const o = find(id); return o ? clone(o) : null; },
    count: () => w.objects.length,
    replaceAsset,
    flush,
  };
}
