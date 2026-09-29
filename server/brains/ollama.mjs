// Ollama brain: a small local model (qwen2.5:3b by default) that answers {reply, ops} as schema-constrained JSON.
//
// The recipe comes from the local-llm research ("variant G": 97% correct on tuning, 18/18 held-out once guarded,
// ~0.7 s warm on an M2 Pro):
//   - /api/chat, stream:false, temperature 0.4, num_ctx 4096, keep_alive 30m
//   - `format` is a JSON schema built per request: ops are anyOf add/remove/clear/mood/move, placement is a small
//     `where` vocabulary instead of raw coordinates, and ids are an enum of the objects that actually exist
//     (shown to the model as short aliases o1..oN and mapped back afterwards). Empty world: no remove/move branch.
//   - a deterministic guard, because a 3B model sometimes clears the world when asked a question, removes the wrong
//     thing, or adds an object for "what's that spaceship?". It shares its language rules with the scripted brain.
// Then `where` becomes a position, mood tweaks become deterministic ("darker" is always a bit darker), and every op
// is clamped to the contract. If the model gives nothing usable for a clear request, the scripted parser rescues it.
//
// Env: OLLAMA_URL (http://127.0.0.1:11434), OLLAMA_MODEL (qwen2.5:3b), OLLAMA_TIMEOUT_MS (30000),
//      OLLAMA_KEEP_ALIVE (30m), OLLAMA_NUM_CTX (4096).

import {
  ARCH_INFO, PRESETS, MOOD_PRESETS, snapshot, worldList, jsonPersona, sanitizeOps, cleanReply, wherePosition,
  objectArchetype, article,
} from './persona.mjs';
import {
  normalize, wantsClear, detectMood, isPureQuestion, hasRequest, archOfText, archesIn, wheresIn, sizeOf,
  parse as scriptedParse,
} from './scripted.mjs';

const WHERE_ENUM = ['beside_user', 'in_front', 'far', 'above_user', 'sky', 'anywhere'];
// placements the scripted rules can read from the utterance, including a few the model has no word for
const WHERE_ALL = [...WHERE_ENUM, 'behind_user', 'left', 'right', 'around_user'];
const SIZE_WORDS = /\b(big|bigger|huge|giant|enormous|massive|large|larger|tall|towering|colossal|gigantic|small|smaller|tiny|little|mini|miniature|wee|teeny|scale|size)\b/;
// A size request ("shrink all the trees") never moves anything, unless the user also named a place or a move verb.
const RESIZE_WORDS = /\b(bigger|larger|huger|smaller|tinier|shrink\w*|enlarge\w*|taller|shorter|resiz\w*|scale (it |them )?(up|down)|twice as big|half the size|grow|grows)\b/;
const MOVE_VERBS = /\b(move|bring|put|place|send|push|pull|shift|lift|raise|lower|slide|nudge|carry|drag|closer|further|farther|higher)\b/;
const PRONOUNS = /\b(it|that|this|them|those|these|one|last|new|latest)\b/;
// A mood op the model invents is kept only if the utterance is about the sky or the feel of the place.
const MOOD_WORDS = /\b(sky|skies|mood|feel|feeling|vibe|atmosphere|ambien\w*|light|lights|lighting|dark\w*|bright\w*|dim\w*|glow\w*|fog\w*|mist\w*|haz\w*|colou?rs?|weather|night|day|dusk|dawn|twilight|aurora|stars?|starry|starfall|sea|ocean|underwater|deep|magic\w*|dream\w*|calm\w*|cozy|cosy|spooky|eerie|warm\w*|cold\w*|winter|summer|autumn|spring|rain\w*|snow\w*|storm\w*|sunset|sunrise|morning|evening|sad|happy|peaceful|relax\w*|soothing|moody|romantic|mysterious|cheerful|gloomy|lighter|surprise\w*|anything|something)\b/;
const GENERIC = new Set(['glowing', 'glow', 'light', 'soft', 'softly', 'bright', 'with', 'that', 'the', 'and', 'from', 'into',
  'gentle', 'gently', 'warm', 'pale', 'deep', 'small', 'tiny', 'big', 'little', 'tall', 'floating', 'shimmering', 'blue',
  'violet', 'teal', 'cyan', 'green', 'gold', 'golden', 'silver', 'amber', 'pink', 'purple', 'white', 'red', 'thing']);

