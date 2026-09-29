// Meshy asset provider: text -> textured GLB via the Meshy text-to-3D API. Inactive unless MESHY_API_KEY is set
// (available() is false without it; nothing here ever talks to Meshy without a key).
//
// API (https://docs.meshy.ai/en/api/text-to-3d, checked 2026-09-24):
//   Base https://api.meshy.ai   Header: Authorization: Bearer <MESHY_API_KEY>
//   1. POST /openapi/v2/text-to-3d  {mode:'preview', prompt (<= 800 chars), ai_model, should_remesh, topology,
//        target_polycount, target_formats:['glb'], origin_at:'bottom'}                          -> {result: '<taskId>'}
//   2. GET  /openapi/v2/text-to-3d/<taskId>
//        -> {id, type, status: PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED, progress 0-100,
//            model_urls:{glb, fbx, obj, usdz, ...}, thumbnail_url, texture_urls, task_error:{message}, consumed_credits}
//        Poll until SUCCEEDED. PENDING/IN_PROGRESS mean "still running"; any other status is a failure.
//        (GET .../<taskId>/stream is an SSE alternative; polling is simpler and has nothing to keep alive.)
//      The preview is untextured geometry.
//   3. POST /openapi/v2/text-to-3d  {mode:'refine', preview_task_id, enable_pbr, texture_prompt (<= 800),
//        target_formats:['glb']}                                                                -> {result: '<refineId>'}
//   4. Poll the refine task the same way -> model_urls.glb, a signed, time-limited URL (files are kept 3 days on
//      non-Enterprise plans).
//   5. Download the GLB into assets/meshy/ (served statically by server/app.mjs): same-origin for GLTFLoader (no CORS
//      question) and it outlives the signed URL. Returns {type:'glb', url:'/assets/meshy/<slug>-<hash>.glb'}.
//   Errors (body {message}): 400 bad params, 401 bad key, 402 out of credits, 403 forbidden, 404 no such task,
//   429 RateLimitExceeded (20 req/s) or NoMoreConcurrentTasks (Pro queue: 10), 5xx server.
//   Test mode: third-party guides cite a free Meshy test key (msy_dummy_api_key_for_test_mode_12345678), but the
//   live API answered 401 "Invalid API key" to it on 2026-09-24, and docs.meshy.ai doesn't mention it. So the success
//   path of this file is verified only against a local mock of the endpoints above; the 401/cooldown path was
//   verified against the real API. Never ship any key as a default.
//
// Cost safety: the file name is a hash of everything sent to Meshy, and an existing file is reused without calling
// the API, so the same request never costs credits twice (even across restarts). Identical requests in flight are
// deduped in index.mjs; at most MESHY_CONCURRENCY jobs run at once.
//
// Env: MESHY_API_KEY (required), MESHY_BASE_URL, MESHY_AI_MODEL (latest), MESHY_POLYCOUNT (12000), MESHY_REFINE (1;
// 0 = stop at the untextured preview), MESHY_PBR (0), MESHY_TIMEOUT_MS (360000, both stages), MESHY_POLL_MS (4000),
// MESHY_ASSET_DIR (<repo>/assets/meshy), MESHY_PUBLIC_PATH (derived from the dir), MESHY_MAX_MB (40),
// MESHY_CONCURRENCY (2), MESHY_STYLE (appended to every prompt).
// Ops: add assets/meshy/ to .gitignore unless she wants generated models committed.

import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TASKS = '/openapi/v2/text-to-3d';
const DEFAULT_STYLE = 'stylized game asset, single object, clean readable silhouette, soft glowing accents, calm sci-fi fantasy';
const TEXTURE_STYLE = 'soft bioluminescent glow, twilight palette of teal, violet and amber, gentle emissive details';

const env = (k, d) => (process.env[k] ?? '').trim() || d;
const envInt = (k, d) => { const v = Number.parseInt(process.env[k] ?? '', 10); return Number.isFinite(v) && v >= 0 ? v : d; };
const envOn = (k, d) => { const v = (process.env[k] ?? '').trim().toLowerCase(); return v ? !['0', 'false', 'no', 'off'].includes(v) : d; };
const key = () => (process.env.MESHY_API_KEY || '').trim();
const base = () => env('MESHY_BASE_URL', 'https://api.meshy.ai').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

