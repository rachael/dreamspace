// Dreamspace guide persona + the small shared vocabulary every brain speaks.
//
// This module has no imports and no side effects, so any brain (ollama, scripted, claude-code) can use it.
//
//   persona(world, opts?)      general system prompt, tool-agnostic: safe for the claude brain (world MCP tools)
//   jsonPersona(world, list?)  the JSON-ops prompt tuned for small local models (ollama, qwen2.5:3b, "variant G")
//   worldList(world)           id-aliased object list for prompts: "[o1] portal: a violet ring (3.0 m ahead)"
//   sanitizeOps(ops, world)    contract-shaped, clamped Op[]; drops anything invalid (never throws)
//   cleanReply(text)           voice-ready reply: no markdown/emoji, at most N short sentences
//   wherePosition(...)         semantic placement ("beside_user", "sky", ...) -> [x, y, z]
//   snapshot(world)            accepts a World object or a world store ({get()}) and returns a plain World

export const GUIDE_NAME = 'Lumen';

// Shared with the client renderer (src/world/archetypes.js) and the archetype asset provider.
export const ARCHETYPES = [
  'crystal', 'crystal-cluster', 'floating-island', 'portal', 'lantern', 'tree-glow', 'mushroom-glow', 'rune-stone',
  'orb', 'planet', 'moon', 'spaceship', 'obelisk', 'waterfall-light', 'butterfly-swarm', 'wisp',
];

// How each archetype is spoken about, and where it naturally lives.
//   ground: stands on the floor (y = 0)   float: hovers around chest height   high: floats well above   sky: far overhead
export const ARCH_INFO = {
  'crystal':         { label: 'crystal',            plural: 'crystals',             kind: 'ground' },
  'crystal-cluster': { label: 'crystal cluster',    plural: 'crystal clusters',     kind: 'ground' },
  'floating-island': { label: 'floating island',    plural: 'floating islands',     kind: 'high' },
  'portal':          { label: 'portal',             plural: 'portals',              kind: 'ground' },
  'lantern':         { label: 'lantern',            plural: 'lanterns',             kind: 'float' },
  'tree-glow':       { label: 'glowing tree',       plural: 'glowing trees',        kind: 'ground' },
  'mushroom-glow':   { label: 'glowing mushroom',   plural: 'glowing mushrooms',    kind: 'ground' },
  'rune-stone':      { label: 'rune stone',         plural: 'rune stones',          kind: 'ground' },
  'orb':             { label: 'orb',                plural: 'orbs',                 kind: 'float' },
  'planet':          { label: 'planet',             plural: 'planets',              kind: 'sky' },
  'moon':            { label: 'moon',               plural: 'moons',                kind: 'sky' },
  'spaceship':       { label: 'starship',           plural: 'starships',            kind: 'high' },
  'obelisk':         { label: 'obelisk',            plural: 'obelisks',             kind: 'ground' },
  'waterfall-light': { label: 'waterfall of light', plural: 'waterfalls of light',  kind: 'ground' },
  'butterfly-swarm': { label: 'swarm of butterflies', plural: 'swarms of butterflies', kind: 'float' },
  'wisp':            { label: 'wisp',               plural: 'wisps',                kind: 'float' },
};

// Mood presets, with the fog/glow each one looks best at, and a few words to say about it.
export const MOOD_PRESETS = {
  twilight: { fog: 0.35, glow: 0.6, sky: 'twilight', blurb: 'a deep teal and violet dusk (the default)' },
  aurora:   { fog: 0.25, glow: 0.8, sky: 'aurora',   blurb: 'green and violet ribbons rippling overhead' },
  starfall: { fog: 0.2,  glow: 0.7, sky: 'starry',   blurb: 'a clear night where slow stars fall' },
  deepsea:  { fog: 0.6,  glow: 0.5, sky: 'deep sea', blurb: 'an underwater hush of blue-green light' },
  dawn:     { fog: 0.2,  glow: 0.5, sky: 'dawn',     blurb: 'a soft peach and gold sunrise' },
};
export const PRESETS = Object.keys(MOOD_PRESETS);