const singular = (w) => (/ies$/.test(w) && w.length > 4 ? w.slice(0, -3) + 'y'
  : /(ches|shes|xes|sses)$/.test(w) ? w.slice(0, -2) : /[^su]s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w);
const words = (s) => (String(s ?? '').toLowerCase().match(/[a-z]+/g) || []).map(singular).filter((w) => w.length > 2);

/** The per-request JSON schema (exported for tests). `aliases` are the o1..oN ids in the world list. */
export function buildSchema(aliases = []) {
  const id = { type: 'string', enum: aliases };
  const branches = [
    { type: 'object', properties: { type: { const: 'add' }, name: { type: 'string' }, description: { type: 'string' }, where: { type: 'string', enum: WHERE_ENUM }, scale: { type: 'number' } }, required: ['type', 'name', 'description', 'where'] },
    ...(aliases.length ? [{ type: 'object', properties: { type: { const: 'remove' }, id }, required: ['type', 'id'] }] : []),
    { type: 'object', properties: { type: { const: 'clear' } }, required: ['type'] },
    { type: 'object', properties: { type: { const: 'mood' }, preset: { type: 'string', enum: PRESETS }, fog: { type: 'number' }, glow: { type: 'number' } }, required: ['type', 'preset'] },
    ...(aliases.length ? [{ type: 'object', properties: { type: { const: 'move' }, id, where: { type: 'string', enum: WHERE_ENUM } }, required: ['type', 'id', 'where'] }] : []),
  ];
  return {
    type: 'object',
    properties: { reply: { type: 'string' }, ops: { type: 'array', items: { anyOf: branches }, maxItems: 6 } },
    required: ['reply', 'ops'],
  };
}

/**
 * Deterministic post-filter for model ops (exported for tests). Ops still carry model ids (already mapped back to
 * real ids) and `where`. Returns { ops, dropped }.
 */
export function guard(text, ops, world) {
  const w = snapshot(world);
  const t = normalize(text);
  const said = new Set(words(t));
  const saidArch = archesIn(t);
  const byId = new Map(w.objects.map((o) => [o.id, o]));
  const archOf = (o) => objectArchetype(o) || archOfText(o.name);
  const mentions = (o) => {
    const a = archOf(o);
    if (a && saidArch.has(a)) return true;
    if (words(o.name).some((x) => said.has(x))) return true;
    return words(o.description).some((x) => !GENERIC.has(x) && x.length > 3 && said.has(x));
  };
  const newest = [...w.objects].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const pronounTarget = (o) => PRONOUNS.test(t) && newest && o.id === newest.id;

  let dropped = 0;
  if (isPureQuestion(text)) return { ops: [], dropped: ops.length };
  const clearOK = wantsClear(text);
  const mood = detectMood(text, w);
  const sizeOnly = RESIZE_WORDS.test(t) && !MOVE_VERBS.test(t) && wheresIn(text).size === 0;
  const objectRequest = saidArch.size > 0 || /\b(add|summon|create|put|place|spawn|conjure|bring|build|plant|grow|open|light|launch)\b/.test(t);

  const out = [];
  for (const raw of ops) {
    const op = { ...raw };
    if (op.type === 'clear') {
      if (!clearOK) { dropped++; continue; }
    } else if (op.type === 'remove' || op.type === 'move') {
      if (op.type === 'move' && sizeOnly) { dropped++; continue; }
      const o = byId.get(op.id);
      if (!o) { dropped++; continue; }
      if (!mentions(o) && !pronounTarget(o)) {
        const alt = w.objects.find((x) => mentions(x) && !out.some((p) => p.type === op.type && p.id === x.id));
        if (!alt) { dropped++; continue; }
        op.id = alt.id;
      }
      if (out.some((p) => p.type === op.type && p.id === op.id)) { dropped++; continue; }
    } else if (op.type === 'add') {
      if (mood && !objectRequest) { dropped++; continue; } // "make it snow" is a sky change, not a snowman
      // "I want some mushrooms" -> mushrooms only, not a bonus tree
      const a = ARCH_INFO[String(op.name || '').toLowerCase().replace(/\s+/g, '-')] ? String(op.name).toLowerCase().replace(/\s+/g, '-') : archOfText(op.name || '');
      if (saidArch.size && a && !saidArch.has(a) && !words(op.name).some((x) => said.has(x))) { dropped++; continue; }
    } else if (op.type !== 'mood') { dropped++; continue; }
    out.push(op);
  }

  // "get rid of the crystals" / "remove all the trees": the model often removes just one of them
  if (/\b(remove|delete|get rid of|take away|banish|erase|destroy)\b/.test(t)) {
    const removed = out.filter((o) => o.type === 'remove').map((o) => byId.get(o.id)).filter(Boolean);
    for (const arch of saidArch) {
      const pluralOrAll = new RegExp(`\\b(all|every|both)\\b`).test(t) || [...t.matchAll(/\b([a-z]+)\b/g)].some(([wd]) => wd !== singular(wd) && archOfText(singular(wd)) === arch);
      if (!pluralOrAll || !removed.some((o) => archOf(o) === arch)) continue;
      for (const o of w.objects) if (archOf(o) === arch && !out.some((p) => p.type === 'remove' && p.id === o.id)) out.push({ type: 'remove', id: o.id });
    }
  }
  return { ops: out, dropped };
}