class MeshyError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

// ---- cooldown after auth/billing failures (no point retrying every add) ----------------------------------------
let disabledUntil = 0;
let disabledWhy = '';
function disable(ms, why) {
  disabledUntil = Date.now() + ms; disabledWhy = why;
  console.warn(`[assets] meshy disabled for ${Math.round(ms / 60000)} min: ${why}`);
}

// ---- tiny semaphore -------------------------------------------------------------------------------------------
let running = 0;
const waiters = [];
async function acquire() {
  const max = Math.max(1, envInt('MESHY_CONCURRENCY', 2));
  while (running >= max) await new Promise((r) => waiters.push(r));
  running++;
}
function release() { running--; waiters.shift()?.(); }

// ---- HTTP with retries for 429 / 5xx / network blips ------------------------------------------------------------
async function api(method, p, body) {
  const delays = [2000, 5000, 12000];
  for (let attempt = 0; ; attempt++) {
    let res, data;
    try {
      res = await fetch(`${base()}${p}`, {
        method,
        headers: { authorization: `Bearer ${key()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    } catch (e) {
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      throw new MeshyError(`network: ${e.message}`, 0);
    }
    if (res.ok) return data;
    const msg = data?.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) { disable(30 * 60_000, `auth (${res.status}: ${msg})`); throw new MeshyError(msg, res.status, data); }
    if (res.status === 402) { disable(30 * 60_000, `out of credits (${msg})`); throw new MeshyError(msg, res.status, data); }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < delays.length) {
      const wait = /NoMoreConcurrentTasks/i.test(msg) ? 15_000 : delays[attempt];
      await sleep(wait);
      continue;
    }
    throw new MeshyError(`${method} ${p}: ${res.status} ${msg}`, res.status, data);
  }
}

async function createTask(body) {
  const data = await api('POST', TASKS, body);
  const id = data?.result;
  if (typeof id !== 'string' || !id) throw new MeshyError('create task: no task id in response', 0, data);
  return id;
}

async function waitTask(id, deadline, label) {
  const every = Math.max(1000, envInt('MESHY_POLL_MS', 4000));
  let last = -1;
  for (;;) {
    const t = await api('GET', `${TASKS}/${encodeURIComponent(id)}`);
    const status = String(t?.status || '').toUpperCase();
    if (status === 'SUCCEEDED') return t;
    if (status !== 'PENDING' && status !== 'IN_PROGRESS') {
      throw new MeshyError(`${label} task ${status || 'UNKNOWN'}: ${t?.task_error?.message || 'no detail'}`, 0, t);
    }
    if (process.env.ASSET_DEBUG && t.progress !== last) { last = t.progress; console.log(`[assets] meshy ${label} ${id}: ${status} ${t.progress ?? 0}%`); }
    if (Date.now() + every > deadline) throw new MeshyError(`${label} timed out (${status} ${t.progress ?? 0}%)`, 0, t);
    await sleep(every);
  }
}

// ---- storage ------------------------------------------------------------------------------------------------
function storage() {
  const dir = path.resolve(ROOT, env('MESHY_ASSET_DIR', 'assets/meshy'));
  let pub = env('MESHY_PUBLIC_PATH', '');
  if (!pub) {
    const rel = path.relative(ROOT, dir);
    pub = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `/${rel.split(path.sep).join('/')}` : '';
  }
  return { dir, pub: pub.replace(/\/+$/, '') };
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';
const exists = async (f) => { try { return (await stat(f)).size > 0; } catch { return false; } };

async function download(url, file) {
  const maxBytes = envInt('MESHY_MAX_MB', 40) * 1024 * 1024;
  let lastErr;
  for (const wait of [0, 2000, 6000]) {
    if (wait) await sleep(wait);
    try {
      // Signed URL: no Authorization header (it's usually a different host, and signed URLs reject extra auth).
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new Error(`GLB too large (${len} bytes > ${maxBytes})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`GLB too large (${buf.length} bytes)`);
      if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a GLB (bad magic bytes)');
      const tmp = `${file}.${process.pid}.${Date.now()}.part`;
      await writeFile(tmp, buf);
      await rename(tmp, file).catch(async (e) => { await unlink(tmp).catch(() => {}); throw e; });
      return buf.length;
    } catch (e) { lastErr = e; if (/too large|not a GLB/.test(e.message)) break; }
  }
  throw new MeshyError(`download failed: ${lastErr?.message}`, 0);
}

// Refine task ids by request hash: if a download fails after Meshy finished, a retry re-downloads instead of
// paying for a new generation (for the life of the process).
const finished = new Map();

function buildRequest(name, description) {
  const style = env('MESHY_STYLE', DEFAULT_STYLE);
  const subject = description && description.toLowerCase() !== name.toLowerCase() ? `${name}: ${description}` : name || description;
  const prompt = clip(`${subject}. ${style}`, 800);
  const texture_prompt = clip(`${description || name}. ${TEXTURE_STYLE}`, 800);
  const refine = envOn('MESHY_REFINE', true);
  const preview = {
    mode: 'preview', prompt, ai_model: env('MESHY_AI_MODEL', 'latest'), should_remesh: true, topology: 'triangle',
    target_polycount: Math.min(300_000, Math.max(100, envInt('MESHY_POLYCOUNT', 12_000))),
    target_formats: ['glb'], origin_at: 'bottom',
  };
  const refineBody = refine ? { mode: 'refine', enable_pbr: envOn('MESHY_PBR', false), texture_prompt, target_formats: ['glb'] } : null;
  const hash = createHash('sha256').update(JSON.stringify({ preview, refineBody })).digest('hex').slice(0, 12);
  return { preview, refineBody, hash };
}

async function generate({ name = '', description = '' } = {}) {
  if (!key()) return null;
  if (Date.now() < disabledUntil) return null;
  name = String(name).slice(0, 60).trim(); description = String(description).slice(0, 300).trim();
  if (!name && !description) return null;

  const { preview, refineBody, hash } = buildRequest(name, description);
  const { dir, pub } = storage();
  const fileName = `${slugify(name || description)}-${hash}.glb`;
  const file = path.join(dir, fileName);
  const local = pub ? `${pub}/${fileName}` : null;
  if (local && await exists(file)) return { type: 'glb', url: local };      // already paid for: reuse

  await acquire();
  try {
    if (local && await exists(file)) return { type: 'glb', url: local };
    const deadline = Date.now() + envInt('MESHY_TIMEOUT_MS', 360_000);
    let done = finished.get(hash);
    if (!done) {
      const previewId = await createTask(preview);
      const pv = await waitTask(previewId, deadline, 'preview');
      done = pv;
      if (refineBody) {
        const refineId = await createTask({ ...refineBody, preview_task_id: previewId });
        done = await waitTask(refineId, deadline, 'refine');
      }
      finished.set(hash, done);
    }
    const glb = done?.model_urls?.glb;
    // https only; plain http is accepted only when MESHY_BASE_URL itself is http (a local mock in tests).
    const okScheme = /^https:\/\//i.test(glb ?? '') || (/^http:\/\//i.test(glb ?? '') && /^http:\/\//i.test(base()));
    if (typeof glb !== 'string' || !okScheme) throw new MeshyError('task has no https glb url', 0, done);
    if (!local) {
      console.warn('[assets] meshy: MESHY_ASSET_DIR is outside the served root and MESHY_PUBLIC_PATH is unset; returning the signed Meshy URL (expires, may hit CORS)');
      return { type: 'glb', url: glb };
    }
    await mkdir(dir, { recursive: true });
    const bytes = await download(glb, file);
    finished.delete(hash);
    if (process.env.ASSET_DEBUG) console.log(`[assets] meshy saved ${fileName} (${(bytes / 1048576).toFixed(1)} MB, ${done.consumed_credits ?? '?'} credits)`);
    return { type: 'glb', url: local };
  } catch (e) {
    console.warn(`[assets] meshy failed for "${name}": ${e.message}`);
    return null;
  } finally {
    release();
  }
}

export default {
  name: 'meshy',
  slow: true,
  available: async () => !!key() && Date.now() >= disabledUntil,
  generate,
};

/** For logs and /api/health detail. */
export function meshyStatus() {
  return { configured: !!key(), disabled: Date.now() < disabledUntil ? disabledWhy : null, running, queued: waiters.length };
}
