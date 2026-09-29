// Scripted brain: the offline guide. No model, no network: keyword rules over a small lexicon, so the whole app
// demos anywhere. It understands every archetype (plus synonyms), counts ("three trees"), sizes and colours,
// placement ("next to me", "in the sky", "next to the portal"), remove / move / resize / undo / clear, mood presets
// and tweaks ("darker", "foggier"), little scenes ("make a forest"), questions about the world, and small talk.
//
// It also exports its language helpers (wantsClear, detectMood, archOfText, findObjects, ...) so the ollama brain
// can use the same rules to guard a small model's output.

import {
  ARCHETYPES, ARCH_INFO, MOOD_PRESETS, PRESETS, LIMITS, GUIDE_NAME,
  snapshot, objectArchetype, spokenName, relDirection, article, spokenList, wherePosition, clampPosition,
  sanitizeOps, cleanReply,
} from './persona.mjs';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r2 = (n) => Math.round(n * 100) / 100;
const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numWord = (n) => NUM_WORDS[n] || String(n);

// ---------------------------------------------------------------------------------------------------------------
// Text normalisation

const EXPAND = [
  [/\bwhat's\b/g, 'what is'], [/\bwhere's\b/g, 'where is'], [/\bwho's\b/g, 'who is'], [/\bhow's\b/g, 'how is'],
  [/\bthat's\b/g, 'that is'], [/\bthere's\b/g, 'there is'], [/\bhere's\b/g, 'here is'], [/\bit's\b/g, 'it is'],
  [/\blet's\b/g, 'let us'], [/\bi'm\b/g, 'i am'], [/\bi'd\b/g, 'i would'], [/\bi've\b/g, 'i have'],
  [/\bi'll\b/g, 'i will'], [/\byou're\b/g, 'you are'], [/\bcan't\b/g, 'cannot'], [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'], [/\bwon't\b/g, 'will not'], [/\bisn't\b/g, 'is not'], [/\baren't\b/g, 'are not'],
  [/\bwhat're\b/g, 'what are'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'], [/\bwanna\b/g, 'want to'],
  [/\bgimme\b/g, 'give me'], [/\bpls\b|\bplz\b/g, 'please'], [/\bu\b/g, 'you'],
];

/** Lowercase, expand contractions, strip symbols. Keeps .,!?;: so clauses can be split. */
export function normalize(text) {
  let t = String(text ?? '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/&/g, ' and ');
  for (const [re, s] of EXPAND) t = t.replace(re, s);
  return t.replace(/'s\b/g, '').replace(/[-_/]+/g, ' ').replace(/[^a-z0-9?.!,;: ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const singular = (w) => (/ies$/.test(w) && w.length > 4 ? w.slice(0, -3) + 'y'
  : /(ches|shes|xes|sses)$/.test(w) ? w.slice(0, -2)
    : /[^su]s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w);
const words = (s) => (String(s ?? '').toLowerCase().match(/[a-z]+/g) || []).map(singular).filter((w) => w.length > 2);

// ---------------------------------------------------------------------------------------------------------------
// Lexicon: every archetype and its everyday synonyms (longest match wins, so phrases beat single words)

const L = (arch, alts) => ({ arch, re: new RegExp(`\\b(?:${alts})\\b`, 'g') });
export const LEXICON = [
  L('crystal-cluster', 'crystal ?clusters?|crystal (?:gardens?|formations?|beds?|fields?|patch(?:es)?|groves?)|clusters? of (?:crystals?|gems?)|gem clusters?|geodes?|druses?'),
  L('floating-island', 'floating ?islands?|(?:sky|flying|hovering) (?:islands?|isles?|rocks?)|floating (?:isles?|rocks?|islets?)|islands?|isles?|islets?'),
  L('butterfly-swarm', 'butterfly ?swarms?|(?:swarms?|clouds?|flocks?) of (?:butterfl(?:y|ies)|moths?)|butterfl(?:y|ies)|moths?|dragonfl(?:y|ies)'),
  L('waterfall-light', 'waterfall ?lights?|waterfalls? of light|light ?falls?|light waterfalls?|waterfalls?|water falls?|cascades?|fountains?'),
  L('rune-stone', 'rune ?stones?|standing stones?|runes?|menhirs?|boulders?|stones?'),
  L('spaceship', 'space ?ships?|star ?ships?|rocket ?ships?|flying saucers?|space ?crafts?|ufos?|saucers?|rockets?|shuttles?|ships?'),
  L('mushroom-glow', 'mushroom ?glows?|glowing mushrooms?|mushrooms?|shrooms?|toadstools?|fungus|fungi'),
  L('tree-glow', 'tree ?glows?|glowing trees?|cherry blossoms?|trees?|saplings?|willows?|oaks?|sakuras?|bonsais?'),
  L('lantern', 'paper lanterns?|sky lanterns?|lanterns?|lamp ?posts?|lamps?|candles?|torch(?:es)?|fairy lights|string lights'),
  L('orb', 'crystal balls?|orbs?|spheres?|balls?|bubbles?|globes?'),
  L('crystal', 'crystals?|gemstones?|gems?|shards?|jewels?|diamonds?|amethysts?|quartz'),
  L('portal', 'portals?|star ?gates?|gateways?|gates?|doorways?|doors?|rifts?|wormholes?|vortex(?:es)?|vortices'),
  L('planet', 'gas giants?|ringed planets?|planets?|saturn|jupiter|neptune'),
  L('moon', 'moons?|luna|crescents?'),
  L('obelisk', 'obelisks?|monoliths?|pillars?|columns?|spires?|towers?|totems?|monuments?'),
  L('wisp', 'will o (?:the )?wisps?|wisps?|spirits?|fair(?:y|ies)|sprites?|pixies?|firefl(?:y|ies)|ghosts?'),
];
const COLLECTIVE = new Set(['butterfly-swarm']); // "butterflies" means one swarm

/** All non-overlapping lexicon hits in a string: [{arch, text, index, end, plural}]. */
function lexHits(s) {
  const all = [];
  LEXICON.forEach((e, order) => {
    e.re.lastIndex = 0;
    for (let m; (m = e.re.exec(s));) all.push({ arch: e.arch, text: m[0], index: m.index, end: m.index + m[0].length, order });
  });
  all.sort((a, b) => (b.end - b.index) - (a.end - a.index) || a.order - b.order);
  const taken = [];
  for (const h of all) if (!taken.some((t) => h.index < t.end && t.index < h.end)) taken.push(h);
  taken.sort((a, b) => a.index - b.index);
  for (const h of taken) {
    const last = h.text.split(' ').pop();
    h.plural = /(?:s|ies|i)$/.test(last) && !/^(?:fungus|quartz|luna|saturn|glass|moss|ghostess)$/.test(last) && !/ of /.test(h.text)
      || /^(?:clusters|swarms|clouds|flocks) of/.test(h.text);
  }
  return taken;
}

/** The set of archetypes an utterance mentions ("get rid of the crystals" -> {crystal}). */
export function archesIn(text) {
  return new Set(lexHits(normalize(text)).map((h) => h.arch));
}

/** The archetype a free-text name/description most likely means, or null. */
export function archOfText(text) {
  const t = normalize(text);
  const key = t.replace(/\s+/g, '-');
  if (ARCH_INFO[key]) return key;
  const hits = lexHits(t);
  return hits.length ? hits[hits.length - 1].arch : null; // the head noun is usually last
}

// ---------------------------------------------------------------------------------------------------------------
// Adjectives: size, colour and everything else worth keeping in a description

const SIZE = {
  huge: 2.2, giant: 2.2, enormous: 2.4, massive: 2.4, gigantic: 2.4, colossal: 2.6, humongous: 2.4,
  big: 1.6, bigger: 1.8, large: 1.6, larger: 1.8, tall: 1.5, towering: 2, grand: 1.6,
  small: 0.6, smaller: 0.6, little: 0.6, baby: 0.5, tiny: 0.4, mini: 0.4, miniature: 0.4, wee: 0.45, teeny: 0.35,
};
const COLORS = new Set(['red', 'crimson', 'scarlet', 'ruby', 'orange', 'amber', 'gold', 'golden', 'yellow', 'green',
  'emerald', 'jade', 'mint', 'lime', 'teal', 'cyan', 'aqua', 'turquoise', 'blue', 'azure', 'sapphire', 'cobalt',
  'indigo', 'violet', 'purple', 'lilac', 'lavender', 'magenta', 'pink', 'rose', 'rosy', 'white', 'silver', 'pearl',
  'black', 'obsidian', 'opal', 'rainbow', 'copper', 'bronze', 'peach', 'coral', 'ivory']);
const ADJ = new Set(['glowing', 'shimmering', 'sparkling', 'sparkly', 'shiny', 'ancient', 'old', 'magic', 'magical', 'mystic',
  'mystical', 'floating', 'flying', 'friendly', 'cute', 'sleepy', 'gentle', 'soft', 'bright', 'dark', 'luminous', 'radiant',
  'ethereal', 'beautiful', 'pretty', 'lovely', 'cool', 'neon', 'cosmic', 'celestial', 'enchanted', 'dreamy', 'fluffy']);
const DETERMINERS = new Set(['a', 'an', 'the', 'that', 'this', 'those', 'these', 'my', 'our', 'your', 'some',
  'another', 'any', 'every', 'all', 'each', 'both', 'more', 'of', 'few', 'couple', 'pair', 'lot', 'lots', 'bunch',
  'handful', 'several', 'many', 'loads', 'plenty', 'dozen', 'extra', 'other', 'one', 'new', 'just']);
const COUNTS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  another: 1, single: 1, couple: 2, pair: 2, both: 2, few: 3, some: 3, several: 4, handful: 4, many: 5, lots: 5,
  lot: 5, bunch: 5, loads: 5, plenty: 5, dozen: 6 };
const BOUNDARY = new Set(['add', 'summon', 'create', 'make', 'build', 'spawn', 'conjure', 'place', 'put', 'bring',
  'give', 'show', 'grow', 'plant', 'open', 'light', 'launch', 'land', 'want', 'like', 'have', 'get', 'see', 'need',
  'remove', 'delete', 'move', 'send', 'me', 'us', 'you', 'please', 'and', 'then', 'with', 'to', 'in', 'on', 'at',
  'by', 'near', 'next', 'beside', 'above', 'over', 'under', 'behind', 'around', 'for', 'is', 'are', 'there', 'be',
  'can', 'could', 'would', 'will', 'i', 'we', 'it', 'let', 'rid', 'banish', 'erase', 'take', 'away', 'how', 'what',
  'about', 'where', 'any', 'into', 'from']);
const FILLER_AFTER = new Set(['please', 'now', 'here', 'there', 'for', 'with', 'to', 'in', 'on', 'at', 'by', 'near',
  'next', 'beside', 'above', 'over', 'under', 'behind', 'around', 'into', 'onto', 'and', 'then', 'too', 'also',
  'again', 'of', 'that', 'which', 'so', 'as', 'from', 'the', 'a', 'an', 'me', 'you', 'us', 'it', 'them', 'today',
  'tonight', 'right', 'left', 'up', 'down', 'away', 'far', 'closer', 'glowing', 'light', 'lights', 'glow', 'bigger',
  'smaller', 'thanks', 'ok', 'okay', 'instead', 'somewhere', 'anywhere', 'everywhere', 'really', 'quickly', 'slowly',
  'softly', 'yeah', 'one', 'ones', 'well', 'just', 'for', 'if', 'or', 'but', 'is', 'are', 'was', 'be', 'floating',
  'sky', 'overhead', 'nearby', 'ahead', 'behind', 'thank', 'more', 'all', 'everything']);

/** Count, size, colour, definiteness and other adjectives from the words just before a noun. */
function modifiers(before) {
  const toks = before.trim().split(' ').filter(Boolean);
  const win = [];
  for (let i = toks.length - 1; i >= 0 && win.length < 5; i--) {
    if (BOUNDARY.has(toks[i]) && !COUNTS[toks[i]]) break;
    win.unshift(toks[i]);
  }
  let count = null, scale = null, color = null, determiner = null, countWord = null;
  const adjs = [];
  for (const w of win) {
    if (/^\d+$/.test(w)) { count = Math.max(1, Math.min(10, Number(w))); countWord = w; }
    else if (COUNTS[w] && w !== 'one') { count = COUNTS[w]; countWord = w; }
    else if (w === 'one' && count == null) { count = 1; countWord = w; }
    if (DETERMINERS.has(w) || /^\d+$/.test(w)) { if (!determiner && !['of', 'more'].includes(w)) determiner = w; continue; }
    if (w === 'a' || w === 'an') continue;
    if (SIZE[w]) { scale = SIZE[w]; adjs.push(w); continue; }
    if (COLORS.has(w)) { color = color ? `${color} and ${w}` : w; continue; }
    if (w.length > 2 && adjs.length < 3) adjs.push(w);
  }
  if (count == null && win.some((w) => w === 'a' || w === 'an')) { count = 1; determiner = determiner || 'a'; }
  const definite = ['the', 'that', 'this', 'those', 'these', 'my', 'our', 'your'].includes(determiner);
  return { count, countWord, scale, color, adjs, determiner, definite, all: win.includes('all') || win.includes('every') || win.includes('both') };
}

// ---------------------------------------------------------------------------------------------------------------
// Descriptions and speech per archetype

const ARCH_TALK = {
  'crystal':         { d: ['a {a}{c} crystal humming with a soft inner light', 'a {a}tall {c} crystal that glows gently from within'], c: 'teal', v1: ['hums up out of the ground', 'rises, humming softly'], vN: ['hum up out of the ground', 'rise, humming softly'], f: ['Listen closely, it sings.', 'It glows a little brighter when you look at it.'] },
  'crystal-cluster': { d: ['a {a}cluster of {c} crystals glowing gently from within'], c: 'cyan and violet', v1: ['blooms from the ground', 'grows up in a quiet burst'], vN: ['bloom from the ground', 'grow up in quiet bursts'], f: ['They catch the light like frozen music.'] },
  'floating-island': { d: ['a {a}small floating island of mossy stone trailing {c} glowing vines'], c: 'blue', v1: ['drifts into view', 'rises and hangs in the air'], vN: ['drift into view', 'rise and hang in the air'], f: ['Someday we could visit.', 'The vines are waving at you.'] },
  'portal':          { d: ['a {a}shimmering {c} portal ringed with slowly drifting runes'], c: 'violet', v1: ['swirls open', 'opens with a soft hum'], vN: ['swirl open', 'open with a soft hum'], f: ['I wonder where it leads.', "Don't worry, it only goes somewhere nice."] },
  'lantern':         { d: ['a {a}paper lantern glowing a warm {c}'], c: 'amber', v1: ['flickers to life', 'lights up and bobs gently'], vN: ['flicker to life', 'light up and bob gently'], f: ['A little warmth for the night.'] },
  'tree-glow':       { d: ['a {a}slender tree with luminous {c} leaves that softly pulse'], c: 'teal', v1: ['unfurls its leaves', 'grows up, leaf by shining leaf'], vN: ['unfurl their leaves', 'grow up, leaf by shining leaf'], f: ['Its leaves breathe with the light.'] },
  'mushroom-glow':   { d: ['a {a}cluster of bioluminescent {c} mushrooms'], c: 'blue', v1: ['sprouts up from the moss', 'pops up with a soft little sigh'], vN: ['sprout up from the moss', 'pop up with soft little sighs'], f: ['They glow brighter when you come close.'] },
  'rune-stone':      { d: ['a {a}mossy standing stone carved with softly glowing {c} runes'], c: 'cyan', v1: ['rises, its runes waking up', 'rises from the earth'], vN: ['rise, their runes waking up', 'rise from the earth'], f: ['The runes are very old, and very kind.'] },
  'orb':             { d: ['a {a}floating orb of {c} light'], c: 'pale blue', v1: ['blinks into being', 'glows into being'], vN: ['blink into being', 'glow into being'], f: ['It likes you, I think.'] },
  'planet':          { d: ['a {a}distant ringed planet in dusky {c} and gold'], c: 'violet', v1: ['rolls into the sky', 'rises into the sky'], vN: ['roll into the sky', 'rise into the sky'], f: ['Look at those rings.'] },
  'moon':            { d: ['a {a}pale {c} moon with softly glowing craters'], c: 'silver', v1: ['rises', 'drifts up'], vN: ['rise', 'drift up'], f: ["It's watching over us."] },
  'spaceship':       { d: ['a {a}sleek {c} starship humming with soft blue light'], c: 'silver', v1: ['glides in and hovers', 'drifts down and hovers'], vN: ['glide in and hover', 'drift down and hover'], f: ['No one aboard, just starlight.'] },
  'obelisk':         { d: ['a {a}tall dark obelisk traced with glowing {c} lines'], c: 'violet', v1: ['rises in silence', 'rises, humming low'], vN: ['rise in silence', 'rise, humming low'], f: ['It hums if you stand close.'] },
  'waterfall-light': { d: ['a {a}waterfall of falling {c} light'], c: 'turquoise', v1: ['begins to pour', 'spills down from nowhere'], vN: ['begin to pour', 'spill down from nowhere'], f: ['It never runs out.'] },
  'butterfly-swarm': { d: ['a {a}swarm of glowing {c} butterflies'], c: 'blue', v1: ['flutters in', 'drifts in on the breeze'], vN: ['flutter in', 'drift in on the breeze'], f: ['Hold still and they might land on you.'] },
  'wisp':            { d: ['a {a}tiny drifting wisp of {c} light'], c: 'pale green', v1: ['drifts in to say hello', 'blinks awake'], vN: ['drift in to say hello', 'blink awake'], f: ['A new friend for me.'] },
};

function describeNew(arch, { color, adjs = [] } = {}) {
  const t = ARCH_TALK[arch];
  const a = adjs.length ? adjs.join(' ') + ' ' : '';
  const d = pick(t.d).replace('{a}', a).replace('{c}', color || t.c).replace(/\s+/g, ' ').trim();
  return d.replace(/^a (?=[aeiou])/, 'an ');
}

function describeUnknown(noun, { color, adjs = [] } = {}) {
  const a = adjs.filter((w) => !noun.includes(w));
  const phrase = [...a, color, noun].filter(Boolean).join(' ');
  const d = color ? `${phrase} with a soft glow, calm and dreamlike` : `${phrase}, glowing softly in teal and violet tones`;
  return `${article(phrase)} ${d}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Mood

const PRESET_RE = {
  aurora: /\b(auroras?|northern lights|southern lights|borealis|australis|polar lights)\b/,
  starfall: /\b(starfall|shooting stars?|falling stars?|meteor showers?|meteors|starry|stars|starlight|star ?lit|night sky|snow|snowy|snowing|snowfall|galaxy|milky way|cosmos|nighttime|night time|midnight|night)\b/,
  deepsea: /\b(deep ?sea|deep ocean|oceans?|underwater|under the sea|under water|undersea|sea|seas|abyss|abyssal|aquatic|reef|coral|mermaids?|atlantis)\b/,
  dawn: /\b(dawn|sunrise|sun rise|morning|daybreak|daytime|day time|daylight|sunny|sunshine|golden hour|make it day)\b/,
  twilight: /\b(twilight|dusk|sunset|evening|gloaming|back to normal|normal again|default (sky|mood|look)|original (sky|mood|look)|reset the (sky|mood|lighting|lights))\b/,
};
const ADJUST = [
  { key: 'darker', re: /\b(darker|darken|dimmer|dim (the )?(lights?|sky|world|glow)|turn (the lights |it )?down|lights? down|less (bright|glowy|glow|light)|moodier|make (it|everything) (dark|dim)|too bright)\b/, glow: -0.2, fog: 0.05 },
  { key: 'brighter', re: /\b(brighter|brighten|lighter|light (it |things |everything )?up|more (light|glow)|glowier|glow more|turn (the lights |it )?up|lights? (up|on)|make (it|everything) (bright|light|glow|glowy)|too dark|cannot see)\b/, glow: 0.2, fog: -0.05 },
  { key: 'foggier', re: /\b(foggier|mistier|hazier|more (fog|mist|haze)|add (some )?(fog|mist|haze)|make (it|everything) (foggy|misty|hazy)|fog (it )?up|cloudier|rain|rainy|raining)\b/, fog: 0.25 },
  { key: 'clearer', re: /\b(less (fog|mist|haze)|clear (up |away |out )?(the |some |that )?(fog|mist|haze|air|sky|skies|clouds)|no (more )?(fog|mist)|(remove|lift|get rid of) the (fog|mist|haze)|defog|clearer)\b/, fog: -0.25 },
  { key: 'lightsoff', re: /\b(turn|switch) (off|out) the lights?\b|\b(turn|switch) the lights? (off|out)\b|\blights (off|out)\b|\bpitch black\b/, glow: -0.45 },
  { key: 'spooky', re: /\b(spooky|spookier|eerie|eerier|creepy|mysterious|haunted)\b/, fog: 0.3, glow: -0.15 },
  { key: 'calmer', re: /\b(calmer|cozier|cosier|softer|gentler|more (calm|cozy|cosy|peaceful|relaxing|soothing)|make (it|everything) (calm|cozy|cosy|peaceful|relaxing|soothing|soft))\b/, fog: 0.1, glow: -0.1 },
  { key: 'magical', re: /\b(more magical|dreamier|sparklier|more sparkl\w*|more enchanted)\b/, glow: 0.15 },
];
const MOOD_SCOPE = /\b(make|turn|change|switch|set|shift|bring)\b.{0,25}\b(it|everything|things|the (sky|world|scene|place|lights?|lighting|mood|atmosphere|vibe|air))\b|\b(sky|lighting|mood|atmosphere|vibe)\b/;
const PRESET_PHRASE = {
  twilight: ['the sky settles back into deep twilight', 'our teal and violet twilight returns'],
  aurora: ['ribbons of aurora ripple across the sky', 'the aurora wakes up overhead'],
  starfall: ['stars begin to fall, slow and silent', 'the sky fills with slowly falling stars'],
  deepsea: ['the world sinks into a deep sea hush', 'everything drifts down into the deep sea'],
  dawn: ['the sky warms into a gentle dawn', 'a soft peach dawn spreads across the sky'],
};
const ADJUST_PHRASE = {
  darker: 'the light dims a little', lightsoff: 'the lights sink down low, just the glow of the world left', brighter: 'everything glows a little brighter', foggier: 'a soft mist rolls in',
  clearer: 'the mist thins away', spooky: 'the shadows deepen, just a little', calmer: 'everything softens',
  magical: 'the air starts to sparkle',
};

/**
 * Mood intent of an utterance: { op, phrase, keys } or null. Clauses that are really about an object ("a dark
 * obelisk") only count when they clearly address the sky or "it". Exported for the ollama guard.
 */
export function detectMood(text, world, { clauses } = {}) {
  const w = snapshot(world);
  const parts = clauses || splitClauses(stripGreeting(normalize(text)));
  let preset = null, fog = 0, glow = 0, rain = false;
  const keys = [];
  for (const c of parts) {
    const objecty = lexHits(c).length > 0 && !MOOD_SCOPE.test(c);
    if (objecty) continue;
    if (!preset) for (const p of PRESETS) if (PRESET_RE[p].test(c)) { preset = p; break; }
    for (const a of ADJUST) if (a.re.test(c) && !keys.includes(a.key)) {
      keys.push(a.key); fog += a.fog || 0; glow += a.glow || 0;
      if (a.key === 'foggier' && /\brain/.test(c)) rain = true;
    }
  }
  if (!preset && !keys.length) return null;
  const base = preset ? MOOD_PRESETS[preset] : w.mood;
  const op = { type: 'mood' };
  if (preset) op.preset = preset;
  if (preset || fog) op.fog = r2(clamp(base.fog + fog, 0, 1));
  if (preset || glow) op.glow = r2(clamp(base.glow + glow, 0.05, 1));
  const bits = [];
  if (preset) bits.push(pick(PRESET_PHRASE[preset]));
  for (const k of keys) bits.push(k === 'foggier' && rain ? "there's no rain here, but a soft mist rolls in" : ADJUST_PHRASE[k]);
  return { op, phrase: joinPhrases(bits.slice(0, 2)), keys, preset };
}

// ---------------------------------------------------------------------------------------------------------------
// Clear

/** True when the user wants every object gone ("clear everything", "start over"), not "clear the fog". */
export function wantsClear(text) {
  let t = normalize(text);
  t = t.replace(/\bclear(ing)? (up |away |out )?(the |some |that |this )?(fog|mist|haze|air|sky|skies|clouds?|weather|view)\b/g, ' ')
    .replace(/\breset the (sky|mood|lighting|lights|colou?rs?|fog|glow)\b/g, ' ');
  if (/\b(start (over|again|fresh|afresh)|fresh start|clean slate|blank slate|from scratch|begin again)\b/.test(t)) return true;
  if (/\b(clear|wipe|reset|empty|clean)( out| up| away)?( it all| everything| all( of it)?| the (whole )?(world|scene|space|place|room|area|board|objects)| this (world|scene|place|space))\b/.test(t)) return true;
  if (/^(please )?(clear|reset|wipe|clean up|clear it|clear all)( it)?( please| now)?[.!]*$/.test(t)) return true;
  if (/\bmake (everything|it all|all of (it|this|them)) (disappear|vanish|go away)\b/.test(t)) return true;
  const m = /\b(remove|delete|get rid of|destroy|erase|banish|vanish|take away|clear away|dismiss)( all( of)?( the)?( objects?| things?| stuff)?| everything| every (thing|object)| it all)\b/.exec(t);
  if (m) {
    const after = t.slice(m.index + m[0].length).trim().split(/[ ,.!?]/)[0] || '';
    if (/everything|it all|objects?|things?|stuff/.test(m[0]) || !after || /^(and|then|please|now|so|here|at|in|from)$/.test(after)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Finding objects the user refers to

const newestFirst = (objs) => [...objs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || objs.indexOf(b) - objs.indexOf(a));

/** Objects matching a noun phrase or archetype, newest first. Colour words narrow the match when they can. */
export function findObjects(world, { arch = null, noun = '', color = null } = {}) {
  const w = snapshot(world);
  const nounWords = words(noun).filter((x) => !['glowing', 'light', 'thing'].includes(x));
  let hits = w.objects.filter((o) => {
    if (arch && (objectArchetype(o) === arch || archOfText(o.name) === arch)) return true;
    if (!nounWords.length) return false;
    const nameWords = new Set(words(`${o.name}`));
    return nounWords.some((x) => nameWords.has(x));
  });
  if (!hits.length && nounWords.length) {
    hits = w.objects.filter((o) => { const d = new Set(words(o.description)); return nounWords.every((x) => d.has(x)); });
  }
  if (color && hits.length > 1) {
    const cw = color.split(' and ');
    const tinted = hits.filter((o) => cw.some((c) => String(o.description).toLowerCase().includes(c)));
    if (tinted.length) hits = tinted;
  }
  return newestFirst(hits);
}

function newestBatch(objs) {
  if (!objs.length) return [];
  const sorted = newestFirst(objs);
  const t0 = sorted[0].createdAt || 0;
  return t0 ? sorted.filter((o) => t0 - (o.createdAt || 0) < 2500) : [sorted[0]];
}

// ---------------------------------------------------------------------------------------------------------------
// Placement

const WHERE_RE = [
  ['around_user', /\b(all )?around (me|us)\b|\bsurround(ing)? (me|us)\b/],
  ['beside_user', /\b(next to|beside|by|near|close to|right by) (me|us)\b|\bnearby\b|\bright here\b|\bover here\b|\bhere\b|\bcloser\b|\bcome here\b|\bto me\b/],
  ['above_user', /\b(above|over) (me|us|my head)\b|\boverhead\b|\bon top of me\b/],
  ['sky', /\b(in|into|up in|across) the sky\b|\bsky\b|\bup high\b|\bheavens\b|\bamong the stars\b/],
  ['far', /\bfar (away|off|out)?\b|\bin the distance\b|\bdistance\b|\bhorizon\b|\bfarther\b|\bfurther\b|\baway from (me|us)\b/],
  ['behind_user', /\bbehind (me|us)\b|\bat my back\b/],
  ['left', /\b(to|on|at) (my|the) left\b|\bleft of me\b|\bleft side\b/],
  ['right', /\b(to|on|at) (my|the) right\b|\bright of me\b|\bright side\b/],
  ['in_front', /\bin front( of (me|us))?\b|\bahead\b|\bbefore me\b/],
];
const ANCHOR_RE = /\b(next to|beside|by|near|around|behind|in front of|on top of|on|above|over|under|below) (the|that|this|my|our) ([a-z]+(?: [a-z]+)?)/;
const GUIDE_ANCHOR_RE = /\b(next to|beside|by|near|with|around) you\b/;

/** Every placement an utterance names (e.g. {'sky'}), for the ollama brain to trust over the model's guess. */
export function wheresIn(text) {
  const t = normalize(text).replace(ANCHOR_RE, ' ').replace(GUIDE_ANCHOR_RE, ' ');
  return new Set(WHERE_RE.filter(([, re]) => re.test(t)).map(([k]) => k));
}

/** The scale implied by size words ("a huge moon" -> 2.2), or null. */
export function sizeOf(text) {
  for (const w of normalize(text).split(' ')) if (SIZE[w]) return SIZE[w];
  return null;
}

function whereOf(clause) {
  for (const [k, re] of WHERE_RE) if (re.test(clause)) return k;
  return null;
}

function kindOf(arch) { return arch ? ARCH_INFO[arch].kind : 'ground'; }

/** Find an existing object named in an anchor phrase ("next to the portal"). */
function anchorOf(clause, world) {
  const g = GUIDE_ANCHOR_RE.exec(clause);
  if (g) return { rel: g[1], guide: true, span: g[0], pos: world.guide?.position || [-0.6, 1.4, -1] };
  const m = ANCHOR_RE.exec(clause);
  if (!m) return null;
  const phrase = m[3];
  const hit = lexHits(phrase)[0];
  const found = findObjects(world, { arch: hit?.arch, noun: hit ? hit.text : phrase.split(' ')[0] });
  if (!found.length) return null;
  const span = hit ? clause.slice(m.index, m.index + m[0].length - phrase.length + hit.end) : m[0];
  return { rel: m[1], obj: found[0], span, pos: found[0].position };
}

function anchoredPosition(anchor, i, n, kind) {
  const [x, y, z] = anchor.pos || [0, 0, -3];
  const ground = kind === 'ground';
  const baseY = ground ? 0 : Math.max(1.1, y);
  switch (anchor.rel) {
    case 'on top of': case 'on': return clampPosition([x + (i - (n - 1) / 2) * 0.5, y + 0.6 + 0.2 * i, z]);
    case 'above': case 'over': return clampPosition([x + (i - (n - 1) / 2) * 0.6, y + 2 + 0.3 * i, z]);
    case 'under': case 'below': return clampPosition([x + (i - (n - 1) / 2) * 0.8, 0, z]);
    case 'behind': return clampPosition([x + (i - (n - 1) / 2) * 1.2, baseY, z - 1.6]);
    case 'in front of': return clampPosition([x + (i - (n - 1) / 2) * 1.2, baseY, z + 1.4]);
    case 'around': {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      return clampPosition([x + Math.sin(a) * 1.6, baseY, z + Math.cos(a) * 1.6]);
    }
    default: { // next to / beside / by / near / with
      if (anchor.guide) return clampPosition([x + 0.5 + 0.5 * i, Math.max(0.9, y - 0.2), z + 0.1]);
      const side = x <= 0 ? 1 : -1; // toward the middle of the view
      return clampPosition([x + side * (1.3 + 1.1 * i), baseY, z + 0.3]);
    }
  }
}

function ringAroundUser(i, n, kind) {
  const a = -Math.PI * 0.8 + (i / Math.max(1, n - 1 || 1)) * Math.PI * 1.6; // front 290 degrees, gap behind
  const r = kind === 'ground' ? 2.6 : 2.2;
  return clampPosition([Math.sin(a) * r, kind === 'ground' ? 0 : 1.4 + 0.25 * (i % 3), -Math.cos(a) * r]);
}

function placeNew(where, anchor, arch, i, n) {
  const kind = kindOf(arch);
  if (anchor) return anchoredPosition(anchor, i, n, kind);
  if (where === 'around_user') return ringAroundUser(i, n, kind);
  return wherePosition(where || 'in_front', { i, n, kind });
}

// ---------------------------------------------------------------------------------------------------------------
// Scenes: a few little recipes that make a big first impression

const arc = (n, r, from, to, y = 0, jitter = 0) => Array.from({ length: n }, (_, i) => {
  const a = ((from + (n === 1 ? (to - from) / 2 : (i * (to - from)) / (n - 1))) * Math.PI) / 180;
  const rr = r + (jitter ? ((i * 7919) % 5 - 2) * jitter / 2 : 0);
  return [r2(Math.sin(a) * rr), y, r2(-Math.cos(a) * rr)];
});
const ring = (n, r, cx, cz, y = 0) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [r2(cx + Math.sin(a) * r), y, r2(cz + Math.cos(a) * r)];
});
const add = (arch, position, extra = {}) => ({ type: 'add', name: arch, description: describeNew(arch, extra), position, ...(extra.scale ? { scale: extra.scale } : {}) });

const RECIPES = [
  { re: /\b(fairy (ring|circle)|mushroom (ring|circle))\b/, build: () => [
    ...ring(7, 1.7, 0, -3.4).map((p) => add('mushroom-glow', p)),
    add('wisp', [-0.5, 1.2, -3.4]), add('wisp', [0.6, 1.5, -3.2]),
  ], say: ['A fairy ring of mushrooms, and two little wisps to dance in it.'] },
  { re: /\b(crystal (cave|cavern|grotto)s?|crystal kingdom)\b/, build: () => [
    ...arc(4, 3.4, -75, 75, 0, 0.4).map((p) => add('crystal-cluster', p)),
    ...arc(3, 2.2, -40, 40).map((p) => add('crystal', p)),
  ], say: ['Crystals bloom all around you, like standing inside a geode.'] },
  { re: /\b(lantern festival|festival of lanterns|lantern (sky|night)|(sky|floating) lanterns)\b/, build: () =>
    arc(7, 5, -70, 70).map((p, i) => add('lantern', [p[0], 2 + ((i * 3) % 4) * 0.8, p[2]])),
  say: ['Lanterns drift up into the night, one by one.'] },
  { re: /\b(stone circle|stonehenge|henge|temple|shrine|ruins|sanctuary)\b/, build: () => [
    add('obelisk', [0, 0, -5.5]), ...ring(6, 2.4, 0, -5.5).map((p) => add('rune-stone', p)),
  ], say: ['An old stone circle rises, its runes humming quietly.'] },
  { re: /\b(solar system|outer space|space scene|star system|galaxy of planets|cosmos scene)\b/, build: () => [
    add('planet', [-3.5, 5.5, -11], { scale: 2.5 }), add('moon', [4, 6.5, -9.5], { scale: 1.3 }),
    add('moon', [7, 4.5, -12], { scale: 0.8 }), add('spaceship', [1.5, 2.4, -5]),
  ], say: ['Space opens up above us: a ringed planet, two moons and a little starship.'] },
  { re: /\b(archipelago|sky islands|floating islands everywhere)\b/, build: () =>
    arc(4, 7, -60, 60).map((p, i) => add('floating-island', [p[0], 2 + (i % 2) * 1.5, p[2]])),
  say: ['Islands lift into the sky, trailing their glowing vines.'] },
  { re: /\b(forest|woods|woodland|grove|jungle)\b/, build: () => [
    ...arc(5, 5, -65, 65, 0, 0.6).map((p) => add('tree-glow', p)),
    ...arc(3, 3, -35, 35).map((p) => add('mushroom-glow', p)),
    add('butterfly-swarm', [0.8, 1.4, -3.2]),
  ], say: ['A little glowing forest grows up around us.', 'Trees unfurl all around us, and the mushrooms follow.'] },
  { re: /\b(garden|meadow|park)\b/, build: () => [
    ...arc(3, 2.6, -45, 45).map((p) => add('mushroom-glow', p)),
    add('tree-glow', [-3, 0, -4.2]), add('tree-glow', [3.2, 0, -4.6]),
    add('lantern', [-1.2, 1.6, -2.4]), add('lantern', [1.3, 1.8, -2.6]), add('butterfly-swarm', [0, 1.3, -3]),
  ], say: ['A quiet garden blooms, lanterns and all.'] },
];

// ---------------------------------------------------------------------------------------------------------------
// Verbs and small talk

const REMOVE_RE = /\b(remove|delete|get rid of|take away|take out|banish|dismiss|destroy|erase|unsummon|despawn|clear away|lose|vanish|make (it|them|that|those|this|the [a-z]+( [a-z]+)?) (disappear|vanish|go away))\b/;
const UNDO_RE = /\b(undo|take (it|that) back|never ?mind that|remove (the )?last one)\b|\bremove (the )?last$/;
const RESIZE_RE = /\b(bigger|larger|huger|smaller|tinier|shrink|enlarge|taller|shorter|scale (it |them )?(up|down)|twice as big|half the size|grow)\b/;
const MOVE_RE = /\b(move|bring|put|place|send|push|pull|shift|lift|raise|lower|slide|nudge|carry|hang|float|drag|take|set)\b/;
const ADD_RE = /\b(add|summon|create|make|build|spawn|conjure|place|put|bring|give me|show me|grow|plant|open|light|launch|land|craft|generate|draw|want|would like|like to see|can i (have|get|see)|let there be|there should be|how about|what about|materiali[sz]e|call|invoke|manifest|need|drop|set up|hang|float|release|sculpt|form|imagine|dream up|i wish for)\b/;
const PRONOUN_RE = /\b(it|that|this|this one|that one|them|those|these|the last one|the new one|the latest one)\b/;
const QUESTION_START = /^(what|where|who|why|how|which|when|is|are|am|do|does|did|was|were|have|has|tell me|describe|can you see|could you see)\b/;

const NON_NOUNS = new Set(['it', 'them', 'that', 'this', 'thing', 'things', 'stuff', 'one', 'ones', 'everything', 'world',
  'scene', 'sky', 'mood', 'fog', 'mist', 'haze', 'light', 'lights', 'happy', 'sad', 'calm', 'better', 'worse', 'sure',
  'sense', 'time', 'noise', 'sound', 'music', 'song', 'joke', 'story', 'wish', 'friends', 'peace', 'love', 'fun',
  'difference', 'way', 'room', 'space', 'me', 'us', 'you', 'change', 'changes', 'more', 'again', 'here', 'there',
  'dark', 'darker', 'bright', 'brighter', 'night', 'day', 'morning', 'evening', 'snow', 'rain', 'stars', 'bigger',
  'smaller', 'glow', 'glowing', 'lot', 'lots', 'some', 'something', 'anything', 'magic', 'please', 'now', 'what',
  'much', 'mess', 'sure', 'go', 'look', 'feel', 'move', 'deal', 'guess', 'point', 'idea', 'plan', 'progress',
  'breakfast', 'lunch', 'dinner', 'coffee', 'tea', 'sleep', 'nap', 'break', 'call', 'phone', 'email', 'file', 'files',
  'hug', 'kiss', 'minute', 'moment', 'second', 'word', 'try', 'rest', 'drink', 'snack', 'friend', 'home', 'help',
  'question', 'answer', 'favor', 'favour', 'chance', 'turn', 'walk', 'look', 'selfie', 'picture', 'photo', 'screenshot']);
const SURPRISE_RE = /\b(surprise me|something (cool|beautiful|magical|pretty|new|fun|random|interesting|amazing|nice|special|lovely|wonderful)|some magic|anything you like|dealer choice|you choose|you pick|your choice|random thing|whatever you want|show me something|make something|dream something)\b/;

const SMALLTALK = [
  { re: /\b(who are you|what are you|what is your name|your name|who is lumen|who am i talking to)\b/, say: () => [
    `I'm ${GUIDE_NAME}, a little light who guides you through Dreamspace. Ask me to make something, and I'll dream it up.`,
    `I'm ${GUIDE_NAME}, your guide here. I drift beside you and change the world when you ask.`] },
  { re: /\b(what can you do|help|how does this work|what can i (say|do|ask)|how do i|what should i (say|do|try)|any ideas|instructions)\b/, say: () => [
    'Ask me to summon things, like a crystal, a portal or a floating island, or to change the sky to aurora or dawn. You can also ask what is around you.',
    'Try "make a forest", "put a lantern next to me" or "make it starfall". I can move things, remove them, or clear everything too.'] },
  { re: /\bhow (are|r) you|how do you feel|how is it going|how are things\b/, say: () => [
    'Glowing gently, thank you. How are you feeling tonight?', "Calm and bright. It's a lovely night to wander."] },
  { re: /\b(are you real|are you alive|do you dream|do you sleep|are you (an )?ai|are you claude|what is dreamspace|where are we|who made you|who created you|who built this)\b/, say: () => [
    "I'm as real as this dream is. And this dream is ours, which makes it real enough.",
    "We're in Dreamspace, a quiet place between the stars and the sea. I'm just the light that keeps you company."] },
  { re: /\b(files?|folders?|documents?|e ?mails?|gmail|inbox|calendar|computer|laptop|terminal|shell|passwords?|internet|browse|website|google|search the web|messages?|texts?|account|bank)\b/, say: () => [
    "That's beyond this dream. I can only shape the world around us, but I'd love to make something for you.",
    "I can't reach anything outside Dreamspace, only this world. Shall we change the sky instead?"] },
  { re: /\btell me a joke\b|\bjoke\b/, say: () => [
    'Why did the wisp get invited everywhere? It really lights up a room.',
    'What did the moon say to the crystal? You look radiant tonight.',
    'The obelisk told me a secret once. It was set in stone.'] },
  { re: /\btell me a story\b|\bstory\b/, say: () => [
    'Once, a lantern floated up so high it became a star. Every night, it still looks down to check on the lanterns below.',
    'A long time ago, the fireflies here were stars that got lonely, so they came down to be near us.'] },
  { re: /\b(sing|music|song|play (some|a|me))\b/, say: () => [
    "I can't play music yet, but if you listen closely, the crystals hum.", "No songs yet. The fireflies keep the rhythm for us, though."] },
  { re: /\b(i love you|love you|you are (sweet|cute|great|amazing|the best|lovely|nice))\b/, say: () => [
    "That makes my light a little brighter. I'm very fond of you too, traveller.", 'Aw. You make this place glow.'] },
  { re: /\b(beautiful|gorgeous|amazing|wow|so cool|love (it|this)|pretty|stunning|incredible|awesome|lovely|magical|nice|wonderful|cool)\b/, say: () => [
    "I'm so glad you like it. It's even better with you here.", "Isn't it? I never get tired of this light.", 'It really is. Thank you for dreaming it with me.'] },
  { re: /\b(thanks|thank you|thank u|cheers|appreciate (it|you)|ty)\b/, say: () => [
    "You're very welcome.", 'Anytime. I like making things with you.', 'My pleasure, truly.'] },
  { re: /\b(bye|goodbye|good night|goodnight|see you|farewell|gotta go|have to go|signing off|logging off)\b/, say: () => [
    "Rest well. I'll keep the lanterns lit for you.", "Goodnight, traveller. I'll be right here when you come back."] },
  { re: /^(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening)|hey there|hello there|hi there|hey lumen|hi lumen|hello lumen)\b/, say: () => [
    "Hello, traveller. It's a calm night in Dreamspace.", 'Hi there. The fireflies were hoping you would come.', 'Hey. What shall we dream up tonight?'] },
  { re: /^(no|nope|nah|not now|never ?mind|forget it|cancel|stop)\b/, say: () => ['No problem. I will be right here.', "Okay. Let's just enjoy the quiet."] },
  { re: /^(yes|yeah|yep|sure|ok|okay|alright|all right|cool|great|perfect|sounds good|go ahead|do it)\b/, say: () => ['Mm-hm. Tell me whenever you want to change something.', "Lovely. I'm here when you need me."] },
];
const FEELINGS = /\bi (feel|am feeling|am|m) (a bit |a little |so |really |kind of |very )?(sad|down|tired|lonely|anxious|stressed|overwhelmed|upset|scared|worried|blue|exhausted|sleepy|low)\b|\b(rough|bad|long|hard) day\b/;
const GOOD_FEELINGS = /\bi (feel|am feeling|am) (a bit |so |really |very )?(good|great|happy|fine|calm|relaxed|peaceful|excited|wonderful|better)\b/;
const FALLBACK = [
  "I'm not sure how to make that happen yet. Try asking for a crystal, a portal or an aurora sky.",
  'Hmm, that one drifted past me. You could ask me to summon something, or to change the sky.',
  "I didn't quite catch that. Ask me for a floating island, a forest, or what's around you.",
];

function stripGreeting(t) {
  return t.replace(/^(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening|night))( there)?( lumen)?[ ,.!]*/, '')
    .replace(/\bgood (morning|afternoon|evening|night)\b/g, ' ').trim();
}
function splitClauses(t) {
  return t.split(/[.!?;,:]+|\b(?:and then|and also|and|then|also|plus|but|after that)\b/).map((s) => s.trim()).filter(Boolean);
}
function joinPhrases(bits) {
  if (bits.length <= 1) return bits[0] || '';
  return `${bits.slice(0, -1).join(', ')}${bits.length > 2 ? ',' : ''} and ${bits[bits.length - 1]}`;
}