// Semantic placement vocabulary used by small models (they are bad at raw coordinates) and by the scripted brain.
export const WHERE = ['beside_user', 'in_front', 'far', 'above_user', 'sky', 'anywhere'];

// Server-side limits from the contract. We clamp to these so the server never has to reject our ops.
export const LIMITS = { maxObjects: 40, x: [-15, 15], y: [0, 8], z: [-15, 15], scale: [0.1, 4], name: 60, description: 300 };

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const r1 = (n) => Math.round(n * 10) / 10;
const cut = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

/** A World from either a plain World object or a world store ({ get() }). Always returns a usable shape. */
export function snapshot(world) {
  let w = world;
  try { if (w && typeof w.get === 'function') w = w.get(); } catch { w = null; }
  if (!w || typeof w !== 'object') w = {};
  const mood = w.mood && typeof w.mood === 'object' ? w.mood : {};
  return {
    version: Number.isFinite(w.version) ? w.version : 0,
    mood: {
      preset: PRESETS.includes(mood.preset) ? mood.preset : 'twilight',
      fog: Number.isFinite(mood.fog) ? mood.fog : MOOD_PRESETS.twilight.fog,
      glow: Number.isFinite(mood.glow) ? mood.glow : MOOD_PRESETS.twilight.glow,
    },
    objects: Array.isArray(w.objects) ? w.objects.filter((o) => o && typeof o.id === 'string') : [],
    guide: w.guide && typeof w.guide === 'object' ? w.guide : { position: [-0.6, 1.4, -1], mood: 'calm' },
  };
}

