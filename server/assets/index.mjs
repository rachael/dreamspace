// Asset resolution: turns an `add` op's {name, description} into an Asset (see docs/CONTRACT.md "Assets").
//
//   import { resolveAsset } from './assets/index.mjs';
//   const asset = await resolveAsset({ name, description });            // never throws, never null
//   const asset = await resolveAsset(req, { onUpgrade: (better) => … }); // optional progressive mode (below)
//
// Providers run in ASSET_PROVIDERS order (default "archetype,parts,meshy", read on every call); unavailable ones are
// skipped. The first valid Asset wins. If none produces one, the fallback is the best loose archetype match
// ("sword in a stone" -> rune-stone), else a wisp tinted by any colour words.
//
// Slow providers (parts ~5-18 s on qwen2.5:3b, meshy ~2-4 min) are bounded:
//  - The whole call is capped at ASSET_BUDGET_MS (default 50 s). When the cap hits, the fallback is returned and the
//    slow job keeps running in the background; its result is cached, so the next identical request is instant.
//  - Progressive mode: pass opts.onUpgrade(asset, info). Instead of waiting for a slow provider, resolveAsset returns
//    the fallback at once and calls onUpgrade later with the better asset (if one arrives). This only helps once the
//    world can swap an existing object's asset; until then, leave onUpgrade out and the call behaves as above.
// Every provider's output is validated here (contract fields only, clamped), whichever provider made it.

import archetype, { matchArchetype, wispFor, isArchetype, ARCHETYPES } from './archetype.mjs';
import parts, { validateParts } from './parts.mjs';
import meshy from './meshy.mjs';

export { ARCHETYPES };

const REGISTRY = new Map([[archetype.name, archetype], [parts.name, parts], [meshy.name, meshy]]);
const SLOW = new Set(['parts', 'meshy']);          // providers that call a model; results are cached
const DEFAULT_ORDER = 'archetype,parts,meshy';
const debug = (...a) => { if (process.env.ASSET_DEBUG) console.log('[assets]', ...a); };
const warned = new Set();
const warnOnce = (k, msg) => { if (!warned.has(k)) { warned.add(k); console.warn('[assets]', msg); } };

function envInt(k, dflt) { const v = Number.parseInt(process.env[k] ?? '', 10); return Number.isFinite(v) && v > 0 ? v : dflt; }
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The provider objects in the configured order (unknown names are ignored with a warning). */
export function providerOrder(list = process.env.ASSET_PROVIDERS) {
  const names = String(list || DEFAULT_ORDER).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const n of names) {
    const p = REGISTRY.get(n);
    if (!p) warnOnce(`unknown:${n}`, `unknown asset provider "${n}" in ASSET_PROVIDERS (known: ${[...REGISTRY.keys()].join(', ')})`);
    else if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : [archetype];
}

/** For /api/health: [{name, available, active}] for every known provider. */
export async function listAssetProviders() {
  const active = new Set(providerOrder().map((p) => p.name));
  return Promise.all([...REGISTRY.values()].map(async (p) => ({
    name: p.name, active: active.has(p.name), available: await safeAvailable(p),
  })));
}
/** For /api/health `assets:[names]`: active providers that are available right now, in order. */
export async function availableAssetProviders() {
  const out = [];
  for (const p of providerOrder()) if (await safeAvailable(p)) out.push(p.name);
  return out;
}

async function safeAvailable(p) {
  try { return !!(await p.available()); } catch (e) { warnOnce(`avail:${p.name}`, `${p.name}.available() threw: ${e.message}`); return false; }
}

// ---- validation -------------------------------------------------------------------------------------------------
function hex(c) {
  if (typeof c !== 'string') return undefined;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : undefined;
}

/** Validate any provider's output against the contract. Returns a clean copy, or null if it can't be used. */
export function validateAsset(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'archetype') {
    if (!isArchetype(a.archetype)) return null;
    const src = a.params && typeof a.params === 'object' ? a.params : {};
    const params = {};
    for (const [k, v] of Object.entries(src).slice(0, 12)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
      if (k === 'color' || k === 'accent') { const h = hex(v); if (h) params[k] = h; continue; }
      if (k === 'variant') { if (Number.isFinite(+v)) params.variant = Math.max(0, Math.min(1000, Math.floor(+v))); continue; }
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
      else if (typeof v === 'boolean') params[k] = v;
      else if (typeof v === 'string') params[k] = clean(v, 60);
    }
    return { type: 'archetype', archetype: a.archetype, params };
  }
  if (a.type === 'parts') {
    const ps = validateParts(a.parts);
    return ps ? { type: 'parts', parts: ps } : null;
  }
  if (a.type === 'glb') {
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    if (!url || url.length > 2048) return null;
    // Same-origin path (not protocol-relative) or an https URL. Nothing else (no javascript:, data:, http:).
    if (!(/^\/(?!\/)[^\s]*$/.test(url) || /^https:\/\/[^\s]+$/i.test(url))) return null;
    return { type: 'glb', url };
  }
  return null;
}