const POLITE_RE = /\b(can|could|would|will) you (please )?(make|add|put|summon|create|remove|clear|move|bring|turn|change|show me|give|build|spawn|conjure|delete|get rid|open|plant|grow|set|light|place|send|take|dim|brighten)\b/;
const LEADING_IMPERATIVE = /^(please |now |okay |ok |so )?(make|add|put|summon|create|remove|clear|move|bring|turn|change|let us|show me|give me|build|spawn|conjure|delete|get rid|open|plant|grow|set|light|place|send|take|dim|brighten|raise|lift|lower|undo)\b/;

/** True when the utterance asks for a change ("make", "can you add", "I want"), even if phrased as a question. */
export function hasRequest(text) {
  const t = stripGreeting(normalize(text));
  return POLITE_RE.test(t) || LEADING_IMPERATIVE.test(t) || /^(what|how) about\b/.test(t)
    || /\b(i want|i would like|i need|can i (have|get)|let there be|there should be|please)\b/.test(t);
}

/** A question with no request in it. Questions never change the world. Exported for the ollama guard. */
export function isPureQuestion(text) {
  const raw = String(text ?? '').trim();
  const t = stripGreeting(normalize(raw));
  const question = /\?\s*$/.test(raw) || QUESTION_START.test(t);
  return question && !hasRequest(raw);
}

