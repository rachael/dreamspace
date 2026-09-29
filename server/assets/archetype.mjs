// Archetype asset provider: keyword matching onto the curated, hand-built models in src/world/archetypes.js.
// Instant, deterministic, needs no model. This is the main path: brains are told to prefer archetype names.
//
// How a request is matched (name first, description mostly for colour):
//  1. Exact archetype name ("tree-glow", "tree glow", "treeglow") wins outright.
//  2. Phrases beat single words, longest first ("crystal ball" -> orb, "floating rock" -> floating-island).
//  3. Only the HEAD noun of the name makes a strong match: the last content word before a preposition.
//     "crystal dragon" is a dragon, not a crystal, so it falls through to the parts provider.
//     Group heads ("cluster of crystals", "crystal formation") look at their members instead.
//  4. The description decides the archetype only when the name is generic ("thing", "gift"). Otherwise it only
//     supplies colour and variant: descriptions always say "glowing", "light", etc.
//  5. loose=true (used by index.mjs as the last resort before a plain wisp) accepts any weaker hit.

export const ARCHETYPES = [
  'crystal', 'crystal-cluster', 'floating-island', 'portal', 'lantern', 'tree-glow', 'mushroom-glow', 'rune-stone',
  'orb', 'planet', 'moon', 'spaceship', 'obelisk', 'waterfall-light', 'butterfly-swarm', 'wisp',
];
const ARCH_SET = new Set(ARCHETYPES);

