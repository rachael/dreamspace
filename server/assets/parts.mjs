// Parts asset provider: asks the local ollama model (OLLAMA_MODEL, default qwen2.5:3b) to compose the object from
// primitive shapes, using a JSON-schema `format` so the reply is always parseable JSON. Then every part is validated,
// clamped and post-processed, because a 3B model's geometry is loose.
//
// Prompt and schema: the local-llm research "better parts prompt" (role first, then shape; full-extent sizes;
// centre positions; placeholder #RRGGBB in the example so the model doesn't copy its palette). Measured 5-9 s per
// call warm on this Mac with minItems 5; calls queue behind the ollama brain on the same model.
//
// SIZE SEMANTICS (the renderer in src/world/objects.js must match these, or models render wrong):
//   size    = full extents in metres, not radii.
//   box [w,h,d]. sphere/icosahedron/octahedron: diameter per axis (unit geometry of radius 0.5, scaled by size).
//   cylinder/cone/capsule: [diameter, height, diameter], upright along y.
//   torus: [outer diameter, tube thickness, outer diameter], lying flat in the x/z plane.
//   position = the CENTRE of the part; the model stands on y=0, centred on x=0,z=0. rotation = Euler XYZ radians.
//
// Post-processing (research list + extras): coerce shapes/colours, degrees->radians, drop dupes, scale the model to
// 0.35-2.2 m tall and <= 2.5 m wide, centre it on x/z, put its lowest point at y=0, clamp sizes to [0.02, 2],
// soften pure primaries, make sure 1+ part glows, cap at 24 parts, round to mm.

import { paletteWords } from './archetype.mjs';

const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosahedron', 'capsule', 'octahedron'];
const MATERIALS = ['matte', 'glow', 'glass'];
const MAX_PARTS = 24;

const ollamaUrl = () => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const ollamaModel = () => process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const envInt = (k, d) => { const v = Number.parseInt(process.env[k] ?? '', 10); return Number.isFinite(v) && v > 0 ? v : d; };

// ---- prompt + schema (verbatim from the local-llm research) -------------------------------------------------------
export const PARTS_PROMPT = `You build small 3D models for a calm, glowing sci-fi and fantasy VR world, using only primitive shapes.
Return JSON {"parts":[...]} with 5 to 16 parts. Each part:
- role: what the part is, e.g. "roof", "door", "blade" (write this first, then choose the shape)
- shape: box, sphere, cylinder, cone, torus, icosahedron, capsule or octahedron
- size [x,y,z] in metres: the full width, height and depth of the part. Sphere/icosahedron/octahedron: diameter. Cylinder/cone/capsule: [diameter, height, diameter], standing upright along y. Torus: [outer diameter, tube thickness, outer diameter], lying flat.
- position [x,y,z]: the CENTRE of the part. The model stands on the ground at y=0, centred on x=0,z=0, about 0.5 to 2 metres tall. A part of height h resting on the ground has y = h/2. A part on top of another sits at (top of the lower part + its own h/2).
- rotation [x,y,z] in radians, usually [0,0,0]. Use 1.5708 to lay a cylinder on its side.
- color "#rrggbb": soft, harmonious colours (teal, violet, amber, moss, silver); avoid pure primaries.
- material: matte for solid parts, glow for lights (windows, runes, cores, gems) with emissive 0.6-1, glass for crystals and domes.
Parts must touch or overlap so the model is one connected object. Include one to three glow parts.

Example, "a lamp post" (shape only, pick your own colours): {"parts":[{"role":"base","shape":"cylinder","size":[0.3,0.1,0.3],"position":[0,0.05,0],"rotation":[0,0,0],"color":"#RRGGBB","material":"matte"},{"role":"pole","shape":"cylinder","size":[0.08,1.4,0.08],"position":[0,0.8,0],"rotation":[0,0,0],"color":"#RRGGBB","material":"matte"},{"role":"light","shape":"sphere","size":[0.25,0.25,0.25],"position":[0,1.6,0],"rotation":[0,0,0],"color":"#RRGGBB","material":"glow","emissive":0.9}]}`;