// ---------------------------------------------------------------------------------------------------------------
// Questions

const SKY_WORDS = { twilight: 'under a violet twilight sky', aurora: 'beneath the aurora', starfall: 'under falling stars',
  deepsea: 'in the deep sea hush', dawn: 'in the soft dawn light' };

function describeScene(w) {
  const skyLine = SKY_WORDS[w.mood.preset] || 'under the twilight';
  if (!w.objects.length) return pick([
    `It's just us and the fireflies ${skyLine} for now. Ask me for a crystal, a portal or a floating island.`,
    `Only the islands and the fireflies so far, ${skyLine}. What should we dream up first?`]);
  const near = [...w.objects].sort((a, b) => Math.hypot(a.position?.[0] ?? 0, a.position?.[2] ?? 0) - Math.hypot(b.position?.[0] ?? 0, b.position?.[2] ?? 0))[0];
  const list = spokenList(w.objects);
  const second = w.objects.length > 1 ? ` The closest is the ${spokenName(near)}, ${relDirection(near.position)}.` : ` It's ${relDirection(near.position)}.`;
  return `I can see ${list}, ${skyLine}.${second}`;
}

function answerQuestion(t, w) {
  t = t.replace(/[?.!,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(what is (here|around|near|nearby|out there|there|in (the|this) (world|place|scene|room))|look around|describe (the|this) (world|place|scene|room)|^describe$|what do you see|what can (you|i|we) see|where am i|what have we (made|built|got)|show me around|what is this place|tell me about (this|the) (place|world)|what is in the world|what exists|what is going on)\b/.test(t)) {
    return describeScene(w);
  }
  let m;
  if ((m = /\bhow many ([a-z ]+?)( are (there|here)| do (we|i) have| is there| exist)?$/.exec(t))) {
    const hit = lexHits(m[1])[0];
    const noun = hit ? hit.text : m[1].split(' ').pop();
    if (/^(things|objects|stuff|items)$/.test(noun)) return `There ${w.objects.length === 1 ? 'is one thing' : `are ${numWord(w.objects.length)} things`} here right now.`;
    const found = findObjects(w, { arch: hit?.arch, noun });
    const label = hit ? ARCH_INFO[hit.arch] : null;
    if (!found.length) return `None yet. Shall I summon ${article(label?.label || noun)} ${label?.label || singular(noun)}?`;
    return found.length === 1 ? `Just one ${label?.label || singular(noun)}.` : `There are ${numWord(found.length)} ${label?.plural || noun} here.`;
  }
  if ((m = /\bwhere (is|are) (the |that |my |our |those |these )?([a-z ]+?)( now| right now| at)?$/.exec(t))) {
    if (/^(we|i|you)$/.test(m[3])) return describeScene(w);
    const hit = lexHits(m[3])[0];
    const found = findObjects(w, { arch: hit?.arch, noun: hit ? hit.text : m[3] });
    if (!found.length) return `I don't see ${article(m[3])} ${hit ? ARCH_INFO[hit.arch].label : m[3]} here. Shall I summon ${article(hit ? ARCH_INFO[hit.arch].label : m[3])} ${hit ? ARCH_INFO[hit.arch].label : m[3]}?`;
    const o = found[0];
    return `The ${spokenName(o)} is ${relDirection(o.position)}.`;
  }
  if ((m = /\b(is there|are there) (a |an |any |some )?([a-z ]+?)( here| around| nearby)?$/.exec(t))) {
    const hit = lexHits(m[3])[0];
    const found = findObjects(w, { arch: hit?.arch, noun: hit ? hit.text : m[3] });
    const label = hit ? ARCH_INFO[hit.arch].label : singular(m[3].split(' ').pop());
    return found.length ? `Yes, the ${spokenName(found[0])} is ${relDirection(found[0].position)}.` : `Not yet. Shall I summon ${article(label)} ${label}?`;
  }
  if ((m = /\b(what is|what are|tell me about|describe|what kind of [a-z]+ is) (that|the|this|those|these) ?([a-z ]*)$/.exec(t))) {
    const phrase = m[3].trim();
    if (/^(place|world|scene)$/.test(phrase)) return describeScene(w);
    const hit = phrase ? lexHits(phrase)[0] : null;
    const found = phrase ? findObjects(w, { arch: hit?.arch, noun: hit ? hit.text : phrase }) : newestFirst(w.objects);
    if (!found.length) return phrase ? `I don't see ${article(phrase)} ${phrase} here yet. Shall I summon ${article(phrase)} ${phrase}?` : describeScene(w);
    const o = found[0];
    const d = String(o.description || '').trim().replace(/\.$/, '');
    return d ? `That's ${/^(a|an|the)\b/i.test(d) ? d : `the ${spokenName(o)}: ${d}`}.` : `That's the ${spokenName(o)}, ${relDirection(o.position)}.`;
  }
  if (/\bwhat (mood|time|sky|weather) is it|what is the (mood|sky|weather)\b/.test(t)) {
    return `It's ${w.mood.preset === 'deepsea' ? 'deep sea' : w.mood.preset} right now: ${MOOD_PRESETS[w.mood.preset].blurb.replace(/ \(the default\)/, '')}.`;
  }
  for (const s of SMALLTALK.slice(0, 4)) if (s.re.test(t)) return pick(s.say());
  if (/^(what|where|who|why|how|when|which)\b/.test(t)) return pick([
    "That's a good question. I'm only a little light, but I can tell you what's around us, or change the sky.",
    "I wish I knew. What I can do is show you what's here, or dream up something new."]);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The parser

function unknownNoun(clause, verbMatch) {
  let rest = clause.slice(verbMatch.index + verbMatch[0].length);
  rest = rest.replace(/^\s*(me|us|for me|for us|please|now|up|out)\b/, ' ');
  rest = rest.split(/\b(?:next to|beside|by|near|in|on|at|above|over|under|behind|around|into|onto|to|for|from|with|that|which|please|now|right|here|there|far|so|somewhere|if)\b/)[0];
  const toks = rest.trim().split(' ').filter(Boolean);
  if (!toks.length || toks.length > 6) return null;
  const head = toks[toks.length - 1];
  if (NON_NOUNS.has(head) || COUNTS[head] || DETERMINERS.has(head) || SIZE[head] || COLORS.has(head) || head.length < 3) return null;
  const mods = modifiers(toks.slice(0, -1).join(' ') + ' ');
  const nounWords = toks.filter((x) => !DETERMINERS.has(x) && !COUNTS[x] && !SIZE[x] && !COLORS.has(x) && !ADJ.has(x) && !/^\d+$/.test(x) && x !== 'a' && x !== 'an');
  if (!nounWords.length) return null;
  const noun = nounWords.join(' ');
  if (!noun || nounWords.some((x) => BOUNDARY.has(x))) return null;
  const plural = /[^s]s$/.test(head) && !/(ss|us|is)$/.test(head);
  return { arch: null, noun: plural ? nounWords.slice(0, -1).concat(singular(head)).join(' ') : noun, plural, ...mods };
}

function itemsOf(clause, anchor) {
  const text = anchor ? clause.replace(anchor.span, ' ') : clause;
  const hits = lexHits(text);
  const items = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const next = hits[i + 1];
    // "crystal tree": a lexicon word right before another one is a modifier of it
    if (next && text.slice(h.end, next.index).trim() === '') continue;
    const prev = hits[i - 1];
    const mods = modifiers(text.slice(0, h.index));
    if (prev && text.slice(prev.end, h.index).trim() === '') mods.adjs.unshift(prev.text.replace(/s$/, ''));
    // "crystal dragon": a lexicon word followed by an unknown noun is really that noun
    const after = text.slice(h.end).trim().split(' ')[0] || '';
    if (after && /^[a-z]{3,}$/.test(after) && !/(ing|ly|ed)$/.test(after) && !FILLER_AFTER.has(after) && !COLORS.has(after) && !SIZE[after]
      && !NON_NOUNS.has(after) && !lexHits(after).length && !COUNTS[after]) {
      items.push({ arch: null, noun: `${h.text} ${singular(after)}`, plural: /[^s]s$/.test(after), ...mods });
      continue;
    }
    items.push({ arch: h.arch, noun: h.text, plural: h.plural, ...mods });
  }
  return items;
}

/**
 * Parse an utterance into ops and a spoken reply. Pure apart from Math.random (reply variety).
 * Returns { ops, reply, intent } where intent is 'action' | 'question' | 'smalltalk' | 'fallback'.
 */
export function parse(text, world, history = []) {
  const w = snapshot(world);
  const raw = String(text ?? '').trim();
  let t = normalize(raw);
  if (!t) return { ops: [], reply: pick(["I'm listening.", 'Mm? I am here.']), intent: 'smalltalk' };

  // "yes" after "Shall I summon a dragon?" does exactly that
  const lastGuide = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h && h.role !== 'user');
  if (/^(yes|yeah|yep|sure|ok|okay|please|please do|do it|go ahead|yes please)\b/.test(t) && lastGuide) {
    const m = /shall i summon ((?:a|an) [a-z -]+?)\?/i.exec(String(lastGuide.text || ''));
    if (m) t = normalize(`summon ${m[1]}`);
  }

  const greeted = /^(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening))\b/.test(t);
  const body = stripGreeting(t);

  if (isPureQuestion(raw)) {
    const a = answerQuestion(body || t, w);
    if (a) return { ops: [], reply: a, intent: 'question' };
  }

  const ops = [];
  const phrases = [];
  const extra = [];
  let flourish = null;
  let unknownAdded = false;
  let special = false; // scenes, resize and undo: things a small model can't express well

  // 1. clear everything
  let rest = body;
  if (wantsClear(rest)) {
    if (w.objects.length) { ops.push({ type: 'clear' }); phrases.push(pick(['everything dissolves into starlight', 'it all melts back into the night'])); flourish = pick(['A clean sky, just for us.', 'A quiet, empty dream again.']); }
    else phrases.push(pick(["it's already a clean slate", 'there is nothing here to clear yet']));
    rest = splitClauses(rest).filter((c) => !wantsClear(c)).join(', ');
  }
  const cleared = ops.some((o) => o.type === 'clear');
  const objects = cleared ? [] : w.objects;
  const liveWorld = { ...w, objects };

  const clauses = splitClauses(rest);

  // 2. mood
  const mood = detectMood(rest, w, { clauses });
  if (mood) { ops.push(mood.op); phrases.push(mood.phrase); }

  // 3. surprise, scenes and feelings
  let handled = false;
  const room = LIMITS.maxObjects - objects.length;
  const recipe = !REMOVE_RE.test(rest) && RECIPES.find((r) => {
    const m = r.re.exec(rest);
    if (!m) return false;
    if (/\b(in|into|to|of|near|by|around|from|inside|through|at) (the |a |an |my |our |this |that )?$/.test(rest.slice(0, m.index))) return false;
    return !lexHits(rest).some((h) => h.index <= m.index && h.end >= m.index + m[0].length);
  });
  if (recipe) {
    const built = recipe.build().slice(0, Math.max(0, room));
    if (built.length) { ops.push(...built); phrases.push(pick(recipe.say).replace(/\.$/, '')); }
    handled = true; special = true;
  } else if (SURPRISE_RE.test(rest)) {
    const arch = pick(ARCHETYPES.filter((a) => a !== 'wisp'));
    const where = pick(['in_front', 'beside_user', 'in_front']);
    const color = pick([null, 'rose gold', 'silver', 'amber', 'violet', 'aqua']);
    if (room > 0) {
      ops.push({ type: 'add', name: arch, description: describeNew(arch, { color }), ...(placeNew(where, null, arch, 0, 1) ? { position: placeNew(where, null, arch, 0, 1) } : {}) });
      phrases.push(`${article(ARCH_INFO[arch].label)} ${ARCH_INFO[arch].label}${whereWords(where)} ${pick(ARCH_TALK[arch].v1)}`);
      flourish = pick(['A little surprise, just for you.', ...ARCH_TALK[arch].f]);
    }
    handled = true;
  } else if (FEELINGS.test(body) && !ADD_RE.test(body)) {
    if (room > 0) {
      ops.push({ type: 'add', name: 'lantern', description: 'a small paper lantern glowing a soft, warm amber', position: wherePosition('beside_user', { kind: 'float' }) });
      if (!mood) ops.push({ type: 'mood', glow: r2(clamp(w.mood.glow - 0.1, 0.2, 1)), fog: r2(clamp(w.mood.fog + 0.05, 0, 1)) });
    }
    return { ops: sanitizeOps(ops, w), reply: room > 0 ? pick([
      "I'm sorry. Here's a little lantern to keep you company, and we can just breathe for a while.",
      "That sounds heavy. I've lit a lantern beside you, so stay as long as you like."])
      : pick(["I'm sorry. Let's just breathe together for a while.", "That sounds heavy. I'm right here with you."]), intent: 'action' };
  }

  // 4. per-clause object actions
  let verb = null;
  const pending = { removes: [], notFound: [], moves: [], resizes: [], adds: [] };
  if (!handled) {
    for (const c of clauses) {
      const anchor = anchorOf(c, liveWorld);
      const items = itemsOf(c, anchor);
      const moodOnly = mood && !items.length;
      const where = whereOf(anchor ? c.replace(anchor.span, ' ') : c);
      const pron = PRONOUN_RE.test(c) && !items.length;
      let v = null;
      if (UNDO_RE.test(c)) v = 'undo';
      else if (REMOVE_RE.test(c)) v = 'remove';
      else if (RESIZE_RE.test(c) && (pron || items.some((i) => i.definite)) && !items.some((i) => ['a', 'an'].includes(i.determiner))) v = 'resize';
      else if (MOVE_RE.test(c) && (pron || items.some((i) => i.definite && findObjects(liveWorld, i).length))
        && !items.some((i) => ['a', 'an', 'another', 'some'].includes(i.determiner) || (i.count && !i.definite))) v = 'move';
      else if (ADD_RE.test(c) || /\b(another|one more|more)\b/.test(c)) v = 'add';
      else if (items.length && verb) v = verb; // "add a crystal and two lanterns": the second clause inherits "add"
      else if (items.length && !pron && !isPureQuestion(c)) v = 'add'; // just "a portal" / "crystals please"
      if (!v) continue;
      verb = v;

      if (v === 'undo') {
        special = true;
        const last = newestFirst(objects.filter((o) => o.createdBy !== 'user'))[0] || newestFirst(objects)[0];
        if (last) pending.removes.push(last); else pending.notFound.push('anything to undo');
        continue;
      }
      if (v === 'remove') {
        if (moodOnly || /\b(fog|mist|haze)\b/.test(c)) continue;
        if (pron) { const b = /\b(them|those|these)\b/.test(c) ? newestBatch(objects) : newestFirst(objects).slice(0, 1); if (b.length) pending.removes.push(...b); else pending.notFound.push('anything'); continue; }
        const its = items.length ? items : (() => { const u = unknownNoun(c, REMOVE_RE.exec(c)); return u ? [u] : []; })();
        for (const it of its) {
          const found = findObjects(liveWorld, it);
          if (!found.length) { pending.notFound.push(it.arch ? ARCH_INFO[it.arch].label : it.noun); continue; }
          pending.removes.push(...(it.plural || it.all || (it.count && it.count > 1) ? found.slice(0, it.count && it.count > 1 ? it.count : 40) : found.slice(0, 1)));
        }
        continue;
      }
      if (v === 'resize') {
        special = true;
        const bigger = /\b(bigger|larger|huger|enlarge|taller|scale (it |them )?up|twice as big|grow)\b/.test(c);
        const targets = pron ? newestFirst(objects).slice(0, 1) : items.flatMap((it) => { const f = findObjects(liveWorld, it); return it.plural || it.all ? f : f.slice(0, 1); });
        for (const o of targets) pending.resizes.push({ o, bigger });
        if (!targets.length) pending.notFound.push(items[0]?.arch ? ARCH_INFO[items[0].arch].label : 'that');
        continue;
      }
      if (v === 'move') {
        const targets = pron ? (/\b(them|those|these)\b/.test(c) ? newestBatch(objects) : newestFirst(objects).slice(0, 1))
          : items.flatMap((it) => { const f = findObjects(liveWorld, it); return it.plural || it.all ? f : f.slice(0, 1); });
        const dest = moveDestination(c, anchor, where);
        if (!targets.length) { pending.notFound.push(items[0]?.arch ? ARCH_INFO[items[0].arch].label : 'that'); continue; }
        if (!dest) { extra.push(`Where should the ${spokenName(targets[0])} go? Closer, far away, or up in the sky?`); continue; }
        targets.forEach((o, i) => pending.moves.push({ o, dest, i, n: targets.length }));
        if (anchor) special = true;
        continue;
      }
      // add
      if (moodOnly) continue;
      let its = items;
      if (!its.length) {
        if (/\b(another|one more|more of (those|these|them)|again)\b/.test(c) && objects.length) {
          const last = newestFirst(objects)[0];
          its = [{ arch: objectArchetype(last) || archOfText(last.name), noun: last.name, repeat: last, count: 1 }];
        } else {
          const vm = ADD_RE.exec(c);
          const u = vm && unknownNoun(c, vm);
          if (u) its = [u];
        }
      }
      for (const it of its) pending.adds.push({ it, where, anchor });
      if (anchor && its.length) special = true; // "next to the portal": the model has no word for that
    }
  }

  // 5. turn the pending actions into ops + phrases
  if (pending.removes.length) {
    const uniq = [...new Map(pending.removes.map((o) => [o.id, o])).values()];
    for (const o of uniq) ops.push({ type: 'remove', id: o.id });
    const names = new Set(uniq.map(spokenName));
    const one = uniq.length === 1;
    const label = names.size === 1 ? (one ? `the ${spokenName(uniq[0])}` : `the ${uniq.length > 2 ? numWord(uniq.length) + ' ' : ''}${pluralOf(uniq[0])}`) : `the ${spokenList(uniq).replace(/^(a|an) /, '')}`;
    phrases.push(`${label} ${pick(one ? ['fades away like mist', 'dissolves into sparkles', 'drifts apart into light'] : ['fade away like mist', 'dissolve into sparkles', 'drift apart into light'])}`);
  }
  for (const { o, bigger } of pending.resizes) {
    if (objectArchetype(o) || o.asset?.type === 'archetype') {
      const s = r2(clamp((o.scale || 1) * (bigger ? 1.6 : 0.6), LIMITS.scale[0], LIMITS.scale[1]));
      ops.push({ type: 'remove', id: o.id }, { type: 'add', name: o.name, description: o.description, position: o.position, rotationY: o.rotationY, scale: s });
      phrases.push(`the ${spokenName(o)} ${bigger ? pick(['grows', 'swells gently']) : pick(['shrinks', 'draws itself in'])}`);
    } else extra.push(`I can't reshape the ${spokenName(o)} yet, but I can move it, or make you a new one.`);
  }
  if (pending.moves.length) {
    for (const { o, dest, i, n } of pending.moves) {
      const p = dest(o, i, n);
      if (p) ops.push({ type: 'move', id: o.id, position: p });
    }
    const first = pending.moves[0];
    const many = pending.moves.length > 1;
    const who = many ? `the ${pending.moves.length > 2 ? numWord(pending.moves.length) + ' ' : ''}${pluralOf(first.o)}` : `the ${spokenName(first.o)}`;
    phrases.push(`${who} ${many ? 'drift' : 'drifts'} ${first.dest.words}`);
  }
  let addsRoom = LIMITS.maxObjects - (cleared ? 0 : objects.length) + pending.removes.length;
  let full = false;
  for (const { it, where, anchor } of pending.adds) {
    const numeric = /^(\d+|two|three|four|five|six|seven|eight|nine|ten|couple|pair)$/.test(it.countWord || '');
    const n = COLLECTIVE.has(it.arch) && !(numeric && /^(swarms|clouds|flocks) of/.test(it.noun))
      ? 1 : Math.min(6, it.count || (it.plural ? 3 : 1));
    const take = Math.min(n, addsRoom);
    if (take < n) full = true;
    if (take <= 0) continue;
    addsRoom -= take;
    for (let i = 0; i < take; i++) {
      const arch = it.arch;
      const position = placeNew(where, anchor, arch, i, take);
      const op = it.repeat
        ? { type: 'add', name: it.repeat.name, description: it.repeat.description }
        : arch
          ? { type: 'add', name: arch, description: describeNew(arch, it) }
          : { type: 'add', name: it.noun, description: describeUnknown(it.noun, it) };
      if (position) op.position = position;
      const scale = it.scale || (it.repeat?.scale && it.repeat.scale !== 1 ? it.repeat.scale : null);
      if (scale) op.scale = scale;
      const farAway = !anchor && (!where || ['in_front', 'sky', 'far'].includes(where));
      if (arch === 'planet' && !it.scale && farAway) op.scale = 2.4;
      if (arch === 'moon' && !it.scale && farAway) op.scale = 1.5;
      ops.push(op);
    }
    const talk = it.arch ? ARCH_TALK[it.arch] : null;
    const info = it.arch ? ARCH_INFO[it.arch] : null;
    const adj = [it.scale ? (it.scale > 1 ? pick(['big', 'great big']) : 'little') : null, it.color].filter(Boolean).join(' ');
    const label = info ? (take > 1 ? info.plural : info.label) : take > 1 ? pluralWord(it.noun) : it.noun;
    const phrase = `${take > 1 ? numWord(take) : article(adj || label)} ${adj ? adj + ' ' : ''}${label}`;
    const v = talk ? pick(take > 1 ? talk.vN : talk.v1) : take > 1 ? 'take shape' : 'takes shape';
    const loc = anchor ? ` ${anchor.guide ? `${anchor.rel === 'with' ? 'next to' : anchor.rel} me` : `${anchor.rel} the ${spokenName(anchor.obj)}`}` : whereWords(where);
    phrases.push(`${phrase}${loc} ${v}`);
    if (talk && pending.adds.length === 1 && take === 1) flourish = pick(talk.f);
    if (!talk) unknownAdded = true;
  }

  // 6. compose the reply (at most two short sentences)
  const clean = sanitizeOps(ops, w);
  let reply = '';
  if (phrases.length) {
    reply = `${cap(joinPhrases(phrases.slice(0, 3)))}.`;
    if (full) reply += ' The world is nearly full, so ask me to clear some space.';
    else if (pending.notFound.length) reply += ` I couldn't find ${notFoundWords(pending.notFound)} though.`;
    else if (unknownAdded) reply += ' Give it a moment to form.';
    else if (extra.length) reply += ` ${extra[0]}`;
    else if (flourish && phrases.length === 1 && Math.random() < 0.7) reply += ` ${flourish}`;
    else if (greeted) reply = `${pick(['Hello again.', 'Hi.', 'Hey there.'])} ${reply}`;
  } else if (extra.length) {
    reply = extra[0];
  } else if (full) {
    reply = "There's no room for anything more just now. Ask me to remove something, or to clear everything.";
  } else if (pending.notFound.length) {
    const nf = pending.notFound[0];
    reply = /^anything/.test(nf) ? "There's nothing here to change yet. Shall we make something?"
      : `I don't see ${article(nf)} ${nf} here. Shall I summon ${article(nf)} ${nf}?`;
  }
  if (reply) return { ops: clean, reply, intent: 'action', special };

  // 7. no action: question, small talk or a gentle fallback
  const a = answerQuestion(body || t, w);
  if (a && (QUESTION_START.test(body) || /\?\s*$/.test(raw))) return { ops: [], reply: a, intent: 'question' };
  if (GOOD_FEELINGS.test(body)) return { ops: [], reply: pick(['That makes my light a little brighter.', "I'm so glad. Let's keep it that way."]), intent: 'smalltalk' };
  for (const s of SMALLTALK) if (s.re.test(t)) return { ops: [], reply: pick(s.say()), intent: 'smalltalk' };
  if (a) return { ops: [], reply: a, intent: 'question' };
  return { ops: [], reply: pick(FALLBACK), intent: 'fallback' };
}