// ---- lexicon -------------------------------------------------------------------------------------------------
// Keys are singular words or space-joined phrases. A value is an archetype, or [archetype, defaultColor] when the
// word implies a tint the speaker didn't say out loud ("campfire" is warm, "sapphire" is blue).
const WARM = '#f5b86b', GOLD = '#f5cf7a', PINK = '#f2a6cf', RED = '#e8707e', BLUE = '#6fa8ff', PALE = '#e4e9ff';
const LEX = {
  'crystal': ['crystal', 'gem', 'gemstone', 'jewel', 'shard', 'quartz', 'amethyst', 'sapphire', 'emerald', 'ruby',
    'diamond', 'topaz', 'citrine', 'opal', 'prism', 'mineral', 'birthstone', 'tourmaline', 'aquamarine', 'garnet',
    'crystal shard', 'power crystal', 'mana crystal', 'jewel stone'],
  'crystal-cluster': ['crystal cluster', 'geode', 'druse', 'crystal formation', 'crystal garden', 'crystal field',
    'crystal bed', 'gem cluster', 'crystal outcrop', 'crystal patch', 'crystal grove'],
  'floating-island': ['island', 'isle', 'islet', 'floating island', 'sky island', 'floating rock', 'flying island',
    'floating land', 'landmass', 'floating mountain', 'floating garden', 'floating meadow', 'archipelago', 'atoll',
    'mesa', 'floating platform', 'sky garden', 'floating isle', 'floating boulder', 'hanging garden', 'sky rock'],
  'portal': ['portal', 'gate', 'gateway', 'door', 'doorway', 'arch', 'archway', 'stargate', 'wormhole', 'rift',
    'vortex', 'torii', 'threshold', 'passage', 'warp', 'teleporter', 'mirror', 'ring', 'black hole', 'star gate',
    'moon gate', 'warp gate', 'magic mirror', 'dimensional rift', 'time portal', 'hole', 'entrance', 'tunnel'],
  'lantern': ['lantern', 'lamp', 'lamppost', 'lamp post', 'street lamp', 'streetlamp', 'street light', 'streetlight',
    'lightbulb', 'bulb', 'sconce', 'chandelier', 'paper lantern', 'sky lantern', 'jar', 'firefly jar', 'glowstick',
    'fairy light', 'string light', 'lighthouse',
    ['torch', WARM], ['candle', WARM], ['brazier', WARM], ['campfire', WARM], ['bonfire', WARM], ['fire', WARM],
    ['fireplace', WARM], ['hearth', WARM], ['flame', WARM], ['fire pit', WARM], ['candelabra', WARM]],
  'tree-glow': ['tree', 'sapling', 'willow', 'oak', 'pine', 'bonsai', 'shrub', 'bush', 'palm', 'birch', 'sequoia',
    'redwood', 'cypress', 'maple', 'elm', 'baobab', 'grove', 'forest', 'plant', 'vine', 'fern', 'tree of life',
    'world tree', 'yggdrasil', 'spirit tree', 'wishing tree', 'glowing tree',
    ['sakura', PINK], ['cherry blossom', PINK], ['cherry tree', PINK], ['blossom tree', PINK]],
  'mushroom-glow': ['mushroom', 'shroom', 'toadstool', 'fungus', 'fungi', 'mycelium', 'puffball', 'morel', 'spore',
    'glowcap', 'fairy ring', 'mushroom house', 'mushroom patch', 'mushroom ring',
    ['flower', PINK], ['bloom', PINK], ['blossom', PINK], ['lotus', PINK], ['lily', PALE], ['tulip', PINK],
    ['rose', RED], ['orchid', PINK], ['bluebell', BLUE], ['daisy', PALE], ['dandelion', GOLD], ['sunflower', GOLD]],
  'rune-stone': ['rune', 'runestone', 'rune stone', 'standing stone', 'stone', 'rock', 'boulder', 'menhir', 'dolmen',
    'megalith', 'tablet', 'stele', 'cairn', 'altar', 'shrine', 'tombstone', 'gravestone', 'headstone', 'pedestal',
    'plinth', 'waystone', 'stone circle', 'henge', 'stonehenge', 'glyph', 'sigil'],
  'orb': ['orb', 'sphere', 'ball', 'bubble', 'globe', 'pearl', 'marble', 'crystal ball', 'energy ball', 'light orb',
    'magic orb', 'core', 'power core', 'energy core', 'reactor', 'snow globe', 'egg', 'dragon egg', 'seed', 'moonstone',
    'scrying orb', 'wisp orb', ['sun', GOLD], ['star', GOLD], ['sunstone', GOLD], ['fireball', WARM]],
  'planet': ['planet', 'world', 'gas giant', 'exoplanet', 'ringed planet', 'planetoid', 'dwarf planet', 'earth',
    ['saturn', GOLD], ['jupiter', WARM], ['mars', RED], ['neptune', BLUE], ['uranus', '#8fe0e0'], ['venus', GOLD]],
  'moon': ['moon', 'luna', 'crescent', 'crescent moon', 'half moon', 'full moon', 'asteroid', 'meteor', 'meteorite',
    'moonlet', 'moon rock'],
  'spaceship': ['spaceship', 'ship', 'starship', 'spacecraft', 'space ship', 'craft', 'ufo', 'saucer',
    'flying saucer', 'rocket', 'shuttle', 'space shuttle', 'vessel', 'cruiser', 'fighter', 'frigate', 'freighter',
    'pod', 'escape pod', 'probe', 'drone', 'airship', 'sky ship', 'mothership', 'satellite', 'space station',
    'station', 'boat', 'lander', 'starfighter', 'zeppelin', 'blimp'],
  'obelisk': ['obelisk', 'monolith', 'pillar', 'column', 'spire', 'tower', 'needle', 'totem', 'pylon', 'beacon',
    'monument', 'antenna', 'transmitter', 'radio tower', 'minaret', 'crystal spire', 'watchtower', 'sundial',
    'lightning rod', 'mast'],
  'waterfall-light': ['waterfall', 'cascade', 'falls', 'fountain', 'spring', 'stream', 'river', 'light fall',
    'lightfall', 'falling light', 'light waterfall', 'rain of light', 'curtain of light', 'water', 'pool', 'pond',
    'geyser', 'wellspring', 'well'],
  'butterfly-swarm': ['butterfly', 'butterflies', 'moth', 'swarm', 'firefly', 'fireflies', 'dragonfly', 'bee', 'flock',
    'petal', 'lightning bug', 'glowbug', 'glow bug', 'flock of birds', 'butterfly swarm', 'firefly swarm', 'swarm of butterflies'],
  'wisp': ['wisp', 'will o wisp', 'will o the wisp', 'willowisp', 'spirit', 'ghost', 'sprite', 'fairy', 'pixie',
    'soul', 'spark', 'ember', 'phantom', 'apparition', 'familiar', 'shooting star', 'comet', 'jellyfish',
    'spirit light', 'light spirit', 'guardian spirit', 'nymph', 'djinn', 'genie', 'aurora wisp',
    ['firefly light', WARM]],
};