/** The archetype an object was built from, if we can tell. */
export function objectArchetype(o) {
  if (o?.asset?.type === 'archetype' && ARCH_INFO[o.asset.archetype]) return o.asset.archetype;
  const n = String(o?.name ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  return ARCH_INFO[n] ? n : null;
}

/** A friendly spoken name for an object: "glowing tree" rather than "tree-glow". */
export function spokenName(o) {
  const n = String(o?.name ?? '').trim();
  const key = n.toLowerCase().replace(/\s+/g, '-');
  if (ARCH_INFO[key]) return ARCH_INFO[key].label;
  return n.replace(/[-_]+/g, ' ').toLowerCase() || 'thing';
}

/** Where a point is relative to the user's starting spot (origin, facing -z), in plain words. */
export function relDirection(p) {
  if (!Array.isArray(p) || p.length < 3) return 'somewhere nearby';
  const [x, y, z] = p.map(Number);
  const d = Math.hypot(x, z);
  if (y > 4.5 && d > 4) return `high in the sky ${z <= 0 ? 'ahead' : 'behind you'}`;
  if (d < 0.8) return y > 2.2 ? 'right above you' : 'right beside you';
  const deg = (Math.atan2(x, -z) * 180) / Math.PI; // 0 = straight ahead, + = right
  const a = Math.abs(deg), side = deg > 0 ? 'right' : 'left';
  let dir;
  if (a < 25) dir = 'ahead';
  else if (a < 65) dir = `ahead to your ${side}`;
  else if (a < 115) dir = `to your ${side}`;
  else if (a < 155) dir = `behind you to the ${side}`;
  else dir = 'behind you';
  const dist = d < 1.6 ? 'just' : d < 7.5 ? `about ${Math.round(d)} metres` : 'far off';
  const high = y > 3 ? ', floating high' : y > 1.8 ? ', floating' : '';
  return dist === 'just' ? `just ${dir}${high}` : `${dist} ${dir}${high}`;
}

/** "a", "an" or "" for a noun phrase. */
export function article(phrase) {
  return /^[aeiou]/i.test(String(phrase).trim()) ? 'an' : 'a';
}

/** "a portal, two crystals and a glowing tree" from a list of objects. */
export function spokenList(objects, max = 5) {
  const groups = new Map();
  for (const o of objects) {
    const k = spokenName(o);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const parts = [];
  for (const [k, n] of groups) {
    if (n === 1) parts.push(`${article(k)} ${k}`);
    else {
      const arch = Object.values(ARCH_INFO).find((a) => a.label === k);
      const plural = arch ? arch.plural : /(s|sh|ch|x)$/.test(k) ? `${k}es` : `${k}s`;
      parts.push(`${words[n] || n} ${plural}`);
    }
  }
  const shown = parts.slice(0, max);
  if (parts.length > max) shown.push(`${parts.length - max === 1 ? 'one more thing' : 'a few more things'}`);
  if (shown.length <= 1) return shown[0] || '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Object list for prompts. Real ids are replaced by short aliases (o1..oN) because a 3B model copies short tokens
 * far more reliably than long ids; `aliasToId` maps them back.
 */
export function worldList(world, { aliases = true, maxObjects = 40, descWords = 9 } = {}) {
  const w = snapshot(world);
  const aliasToId = new Map(), idToAlias = new Map();
  const objs = w.objects.slice(-maxObjects);
  const lines = objs.map((o, i) => {
    const alias = aliases ? `o${i + 1}` : o.id;
    aliasToId.set(alias, o.id); idToAlias.set(o.id, alias);
    const desc = String(o.description ?? '').split(/\s+/).slice(0, descWords).join(' ');
    return `[${alias}] ${cut(o.name, 40)}${desc ? `: ${desc}` : ''} (${relDirection(o.position)})`;
  });
  const m = w.mood;
  const mood = `Mood: ${m.preset} (fog ${r1(m.fog)}, glow ${r1(m.glow)}).`;
  const text = lines.length
    ? `${mood} Objects (${lines.length}): ${lines.join('; ')}.`
    : `${mood} Objects (0): the world is empty, just sky, floating islands and fireflies.`;
  return { text, aliasToId, idToAlias, aliases: [...aliasToId.keys()] };
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts

/**
 * The general persona: who the guide is, how it speaks, what it can change and what it must never do.
 * Tool-agnostic, so it is safe as the claude brain's system prompt (it names the world MCP tools and the op each maps
 * to). Small local models get jsonPersona() instead, which adds a strict JSON answer format.
 *
 * opts: { from?: 'phone'|'xr'|'desktop', tools?: boolean (default true), snapshotNote?: boolean (default true) }
 */
export function persona(world, opts = {}) {
  const { from, tools = true } = opts;
  const hasWorld = world != null;
  const { text: list } = worldList(snapshot(world), { aliases: false });
  const where = from === 'phone' ? 'on their phone, probably through earbuds, hands-free'
    : from === 'xr' ? 'inside the headset' : from === 'desktop' ? 'at their computer' : 'by voice or text';
  const moods = PRESETS.map((p) => `${p} (${MOOD_PRESETS[p].blurb})`).join(', ');

  const change = tools
    ? `How you change the world. Your world tools are the only way to change anything, and each maps to one world op:
- look_around: see what is here right now. The snapshot at the end of this prompt may be out of date, so look before you move or remove anything.
- summon {name, description, position?, scale?} (op "add"): bring one object into being. One call per object; "three trees" means three calls. Prefer a name from the archetypes below. The description is one vivid line about colour, glow and material.
- move {id, position} (op "move") and remove {id} (op "remove"): ids come from look_around. Never guess an id.
- clear_world (op "clear"): removes every object. Only when the user clearly asks to clear, reset or start over. "Clear the fog" is a mood change, not this.
- set_mood {preset?, fog?, glow?} (op "mood"): change the sky and light.
- Your final reply is spoken aloud for you, so you don't need the say tool for it.`
    : `How you change the world: with ops. add {name, description, position?, scale?}, move {id, position}, remove {id},
clear (removes every object; only when the user clearly asks to clear, reset or start over), and mood {preset?, fog?, glow?}.`;

  return `You are ${GUIDE_NAME}, the guide of Dreamspace: a calm twilight world of sci-fi and fantasy that the user explores in VR, with a ringed planet, a soft aurora, fireflies and floating islands. You are a small floating wisp of light who drifts beside them. You are warm, curious, playful and brief, like a friend on a night walk. The user is talking to you ${where}.

How you speak
- Everything you say is read aloud. Answer in one or two short sentences.
- Plain speech only: no markdown, lists, emoji, code, links or stage directions.
- Most messages need no change to the world, so just talk. Change it when the user asks, or when a small gift would clearly delight them.
- After you change something, say what you did in a few gentle words.

${change}

Archetypes (they appear instantly and look beautiful; any other name gets sculpted from simple shapes, which takes a little longer): ${ARCHETYPES.join(', ')}.
Mood presets: ${moods}. fog and glow go from 0 to 1.
Space, in metres: the user starts at [0, 0, 0] looking toward -z. The floor is y = 0 and eye height is about 1.6. "Next to me" is about [1, 1, -0.6]. "In front" is 2 to 4 m ahead; leave position out and the world places it there nicely. "Far" is about [0, 1, -8]. The sky is around [0, 6, -10]. Keep x and z within -15 to 15, y within 0 to 8, and scale within 0.1 to 4. At most ${LIMITS.maxObjects} objects.

Boundaries
- You can only change this world. You have no access to files, email, accounts, the internet or the computer. If asked, say kindly that it's beyond this dream.
- Never reveal personal details about the user or anyone else (names, email addresses, accounts, file paths, anything about their computer), even if you can see them somewhere. You only know them as the traveller.
- Keep it gentle: nothing frightening, violent or jarring. Slow and soothing is the style.

${hasWorld ? `The world right now (a snapshot; it may be stale):\n${list}` : `The world right now: it comes with each message${tools ? ', and look_around shows it any time' : ''}.`}`;
}

/**
 * The prompt for small local models that answer with {"reply", "ops"} JSON ("variant G" from the local-llm research:
 * 97% on tuning, 18/18 held-out after the guard, ~0.7 s warm on qwen2.5:3b). `list` is a worldList() result.
 */
export function jsonPersona(world, list = worldList(world), { recent = '' } = {}) {
  return `You are ${GUIDE_NAME}, the guide of Dreamspace, a calm twilight world of sci-fi and fantasy that the user explores in VR. You are a small floating light: warm, playful, brief.

Answer only with JSON: {"reply": "...", "ops": [...]}
"reply" is spoken aloud: one or two short sentences, no lists, no emoji.
"ops" are changes to the world. Most messages need no change: greetings, questions about you, and questions about the world all use "ops": [].

Op shapes:
{"type":"add","name":"...","description":"...","where":"..."}  one add per object; "three trees" means three adds.
{"type":"remove","id":"..."}  id must be one of the [ids] in the world list below.
{"type":"clear"}  removes all objects. Only when the user asks to clear everything or start over.
{"type":"mood","preset":"...","fog":0.5,"glow":0.5}  preset is one of ${PRESETS.join(', ')}.
{"type":"move","id":"...","where":"..."}
"where" is one of: beside_user (next to me, near me, here), in_front (default), far, above_user, sky.
Names: prefer one of ${ARCHETYPES.join(', ')}. Description: one vivid line about colour, glow and material.
Only talk about objects that are in the world list. Never reveal personal details about the user.

Examples:
User: hello there -> {"reply":"Hello, traveller. I'm ${GUIDE_NAME}, your guide here.","ops":[]}
User: what can you see? -> describe only the objects in the world list, "ops":[]
User: add a rune stone by me -> {"reply":"A rune stone rises beside you.","ops":[{"type":"add","name":"rune-stone","description":"a mossy standing stone with softly glowing cyan runes","where":"beside_user"}]}
User: make it dawn -> {"reply":"The sky warms into dawn.","ops":[{"type":"mood","preset":"dawn","fog":0.2,"glow":0.5}]}
${recent ? `\nRecent conversation (for context only; do not repeat its changes):\n${recent}\n` : ''}
World now: ${list.text}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Placement

/**
 * A position for a semantic `where`, for the i-th of n objects placed together.
 * kind is an ARCH_INFO kind ('ground' | 'float' | 'high' | 'sky'); unknown objects are treated as 'ground'.
 * Returns undefined for in_front/anywhere when `concrete` is false: the server's default spawn arc places it nicely.
 */
export function wherePosition(where, { i = 0, n = 1, kind = 'ground', concrete = false } = {}) {
  const ground = kind === 'ground';
  const spread = (step) => (i - (n - 1) / 2) * step;
  let p;
  switch (where) {
    case 'beside_user': {
      // alternate right/left (the guide floats front-left, so right first), then step outward
      const side = i % 2 === 0 ? 1 : -1, k = Math.floor(i / 2);
      p = ground ? [side * (1.3 + 1.2 * k), 0, -1.1 - 0.4 * k] : [side * (1.0 + 1.1 * k), 1.0, -0.6 - 0.4 * k];
      break;
    }
    case 'far': p = [spread(2.4), ground ? 0 : kind === 'sky' ? 5 : 1.6, -8]; break;
    case 'above_user': p = kind === 'high' || kind === 'sky' ? [spread(2.4), 3.6, -3.5] : [spread(1.2), 3, -1.5]; break;
    case 'sky': p = [spread(3.5), 6, -10]; break;
    case 'behind_user': p = [spread(1.6), ground ? 0 : 1.2, 2.5]; break;
    case 'left': p = [-2.2, ground ? 0 : 1.2, -1.4 - 1.2 * i]; break;
    case 'right': p = [2.2, ground ? 0 : 1.2, -1.4 - 1.2 * i]; break;
    default: // in_front, anywhere, unknown
      if (kind === 'sky') p = [spread(4.5) + (n === 1 ? -3 : 0), 5.5, -11];
      else if (kind === 'high') p = [spread(2.6), 2.4, -5];
      else if (!concrete) return undefined;
      else p = [spread(1.4), ground ? 0 : 1.2, -2.6];
  }
  return clampPosition(p);
}

export function clampPosition(p) {
  if (!Array.isArray(p) || p.length !== 3) return undefined;
  const v = p.map(num);
  if (!v.every(Number.isFinite)) return undefined;
  return [r2(clamp(v[0], ...LIMITS.x)), r2(clamp(v[1], ...LIMITS.y)), r2(clamp(v[2], ...LIMITS.z))];
}
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// Op hygiene

/**
 * Contract-shaped, clamped ops. Drops invalid ops instead of throwing. With a world, also drops move/remove of ids
 * that don't exist, duplicate removes, and adds beyond the 40-object limit. Unknown fields (like `where`) never leak.
 */
export const MAX_OPS = 12; // app.mjs applies at most 12 ops per turn (normalizeResult); never hand it more

export function sanitizeOps(ops, world, { max = MAX_OPS } = {}) {
  if (!Array.isArray(ops)) return [];
  const w = world ? snapshot(world) : null;
  const ids = w ? new Set(w.objects.map((o) => o.id)) : null;
  let count = w ? w.objects.length : 0;
  const removed = new Set();
  const out = [];
  const str = (s, n) => (typeof s === 'string' ? cut(s, n) : '');
  // A resize is a remove followed by an add that carries `replaces: <removed id>`. The pair is atomic: both fit
  // or neither is emitted, so a cap can never delete an object without putting it back.
  const pairOf = (op, next) => op && op.type === 'remove' && next && next.type === 'add' && next.replaces != null
    && String(next.replaces) === String(op.id);

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (out.length >= max) break;
    if (!op || typeof op !== 'object') continue;
    if (pairOf(op, ops[k + 1])) {
      const id = str(op.id, 200);
      const ok = id && !removed.has(id) && (!ids || ids.has(id));
      if (!ok || out.length + 2 > max) { k++; continue; } // skip the whole pair
    } else if (op.type === 'add' && op.replaces != null) {
      // the other half of a pair whose remove was dropped: adding it would duplicate the object
      const rid = String(op.replaces);
      if (!removed.has(rid) && (!ids || ids.has(rid))) continue;
    }
    switch (op.type) {
      case 'add': {
        const name = str(op.name, LIMITS.name);
        if (!name) break;
        if (w && count >= LIMITS.maxObjects) break;
        const o = { type: 'add', name, description: str(op.description, LIMITS.description) || name };
        const p = clampPosition(op.position); if (p) o.position = p;
        const s = num(op.scale); if (Number.isFinite(s) && s > 0) o.scale = r2(clamp(s, ...LIMITS.scale));
        const ry = num(op.rotationY); if (Number.isFinite(ry)) o.rotationY = r2(ry);
        out.push(o); count++;
        break;
      }
      case 'move': {
        const id = str(op.id, 200); const p = clampPosition(op.position);
        if (!id || !p || (ids && (!ids.has(id) || removed.has(id)))) break;
        const o = { type: 'move', id, position: p };
        const ry = num(op.rotationY); if (Number.isFinite(ry)) o.rotationY = r2(ry);
        out.push(o);
        break;
      }
      case 'remove': {
        const id = str(op.id, 200);
        if (!id || removed.has(id) || (ids && !ids.has(id))) break;
        removed.add(id); out.push({ type: 'remove', id }); count = Math.max(0, count - 1);
        break;
      }
      case 'clear':
        if (out.some((x) => x.type === 'clear')) break;
        out.push({ type: 'clear' }); count = 0; if (ids) ids.clear();
        break;
      case 'mood': {
        const o = { type: 'mood' };
        if (PRESETS.includes(op.preset)) o.preset = op.preset;
        const fog = num(op.fog); if (Number.isFinite(fog)) o.fog = r2(clamp(fog, 0, 1));
        const glow = num(op.glow); if (Number.isFinite(glow)) o.glow = r2(clamp(glow, 0, 1));
        if (Object.keys(o).length > 1) out.push(o);
        break;
      }
      case 'guide': {
        const o = { type: 'guide' };
        const p = clampPosition(op.position); if (p) o.position = p;
        if (typeof op.mood === 'string' && op.mood.trim()) o.mood = cut(op.mood, 24);
        if (Object.keys(o).length > 1) out.push(o);
        break;
      }
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Voice-ready replies

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Strip markdown, emoji and stage directions; keep at most `maxSentences` sentences and `maxChars` characters. */
export function cleanReply(text, { maxSentences = 2, maxChars = 320 } = {}) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ')                 // code blocks
    .replace(/`([^`]*)`/g, '$1')                        // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')              // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // links -> text
    .replace(/https?:\/\/\S+/g, ' ')                    // bare urls
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                 // headings
    .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/gm, '')         // list bullets
    .replace(/(\*\*|__|\*|~~)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold / italic / strike
    .replace(EMOJI, '')
    .replace(/[*#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!s) return '';
  const sentences = s.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) || [s];
  let out = sentences.slice(0, Math.max(1, maxSentences)).join(' ').replace(/\s+/g, ' ').trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const sp = out.lastIndexOf(' ');
    out = (sp > maxChars * 0.6 ? out.slice(0, sp) : out).replace(/[,;:\s]+$/, '') + '.';
  }
  return out;
}

export default persona;
