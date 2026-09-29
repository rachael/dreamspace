#!/usr/bin/env node
// Dreamspace server: one process, one port, zero dependencies beyond node built-ins.
//   - static files from the repo root (no-store caching, like serve/serve.mjs; secrets and server code are never served)
//   - the JSON API under /api/* and Server-Sent Events at /api/events, plus its long-poll twin /api/events/poll
//     for clients behind proxies that won't stream (see docs/CONTRACT.md)
//   - the remote MCP endpoint for a claude.ai custom connector at /mcp/<token>
//   - brains (server/brains), asset providers (server/assets), vibe mode (server/vibe.mjs), loaded with
//     dynamic imports so the server still boots, and says so politely, when one of them is missing or broken
//
//   node server/app.mjs                      http://127.0.0.1:8787
//   PORT=18123 DATA_DIR=/tmp/x node server/app.mjs
//
// Env: PORT (8787), HOST (127.0.0.1), DATA_DIR (.data), WORLD_TOKEN (else .env.local, else generated),
//      ENV_FILE (.env.local), WHISPER_URL, OLLAMA_URL, OLLAMA_MODEL, ASSET_PROVIDERS (read by their modules),
//      SSE_PING_MS (15000), BRAIN_TIMEOUT_MS (75000), ASSET_WAIT_MS (4000),
//      BRAINS_ENABLED (comma list; default all: claude,ollama,scripted; the smoke test uses "scripted").

import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, LIMITS } from './world.mjs';
import { transcribe, whisperAvailable } from './stt.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BRAIN_NAMES = ['claude', 'ollama', 'scripted'];
const BRAIN_FILES = { claude: 'claude-code.mjs', ollama: 'ollama.mjs', scripted: 'scripted.mjs' };
const FROM = new Set(['phone', 'xr', 'desktop']);
// Friendly spellings accepted for a brain name (same as server/brains/index.mjs).
const BRAIN_ALIASES = { 'claude-code': 'claude', 'claude code': 'claude', local: 'ollama', qwen: 'ollama', offline: 'scripted' };
const normBrain = (v) => { const s = String(v ?? '').trim().toLowerCase(); return BRAIN_ALIASES[s] || s; };

const SAY = {
  noBrain: 'My thoughts are drifting just out of reach right now. The world is still here with you, so try me again in a moment.',
  timeout: 'I drifted off among the stars for a moment. Could you say that again?',
  error: 'Something flickered in my thoughts. Try me again in a moment.',
  full: `The world is full (${LIMITS.maxObjects} things), so some of it could not appear. Ask me to clear a little space.`,
  busy: 'I am still thinking about what you said before. Give me a moment.',
};

// ------------------------------------------------------------------------------------------------ small helpers