// Heads that mean "a bunch of X": look at the members instead ("a cluster of crystals", "a mushroom patch").
const GROUP_HEADS = new Set(['cluster', 'formation', 'field', 'patch', 'group', 'bunch', 'pile', 'bed', 'garden',
  'circle', 'ring', 'collection', 'heap', 'outcrop', 'outcropping', 'grove', 'swarm', 'cloud', 'flock', 'bouquet']);
// Group heads whose modifiers are the members too ("crystal formation", "mushroom patch"). A "crystal ring" is a
// ring, so ring/circle/cloud only take members from an "of" complement ("a ring of mushrooms").
const GROUP_PRE_OK = new Set(['cluster', 'formation', 'field', 'patch', 'group', 'bunch', 'pile', 'bed', 'garden',
  'collection', 'heap', 'outcrop', 'outcropping', 'grove', 'swarm', 'flock', 'bouquet']);
// Heads that say nothing about the object: then the description decides.
const GENERIC_HEADS = new Set(['thing', 'object', 'item', 'something', 'stuff', 'it', 'one', 'gift', 'surprise',
  'present', 'decoration', 'ornament', 'artifact', 'artefact', 'creation', 'sculpture', 'shape', 'structure',
  'piece', 'model', 'figure', 'form', 'prop', 'friend', 'companion', 'light', 'glow', 'magic', 'treasure', 'wonder']);
// Splitters: everything after one of these is a complement, not the head.
const PREPS = new Set(['of', 'with', 'made', 'from', 'in', 'on', 'at', 'for', 'under', 'over', 'near', 'beside',
  'by', 'full', 'that', 'which', 'where', 'holding', 'carrying', 'containing', 'filled', 'covered', 'into', 'above',
  'below', 'behind', 'inside', 'around', 'atop', 'upon', 'like', 'to', 'and', 'or', 'but', 'while', 'as']);
// Words skipped when finding the head (articles, sizes, moods, glow words, numbers).
const SKIP = new Set(['a', 'an', 'the', 'some', 'my', 'your', 'our', 'this', 'that', 'these', 'those', 'another',
  'small', 'tiny', 'little', 'mini', 'big', 'large', 'huge', 'giant', 'enormous', 'massive', 'tall', 'short', 'wide',
  'old', 'ancient', 'new', 'young', 'elder', 'glowing', 'glowy', 'glow', 'luminous', 'shimmering', 'shiny', 'shining',
  'sparkling', 'sparkly', 'softly', 'soft', 'bright', 'dim', 'dark', 'pale', 'deep', 'floating', 'hovering',
  'flying', 'drifting', 'magic', 'magical', 'mystic', 'mystical', 'mysterious', 'enchanted', 'cosmic', 'celestial',
  'ethereal', 'gentle', 'calm', 'serene', 'peaceful', 'dreamy', 'beautiful', 'pretty', 'cute', 'lovely', 'cozy',
  'sleepy', 'quiet', 'lonely', 'lone', 'single', 'twin', 'double', 'bioluminescent', 'radiant', 'lit', 'faint',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'few', 'several', 'many', 'more',
  'very', 'really', 'super', 'extra', 'kind', 'sort', 'please', 'just', 'here', 'there', 'now', 'sci', 'fi', 'scifi',
  'fantasy', 'futuristic', 'alien', 'space', 'sky', 'star', 'starry', 'moonlit', 'twilight', 'misty', 'foggy',
  'translucent', 'transparent', 'frosted', 'polished', 'carved', 'mossy', 'ornate', 'rustic', 'stone', 'crystal',
  'crystalline', 'wooden', 'metal', 'metallic', 'golden', 'silver', 'silvery', 'glass', 'glassy', 'neon', 'pastel',
  'shaped', 'style', 'styled', 'looking', 'themed']);
