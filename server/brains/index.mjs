// The brain layer: loads the three brains, knows which are available, picks one, and makes every answer safe.
//
//   const brains = await createBrains(ctx);        // ctx is passed through to each brain's create(ctx)
//   const b = await brains.get('ollama');          // a wrapped brain: { name, available(), respond() } (or null)
//   const b = await brains.pick(requested);        // requested if available, else the default (see below)
//   await brains.respond({ text, history, world, from, brain })   // pick + respond in one call
//   await brains.health()                          // { claude, ollama, scripted: true } (cached, never slow)
//   brains.setDefault('ollama' | 'claude' | 'scripted' | 'auto')
//
// Picking: a requested brain that is available, else the default. The default is the one set with setDefault()
// (or DEFAULT_BRAIN), else "auto": claude if available, else ollama, else scripted.
//
// Every wrapped respond() resolves (it never throws) to { reply, ops, brain } where `brain` is the brain that
// actually answered, plus `fallbackFrom` when another one had to step in:
//   - ollama fails, times out or returns garbage          -> scripted answers instead.
//   - claude says it can't (usage limit, offline, unsafe) and used no tools -> ollama, else scripted, answers,
//     and claude sits out for a while so the next turns go straight to the local brain.
//   - claude errors after it may have touched the world   -> no fallback (it could have applied ops through MCP;
//     a second brain would do it twice). Its own friendly reply stands.
// Replies are cleaned for speech (no markdown or emoji, two short sentences; three for claude) and ops are clamped
// to the contract, so a brain can never send the server something it would reject.
//
// Also exported for convenience: BRAIN_NAMES, getBrains(ctx) (shared instance), pickBrain, respond, brainHealth,
// setDefaultBrain. app.mjs uses createBrains(ctx).get(name).

import { cleanReply, sanitizeOps } from './persona.mjs';

export const BRAIN_NAMES = ['claude', 'ollama', 'scripted'];
const AUTO_ORDER = ['claude', 'ollama', 'scripted'];
const LOADERS = {
  claude: () => import('./claude-code.mjs'),
  ollama: () => import('./ollama.mjs'),
  scripted: () => import('./scripted.mjs'),
};
const HARD_TIMEOUT_MS = { claude: 90_000, ollama: 45_000, scripted: 5_000 };
const CHECK_TIMEOUT_MS = { claude: 12_000, ollama: 3_000, scripted: 1_000 };
const FRESH_MS = { claude: 20_000, ollama: 5_000, scripted: Infinity };
const GIVE_UP = [
  { re: /usage limit|reached my .*limit|until it resets/i, why: 'limit', coolMs: 10 * 60_000 },
  { re: /can't reach claude|cannot reach claude|not logged in/i, why: 'offline', coolMs: 60_000 },
  { re: /doesn't look right|staying quiet/i, why: 'unsafe', coolMs: 5 * 60_000 },
  { re: /local guide can (take over|help)/i, why: 'unavailable', coolMs: 60_000 },
];
const HANDOFF = {
  limit: 'Claude needs a little rest, so I will think locally for now.',
  offline: "I can't reach Claude just now, so I'm thinking locally.",
  unsafe: 'I am switching to my local mind for a bit.',
  unavailable: 'I am switching to my local mind for a bit.',
  error: '',
};
const SAFE_REPLY = "I'm here, but my thoughts scattered for a moment. Could you say that again?";

const normName = (n) => {
  const s = String(n ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'claude-code' || s === 'claude code') return 'claude';
  if (s === 'local' || s === 'qwen') return 'ollama';
  if (s === 'offline') return 'scripted';
  return s === 'auto' || BRAIN_NAMES.includes(s) ? s : undefined;
};

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => (onTimeout === undefined
        ? reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'ETIMEDOUT' }))
        : resolve(onTimeout)), ms);
    }),
  ]);
}