const TIMEOUT = Symbol('timeout');
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((r) => { t = setTimeout(() => r(TIMEOUT), ms); t.unref?.(); }),
  ]);
}
const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 && process.env[k] !== '' ? n : d; };
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, max).join('').trim() : t;
};
let idCounter = 0;
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(++idCounter).toString(36)}${randomBytes(2).toString('hex')}`;
const stamp = () => new Date().toTimeString().slice(0, 8);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch { /* socket gone */ } return; }
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** Read the whole request body (Buffer), refusing more than `limit` bytes with a 413. */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(new HttpError(413, `body too large (max ${limit} bytes)`)); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; chunks.length = 0; req.resume(); reject(new HttpError(413, `body too large (max ${limit} bytes)`)); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolveBody(Buffer.concat(chunks)); } });
    req.on('aborted', () => { if (!done) { done = true; reject(new HttpError(400, 'request aborted')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(new HttpError(400, e.message)); } });
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return undefined;
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

// ------------------------------------------------------------------------------------------------ env + token

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Token: WORLD_TOKEN from the environment, else from the env file (.env.local), else 24 random bytes (base64url)
 * appended to the env file. Other keys in the env file (MESHY_API_KEY, OLLAMA_MODEL...) are loaded into process.env
 * when not already set. ANTHROPIC_* keys are never loaded: Claude runs on her subscription, not the API.
 */
function loadEnvAndToken(envFile, log) {
  const fromEnv = (process.env.WORLD_TOKEN || '').trim();
  let fileVars = {};
  let fileText = '';
  try { fileText = readFileSync(envFile, 'utf8'); fileVars = parseEnvFile(fileText); } catch { /* no env file yet */ }
  for (const [k, v] of Object.entries(fileVars)) {
    if (/^ANTHROPIC_/.test(k)) { log(`ignoring ${k} in ${envFile}: Claude runs on the subscription, never the API`); continue; }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  if (fromEnv) return { token: fromEnv, source: 'environment' };
  if (fileVars.WORLD_TOKEN && fileVars.WORLD_TOKEN.trim()) return { token: fileVars.WORLD_TOKEN.trim(), source: envFile };
  const token = randomBytes(24).toString('base64url');
  try {
    const sepNl = fileText && !fileText.endsWith('\n') ? '\n' : '';
    writeFileSync(envFile, `${fileText}${sepNl}WORLD_TOKEN=${token}\n`, { mode: 0o600 });
    return { token, source: `${envFile} (new)` };
  } catch (e) {
    log(`could not write ${envFile} (${e.message}); using a one-off token for this run`);
    return { token, source: 'generated (not saved)' };
  }
}

// ------------------------------------------------------------------------------------------------ optional modules

/**
 * Import a sibling module if it exists. Missing -> null (retried on the next call). Broken -> null, logged once per
 * file version; editing the file makes the next call try again (cache-busted by mtime).
 */
const importState = new Map();
async function importOptional(rel, log) {
  const url = new URL(rel, import.meta.url);
  const file = fileURLToPath(url);
  let mtime;
  try { mtime = statSync(file).mtimeMs; } catch { return null; }
  const st = importState.get(rel);
  if (st?.mod) return st.mod; // loaded modules stay loaded (they may hold live state such as a claude process)
  if (st?.failedAt === mtime) return null;
  try {
    const mod = await import(`${url.href}?v=${Math.round(mtime)}`);
    importState.set(rel, { mod, mtime });
    return mod;
  } catch (e) {
    importState.set(rel, { failedAt: mtime });
    log(`${rel} failed to load: ${String(e?.stack || e).split('\n').slice(0, 3).join(' | ')}`);
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
// Never served, whatever the URL: dotfiles/dot-dirs (.env.local holds the token, .data, .git), server code, tooling.
const DENY_TOP = new Set(['server', 'scripts', 'serve', 'node_modules', 'models', 'docs', 'captures', 'shots']);
// Files directly in the repo root that may be served (BRIEF.md, CLAUDE.md, package.json... may not).
const ROOT_FILE_OK = /^(?:[\w-]+\.html|[\w-]+\.webmanifest|robots\.txt|[\w-]+\.(?:ico|png|svg|webp|jpg))$/i;

function deniedRel(rel) {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s.startsWith('.') || s.includes('\0'))) return true;
  return segs.length > 0 && DENY_TOP.has(segs[0].toLowerCase());
}

function createStatic({ root, deny = [], log }) {
  const realRoot = realpathSync(root);
  const denyReal = deny.map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });

  function notFound(res, head) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(head ? undefined : '404 not found\n');
    return 404;
  }

  return async function serveStatic(req, res, url) {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('405 method not allowed\n');
      return 405;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return notFound(res, head); }
    if (pathname.includes('\0') || pathname.includes('\\')) return notFound(res, head);
    const rel = posix.normalize(pathname).replace(/^\/+/, '');
    if (rel.startsWith('..') || deniedRel(rel)) return notFound(res, head);
    let file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return notFound(res, head);
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        // /phone -> /phone/ so relative URLs inside the page resolve (the query, e.g. ?t=, is kept)
        const target = `${url.pathname}/${url.search}`;
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
        res.end();
        return 302;
      }
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return notFound(res, head);
    // Only a small allowlist of files directly in the root (index.html, manifests, icons).
    if (relative(root, file).split(sep).length === 1 && !ROOT_FILE_OK.test(relative(root, file))) return notFound(res, head);
    // Resolve symlinks and re-check, so a link can't point outside the root or into a denied place.
    const real = await realpath(file).catch(() => null);
    if (!real || !real.startsWith(realRoot + sep)) return notFound(res, head);
    if (deniedRel(relative(realRoot, real)) || denyReal.some((d) => real === d || real.startsWith(d + sep))) return notFound(res, head);

    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (head) { res.end(); return 200; }
    await new Promise((done) => {
      const stream = createReadStream(file);
      stream.on('error', (e) => { log(`static read failed ${rel}: ${e.message}`); res.destroy(); done(); });
      res.on('close', () => { stream.destroy(); done(); });
      stream.pipe(res);
    });
    return 200;
  };
}

// ------------------------------------------------------------------------------------------------ brains

/**
 * The brain layer. Prefers server/brains/index.mjs when it exposes a way to get a brain by name; otherwise builds
 * each brain from its own module (contract: default async create(ctx) -> {name, available, respond}).
 * Each brain is created once (the claude brain holds a live `claude` process), lazily, on first use.
 */
function createBrainLayer(ctx, { enabled, log }) {
  const instances = new Map(); // name -> brain
  const creating = new Map(); // name -> Promise<brain|null>
  const failedAt = new Map(); // name -> time of the last failed create (retry after a few seconds)
  const availCache = new Map(); // name -> {at, ok}
  let indexApi; // undefined = not decided yet (index.mjs missing so far), null = build brains from their own modules

  async function fromIndex() {
    if (indexApi !== undefined) return indexApi;
    const mod = await importOptional('./brains/index.mjs', log);
    if (!mod) return null; // maybe it appears later; brains built meanwhile come from their own modules
    let api = null;
    try {
      // A registry factory: createBrains(ctx) -> {get(name)} / {brains:{name: brain}}.
      const factory = ['createBrains', 'loadBrains', 'initBrains', 'setupBrains'].map((k) => mod[k]).find((f) => typeof f === 'function');
      if (factory) {
        const reg = await factory(ctx);
        const getter = reg && ['get', 'getBrain', 'brain'].map((k) => reg[k]).find((f) => typeof f === 'function');
        if (getter) api = { get: (n) => getter.call(reg, n), reg };
        else if (reg?.brains && typeof reg.brains === 'object') api = { get: (n) => reg.brains[n] || null, reg };
      }
      // Or a module-level getter: getBrain(name, ctx).
      if (!api && typeof mod.getBrain === 'function') api = { get: (n) => mod.getBrain(n, ctx), reg: mod };
    } catch (e) {
      log(`brains/index.mjs could not build the brains: ${e.message}`);
    }
    indexApi = api;
    return api;
  }

  async function createFromModule(name) {
    const mod = await importOptional(`./brains/${BRAIN_FILES[name]}`, log);
    const create = mod?.default;
    if (typeof create !== 'function') return null;
    return create(ctx);
  }

  async function get(name) {
    if (!BRAIN_NAMES.includes(name) || !enabled(name)) return null;
    if (instances.has(name)) return instances.get(name);
    if (creating.has(name)) return creating.get(name);
    if (Date.now() - (failedAt.get(name) || 0) < 3000) return null;
    const p = (async () => {
      try {
        const api = await fromIndex();
        let brain = api ? await api.get(name) : null;
        if (!api) {
          brain = await createFromModule(name);
          if (brain) indexApi = null; // never mix: a late index.mjs would start a second copy of each brain
        }
        if (brain && typeof brain.respond === 'function') { instances.set(name, brain); return brain; }
      } catch (e) {
        log(`brain "${name}" failed to start: ${e.message}`);
      }
      failedAt.set(name, Date.now());
      return null;
    })().finally(() => creating.delete(name));
    creating.set(name, p);
    return p;
  }

  async function isAvailable(name, { timeoutMs = 2500 } = {}) {
    const hit = availCache.get(name);
    const now = Date.now();
    if (hit && now - hit.at < (hit.ok ? 15000 : 4000)) return hit.ok;
    const brain = await get(name);
    let ok = false;
    let timedOut = false;
    if (brain) {
      try {
        const r = typeof brain.available === 'function' ? await withTimeout(brain.available(), timeoutMs) : true;
        timedOut = r === TIMEOUT;
        ok = r === true;
      } catch { ok = false; }
    }
    if (!timedOut) availCache.set(name, { at: Date.now(), ok }); // a slow first check (claude) isn't a verdict
    return ok;
  }

  /** Requested brain if available, else the user's default, else claude, ollama, scripted. */
  async function pick(requested, preferred) {
    const order = [requested, preferred, ...BRAIN_NAMES].filter((n, i, a) => n && n !== 'auto' && a.indexOf(n) === i);
    for (const name of order) {
      // A chat can wait for a first-time check (claude's can take several seconds); health can't.
      if (await isAvailable(name, { timeoutMs: 13000 })) return { name, brain: instances.get(name) };
    }
    return null;
  }

  async function availability() {
    const out = {};
    const api = await fromIndex();
    if (typeof api?.reg?.health === 'function') {
      // The registry keeps its own cached availability ("never slow").
      const h = await withTimeout(Promise.resolve().then(() => api.reg.health()), 2500).catch(() => null);
      if (h && h !== TIMEOUT && typeof h === 'object') {
        for (const n of BRAIN_NAMES) out[n] = enabled(n) && h[n] === true;
        return out;
      }
    }
    await Promise.all(BRAIN_NAMES.map(async (n) => { out[n] = await isAvailable(n); }));
    return out;
  }

  /** Mirror the user's default into the registry (it warms ollama when that becomes the default). */
  async function setDefault(name) {
    const api = await fromIndex();
    if (typeof api?.reg?.setDefault === 'function') {
      try { api.reg.setDefault(name || 'auto'); } catch (e) { log(`brains: setDefault(${name}) failed: ${e.message}`); }
    }
  }

  function forget(name) { availCache.delete(name); }

  async function close() {
    const all = [...instances.values(), indexApi?.reg].filter(Boolean);
    await Promise.all(all.map(async (b) => {
      for (const k of ['close', 'dispose', 'shutdown', 'stop']) {
        if (typeof b[k] === 'function') { try { await withTimeout(b[k](), 2000); } catch { /* best effort */ } break; }
      }
    }));
  }

  return { get, pick, availability, isAvailable, forget, close, setDefault };
}

// ------------------------------------------------------------------------------------------------ assets

// Used only when server/assets is missing or broken, so a summoned thing still appears as something sensible.
const FALLBACK_ARCHETYPES = [
  [/crystal cluster|crystals|geode/, 'crystal-cluster'], [/crystal|gem|shard|quartz/, 'crystal'],
  [/island|floating rock/, 'floating-island'], [/portal|gate|doorway|arch/, 'portal'], [/lantern|lamp|light/, 'lantern'],
  [/tree|willow|sapling/, 'tree-glow'], [/mushroom|fungus|toadstool/, 'mushroom-glow'], [/rune|standing stone|monolith stone/, 'rune-stone'],
  [/planet|saturn|gas giant/, 'planet'], [/moon/, 'moon'], [/ship|rocket|ufo|spacecraft/, 'spaceship'],
  [/obelisk|pillar|monolith|tower/, 'obelisk'], [/waterfall|fountain|cascade/, 'waterfall-light'],
  [/butterfl|moth|swarm/, 'butterfly-swarm'], [/orb|sphere|ball|bubble/, 'orb'],
];
function fallbackAsset({ name = '', description = '' }) {
  const s = `${name} ${description}`.toLowerCase();
  const hit = FALLBACK_ARCHETYPES.find(([re]) => re.test(s));
  return { type: 'archetype', archetype: hit ? hit[1] : 'wisp', params: {} };
}

// ------------------------------------------------------------------------------------------------ the server

export async function startServer(opts = {}) {
  const log = opts.log || ((...a) => console.log(`[${stamp()}]`, ...a));

  // Env hygiene: this app only ever uses Claude through the logged-in CLI (her subscription), never the API.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    if (process.env[k] !== undefined) { delete process.env[k]; log(`removed ${k} from the environment (subscription only, never the API)`); }
  }

  const envFile = resolve(ROOT, opts.envFile || process.env.ENV_FILE || '.env.local');
  const { token, source: tokenSource } = loadEnvAndToken(envFile, log);
  if (token.length < 16) log('warning: WORLD_TOKEN is short; anyone who guesses it controls the world over the tunnel');
  const cfg = {
    port: opts.port ?? envNum('PORT', 8787),
    host: opts.host || process.env.HOST || '127.0.0.1',
    dataDir: resolve(ROOT, opts.dataDir || process.env.DATA_DIR || '.data'),
    pingMs: Math.max(200, envNum('SSE_PING_MS', 15000)),
    brainTimeoutMs: Math.max(1000, envNum('BRAIN_TIMEOUT_MS', 75000)),
    assetWaitMs: Math.max(200, envNum('ASSET_WAIT_MS', 4000)),
  };
  const enabledSet = process.env.BRAINS_ENABLED
    ? new Set(process.env.BRAINS_ENABLED.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
  const brainEnabled = (n) => !enabledSet || enabledSet.has(n);
  // server/brains/index.mjs filters with BRAINS (and always keeps scripted); keep it in step so it doesn't
  // preload or warm brains this run has switched off.
  if (enabledSet && process.env.BRAINS === undefined) process.env.BRAINS = BRAIN_NAMES.filter((n) => enabledSet.has(n)).join(',') || 'scripted';
  mkdirSync(cfg.dataDir, { recursive: true });

  // Children (the claude brain's MCP server, vibe) must reach *this* app with *this* token.
  process.env.WORLD_TOKEN = token;
  process.env.WORLD_URL = `http://127.0.0.1:${cfg.port}`;

  // ---- world
  const world = createWorld({ file: join(cfg.dataDir, 'world.json'), log: (m) => log(m) });

  // ---- settings (the default brain survives restarts)
  const settingsFile = join(cfg.dataDir, 'settings.json');
  let settings = { brain: 'auto' };
  try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
  const saveSettings = () => { try { writeFileSync(settingsFile, JSON.stringify(settings, null, 1)); } catch (e) { log(`settings save failed: ${e.message}`); } };

  // ---- SSE
  const clients = new Set();
  let eventSeq = 0;
  const history = []; // [{id, role, text}] last 50 chat lines, for brains
  let status = { thinking: false, brain: null };

  function dropClient(c) {
    if (!clients.delete(c)) return;
    try { c.res.end(); } catch { /* gone */ }
  }
  function writeTo(c, chunk) {
    try {
      c.res.write(chunk);
      if (c.res.writableLength > 8 * 1024 * 1024) { log(`sse: dropping a stalled client (${c.from})`); dropClient(c); }
    } catch { dropClient(c); }
  }
  // Recent broadcasts for clients that can't hold an SSE stream open (GET /api/events/poll).
  const RECENT_MAX = 200;
  const recent = []; // [{id, event, data}] oldest first; ids come from eventSeq (gaps are SSE-only snapshot ids)
  const pollWaiters = new Set(); // () => void, woken by the next broadcast
  let wakeTimer = null;
  function wakePollers() {
    // Coalesce a burst (user chat + status + op + reply) into one response per waiter.
    if (wakeTimer || !pollWaiters.size) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      const ws = [...pollWaiters];
      pollWaiters.clear();
      for (const w of ws) { try { w(); } catch { /* gone */ } }
    }, 40);
    wakeTimer.unref?.();
  }
  function broadcast(event, data) {
    const json = JSON.stringify(data ?? null);
    const id = ++eventSeq;
    const chunk = `id: ${id}\nevent: ${event}\ndata: ${json}\n\n`;
    recent.push({ id, event, data: JSON.parse(json) });
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    wakePollers();
    for (const c of clients) writeTo(c, chunk);
    if (event === 'status' && data && typeof data === 'object') status = { ...data }; // vibe reports status too
    if (event === 'chat' && data && typeof data.text === 'string') {
      history.push({ id: data.id, role: data.role === 'user' ? 'user' : 'guide', text: data.text });
      if (history.length > 50) history.splice(0, history.length - 50);
    }
  }
  const pinger = setInterval(() => { for (const c of clients) writeTo(c, ': ping\n\n'); }, cfg.pingMs);
  pinger.unref();

  function setStatus(s) {
    broadcast('status', { thinking: !!s.thinking, brain: s.brain ?? status.brain ?? null, ...(s.detail ? { detail: s.detail } : {}) });
  }

  world.on((op, w) => broadcast('op', { op, world_version: w.version }));

  // ---- the guide speaking without a brain turn (MCP `say`, vibe summaries)
  function sayLine(text, { from = 'guide', brain } = {}) {
    const t = oneLine(text, 600);
    if (!t) return null;
    const msg = { id: newId('s'), role: 'guide', from, text: t, ...(brain ? { brain } : {}) };
    broadcast('chat', msg);
    return msg;
  }

  // ---- asset resolution + ops
  async function assetsModule() { return importOptional('./assets/index.mjs', log); }

  function upgradeLater(getId) {
    // Called with a better asset once a slow provider (parts, meshy) finishes: swap it in if the object is still there.
    return (better) => {
      const id = getId();
      if (!id || !better) return;
      const cur = world.find(id);
      if (!cur) return;
      const res = world.replaceAsset(cur.id, better);
      if (res.ok) log(`asset upgraded: ${cur.id} -> ${res.object.id} (${better.type}${better.archetype ? `:${better.archetype}` : ''})`);
    };
  }

  /** Apply an Op. For `add` without an asset, resolve one first (without letting a slow provider block the reply). */
  async function applyOp(op, meta = {}) {
    const isAdd = op && typeof op === 'object' && !Array.isArray(op) && String(op.type || '').trim().toLowerCase() === 'add';
    if (!isAdd || op.asset) return world.apply(op, meta);
    if (world.count() >= LIMITS.maxObjects) return world.apply(op, meta); // the "world is full" answer, no generation
    const req = { name: oneLine(op.name, LIMITS.name), description: oneLine(op.description, LIMITS.description) };
    if (!req.name && !req.description) return world.apply(op, meta);
    let objectId = null;
    let early = null; // an upgrade that arrived before the object existed
    const onUpgrade = (a) => { if (objectId) upgradeLater(() => objectId)(a); else early = a; };
    const mod = await assetsModule();
    let pending;
    if (typeof mod?.resolveAsset === 'function') {
      pending = Promise.resolve().then(() => mod.resolveAsset(req, { onUpgrade })).catch((e) => { log(`resolveAsset failed: ${e.message}`); return null; });
    } else {
      pending = Promise.resolve(fallbackAsset(req));
    }
    let asset = await withTimeout(pending, cfg.assetWaitMs);
    let placeholder = false;
    if (asset === TIMEOUT) { placeholder = true; asset = { type: 'archetype', archetype: 'wisp', params: { pending: true } }; }
    if (!asset) asset = fallbackAsset(req);
    const res = world.apply({ ...op, asset }, meta);
    if (res.ok) {
      objectId = res.object.id;
      if (placeholder) pending.then((late) => { if (late && !(late.type === 'archetype' && late.archetype === 'wisp')) onUpgrade(late); });
      if (early) onUpgrade(early);
    }
    return res;
  }

  // ---- brains
  const ctx = {
    root: ROOT,
    dataDir: cfg.dataDir,
    port: cfg.port,
    host: cfg.host,
    token,
    worldUrl: process.env.WORLD_URL,
    creationsDir: join(ROOT, 'creations'),
    world: {
      get: () => world.get(),
      describe: () => world.describe(),
      on: (fn) => world.on(fn),
      find: (id) => world.find(id),
      count: () => world.count(),
      apply: (op, meta) => applyOp(op, meta), // async: resolves assets for `add`
    },
    applyOp,
    broadcast,
    emit: broadcast,
    say: async (text, extra = {}) => sayLine(text, { from: extra.from || 'claude.ai', brain: extra.brain || 'claude' }),
    setStatus,
    readBody,
    readJson,
    sendJson,
    log: (...a) => log(...a),
    history: () => history.slice(-12).map(({ role, text }) => ({ role, text })),
  };
  const brains = createBrainLayer(ctx, { enabled: brainEnabled, log });
  if (settings.brain && settings.brain !== 'auto') brains.setDefault(settings.brain).catch(() => {});

  function worldForBrain() {
    const snap = world.get();
    Object.defineProperty(snap, 'describe', { value: () => world.describe(), enumerable: false });
    return snap;
  }

  function normalizeResult(r) {
    if (typeof r === 'string') return { reply: r, ops: [] };
    if (!r || typeof r !== 'object') return { reply: '', ops: [] };
    const reply = typeof r.reply === 'string' ? r.reply : typeof r.text === 'string' ? r.text : '';
    const ops = Array.isArray(r.ops) ? r.ops.filter((o) => o && typeof o === 'object' && !Array.isArray(o)).slice(0, 12) : [];
    return { reply, ops, brain: typeof r.brain === 'string' ? r.brain : null };
  }

  let queueDepth = 0;
  let chain = Promise.resolve();
  function enqueue(job) {
    queueDepth++;
    chain = chain.then(job).catch((e) => log(`chat job failed: ${e.stack || e.message}`)).finally(() => { queueDepth--; });
  }

  async function runChat({ id, text, from, requested }) {
    const prior = history.filter((h) => h.id !== id).slice(-12).map(({ role, text: t }) => ({ role, text: t }));
    const guideLine = (t, brain) => broadcast('chat', { id: `${id}-r`, role: 'guide', from, text: t, ...(brain ? { brain } : {}), replyTo: id });

    const picked = await brains.pick(requested, settings.brain);
    if (!picked) {
      log('chat: no brain is available');
      guideLine(SAY.noBrain);
      broadcast('error', { message: 'No brain is available (claude, ollama and scripted all unavailable).' });
      setStatus({ thinking: false, brain: null });
      return;
    }
    let brainName = picked.name;
    setStatus({ thinking: true, brain: brainName, detail: 'thinking' });
    const t0 = Date.now();
    const onStatus = (st) => { if (st && typeof st === 'object') setStatus({ thinking: st.thinking !== false, brain: st.brain || brainName, detail: st.detail }); };
    const input = { text, history: prior, world: worldForBrain(), from, onStatus };
    let result;
    let reply = '';
    try {
      result = await withTimeout(picked.brain.respond(input), cfg.brainTimeoutMs);
      if (result === TIMEOUT) { log(`chat: ${brainName} timed out after ${cfg.brainTimeoutMs} ms`); reply = SAY.timeout; result = null; }
    } catch (e) {
      log(`chat: ${brainName} failed: ${e.message}`);
      brains.forget(brainName);
      result = null;
      reply = SAY.error;
      // A gentle rescue: the offline brain answers rather than leaving the user hanging.
      if (brainName !== 'scripted' && await brains.isAvailable('scripted')) {
        try {
          const alt = await withTimeout((await brains.get('scripted')).respond({ ...input, world: worldForBrain() }), 5000);
          if (alt !== TIMEOUT && alt) { result = alt; brainName = 'scripted'; reply = ''; }
        } catch { /* keep the friendly error */ }
      }
    }
    const norm = normalizeResult(result);
    if (norm.brain && BRAIN_NAMES.includes(norm.brain)) brainName = norm.brain;
    reply = reply || norm.reply;

    let full = false;
    if (norm.ops.length) {
      setStatus({ thinking: true, brain: brainName, detail: 'shaping the world' });
      for (const op of norm.ops) {
        const r = await applyOp(op, { createdBy: 'guide' });
        if (!r.ok) {
          log(`chat: dropped ${op.type || '?'} op from ${brainName}: ${r.error}`);
          if (/full/.test(r.error || '')) full = true;
        }
      }
    }
    let spoken = oneLine(reply, 800);
    if (full) spoken = spoken ? `${spoken} ${SAY.full}` : SAY.full;
    if (!spoken) spoken = norm.ops.length ? 'There you go.' : "I'm here with you.";
    guideLine(spoken, brainName);
    setStatus({ thinking: false, brain: brainName });
    log(`chat: ${brainName} answered in ${Date.now() - t0} ms with ${norm.ops.length} op(s)`);
  }

  // ---- health (public; cached so polling through the tunnel stays cheap)
  let healthCache = { at: 0, body: null, pending: null };
  async function health() {
    if (Date.now() - healthCache.at < 2000 && healthCache.body) return healthCache.body;
    if (healthCache.pending) return healthCache.pending;
    healthCache.pending = (async () => {
      const [b, whisper, assets] = await Promise.all([
        brains.availability(),
        whisperAvailable({ timeoutMs: 1500 }).catch(() => false),
        (async () => {
          const mod = await assetsModule();
          if (typeof mod?.availableAssetProviders === 'function') {
            const r = await withTimeout(mod.availableAssetProviders(), 2500).catch(() => TIMEOUT);
            if (Array.isArray(r)) return r;
          }
          return mod ? ['archetype'] : ['builtin'];
        })(),
      ]);
      const body = {
        ok: true,
        brains: { ollama: !!b.ollama, claude: !!b.claude, scripted: !!b.scripted },
        stt: { whisper: !!whisper },
        assets,
        brain: settings.brain || 'auto',
        version: world.get().version,
        vibe: !!(await importOptional('./vibe.mjs', log))?.handleVibe,
      };
      healthCache = { at: Date.now(), body, pending: null };
      return body;
    })().catch((e) => { healthCache.pending = null; throw e; });
    return healthCache.pending;
  }

  // ---- auth
  const tokenHash = createHash('sha256').update(token).digest();
  const tokenOk = (candidate) => typeof candidate === 'string' && candidate.length > 0 && candidate.length < 512
    && timingSafeEqual(createHash('sha256').update(candidate).digest(), tokenHash);
  function requestToken(req, url) {
    const h = req.headers['x-world-token'];
    if (typeof h === 'string' && h) return h.trim();
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    return url.searchParams.get('t') || '';
  }
  const redact = (s) => String(s).split(token).join('***').replace(/([?&]t=)[^&]*/g, '$1***');

  // ---- routes
  const routes = {
    'GET /api/health': async (req, res) => sendJson(res, 200, await health()),

    'GET /api/world': async (req, res) => sendJson(res, 200, world.get()),

    'GET /api/events': async (req, res, url) => {
      if (clients.size >= 100) return sendJson(res, 503, { error: 'too many listeners' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders?.();
      req.socket.setNoDelay?.(true);
      req.socket.setKeepAlive?.(true, 30000);
      req.socket.setTimeout?.(0);
      const client = { res, from: oneLine(url.searchParams.get('from') || 'client', 20) };
      // First bytes right away (with padding past any proxy buffer), then the snapshot, always first.
      res.write(`retry: 3000\n: open ${' '.repeat(2048)}\n\n`);
      res.write(`id: ${++eventSeq}\nevent: snapshot\ndata: ${JSON.stringify(world.get())}\n\n`);
      if (status.thinking) res.write(`id: ${++eventSeq}\nevent: status\ndata: ${JSON.stringify(status)}\n\n`);
      clients.add(client);
      const bye = () => dropClient(client);
      res.on('close', bye);
      res.on('error', bye);
      return 'sse';
    },

    // Polling twin of /api/events for clients whose proxy won't stream (see docs/CONTRACT.md).
    //   ?from=<last id seen>&wait=<ms, <= 20000>  ->  {events:[{id, event, data}], last}
    //   no `from`, a `from` older than the buffer, or one from before a server restart  ->  {snapshot, status, last}
    // With `wait`, an empty answer is held until the next broadcast (or the wait runs out): near-real-time via the tunnel.
    'GET /api/events/poll': async (req, res, url) => {
      const fromRaw = url.searchParams.get('from');
      const from = fromRaw === null || fromRaw === '' ? NaN : Number(fromRaw);
      const wait = Math.min(20000, Math.max(0, Math.floor(Number(url.searchParams.get('wait')) || 0)));
      const oldest = recent.length ? recent[0].id : eventSeq + 1;
      if (!Number.isInteger(from) || from < 0 || from > eventSeq || from < oldest - 1) {
        return sendJson(res, 200, { snapshot: world.get(), status: { ...status }, last: eventSeq });
      }
      const newer = () => recent.filter((e) => e.id > from);
      let events = newer();
      if (!events.length && wait > 0) {
        if (pollWaiters.size >= 200) return sendJson(res, 503, { error: 'too many listeners' });
        req.socket.setTimeout?.(0);
        await new Promise((done) => {
          let t = null;
          const finish = () => { clearTimeout(t); pollWaiters.delete(finish); res.off('close', finish); done(); };
          t = setTimeout(finish, wait);
          pollWaiters.add(finish);
          res.on('close', finish);
        });
        if (res.destroyed || res.writableEnded) return 'poll-gone';
        // The buffer may have rolled past `from` during a very long burst: hand back a snapshot then.
        if (recent.length && recent[0].id > from + 1) return sendJson(res, 200, { snapshot: world.get(), status: { ...status }, last: eventSeq });
        events = newer();
      }
      sendJson(res, 200, { events, last: events.length ? events[events.length - 1].id : eventSeq });
    },

    'POST /api/chat': async (req, res) => {
      const body = await readJson(req, 64 * 1024);
      const text = oneLine(body?.text, 2000);
      if (!text) return sendJson(res, 400, { error: 'text is required' });
      const from = FROM.has(body?.from) ? body.from : 'desktop';
      let requested = null;
      if (body?.brain !== undefined && body?.brain !== null && body?.brain !== '') {
        requested = normBrain(body.brain);
        if (requested !== 'auto' && !BRAIN_NAMES.includes(requested)) return sendJson(res, 400, { error: `unknown brain "${oneLine(body.brain, 30)}" (use ${BRAIN_NAMES.join(', ')})` });
      }
      if (queueDepth >= 6) return sendJson(res, 429, { error: SAY.busy });
      const id = newId('m');
      sendJson(res, 202, { id });
      broadcast('chat', { id, role: 'user', from, text });
      enqueue(() => runChat({ id, text, from, requested }));
    },

    'POST /api/op': async (req, res) => {
      const body = await readJson(req, 256 * 1024);
      const actor = String(req.headers['x-world-actor'] || '').toLowerCase();
      const createdBy = actor === 'guide' || body?.createdBy === 'guide' ? 'guide' : 'user';
      const r = await applyOp(body, { createdBy });
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
      sendJson(res, 200, { ok: true, world: r.world, op: r.op, ...(r.object ? { object: r.object } : {}) });
    },

    'POST /api/brain': async (req, res) => {
      const body = await readJson(req, 16 * 1024);
      const b = normBrain(body?.brain);
      if (b !== 'auto' && !BRAIN_NAMES.includes(b)) return sendJson(res, 400, { error: `brain must be one of ${BRAIN_NAMES.join(', ')}, or auto` });
      settings.brain = b;
      saveSettings();
      await brains.setDefault(b);
      healthCache.at = 0;
      const available = b === 'auto' ? true : await brains.isAvailable(b);
      sendJson(res, 200, { brain: b, available });
      if (!status.thinking) setStatus({ thinking: false, brain: b, detail: 'brain changed' });
    },

    'POST /api/say': async (req, res) => {
      const body = await readJson(req, 16 * 1024);
      const from = oneLine(body?.from || 'guide', 20);
      const brain = typeof body?.brain === 'string' ? oneLine(body.brain, 20)
        : ['mcp', 'claude', 'claude.ai'].includes(from) ? 'claude' : undefined;
      const msg = sayLine(body?.text, { from, brain });
      if (!msg) return sendJson(res, 400, { error: 'text is required' });
      sendJson(res, 200, { ok: true, id: msg.id });
    },

    'POST /api/stt': async (req, res) => {
      const contentType = String(req.headers['content-type'] || '');
      const buf = await readBody(req, 15 * 1024 * 1024);
      if (!buf.length) return sendJson(res, 400, { error: 'empty audio body' });
      try {
        const text = await transcribe(buf, { contentType });
        sendJson(res, 200, { text });
      } catch (e) {
        const code = e.status || 502;
        if (code !== 503) log(`stt: ${e.message}`);
        sendJson(res, code, { error: e.message });
      }
    },

    'POST /api/vibe': (req, res) => vibeHandler(req, res),
    'GET /api/vibe': (req, res) => vibeHandler(req, res), // vibe status {busy, ...}

    'GET /api/creations': async (req, res) => {
      const mod = await importOptional('./vibe.mjs', log);
      if (typeof mod?.listCreations !== 'function') return sendJson(res, 503, { error: 'Vibe mode is not available right now.' });
      sendJson(res, 200, await mod.listCreations(ctx));
    },
  };
  async function vibeHandler(req, res) {
    const mod = await importOptional('./vibe.mjs', log);
    if (typeof mod?.handleVibe !== 'function') return sendJson(res, 503, { error: 'Vibe mode is not available right now.' });
    await mod.handleVibe(req, res, ctx); // reads its own body
  }
  const knownPaths = new Map();
  for (const key of Object.keys(routes)) {
    const [m, p] = key.split(' ');
    knownPaths.set(p, [...(knownPaths.get(p) || []), m]);
  }

  async function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      const methods = knownPaths.get(url.pathname);
      if (methods) return sendJson(res, 405, { error: 'method not allowed' }, { Allow: methods.join(', ') });
      return sendJson(res, 404, { error: 'not found' });
    }
    if (key !== 'GET /api/health' && !tokenOk(requestToken(req, url))) return sendJson(res, 401, { error: 'unauthorized' });
    return route(req, res, url);
  }

  async function handleMcpRoute(req, res, url) {
    // The token rides in the path (/mcp/<token>) because claude.ai connectors can't add headers.
    const segs = url.pathname.split('/').filter(Boolean);
    let candidate = '';
    try { candidate = decodeURIComponent(segs[1] || ''); } catch { candidate = ''; }
    if (!tokenOk(candidate)) return sendJson(res, 401, { error: 'unauthorized' });
    const mod = await importOptional('./mcp/http.mjs', log);
    if (typeof mod?.handleMcp !== 'function') {
      return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'The world MCP endpoint is not available right now.' }, id: null });
    }
    await mod.handleMcp(req, res, { ...ctx, from: 'claude.ai' });
  }

  const serveStatic = createStatic({ root: ROOT, deny: [cfg.dataDir, envFile], log });

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    let url;
    try { url = new URL(req.url || '/', 'http://local'); } catch { res.writeHead(400); res.end(); return; }
    const p = url.pathname;
    const isApi = p === '/api' || p.startsWith('/api/');
    const isMcp = p === '/mcp' || p.startsWith('/mcp/');
    let outcome;
    try {
      if (isApi) outcome = await handleApi(req, res, url);
      else if (isMcp) outcome = await handleMcpRoute(req, res, url);
      else outcome = await serveStatic(req, res, url);
    } catch (e) {
      const code = e instanceof HttpError ? e.status : 500;
      if (code === 500) log(`error ${req.method} ${redact(req.url)}: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, code, { error: code === 500 ? 'internal error' : e.message }, code === 413 ? { Connection: 'close' } : {});
      else try { res.end(); } catch { /* gone */ }
    } finally {
      const quiet = p === '/api/health' || (p === '/api/events/poll' && res.statusCode < 400) || (!isApi && !isMcp && (res.statusCode < 400));
      if (outcome === 'sse') log(`sse open (${clients.size} listening)`);
      else if (!quiet) log(`${res.statusCode} ${req.method} ${redact(req.url)} ${Date.now() - t0}ms`);
    }
  });
  // Behind cloudflared the proxy reuses idle connections; keep ours open longer than it does to avoid 502s.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(cfg.port, cfg.host, () => { server.off('error', fail); ok(); });
  });
  const port = server.address().port;
  if (port !== cfg.port) {
    process.env.WORLD_URL = `http://127.0.0.1:${port}`;
    ctx.port = port;
    ctx.worldUrl = process.env.WORLD_URL;
  }
  server.on('error', (e) => log(`server error: ${e.message}`));

  const base = `http://${cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host}:${port}`;
  log(`Dreamspace listening on ${base}  (root ${ROOT}, data ${cfg.dataDir}, token from ${tokenSource})`);
  log(`  viewer  ${base}/?t=${token}`);
  log(`  phone   ${base}/phone/?t=${token}`);
  log(`  mcp     ${base}/mcp/${token}   (for a claude.ai connector, use the public tunnel URL)`);
  health().then((h) => {
    const on = Object.entries(h.brains).filter(([, v]) => v).map(([k]) => k);
    log(`  brains  ${on.length ? on.join(', ') : 'none available'}${enabledSet ? ` (enabled: ${[...enabledSet].join(', ')})` : ''}; default ${settings.brain}`);
    log(`  stt     whisper ${h.stt.whisper ? 'ready' : `not running at ${process.env.WHISPER_URL || 'http://127.0.0.1:8178'}`}; assets ${h.assets.join(', ')}`);
  }).catch(() => {});

  // ---- shutdown
  let closing = null;
  async function close(reason = 'close') {
    if (closing) return closing;
    closing = (async () => {
      log(`shutting down (${reason})`);
      clearInterval(pinger);
      clearTimeout(wakeTimer);
      for (const w of [...pollWaiters]) { try { w(); } catch { /* gone */ } }
      world.flush();
      for (const c of [...clients]) dropClient(c);
      server.close();
      server.closeAllConnections?.();
      await withTimeout(brains.close(), 3000);
      const vibe = importState.get('./vibe.mjs')?.mod;
      for (const k of ['closeVibe', 'close', 'dispose', 'shutdown']) {
        if (typeof vibe?.[k] === 'function') { try { await withTimeout(vibe[k](), 2000); } catch { /* best effort */ } break; }
      }
    })();
    return closing;
  }

  return { server, port, url: base, token, ctx, world, close };
}

// ------------------------------------------------------------------------------------------------ main

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const log = (...a) => console.log(`[${stamp()}]`, ...a);
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));
  process.on('uncaughtException', (e) => log(`uncaught exception: ${e?.stack || e}`));
  startServer({ log }).then((app) => {
    const stop = (sig) => { app.close(sig).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGHUP', () => stop('SIGHUP'));
    process.on('exit', () => { try { app.world.flush(); } catch { /* best effort */ } });
  }).catch((e) => {
    if (e?.code === 'EADDRINUSE') console.error(`Port ${e.port ?? process.env.PORT ?? 8787} is busy: something else is already serving it. Stop it or run with PORT=<another>.`);
    else console.error(e?.stack || e);
    process.exit(1);
  });
}

export { ROOT, fallbackAsset };