// NOTE: SKIP only affects head finding for words that are NOT the last content word. See headOf() below:
// material words like 'stone'/'crystal' are skipped only when a later non-skip word exists.

// ---- colours ------------------------------------------------------------------------------------------------
// Soft, twilight-friendly versions of colour words. Longest words are matched first via token lookup.
const COLOURS = {
  red: RED, crimson: '#e0677a', scarlet: '#e8707e', ruby: '#e0677a', cherry: '#e8788e', rose: '#f09ab0',
  pink: PINK, blush: '#f4b6c8', magenta: '#e38ad6', fuchsia: '#e38ad6', coral: '#f59a8a', salmon: '#f5a090',
  orange: '#f5a162', tangerine: '#f5a162', copper: '#d98f63', ember: '#f39a5c', rust: '#c97a5a', peach: '#f7b996',
  amber: '#f5b86b', gold: GOLD, golden: GOLD, honey: '#f2c46b', yellow: '#f2e27a', saffron: '#f5c55e', sunny: '#f5d77a',
  lemon: '#f0e68a', citrine: '#f2cf6b', topaz: '#f2c070', bronze: '#c9955e', brass: '#d6ae6a',
  green: '#7fd6a0', emerald: '#5fd49a', jade: '#6fcf9f', moss: '#8fb87a', mossy: '#8fb87a', lime: '#b5e67a',
  mint: '#9ff0c8', sage: '#a3c4a0', olive: '#a6b06a', verdant: '#7fd6a0', forest: '#5fa87a',
  teal: '#5fd4d0', turquoise: '#62dcd0', aqua: '#6fe6e0', cyan: '#7fe8ff', seafoam: '#8fe8cf', aquamarine: '#7fe6d6',
  blue: BLUE, azure: '#78b4ff', sapphire: '#5f8fff', cobalt: '#5f7fe8', cerulean: '#6fb0f0', sky: '#8cc4ff',
  ice: '#bfe6ff', icy: '#bfe6ff', frost: '#cfeaff', frosty: '#cfeaff',
  indigo: '#6b73d6', navy: '#4f5aa8', midnight: '#3b4580',
  violet: '#b48cff', purple: '#a57ff0', amethyst: '#b08cf5', lavender: '#c8b4ff', lilac: '#d0b0f5', plum: '#a86fc0',
  mauve: '#c49ac8', orchid: '#d69ae8',
  white: '#eef1ff', pearl: '#f1eef8', pearly: '#f1eef8', ivory: '#f6f0dc', snow: '#f4f7ff', snowy: '#f4f7ff',
  silver: '#c9d3e6', silvery: '#c9d3e6', platinum: '#d8dde8', grey: '#9aa3b8', gray: '#9aa3b8', ash: '#a0a4b0',
  black: '#2b2f4a', obsidian: '#2f2a45', onyx: '#2b2d3a', ebony: '#2e2a33', charcoal: '#3a3d4a',
  brown: '#a07a5a', chocolate: '#8a5f45', tan: '#c8a57a', sand: '#d8c49a', sandy: '#d8c49a',
  rainbow: '#d8c8ff', iridescent: '#d8c8ff', opal: '#e6dcff', opalescent: '#e6dcff', prismatic: '#d8c8ff',
  holographic: '#cfe0ff',
};
// Words that are colours only in some senses: "sky island", "forest", "star", "ice cream"... Only count these as
// colours when they directly precede another word we are describing (i.e. never when they are the head itself).
const WEAK_COLOURS = new Set(['sky', 'forest', 'snow', 'ice', 'sand', 'rose', 'cherry', 'honey', 'ember', 'rust',
  'moss', 'sage', 'olive', 'orchid', 'ash', 'lemon', 'peach', 'coral', 'opal', 'topaz', 'citrine', 'midnight',
  'chocolate', 'tan', 'amethyst', 'aquamarine']);