/** where -> position, scale only when asked, canonical archetype names, deterministic mood tweaks. */
function finish(text, ops, world) {
  const w = snapshot(world);
  const t = normalize(text);
  const groups = new Map();
  for (const op of ops) if ((op.type === 'add' || op.type === 'move') && op.where) groups.set(op.where, (groups.get(op.where) || 0) + 1);
  const seen = new Map();
  const mood = detectMood(text, w);
  const said = [...wheresIn(text)].filter((x) => WHERE_ALL.includes(x));
  const saidWhere = said.length === 1 ? said[0] : null; // one clear placement in the words beats the model's guess
  const size = sizeOf(text);
  if (saidWhere) { groups.clear(); for (const op of ops) if (op.type === 'add' || op.type === 'move') groups.set(saidWhere, (groups.get(saidWhere) || 0) + 1); }
  const out = [];
  for (const op of ops) {
    if (op.type === 'add' || op.type === 'move') {
      const where = saidWhere || (WHERE_ENUM.includes(op.where) ? op.where : 'in_front');
      const i = seen.get(where) || 0; seen.set(where, i + 1);
      const n = groups.get(where) || 1;
      if (op.type === 'add') {
        const key = String(op.name || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
        const name = ARCH_INFO[key] ? key : String(op.name || '').trim();
        const arch = ARCH_INFO[key] ? key : archOfText(name);
        const o = { type: 'add', name, description: String(op.description || '').trim() || `${article(name)} ${name}, glowing softly` };
        const kind = arch ? ARCH_INFO[arch].kind : 'ground';
        // islands, starships, planets and moons don't fit at arm's length unless the user asked for it
        const whereFit = !saidWhere && (kind === 'high' || kind === 'sky') && (where === 'beside_user' || where === 'above_user') ? 'in_front' : where;
        const p = where === 'around_user' ? aroundUser(i, n, kind) : wherePosition(whereFit, { i, n, kind });
        if (p) o.position = p;
        if (Number.isFinite(op.scale) && SIZE_WORDS.test(t)) o.scale = Math.min(3, Math.max(0.3, op.scale));
        else if (size) o.scale = size;
        if (!o.scale && (arch === 'planet' || arch === 'moon') && ['in_front', 'anywhere', 'sky', 'far'].includes(where)) o.scale = arch === 'planet' ? 2.4 : 1.5;
        out.push(o);
      } else {
        const obj = w.objects.find((x) => x.id === op.id);
        const arch = obj ? objectArchetype(obj) || archOfText(obj.name) : null;
        const kind = arch ? ARCH_INFO[arch].kind : 'ground';
        out.push({ type: 'move', id: op.id, position: where === 'around_user' ? aroundUser(i, n, kind) : wherePosition(where, { i, n, kind, concrete: true }) });
      }
    } else if (op.type === 'mood') {
      if (mood) { if (!out.some((x) => x.type === 'mood')) out.push(mood.op); continue; } // keyword intent wins
      if (!MOOD_WORDS.test(t)) continue; // "make it a bit bigger" is not a request for dawn
      const preset = PRESETS.includes(op.preset) ? op.preset : null;
      const tweak = /\b(fog|mist|haze|glow|dark|dim|bright|light)\w*\b/.test(t);
      const base = preset ? MOOD_PRESETS[preset] : w.mood;
      out.push({ type: 'mood', ...(preset ? { preset } : {}), fog: tweak && Number.isFinite(op.fog) ? op.fog : base.fog, glow: tweak && Number.isFinite(op.glow) ? op.glow : base.glow });
    } else out.push(op);
  }
  // a clear mood request the model missed ("make it darker" -> ops: [])
  if (mood && !out.some((x) => x.type === 'mood') && !isPureQuestion(text)) out.push(mood.op);
  return out;
}

function aroundUser(i, n, kind) {
  const a = -Math.PI * 0.8 + (i / Math.max(1, n - 1 || 1)) * Math.PI * 1.6;
  const r = kind === 'ground' ? 2.6 : 2.2;
  return [Math.round(Math.sin(a) * r * 100) / 100, kind === 'ground' ? 0 : 1.4, Math.round(-Math.cos(a) * r * 100) / 100];
}

/** "add two lanterns and a portal" -> the model sometimes adds one lantern; the scripted count fills the gap. */
function topUp(ops, pre) {
  if (pre.intent !== 'action') return ops;
  const want = new Map();
  for (const o of pre.ops) if (o.type === 'add') { const a = archOfText(o.name); if (a) want.set(a, (want.get(a) || 0) + 1); }
  const out = [...ops];
  for (const [a, n] of want) {
    const mine = out.filter((o) => o.type === 'add' && archOfText(o.name) === a);
    if (!mine.length || mine.length >= n) continue;
    for (let k = mine.length; k < Math.min(n, 6); k++) out.splice(out.lastIndexOf(mine[mine.length - 1]) + 1, 0, { ...mine[0] });
  }
  return out;
}

function historyBlock(history, text) {
  const h = (Array.isArray(history) ? history : []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
  if (h.length && h[h.length - 1].role === 'user' && h[h.length - 1].text.trim() === String(text).trim()) h.pop();
  return h.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Lumen'}: ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  return m ? { reply: JSON.parse(`"${m[1]}"`), ops: [] } : null;
}

export default async function create(ctx = {}) {
  const env = ctx.env || process.env;
  const url = String(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = env.OLLAMA_MODEL || 'qwen2.5:3b';
  const timeoutMs = Number(env.OLLAMA_TIMEOUT_MS) || 30_000;
  const keepAlive = env.OLLAMA_KEEP_ALIVE || '30m';
  const numCtx = Number(env.OLLAMA_NUM_CTX) || 4096;
  const log = (...a) => (typeof ctx.log === 'function' ? ctx.log : console.log)('[ollama-brain]', ...a);

  let avail = { at: 0, ok: false };
  let checking = null;
  async function available() {
    if (Date.now() - avail.at < 5000) return avail.ok;
    if (!checking) {
      checking = (async () => {
        let ok = false;
        try {
          const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            const j = await r.json();
            const want = model.includes(':') ? model : `${model}:latest`;
            ok = (j.models || []).some((m) => m.name === model || m.name === want || m.model === model || m.model === want);
          }
        } catch { ok = false; }
        avail = { at: Date.now(), ok };
        checking = null;
        return ok;
      })();
    }
    return checking;
  }

  let warming = null;
  /** Load the model into memory ahead of the first utterance (the first-ever load can take ~60 s). Never throws. */
  function warm() {
    if (!warming) {
      warming = fetch(`${url}/api/generate`, {
        // same num_ctx as chat: ollama reloads the model whenever num_ctx changes between requests
        method: 'POST', body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: keepAlive, options: { num_ctx: numCtx } }),
        signal: AbortSignal.timeout(120_000),
      }).then((r) => r.ok).catch(() => false).finally(() => { setTimeout(() => { warming = null; }, 60_000); });
    }
    return warming;
  }

  async function chat(messages, schema) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, format: schema, keep_alive: keepAlive, messages,
          options: { temperature: 0.4, num_ctx: numCtx, num_predict: 600 },
        }),
        signal: ac.signal,
      });
      if (!r.ok) throw Object.assign(new Error(`ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { code: 'EHTTP' });
      const j = await r.json();
      return String(j?.message?.content ?? '');
    } catch (e) {
      avail = { at: 0, ok: false }; // re-check next time
      if (e.name === 'AbortError') throw Object.assign(new Error(`ollama timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function respond({ text, history, world } = {}) {
    const w = snapshot(world);
    const utter = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!utter) return { reply: "I'm listening.", ops: [] };

    // Scenes ("make a forest"), resize and undo: the scripted rules do these better and instantly.
    let pre;
    try { pre = scriptedParse(utter, w, history); } catch (e) { log(`scripted pre-parse failed: ${e.message}`); pre = { ops: [], reply: '', intent: 'fallback' }; }
    if (pre.special && pre.ops.length) {
      log('scene/resize/undo handled by the scripted rules');
      return { reply: pre.reply, ops: pre.ops, ms: 0, rescued: true };
    }

    const list = worldList(w);
    const system = jsonPersona(w, list, { recent: historyBlock(history, utter) });
    const t0 = Date.now();
    const content = await chat([{ role: 'system', content: system }, { role: 'user', content: utter }], buildSchema(list.aliases));
    const ms = Date.now() - t0;
    const out = parseJson(content);
    if (!out || typeof out !== 'object') throw Object.assign(new Error('ollama returned unparseable JSON'), { code: 'EPARSE' });

    // aliases (o1..oN) back to real ids; unknown aliases are dropped by the guard
    const rawOps = (Array.isArray(out.ops) ? out.ops : []).filter((o) => o && typeof o === 'object')
      .map((o) => (o.id != null ? { ...o, id: list.aliasToId.get(String(o.id)) ?? `?${o.id}` } : o));
    const guarded = guard(utter, rawOps, w);
    let ops = sanitizeOps(finish(utter, topUp(guarded.ops, pre), w), w);
    let reply = cleanReply(out.reply, { maxSentences: 2, maxChars: 280 });
    let rescued = false;

    // Nothing usable for something that clearly asked for a change: the scripted parser knows these by heart.
    // (Also when the model proposed changes but none survived: its reply would describe something that never happened.)
    if (!ops.length && (rawOps.length > 0 || hasRequest(utter)) && !isPureQuestion(utter)) {
      if (pre.intent === 'action') { ops = pre.ops; reply = pre.reply; rescued = true; }
    }
    // A question about something that isn't here ("what's that spaceship?"): small models invent one; the rules don't.
    if (!ops.length && isPureQuestion(utter)) {
      const asked = archesIn(utter);
      const present = new Set(w.objects.map((o) => objectArchetype(o) || archOfText(o.name)));
      if (asked.size && ![...asked].some((a) => present.has(a)) && pre.reply) { reply = pre.reply; rescued = true; }
    }
    if (!reply) reply = ops.length ? 'There you go.' : 'Mm, tell me more?';
    log(`${ms} ms, ${rawOps.length} raw -> ${ops.length} ops${guarded.dropped ? `, ${guarded.dropped} guarded` : ''}${rescued ? ', rescued by scripted' : ''}`);
    return { reply, ops, ms, ...(rescued ? { rescued: true } : {}) };
  }

  return { name: 'ollama', model, available, respond, warm };
}