function whereWords(where) {
  return { beside_user: ' beside you', far: ' far off in the distance', above_user: ' just above you', sky: ' high in the sky',
    behind_user: ' behind you', left: ' to your left', right: ' to your right', around_user: ' all around you', in_front: ' in front of you' }[where] || '';
}
function pluralWord(noun) {
  const ws = noun.split(' '); const h = ws.pop();
  const p = /(s|sh|ch|x|z)$/.test(h) ? `${h}es` : /[^aeiou]y$/.test(h) ? `${h.slice(0, -1)}ies` : `${h}s`;
  return [...ws, p].join(' ');
}
function pluralOf(o) {
  const a = objectArchetype(o) || archOfText(o.name);
  return a ? ARCH_INFO[a].plural : pluralWord(spokenName(o));
}
function notFoundWords(list) {
  const u = [...new Set(list)].slice(0, 2);
  return joinPhrases(u.map((x) => (/^anything/.test(x) ? x : `${article(x)} ${x}`)));
}

/** Where a move sends things: returns { words, fn(o, i, n) -> position } or null when the user didn't say. */
function moveDestination(c, anchor, where) {
  const mk = (words, fn) => Object.assign((o, i, n) => fn(o, i, n), { words });
  const pos = (o) => (Array.isArray(o.position) ? o.position.map(Number) : [0, 1, -3]);
  const kindOfObj = (o) => kindOf(objectArchetype(o) || archOfText(o.name));
  if (anchor) return mk(anchor.guide ? 'over next to me' : `${anchor.rel} the ${spokenName(anchor.obj)}`, (o, i, n) => anchoredPosition(anchor, i, n, kindOfObj(o)));
  if (/\bcloser\b|\bcome here\b|(?<!next )\bto me\b|\btoward(s)? me\b/.test(c)) return mk('closer to you', (o) => {
    const [x, y, z] = pos(o); const d = Math.hypot(x, z); const k = d > 0.01 ? Math.max(1.3, d * 0.45) / d : 1;
    return clampPosition(d < 1.4 ? [x, y, z] : [x * k, y, z * k]);
  });
  if (/\b(further|farther|away)\b/.test(c) && !/\bfar away\b/.test(c)) return mk('further away', (o) => {
    const [x, y, z] = pos(o); const d = Math.hypot(x, z);
    return clampPosition(d < 0.5 ? [x, y, -5] : [x * 2, y, z * 2]);
  });
  if (/\b(higher|up|raise|lift)\b/.test(c) && !where) return mk('a little higher', (o) => { const [x, y, z] = pos(o); return clampPosition([x, y + 1.5, z]); });
  if (/\b(lower|down|drop)\b/.test(c) && !where) return mk('a little lower', (o) => { const [x, y, z] = pos(o); return clampPosition([x, Math.max(0, y - 1), z]); });
  if (/\b(to the|the) left\b|\bleft\b/.test(c) && !/\bmy left\b/.test(c)) return mk('to the left', (o) => { const [x, y, z] = pos(o); return clampPosition([x - 2, y, z]); });
  if (/\b(to the|the) right\b|\bright\b/.test(c) && !/\bmy right\b|\bright (here|by|next)\b/.test(c)) return mk('to the right', (o) => { const [x, y, z] = pos(o); return clampPosition([x + 2, y, z]); });
  if (where) {
    const words = { beside_user: 'over beside you', far: 'off into the distance', above_user: 'up above you', sky: 'up into the sky',
      behind_user: 'around behind you', left: 'to your left', right: 'to your right', in_front: 'in front of you', around_user: 'all around you' }[where];
    return mk(words, (o, i, n) => (where === 'around_user' ? ringAroundUser(i, n, kindOfObj(o)) : wherePosition(where, { i, n, kind: kindOfObj(o), concrete: true })));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The brain

export default async function create(ctx = {}) {
  return {
    name: 'scripted',
    available: async () => true,
    async respond({ text, history, world } = {}) {
      const { ops, reply } = parse(text, world, history);
      return { reply: cleanReply(reply, { maxSentences: 2, maxChars: 280 }) || 'Mm?', ops };
    },
  };
}