// ---- text utilities -----------------------------------------------------------------------------------------
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

function singular(w) {
  if (w.length <= 3) return w;
  if (/(ss|us|is|ous)$/.test(w)) return w;                 // glass, cactus, axis
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';   // fireflies -> firefly
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);     // torches -> torch, boxes -> box
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'f';  // elves -> elf (rare here)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return clean(text, 400).toLowerCase()
    .replace(/o'(the)?\s*/g, 'o $1 ')          // will-o'-the-wisp, will o' wisp
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

// Build the phrase index: phrase (singular tokens joined by space) -> {arch, color, len}.
const PHRASES = new Map();
let MAX_PHRASE = 1;
for (const [arch, list] of Object.entries(LEX)) {
  for (const entry of list) {
    const [word, color] = Array.isArray(entry) ? entry : [entry, undefined];
    const toks = tokenize(word).map(singular);
    const key = toks.join(' ');
    if (!PHRASES.has(key)) PHRASES.set(key, { arch, color, len: toks.length });
    MAX_PHRASE = Math.max(MAX_PHRASE, toks.length);
  }
}
// Exact archetype names in any spelling: "tree-glow", "tree glow", "treeglow".
const EXACT = new Map();
for (const a of ARCHETYPES) {
  EXACT.set(a, a); EXACT.set(a.replace(/-/g, ' '), a); EXACT.set(a.replace(/-/g, ''), a);
}

// Turn raw tokens into units: a unit is a lexicon phrase (longest first) or a single word.
function units(rawTokens) {
  const toks = rawTokens.map((w) => ({ raw: w, s: singular(w), plural: singular(w) !== w }));
  const out = [];
  for (let i = 0; i < toks.length;) {
    let hit = null;
    for (let n = Math.min(MAX_PHRASE, toks.length - i); n >= 1; n--) {
      const key = toks.slice(i, i + n).map((t) => t.s).join(' ');
      const p = PHRASES.get(key);
      if (p) { hit = { ...p, key, plural: toks[i + n - 1].plural, raw: toks.slice(i, i + n).map((t) => t.raw) }; break; }
    }
    if (hit) { out.push({ word: hit.key, match: hit, plural: hit.plural, raw: hit.raw }); i += hit.len; }
    else { out.push({ word: toks[i].s, match: null, plural: toks[i].plural, raw: [toks[i].raw] }); i += 1; }
  }
  return out;
}

// Split units at the first preposition. Returns {head, headIdx, pre, post}: head = last content unit before it.
function analyse(text) {
  const us = units(tokenize(text));
  let cut = us.findIndex((u, i) => i > 0 && !u.match && PREPS.has(u.word));
  if (cut < 0) cut = us.length;
  const pre = us.slice(0, cut), post = us.slice(cut + 1);
  // Head: the last unit in `pre` that is a lexicon match or not in SKIP. Material/colour adjectives in SKIP only
  // lose when a later word exists ("stone golem" -> golem, but "a stone" -> stone).
  let headIdx = -1;
  for (let i = pre.length - 1; i >= 0; i--) {
    const u = pre[i];
    if (u.match || !SKIP.has(u.word) || (i === pre.length - 1 && !isPureSkip(u.word))) { headIdx = i; break; }
  }
  if (headIdx < 0) { // every word was a skip word: take the last one that is a lexicon word ("a crystal")
    for (let i = pre.length - 1; i >= 0; i--) if (PHRASES.has(pre[i].word)) { headIdx = i; break; }
  }
  return { units: us, pre, post, head: headIdx >= 0 ? pre[headIdx] : null, headIdx };
}
// Skip words that can never be a head noun on their own (articles, sizes, moods).
function isPureSkip(w) { return SKIP.has(w) && !PHRASES.has(w); }

function lexOf(unit) {
  if (!unit) return null;
  if (unit.match) return unit.match;
  return PHRASES.get(unit.word) || null;
}

// Crystal words used as a group ("crystals", "a cluster of crystals") become the cluster archetype.
function pluralise(hit, plural) {
  if (hit && plural && hit.arch === 'crystal') return { ...hit, arch: 'crystal-cluster' };
  return hit;
}

// Strong match on one text (name, or description when the name is generic). Returns {arch, color, why} or null.
function strongMatch(text) {
  const a = analyse(text);
  const h = a.head;
  if (!h) return null;
  if (GROUP_HEADS.has(h.word)) {
    // "cluster of crystals" -> members after the preposition; "crystal formation" -> modifiers before the head.
    const members = [...a.post, ...(GROUP_PRE_OK.has(h.word) ? a.pre.slice(0, a.headIdx).reverse() : [])];
    for (const m of members) {
      const hit = lexOf(m);
      if (hit && !GROUP_HEADS.has(m.word)) return { ...pluralise(hit, true), why: `group "${h.word}" of "${m.word}"` };
    }
    // No members: "a swarm", "a ring", "a grove" still mean something on their own (below).
  }
  const hit = lexOf(h);
  if (hit) return { ...pluralise(hit, h.plural), why: `head "${h.word}"` };
  return null;
}

// Every hit anywhere, scored: name head-segment words 3, name complements 2, description words 1.
// Glow/light words never count from the description.
const DESC_IGNORE = new Set(['light', 'glow', 'spark', 'star', 'core', 'ring', 'world', 'water', 'stone', 'rock',
  'fire', 'flame', 'ember', 'bubble', 'spring', 'well', 'hole', 'station', 'craft', 'bed', 'field', 'garden', 'pool',
  'stream', 'passage', 'plant', 'seed', 'egg', 'jar', 'bulb', 'mirror', 'petal', 'spirit', 'soul', 'form']);
function looseMatch(name, description) {
  const score = new Map();
  const add = (hit, w, why) => {
    if (!hit) return;
    const cur = score.get(hit.arch) || { arch: hit.arch, color: hit.color, s: 0, why };
    cur.s += w; score.set(hit.arch, cur);
  };
  const n = analyse(name);
  n.pre.forEach((u) => add(pluralise(lexOf(u), u.plural), 3, `name word "${u.word}"`));
  n.post.forEach((u) => add(pluralise(lexOf(u), u.plural), 2, `name complement "${u.word}"`));
  const d = analyse(description);
  d.units.forEach((u) => { if (!DESC_IGNORE.has(u.word)) add(pluralise(lexOf(u), u.plural), 1, `description word "${u.word}"`); });
  let best = null;
  for (const v of score.values()) if (!best || v.s > best.s) best = v;
  return best ? { arch: best.arch, color: best.color, why: best.why } : null;
}

// Colour words -> {color, accent}. Name colours first, then description colours.
// Colours before a preposition, or after of/made/from ("a dragon of teal crystal"), describe the object itself.
// Colours after with/on/in/... describe a secondary part ("an orb on a brass stand", "a stone with cyan runes"):
// they only become the accent. With no primary colour, `color` stays unset so the renderer's own palette applies.
const MATERIAL_PREPS = new Set(['of', 'made', 'from']);
export function extractColours(name, description) {
  const primary = [], secondary = [];
  for (const text of [name, description]) {
    const toks = tokenize(text);
    let bucket = primary;
    toks.forEach((w, i) => {
      if (i > 0 && PREPS.has(w) && !MATERIAL_PREPS.has(w)) bucket = secondary;
      const hex = COLOURS[w];
      if (!hex) return;
      // Weak colour words count only as a modifier of a following word ("ice crystal", "rose quartz"), never alone.
      if (WEAK_COLOURS.has(w) && !(i + 1 < toks.length && !PREPS.has(toks[i + 1]))) return;
      // "sky island", "forest spirit", "sand dune" etc: skip when this word + next is a lexicon phrase.
      if (i + 1 < toks.length && PHRASES.has(`${singular(w)} ${singular(toks[i + 1])}`)) return;
      if (!primary.includes(hex) && !secondary.includes(hex)) bucket.push(hex);
    });
  }
  const color = primary[0];
  const accent = secondary[0] ?? primary[1];
  return { color, accent: accent !== color ? accent : undefined };
}

/** Colour words in order of appearance, as [{word, hex}] (unique hex, max 4). Used as a palette hint for LLMs. */
export function paletteWords(name, description) {
  const out = [];
  for (const text of [name, description]) {
    const toks = tokenize(text);
    toks.forEach((w, i) => {
      const hex = COLOURS[w];
      if (!hex || out.length >= 4 || out.some((o) => o.hex === hex)) return;
      if (WEAK_COLOURS.has(w) && !(i + 1 < toks.length && !PREPS.has(toks[i + 1]))) return;
      if (i + 1 < toks.length && PHRASES.has(`${singular(w)} ${singular(toks[i + 1])}`)) return;
      out.push({ word: w, hex });
    });
  }
  return out;
}

// FNV-1a: stable variant per (name, description) so the same request always looks the same.
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function build(arch, name, description, hintColor, why, strength) {
  const { color, accent } = extractColours(name, description);
  const params = { variant: hash32(`${name}|${description}`) % 4 };
  const c = color || hintColor;
  if (c) params.color = c;
  if (accent && accent !== c) params.accent = accent;
  const asset = { type: 'archetype', archetype: arch, params };
  // Non-enumerable debugging info: not serialised into the world, but visible to tests and logs.
  Object.defineProperty(asset, '_why', { value: `${strength}: ${why}`, enumerable: false });
  return asset;
}

/** Match a request onto an archetype. Returns an Asset or null. `loose` accepts weak hits (last-resort fallback). */
export function matchArchetype({ name = '', description = '' } = {}, { loose = false } = {}) {
  name = clean(name, 60).trim();
  description = clean(description, 300).trim();
  if (!name && !description) return null;
  const subject = name || description;

  // 1. Exact archetype name.
  const exact = EXACT.get(subject.toLowerCase().replace(/[^a-z]+/g, ' ').trim())
    || EXACT.get(subject.toLowerCase().replace(/[^a-z-]+/g, ''));
  if (exact) return build(exact, name, description, undefined, `exact name "${exact}"`, 'strong');

  // 2-3. Head noun of the name.
  const s = strongMatch(subject);
  if (s) return build(s.arch, name, description, s.color, s.why, 'strong');

  // 4. Generic name ("a gift", "something pretty"): let the description's head decide.
  const head = analyse(subject).head;
  if (name && description && (!head || GENERIC_HEADS.has(head.word))) {
    const d = strongMatch(description);
    if (d) return build(d.arch, name, description, d.color, `generic name, description ${d.why}`, 'strong');
  }

  // 5. Loose: any hit, scored.
  if (loose) {
    const l = looseMatch(name, description);
    if (l) return build(l.arch, name, description, l.color, l.why, 'loose');
  }
  return null;
}

/** Last resort: a wisp tinted by any colour words, so even the fallback feels intentional. */
export function wispFor({ name = '', description = '' } = {}) {
  return build('wisp', clean(name, 60), clean(description, 300), undefined, 'fallback wisp', 'fallback');
}

export function isArchetype(name) { return ARCH_SET.has(name); }

export default {
  name: 'archetype',
  available: async () => true,
  generate: async ({ name, description } = {}) => matchArchetype({ name, description }),
};