const v3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
// minItems 5 (research used 3): A/B on 4 objects x 2 runs, qwen2.5:3b warm. min 3 -> 3.1 parts avg, 3.4 s, 32% of
// parts floating; min 5 -> 5.0 parts, 5.5 s, 12% floating; min 7 -> 7.0 parts, 7.9 s, 14% floating. PARTS_MIN overrides.
export const PARTS_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array', minItems: 5, maxItems: MAX_PARTS,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          shape: { type: 'string', enum: SHAPES },
          size: v3, position: v3, rotation: v3,
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          material: { type: 'string', enum: MATERIALS },
          emissive: { type: 'number' },
        },
        required: ['role', 'shape', 'size', 'position', 'rotation', 'color', 'material'],
      },
    },
  },
  required: ['parts'],
};

function schemaWithMin(min) {
  const s = structuredClone(PARTS_SCHEMA);
  s.properties.parts.minItems = Math.max(1, Math.min(16, min));
  return s;
}

// ---- coercion helpers ------------------------------------------------------------------------------------------
const SHAPE_ALIASES = {
  cube: 'box', cuboid: 'box', block: 'box', rectangle: 'box', slab: 'box', plane: 'box', brick: 'box', panel: 'box',
  ball: 'sphere', globe: 'sphere', orb: 'sphere', dome: 'sphere', ellipsoid: 'sphere', hemisphere: 'sphere',
  tube: 'cylinder', pipe: 'cylinder', rod: 'cylinder', pillar: 'cylinder', column: 'cylinder', disc: 'cylinder', disk: 'cylinder', cyl: 'cylinder',
  pyramid: 'cone', spike: 'cone', ring: 'torus', donut: 'torus', doughnut: 'torus', halo: 'torus', hoop: 'torus',
  ico: 'icosahedron', gem: 'icosahedron', dodecahedron: 'icosahedron', polyhedron: 'icosahedron',
  pill: 'capsule', diamond: 'octahedron', octa: 'octahedron', crystal: 'octahedron',
};
const NAMED = {
  teal: '#5fd4d0', violet: '#b48cff', purple: '#a57ff0', amber: '#f5b86b', gold: '#f5cf7a', moss: '#8fb87a',
  green: '#7fd6a0', silver: '#c9d3e6', white: '#eef1ff', blue: '#6fa8ff', cyan: '#7fe8ff', pink: '#f2a6cf',
  red: '#e8707e', orange: '#f5a162', yellow: '#f2e27a', brown: '#a07a5a', black: '#2b2f4a', grey: '#9aa3b8', gray: '#9aa3b8',
};
const DEFAULT_COLOR = { matte: '#6f7fa0', glow: '#ffd89a', glass: '#9fd8ff' };
const TAU = Math.PI * 2;
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function vec3(v, dflt) {
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) v = Number(v);      // "3" -> 3
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v];
  if (!Array.isArray(v) || v.length === 0) return dflt;
  const out = v.slice(0, 3).map(Number);
  while (out.length < 3) out.push(out.length ? out[out.length - 1] : 0);
  return out.every(Number.isFinite) ? out : dflt;
}
function colour(c, material) {
  let s = typeof c === 'string' ? c.trim().toLowerCase() : '';
  if (NAMED[s]) return NAMED[s];
  if (/^[0-9a-f]{6}$/.test(s)) s = `#${s}`;
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) s = `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(s)) return DEFAULT_COLOR[material] || DEFAULT_COLOR.matte;
  return soften(s);
}
// Pure primaries (#ff0000, #00ff00, #0000ff ...) and pure black jar in a calm twilight scene: pull them gently
// toward a cool pastel. Anything already soft is left alone.
function soften(h) {
  const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const max = Math.max(...rgb), min = Math.min(...rgb);
  if (max === 0) return '#1e2233';
  if (!(max >= 250 && min <= 5)) return h;
  const tint = [200, 208, 236];
  return '#' + rgb.map((c, i) => Math.round(c * 0.7 + tint[i] * 0.3).toString(16).padStart(2, '0')).join('');
}
const wrap = (a) => { let x = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI; if (Math.abs(x) < 1e-6) x = 0; return x; };

// Axis-aligned half extents of a rotated box (Euler XYZ, as three.js applies it): |R| * half.
function rotatedHalf(size, rot) {
  const [hx, hy, hz] = size.map((s) => s / 2);
  if (!rot[0] && !rot[1] && !rot[2]) return [hx, hy, hz];
  const [a, b, c] = rot;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // three.js Euler 'XYZ' matrix
  const R = [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
  return R.map((row) => Math.abs(row[0]) * hx + Math.abs(row[1]) * hy + Math.abs(row[2]) * hz);
}
function bounds(ps) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of ps) {
    const h = rotatedHalf(p.size, p.rotation);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p.position[i] - h[i]); hi[i] = Math.max(hi[i], p.position[i] + h[i]); }
  }
  return { lo, hi };
}

const GLOWY_ROLE = /light|glow|lamp|window|core|gem|crystal|rune|eye|flame|fire|orb|bulb|star|jewel|beacon|heart|spark|lantern|tip|halo|energy/i;

/**
 * Turn a model's raw parts (any shape of junk) into contract Parts, post-processed. Returns Part[] or null.
 * Exported for tests and for other providers that emit parts.
 */
export function sanitizeParts(raw) {
  if (!Array.isArray(raw)) return null;
  let ps = [];
  for (const q of raw.slice(0, 64)) {
    if (!q || typeof q !== 'object') continue;
    let shape = String(q.shape ?? '').trim().toLowerCase();
    shape = SHAPES.includes(shape) ? shape : SHAPE_ALIASES[shape];
    if (!shape) continue;
    let size = vec3(q.size, null);
    if (!size) continue;
    size = size.map((s) => Math.abs(s));
    if (size.every((s) => s < 1e-4)) continue;
    size = size.map((s) => (s < 1e-4 ? Math.max(...size) : s));     // a zero axis: treat as round
    const position = vec3(q.position, [0, size[1] / 2, 0]);
    let rotation = vec3(q.rotation, [0, 0, 0]);
    if (rotation.some((a) => Math.abs(a) > TAU + 0.01)) rotation = rotation.map((a) => (a * Math.PI) / 180); // degrees
    rotation = rotation.map(wrap);
    let material = String(q.material ?? '').trim().toLowerCase();
    if (!MATERIALS.includes(material)) {
      material = /glow|emissive|light|neon/.test(material) ? 'glow' : /glass|crystal|transparent/.test(material) ? 'glass' : 'matte';
    }
    const part = { role: typeof q.role === 'string' ? q.role.slice(0, 40) : '', shape, size, position, rotation, color: colour(q.color, material), material };
    const em = Number(q.emissive);
    if (Number.isFinite(em) && em > 0) part.emissive = clamp(em, 0, 1);
    ps.push(part);
  }

  // Drop duplicates: same shape, same place, same size (to the cm).
  const seen = new Set();
  ps = ps.filter((p) => {
    const k = JSON.stringify([p.shape, p.position.map((n) => Math.round(n * 50)), p.size.map((n) => Math.round(n * 50))]);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (ps.length < 2) return null;
  ps = ps.slice(0, MAX_PARTS);

  // Normalise scale: 0.35-2.2 m tall, <= 2.5 m wide. Then centre on x/z and stand on y=0.
  let { lo, hi } = bounds(ps);
  const H = hi[1] - lo[1], W = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
  let s = 1;
  if (H > 2.2) s = 2.0 / H;
  else if (H < 0.35 && H > 0) s = 0.6 / H;
  if (W * s > 2.5) s = 2.5 / W;
  if (s !== 1) for (const p of ps) { p.size = p.size.map((v) => v * s); p.position = p.position.map((v) => v * s); }
  ({ lo, hi } = bounds(ps));
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, by = lo[1];
  for (const p of ps) p.position = [p.position[0] - cx, p.position[1] - by, p.position[2] - cz];
  for (const p of ps) p.size = p.size.map((v) => clamp(v, 0.02, 2));

  // At least one glow part: prefer a part whose role sounds like a light, else the smallest part.
  if (!ps.some((p) => p.material === 'glow')) {
    const vol = (p) => p.size[0] * p.size[1] * p.size[2];
    const pick = ps.find((p) => GLOWY_ROLE.test(p.role)) || [...ps].sort((a, b) => vol(a) - vol(b))[0];
    pick.material = 'glow';
    if (pick.color === DEFAULT_COLOR.matte) pick.color = DEFAULT_COLOR.glow;
  }
  for (const p of ps) {
    if (p.material === 'glow') p.emissive = clamp(p.emissive ?? 0.85, 0.3, 1);
  }

  // Contract fields only (role is dropped), rounded to the millimetre.
  return ps.map((p) => {
    const out = {
      shape: p.shape, size: p.size.map(r3), position: p.position.map(r3), rotation: p.rotation.map(r3),
      color: p.color, material: p.material,
    };
    if (p.emissive !== undefined) out.emissive = r3(p.emissive);
    return out;
  });
}

/**
 * Strict contract check for Part[] from any source (used by index.mjs on every provider's output).
 * Clamps rather than rejects where it can; returns a clean copy, or null when nothing usable is left.
 */
export function validateParts(ps) {
  if (!Array.isArray(ps)) return null;
  const out = [];
  for (const p of ps) {
    if (out.length >= MAX_PARTS) break;
    if (!p || typeof p !== 'object' || !SHAPES.includes(p.shape) || !MATERIALS.includes(p.material)) continue;
    const size = vec3(p.size, null), position = vec3(p.position, null), rotation = vec3(p.rotation, [0, 0, 0]);
    if (!size || !position) continue;
    if (typeof p.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(p.color)) continue;
    const q = {
      shape: p.shape,
      size: size.map((v) => r3(clamp(Math.abs(v), 0.02, 2))),
      position: [r3(clamp(position[0], -5, 5)), r3(clamp(position[1], -1, 6)), r3(clamp(position[2], -5, 5))],
      rotation: rotation.map((a) => r3(wrap(a))),
      color: p.color.toLowerCase(),
      material: p.material,
    };
    const em = Number(p.emissive);
    if (p.emissive !== undefined && Number.isFinite(em)) q.emissive = r3(clamp(em, 0, 1));
    out.push(q);
  }
  return out.length ? out : null;
}

// ---- ollama ---------------------------------------------------------------------------------------------------
let availCache = { at: 0, value: false };
async function ollamaHasModel() {
  if (Date.now() - availCache.at < 10_000) return availCache.value;
  let value = false;
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const want = ollamaModel().replace(/:latest$/, '');
      const { models = [] } = await res.json();
      value = models.some((m) => [m.name, m.model].some((n) => String(n || '').replace(/:latest$/, '') === want));
    }
  } catch { value = false; }
  availCache = { at: Date.now(), value };
  return value;
}

// The research user message, plus the colour words as hex. A/B (3 objects x 2 runs, qwen2.5:3b): without the hint
// 9/21 parts used the description's colours (2/6 runs fully); with it 23/23 parts (6/6 runs), at no extra latency.
export function userMessage(name, description) {
  const pal = paletteWords(name, description);
  return `Name: ${name}\nDescription: ${description || name}` + (pal.length ? `\nColours to use: ${pal.map((c) => `${c.word} ${c.hex}`).join(', ')}` : '');
}

async function askOllama({ name, description }, { temperature, timeoutMs }) {
  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: ollamaModel(),
      stream: false,
      format: schemaWithMin(envInt('PARTS_MIN', 5)),
      keep_alive: '30m',
      options: { temperature, num_ctx: 4096, num_predict: 3000 },
      messages: [
        { role: 'system', content: PARTS_PROMPT },
        { role: 'user', content: userMessage(name, description) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const body = await res.json();
  const text = body?.message?.content;
  if (typeof text !== 'string') throw new Error('ollama: no message content');
  const obj = JSON.parse(text);
  return obj?.parts;
}

export default {
  name: 'parts',
  slow: true,
  available: ollamaHasModel,
  /** {name, description} -> {type:'parts', parts} | null. One retry if the first answer is unusable and time allows. */
  async generate({ name = '', description = '' } = {}) {
    name = String(name).slice(0, 60); description = String(description).slice(0, 300);
    const budget = envInt('PARTS_TIMEOUT_MS', 35_000);
    const t0 = Date.now();
    let lastErr;
    for (const temperature of [0.5, 0.7]) {
      const left = budget - (Date.now() - t0);
      if (left < 8_000) break;
      try {
        const parts = sanitizeParts(await askOllama({ name, description }, { temperature, timeoutMs: left }));
        if (parts && parts.length >= 3) return { type: 'parts', parts };
        lastErr = new Error('too few usable parts');
      } catch (e) {
        lastErr = e;
        if (e.name === 'TimeoutError' || e.name === 'AbortError') break;
      }
    }
    if (lastErr) console.warn(`[assets] parts: no model for "${name}" (${lastErr.message})`);
    return null;
  },
};