// ---- cache + in-flight dedupe (slow providers only; memory only) -------------------------------------------------
const CACHE_MAX = 200;
const cache = new Map();       // key -> asset (Map keeps insertion order: oldest first, for LRU eviction)
const inflight = new Map();    // key -> Promise<asset|null>
const keyOf = (p, r) => `${p}|${r.name.toLowerCase()}|${r.description.toLowerCase()}`;
function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k, v) { cache.set(k, v); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

// Run one provider with caching, dedupe and validation. Resolves to a valid Asset or null; never rejects.
function runProvider(p, r) {
  const slow = p.slow ?? SLOW.has(p.name);
  const k = keyOf(p.name, r);
  if (slow) {
    const hit = cacheGet(k);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(k)) return inflight.get(k);
  }
  const t0 = Date.now();
  const job = (async () => {
    try {
      const raw = await p.generate({ name: r.name, description: r.description });
      const asset = validateAsset(raw);
      if (raw && !asset) warnOnce(`invalid:${p.name}`, `${p.name} returned an invalid asset; ignoring it`);
      debug(`${p.name} ${asset ? 'ok' : 'no result'} in ${Date.now() - t0} ms for "${r.name}"`);
      if (asset && slow) cacheSet(k, asset);
      return asset;
    } catch (e) {
      console.warn(`[assets] ${p.name} failed for "${r.name}": ${e.message}`);
      return null;
    } finally {
      inflight.delete(k);
    }
  })();
  if (slow) inflight.set(k, job);
  return job;
}

function fallback(r) {
  const loose = matchArchetype(r, { loose: true });
  if (loose) return { asset: validateAsset(loose), why: loose._why };
  return { asset: validateAsset(wispFor(r)), why: 'fallback wisp' };
}

const copy = (a) => structuredClone(a);

/**
 * Like resolveAsset, but also says where the asset came from:
 * {asset, provider, ms, placeholder, why}. provider is a provider name, or 'fallback'.
 */
export async function resolveAssetDetailed(req = {}, opts = {}) {
  const t0 = Date.now();
  const r = { name: clean(req?.name, 60), description: clean(req?.description, 300) };
  if (!r.name && !r.description) r.name = 'wisp';
  const onUpgrade = typeof opts.onUpgrade === 'function' ? opts.onUpgrade : null;
  const budget = opts.budgetMs ?? envInt('ASSET_BUDGET_MS', 50_000);
  const chain = opts.providers ? providerOrder(opts.providers) : providerOrder();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (asset, provider, why, placeholder = false) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      const out = { asset: copy(asset), provider, ms: Date.now() - t0, placeholder, why };
      debug(`"${r.name}" -> ${asset.type}${asset.archetype ? `:${asset.archetype}` : ''} via ${provider} in ${out.ms} ms${placeholder ? ' (placeholder)' : ''}`);
      resolve(out);
      return true;
    };
    const settleFallback = (why, placeholder) => { const f = fallback(r); settle(f.asset, 'fallback', `${why}; ${f.why}`, placeholder); };
    const timer = setTimeout(() => settleFallback(`budget ${budget} ms reached`, true), budget);
    timer.unref?.();

    (async () => {
      for (const p of chain) {
        // The caller already has its answer and nobody is listening for an upgrade: don't start new (possibly paid)
        // jobs. A job already running still finishes and is cached.
        if (settled && !onUpgrade) return;
        if (!(await safeAvailable(p))) { debug(`${p.name} unavailable, skipping`); continue; }
        const slow = p.slow ?? SLOW.has(p.name);
        // Progressive mode: don't make the caller wait on a slow provider unless it's already cached.
        if (slow && onUpgrade && !settled && !cache.has(keyOf(p.name, r))) settleFallback(`progressive: ${p.name} running in background`, true);
        const asset = await runProvider(p, r);
        if (!asset) continue;
        const why = asset.type === 'archetype' ? matchArchetype(r)?._why : undefined;
        if (!settle(asset, p.name, why) && onUpgrade) {
          try { onUpgrade(copy(asset), { provider: p.name, ms: Date.now() - t0 }); }
          catch (e) { console.warn(`[assets] onUpgrade threw: ${e.message}`); }
        }
        return;
      }
      settleFallback('no provider produced an asset', false);
    })().catch((e) => { console.warn(`[assets] resolve failed: ${e.message}`); settleFallback('error', false); });
  });
}

/** Contract entry point: {name, description} -> Asset. Never throws, never returns null. */
export async function resolveAsset(req, opts) {
  try {
    return (await resolveAssetDetailed(req, opts)).asset;
  } catch (e) {
    console.warn(`[assets] resolveAsset failed: ${e.message}`);
    return { type: 'archetype', archetype: 'wisp', params: {} };
  }
}

export default resolveAsset;