export async function createBrains(ctx = {}) {
  const env = ctx.env || process.env;
  const log = (...a) => (typeof ctx.log === 'function' ? ctx.log : console.log)('[brains]', ...a);
  const loaders = { ...LOADERS, ...(ctx.loaders || {}) }; // tests can inject fake brains
  const enabled = new Set(String(env.BRAINS || BRAIN_NAMES.join(',')).split(',').map(normName).filter((n) => BRAIN_NAMES.includes(n)));
  enabled.add('scripted'); // the offline brain is always there

  const slots = new Map();     // name -> { brain } | { error, at } | { loading }
  const avail = new Map();     // name -> { ok, at }
  const checking = new Map();  // name -> Promise<bool>
  const cooldown = new Map();  // name -> { until, why, announced }
  const wrappers = new Map();
  const recent = [];           // our own history, used only if the caller doesn't pass one
  let preferred = normName(env.DEFAULT_BRAIN || env.BRAIN) || 'auto';
  if (preferred === undefined) preferred = 'auto';

  // ---- loading --------------------------------------------------------------------------------------------------
  async function load(name) {
    if (!enabled.has(name)) return null;
    const s = slots.get(name);
    if (s?.brain) return s.brain;
    if (s?.loading) return s.loading;
    if (s?.error && Date.now() - s.at < 30_000) return null;
    const loading = (async () => {
      try {
        const mod = await loaders[name]();
        const create = typeof mod?.default === 'function' ? mod.default : mod?.create;
        if (typeof create !== 'function') throw new Error('module has no default create(ctx)');
        const brain = await create(ctx);
        if (!brain || typeof brain.respond !== 'function') throw new Error('create(ctx) did not return a brain');
        slots.set(name, { brain });
        return brain;
      } catch (e) {
        slots.set(name, { error: e, at: Date.now() });
        log(`${name} brain could not load: ${e.code === 'ERR_MODULE_NOT_FOUND' ? 'module not found' : e.message}`);
        return null;
      }
    })();
    slots.set(name, { loading });
    return loading;
  }

  // ---- availability ---------------------------------------------------------------------------------------------
  function coolingDown(name) {
    const c = cooldown.get(name);
    if (!c) return false;
    if (Date.now() < c.until) return true;
    cooldown.delete(name);
    return false;
  }

  function check(name) {
    if (checking.has(name)) return checking.get(name);
    const p = (async () => {
      const b = await load(name);
      if (!b) return false;
      if (typeof b.available !== 'function') return true;
      try { return (await withTimeout(b.available(), CHECK_TIMEOUT_MS[name], false)) === true; } catch { return false; }
    })().then((ok) => {
      avail.set(name, { ok, at: Date.now() });
      checking.delete(name);
      return ok;
    });
    checking.set(name, p);
    return p;
  }

  /** Cached availability. A stale answer is returned at once while a fresh check runs in the background. */
  async function isAvailable(name) {
    if (!enabled.has(name)) return false;
    if (name === 'scripted') return true;
    if (coolingDown(name)) return false;
    const a = avail.get(name);
    if (a && Date.now() - a.at < FRESH_MS[name]) return a.ok;
    if (a) { check(name).catch(() => {}); return a.ok; }
    return check(name);
  }

  function invalidate(name) { avail.delete(name); }

  async function health() {
    const out = {};
    await Promise.all(BRAIN_NAMES.map(async (n) => { out[n] = await isAvailable(n); }));
    return out;
  }

  // ---- picking --------------------------------------------------------------------------------------------------
  async function resolveName(requested) {
    const req = normName(requested);
    if (req && req !== 'auto' && await isAvailable(req)) return req;
    const order = preferred !== 'auto' ? [preferred, ...AUTO_ORDER.filter((n) => n !== preferred)] : AUTO_ORDER;
    for (const n of order) if (await isAvailable(n)) return n;
    return 'scripted';
  }

  async function pick(requested) { return get(await resolveName(requested)); }

  function setDefault(name) {
    const n = normName(name);
    if (!n) throw Object.assign(new Error(`unknown brain "${name}" (use ${BRAIN_NAMES.join(', ')} or auto)`), { status: 400 });
    preferred = n;
    if (n === 'ollama') load('ollama').then((b) => b?.warm?.()).catch(() => {});
    log(`default brain: ${n}`);
    return n;
  }

  // ---- answering ------------------------------------------------------------------------------------------------
  function finalize(name, res, world, extra = {}) {
    const raw = typeof res === 'string' ? res : res?.reply ?? res?.text ?? '';
    const reply = cleanReply(raw, name === 'claude' ? { maxSentences: 3, maxChars: 420 } : { maxSentences: 2, maxChars: 300 });
    const ops = sanitizeOps(Array.isArray(res?.ops) ? res.ops : [], world);
    const tools = Array.isArray(res?.tools) ? { tools: res.tools } : {}; // claude: which world tools it used
    return { reply: reply || (ops.length ? 'There you go.' : SAFE_REPLY), ops, brain: name, ...tools, ...extra };
  }

  async function runLocal(order, input, reason) {
    for (const n of order) {
      if (n !== 'scripted' && !(await isAvailable(n))) continue;
      const b = await load(n);
      if (!b) continue;
      try {
        const res = await withTimeout(b.respond(input), HARD_TIMEOUT_MS[n]);
        if (res && (typeof res === 'string' || typeof res.reply === 'string')) return { name: n, res };
        throw new Error('empty answer');
      } catch (e) {
        log(`${n} failed while covering (${reason}): ${e.message}`);
        if (n !== 'scripted') invalidate(n);
      }
    }
    return null;
  }

  async function respondWith(name, args = {}) {
    const text = String(args.text ?? '');
    const history = Array.isArray(args.history) ? args.history : recent.slice(-12);
    const world = args.world;
    const input = { text, history, world, from: args.from };
    const onStatus = typeof args.onStatus === 'function' ? args.onStatus : () => {};
    const t0 = Date.now();
    const done = (out) => {
      recent.push({ role: 'user', text }, { role: 'guide', text: out.reply });
      while (recent.length > 24) recent.shift();
      log(`${out.brain}${out.fallbackFrom ? ` (covering for ${out.fallbackFrom}: ${out.detail})` : ''} answered in ${Date.now() - t0} ms, ${out.ops.length} op(s)`);
      return out;
    };

    // claude is sitting out (usage limit, offline, tripwire): don't spend another CLI turn on it. The caller may still
    // pick it for a few seconds from its own availability cache, so this check has to live here.
    if (name === 'claude' && coolingDown('claude')) {
      const c = cooldown.get('claude');
      onStatus({ thinking: true, brain: 'ollama', detail: `claude ${c.why}; answering locally` });
      const local = await runLocal(['ollama', 'scripted'], input, `claude ${c.why}`);
      if (local) {
        const out = finalize(local.name, local.res, world, { fallbackFrom: 'claude', detail: c.why });
        if (!c.announced && HANDOFF[c.why]) { out.reply = `${HANDOFF[c.why]} ${out.reply}`; c.announced = true; }
        return done(out);
      }
    }

    const brain = await load(name);
    let res = null, error = null;
    if (brain) {
      try { res = await withTimeout(brain.respond(input), HARD_TIMEOUT_MS[name]); } catch (e) { error = e; }
    } else error = new Error('not loaded');

    if (name === 'claude') {
      // claude may already have changed the world through MCP, so only hand over when it clearly did nothing
      const quiet = !res || !Array.isArray(res.tools) || res.tools.length === 0;
      // an explicit res.error / res.reason ('limit' | 'offline' | 'unsafe') wins; else recognise its friendly lines
      const tag = String(res?.error ?? res?.reason ?? '');
      const gaveUp = !error && res && quiet ? (GIVE_UP.find((g) => g.why === tag) || GIVE_UP.find((g) => g.re.test(String(res.reply ?? '')))) : null;
      if (gaveUp || (error && !brain)) {
        const why = gaveUp ? gaveUp.why : 'error';
        const prev = cooldown.get('claude');
        cooldown.set('claude', { until: Date.now() + (gaveUp ? gaveUp.coolMs : 60_000), why, announced: prev?.announced && Date.now() < prev.until });
        invalidate('claude');
        onStatus({ thinking: true, brain: 'ollama', detail: `claude ${why}; answering locally` });
        const local = await runLocal(['ollama', 'scripted'], input, `claude ${why}`);
        if (local) {
          const c = cooldown.get('claude');
          const out = finalize(local.name, local.res, world, { fallbackFrom: 'claude', detail: why });
          if (!c.announced && HANDOFF[why]) { out.reply = `${HANDOFF[why]} ${out.reply}`; c.announced = true; }
          return done(out);
        }
      }
      if (error) {
        log(`claude failed: ${error.message}`);
        invalidate('claude');
        return done({ reply: "I lost the thread there for a second. Could you try that again?", ops: [], brain: 'claude' });
      }
      return done(finalize('claude', res, world));
    }

    const usable = !error && res && (typeof res === 'string' || typeof res.reply === 'string' || Array.isArray(res.ops));
    if (usable) return done(finalize(name, res, world));

    // ollama (or anything but scripted) failed: the offline brain covers, so the guide never goes silent
    const why = error?.code === 'ETIMEDOUT' ? 'timeout' : 'error';
    log(`${name} failed (${error ? error.message : 'unusable answer'}); scripted covers`);
    invalidate(name);
    if (name !== 'scripted') {
      onStatus({ thinking: true, brain: 'scripted', detail: `${name} ${why}; answering offline` });
      const local = await runLocal(['scripted'], input, `${name} ${why}`);
      if (local) return done(finalize('scripted', local.res, world, { fallbackFrom: name, detail: why }));
    }
    return done({ reply: SAFE_REPLY, ops: [], brain: name });
  }

  /** A stable wrapped brain for `name`, or null when its module can't load. */
  async function get(name) {
    const n = normName(name);
    if (!n || n === 'auto' || !enabled.has(n)) return null;
    const b = await load(n);
    if (!b) return null;
    if (!wrappers.has(n)) {
      wrappers.set(n, {
        name: n,
        available: () => isAvailable(n),
        respond: (args) => respondWith(n, args),
        warm: () => (typeof b.warm === 'function' ? b.warm() : undefined),
        reset: typeof b.reset === 'function' ? () => b.reset() : undefined,
        debug: typeof b.debug === 'function' ? () => b.debug() : undefined,
        inner: b,
      });
    }
    return wrappers.get(n);
  }

  async function respond(args = {}) {
    const name = await resolveName(args.brain);
    return respondWith(name, args);
  }

  async function close() {
    for (const s of slots.values()) {
      const b = s.brain;
      if (!b) continue;
      for (const k of ['close', 'dispose', 'shutdown', 'stop']) {
        if (typeof b[k] === 'function') { try { await withTimeout(b[k](), 2000, null); } catch { /* best effort */ } break; }
      }
    }
  }

  // Start loading in the background so the first health check and the first utterance are quick. The ollama model is
  // warmed only if it will actually be used (it costs ~2 GB of RAM on a Mac that is already swapping).
  if (ctx.preload !== false) {
    for (const n of BRAIN_NAMES) if (enabled.has(n)) load(n).then(() => (n === 'scripted' ? null : isAvailable(n))).catch(() => {});
    (async () => {
      const first = await resolveName(null);
      if (first === 'ollama' && ctx.warm !== false) (await load('ollama'))?.warm?.();
    })().catch(() => {});
  }

  return {
    names: BRAIN_NAMES,
    get,
    getBrain: get,
    pick,
    respond,
    health,
    availability: health,
    isAvailable,
    setDefault,
    getDefault: () => preferred,
    current: () => resolveName(null),
    close,
  };
}

// ---- a shared instance, for callers that prefer plain functions ----------------------------------------------------
let shared = null;
export function getBrains(ctx) { if (!shared) shared = createBrains(ctx); return shared; }
export async function pickBrain(requested, ctx) { return (await getBrains(ctx)).pick(requested); }
export async function respond(args, ctx) { return (await getBrains(ctx)).respond(args); }
export async function brainHealth(ctx) { return (await getBrains(ctx)).health(); }
export async function setDefaultBrain(name, ctx) { return (await getBrains(ctx)).setDefault(name); }

export default createBrains;
