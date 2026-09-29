#!/usr/bin/env node
// scripts/up.mjs: bring Dreamspace up with one command.   npm run up
//
//   1. ollama    answering? If not, start `ollama serve`. Warm the model in the background (first load can take ~60 s).
//   2. whisper   download models/ggml-base.en.bin once (~148 MB, SHA-1 checked), then whisper-server --convert (speech-to-text).
//   3. the app   node server/app.mjs on :8787, with the token from .env.local (made on first run).
//   4. tunnel    a cloudflared quick tunnel (free, no account): a public https URL for the phone, the Quest and claude.ai.
//   5. checks    health, live events (SSE) and MCP *through* the public URL, so a broken tunnel shows now, not mid-demo.
//   6. prints    the phone, viewer, Quest and claude.ai connector URLs, and a QR code for the phone.
//
//   npm run up -- --local          no tunnel: this Mac, plus a Quest over USB
//   npm run up -- --no-whisper     skip speech-to-text (voice falls back to the browser's own, or text)
//   npm run up -- --no-ollama      don't start or warm ollama
//   npm run up -- --port 8788      another app port
//
// Keys: u = URLs and QR again, o = open the viewer on a USB headset, q or Ctrl+C = stop.
// It stops only what it started: an ollama or whisper-server that was already running keeps running.
// Logs: <DATA_DIR>/logs/{app,whisper,cloudflared,ollama}.log
//
// Env (all optional): PORT, DATA_DIR, ENV_FILE, WORLD_TOKEN, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_KEEP_ALIVE, WHISPER_URL,
//   WHISPER_MODEL (path), WHISPER_MODEL_URL, CLOUDFLARED_BIN, TUNNEL_TRANSPORT_PROTOCOL=http2 (cloudflared's own
//   variable, for networks that block UDP/QUIC). Node built-ins only, including the QR encoder at the bottom.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  accessSync, constants as FS, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const WHISPER_MODEL = {
  file: 'models/ggml-base.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  bytes: 147_964_211,
  sha1: '137c40403d78fd54d454da0f9bd998f78703390c',
};

// ------------------------------------------------------------------------------------------------ output

const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  teal: paint('38;5;116'), violet: paint('38;5;147'), amber: paint('38;5;222'), rose: paint('38;5;174'),
  dim: paint('38;5;244'), bold: paint('1'),
};
// If the terminal goes away (window closed, pipe reader gone), writes fail with EPIPE. Swallow that so shutdown
// still runs and stops every child, instead of error handlers writing about write errors forever.
let outputGone = false;
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => { outputGone = true; });
const write = (s) => { if (!outputGone) { try { process.stdout.write(s); } catch { outputGone = true; } } };
const say = (s = '') => write(`${s}\n`);
const ok = (s) => say(`  ${c.teal('✓')} ${s}`);
const step = (s) => say(`  ${c.violet('·')} ${s}`);
const warn = (s) => say(`  ${c.amber('!')} ${s}`);
const bad = (s) => say(`  ${c.rose('✗')} ${s}`);
const note = (s) => say(`    ${c.dim(s)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const rel = (p) => { const r = relative(ROOT, p); return !r ? '.' : r.startsWith('..') ? p : r; };

// ------------------------------------------------------------------------------------------------ small helpers

/** Same rules as server/app.mjs, so both read .env.local identically. */
export function parseEnvFile(text) {
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
 * The token, resolved exactly as the app does (env, then the env file, then 24 random bytes appended to the env file),
 * and handed to the app explicitly so the printed links always match. Other keys in the env file (OLLAMA_MODEL,
 * WHISPER_URL, MESHY_API_KEY...) are loaded when not already set. ANTHROPIC_* keys are never loaded.
 */
function loadEnvAndToken(envFile) {
  const fromEnv = (process.env.WORLD_TOKEN || '').trim();
  let text = '';
  let vars = {};
  try { text = readFileSync(envFile, 'utf8'); vars = parseEnvFile(text); } catch { /* first run */ }
  for (const [k, v] of Object.entries(vars)) if (!/^ANTHROPIC_/.test(k) && process.env[k] === undefined) process.env[k] = v;
  if (fromEnv) return { token: fromEnv, source: 'the environment' };
  if (vars.WORLD_TOKEN?.trim()) return { token: vars.WORLD_TOKEN.trim(), source: rel(envFile) };
  const token = randomBytes(24).toString('base64url');
  try {
    writeFileSync(envFile, `${text}${text && !text.endsWith('\n') ? '\n' : ''}WORLD_TOKEN=${token}\n`, { mode: 0o600 });
    return { token, source: `${rel(envFile)} (new)` };
  } catch (e) {
    return { token, source: `this run only (could not write ${rel(envFile)}: ${e.message})` };
  }
}

function which(cmd) {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  const dirs = [...(process.env.PATH || '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, cmd);
    try { accessSync(p, FS.X_OK); if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const s = net.createServer();
    s.once('error', () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  });
}

function freePort() {
  return new Promise((done, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

async function getJson(url, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) { await r.body?.cancel(); return null; }
    return await r.json();
  } catch { return null; }
}

async function waitFor(fn, ms, every = 500, shouldStop = () => false) {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

const isLocalUrl = (u) => { try { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };
const portOf = (u, d) => { try { return Number(new URL(u).port) || d; } catch { return d; } };

/** The environment every child gets: hers, minus anything that would point Claude at the API instead of the subscription. */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  return env;
}

// ------------------------------------------------------------------------------------------------ state + processes

const S = {
  opts: null,
  port: 8787,
  token: '',
  dataDir: '',
  logDir: '',
  procs: {}, // name -> ChildProcess (only the ones this script started)
  ollama: { state: 'off', detail: '' },
  whisper: { state: 'off', detail: '' },
  whisperTmp: null,
  publicUrl: null,
  checks: null, // result of checkThrough() against the public URL (or 127.0.0.1 with --local)
  health: null,
  adbReversed: [],
  adbStarted: false,
  appTail: [],
  streamAppLog: false,
  tunnelRestarts: 0,
  stopping: null,
};

/** Spawn a child with its output going to <logDir>/<name>.log; `onLine` sees every line (stdout and stderr). */
function launch(name, cmd, args, { env = childEnv(), cwd = ROOT, onLine } = {}) {
  const log = createWriteStream(join(S.logDir, `${name}.log`), { flags: 'w' });
  log.on('error', () => { /* a log file problem must never take the app down */ });
  const cp = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = (stream) => {
    let buf = '';
    stream.on('data', (b) => {
      log.write(b);
      buf += b.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        try { onLine?.(line); } catch { /* never let a parser bug kill us */ }
      }
    });
  };
  lines(cp.stdout);
  lines(cp.stderr);
  cp.exited = new Promise((done) => {
    cp.once('exit', (code, signal) => done({ code, signal }));
    cp.once('error', (e) => {
      // A failed spawn (ENOENT, EACCES) never emits 'exit' and keeps exitCode null: mark it dead ourselves.
      if (!cp.pid || e.code === 'ENOENT' || e.code === 'EACCES') cp.failed = e;
      log.write(`\n[up] ${cmd}: ${e.message}\n`);
      if (cp.failed) done({ code: null, signal: null, error: e });
    });
  });
  cp.exited.then(() => log.end());
  S.procs[name] = cp;
  return cp;
}

const alive = (cp) => !!cp && !cp.failed && cp.exitCode === null && cp.signalCode === null;

/** SIGTERM, then (optionally) a second SIGTERM, then SIGKILL. Resolves when the child is gone. */
async function stopChild(cp, { killAfterMs = 5000, secondTermAfterMs = 0 } = {}) {
  if (!alive(cp)) return;
  const timers = [];
  try { cp.kill('SIGTERM'); } catch { /* already gone */ }
  if (secondTermAfterMs) timers.push(setTimeout(() => { try { cp.kill('SIGTERM'); } catch { /* gone */ } }, secondTermAfterMs));
  timers.push(setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* gone */ } }, killAfterMs));
  await Promise.race([cp.exited, sleep(killAfterMs + 1500)]);
  timers.forEach(clearTimeout);
}

/** A child we own exited while we were not shutting down. Signals from Ctrl+C reach the whole group at once, so wait a beat. */
function onUnexpectedExit(cp, fn) {
  cp.exited.then(async (info) => { await sleep(200); if (!S.stopping) fn(info); });
}

// ------------------------------------------------------------------------------------------------ 1. ollama

async function ensureOllama() {
  const url = String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  let tags = await getJson(`${url}/api/tags`);
  let started = false;
  if (!tags) {
    const bin = which('ollama');
    if (!isLocalUrl(url)) { S.ollama = { state: 'off', detail: `not answering at ${url}` }; warn(`ollama is not answering at ${url}; the ollama brain stays off`); return; }
    if (!bin) { S.ollama = { state: 'off', detail: 'not installed' }; warn('ollama is not installed (brew install ollama); the guide uses Claude or the scripted brain'); return; }
    step('starting ollama');
    const cp = launch('ollama', bin, ['serve'], { env: childEnv({ OLLAMA_HOST: `127.0.0.1:${portOf(url, 11434)}` }) });
    tags = await waitFor(() => getJson(`${url}/api/tags`, 1500), 20_000, 500, () => !alive(cp));
    if (!tags) { S.ollama = { state: 'off', detail: 'did not start' }; warn(`ollama did not start; see ${rel(join(S.logDir, 'ollama.log'))}`); await stopChild(cp); return; }
    started = true;
    onUnexpectedExit(cp, () => { S.ollama = { state: 'off', detail: 'stopped' }; warn('ollama stopped; the ollama brain is off until the next npm run up'); });
  }
  const want = model.includes(':') ? model : `${model}:latest`;
  const hasModel = (list) => (list?.models || []).some((m) => [m.name, m.model].some((n) => n === model || n === want));
  if (!hasModel(tags)) {
    S.ollama = { state: 'no-model', detail: `${model} not pulled` };
    warn(`ollama is ${started ? 'up' : 'running'} but ${model} is not pulled yet:  ollama pull ${model}   (about 2 GB)`);
    return;
  }
  if (hasModel(await getJson(`${url}/api/ps`))) {
    S.ollama = { state: 'ready', detail: `${model} warm` };
    ok(`ollama ${started ? 'started' : 'running'} · ${model} warm`);
    return;
  }
  S.ollama = { state: 'warming', detail: `${model} warming` };
  ok(`ollama ${started ? 'started' : 'running'} · warming ${model} in the background`);
  const t0 = Date.now();
  fetch(`${url}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m' }),
    signal: AbortSignal.timeout(180_000),
  }).then(async (r) => {
    await r.body?.cancel();
    if (S.stopping) return;
    if (r.ok) { S.ollama = { state: 'ready', detail: `${model} warm` }; ok(`ollama ${model} is warm (${secs(Date.now() - t0)})`); }
    else { S.ollama = { state: 'ready', detail: `${model} (warm-up said ${r.status})` }; warn(`ollama warm-up answered ${r.status}; the model loads on the first question instead`); }
  }).catch(() => { if (!S.stopping) { S.ollama = { state: 'ready', detail: `${model} (cold)` }; warn('ollama warm-up timed out; the first local answer may be slow'); } });
}

// ------------------------------------------------------------------------------------------------ 2. whisper

/**
 * Stream `url` to `dest` via `dest.part`, checking size and SHA-1 when given, then rename into place.
 * A stalled download (30 s without bytes) is aborted. Never leaves a partial file behind.
 */
export async function downloadFile(url, dest, { bytes, sha1, onProgress, stallMs = 30_000 } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const ac = new AbortController();
  let idle;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error(`stalled for ${stallMs / 1000} s`)), stallMs); };
  let out = null;
  try {
    kick();
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || bytes || 0;
    const hash = createHash('sha1');
    let got = 0;
    let writeError = null;
    out = createWriteStream(part);
    out.on('error', (e) => { writeError = e; ac.abort(e); });
    for await (const chunk of r.body) {
      kick();
      got += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      onProgress?.(got, total);
    }
    await new Promise((done, fail) => out.end((e) => (e ? fail(e) : done())));
    if (writeError) throw writeError;
    if (bytes && got !== bytes) throw new Error(`got ${got} bytes, expected ${bytes}`);
    const digest = hash.digest('hex');
    if (sha1 && digest !== sha1) throw new Error(`SHA-1 ${digest}, expected ${sha1}`);
    renameSync(part, dest);
    return { bytes: got, sha1: digest };
  } catch (e) {
    out?.destroy();
    try { unlinkSync(part); } catch { /* nothing to clean */ }
    throw (ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : e);
  } finally {
    clearTimeout(idle);
  }
}

function progressPrinter(label) {
  let last = 0;
  let lastPct = -1;
  return (got, total) => {
    const pct = total ? Math.floor((got / total) * 100) : 0;
    const mb = (n) => (n / 1048576).toFixed(0);
    if (process.stdout.isTTY) {
      if (Date.now() - last < 150 && got !== total) return;
      last = Date.now();
      write(`\r    ${c.dim(`${label}  ${total ? `${String(pct).padStart(3)}%  ` : ''}${mb(got)}${total ? ` / ${mb(total)}` : ''} MB`)}\x1b[K`);
      if (total && got >= total) write('\n');
    } else if (total && pct >= lastPct + 25) {
      lastPct = pct - (pct % 25);
      note(`${label} ${lastPct}%`);
    }
  };
}

async function ensureWhisperModel() {
  const custom = process.env.WHISPER_MODEL;
  const file = resolve(ROOT, custom || WHISPER_MODEL.file);
  if (existsSync(file) && statSync(file).size > 0) {
    const size = statSync(file).size;
    if (!custom && size !== WHISPER_MODEL.bytes) warn(`${rel(file)} is ${size} bytes, expected ${WHISPER_MODEL.bytes}; delete it to download a fresh copy`);
    return file;
  }
  if (custom && !process.env.WHISPER_MODEL_URL) { warn(`WHISPER_MODEL ${custom} not found; speech-to-text stays off`); return null; }
  const url = process.env.WHISPER_MODEL_URL || WHISPER_MODEL.url;
  const known = !process.env.WHISPER_MODEL_URL && !custom;
  step(`downloading the whisper model once (${known ? '148 MB' : url}) to ${rel(file)}`);
  const t0 = Date.now();
  try {
    await downloadFile(url, file, { bytes: known ? WHISPER_MODEL.bytes : undefined, sha1: known ? WHISPER_MODEL.sha1 : undefined, onProgress: progressPrinter('whisper model') });
    ok(`whisper model saved${known ? ' (SHA-1 verified)' : ''} in ${secs(Date.now() - t0)}`);
    return file;
  } catch (e) {
    if (process.stdout.isTTY) write('\n');
    warn(`whisper model download failed (${e.message}); speech-to-text stays off this run`);
    return null;
  }
}

async function whisperHealthy(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    await r.body?.cancel();
    return r.ok;
  } catch { return false; }
}

/** Starts whisper-server if it isn't already answering. Returns without waiting for it to be ready. */
async function ensureWhisper() {
  const url = String(process.env.WHISPER_URL || 'http://127.0.0.1:8178').replace(/\/+$/, '');
  if (await whisperHealthy(url)) { S.whisper = { state: 'ready', detail: `already running at ${url}` }; ok(`whisper already running at ${url}`); return; }
  const off = (detail, msg) => { S.whisper = { state: 'off', detail }; warn(msg); };
  if (!isLocalUrl(url)) return off('not answering', `whisper is not answering at ${url}; voice uses the browser's own recognition, or text`);
  const bin = which('whisper-server');
  if (!bin) return off('not installed', 'whisper-server not found (brew install whisper-cpp); voice uses the browser\'s own recognition, or text');
  if (!which('ffmpeg')) return off('needs ffmpeg', 'ffmpeg not found (brew install ffmpeg); whisper needs it to read phone and Quest audio, so it stays off');
  const port = portOf(url, 8178);
  if (!(await portFree(port))) return off(`port ${port} busy`, `port ${port} is busy with something that isn't whisper-server; set WHISPER_URL to another port`);
  const model = await ensureWhisperModel();
  if (!model) { S.whisper = { state: 'off', detail: 'no model' }; return; }

  S.whisperTmp = mkdtempSync(join(tmpdir(), 'dreamspace-whisper-'));
  const cp = launch('whisper', bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--convert', '--tmp-dir', S.whisperTmp], { cwd: S.whisperTmp });
  S.whisper = { state: 'starting', detail: 'starting (the very first launch compiles GPU shaders, ~40 s)' };
  step(`whisper-server starting on :${port}`);
  const t0 = Date.now();
  waitFor(() => whisperHealthy(url), 120_000, 700, () => !alive(cp) || !!S.stopping).then((ready) => {
    if (S.stopping) return;
    if (ready) { S.whisper = { state: 'ready', detail: `ready on :${port}` }; ok(`whisper ready: voice-to-text is on (${secs(Date.now() - t0)})`); return; }
    S.whisper = { state: 'off', detail: 'did not start' };
    warn(`whisper-server did not come up; see ${rel(join(S.logDir, 'whisper.log'))}. Voice falls back to the browser's own recognition, or text`);
    if (alive(cp)) stopChild(cp, { killAfterMs: 3000 });
  });
  onUnexpectedExit(cp, ({ code, signal }) => {
    if (S.whisper.state === 'off') return;
    S.whisper = { state: 'off', detail: 'stopped' };
    warn(`whisper-server stopped (${signal || `exit ${code}`}); see ${rel(join(S.logDir, 'whisper.log'))}`);
  });
}

// ------------------------------------------------------------------------------------------------ 3. the app

async function startApp() {
  const cp = launch('app', process.execPath, [join(ROOT, 'server', 'app.mjs')], {
    env: childEnv({ PORT: String(S.port), WORLD_TOKEN: S.token, DATA_DIR: S.dataDir }),
    onLine: (line) => {
      S.appTail.push(line);
      if (S.appTail.length > 40) S.appTail.shift();
      if (S.streamAppLog && line.trim()) say(c.dim(`  │ ${line}`));
    },
  });
  const t0 = Date.now();
  const health = await waitFor(() => getJson(`http://127.0.0.1:${S.port}/api/health`, 10_000), 30_000, 300, () => !alive(cp));
  if (!health) {
    bad(alive(cp) ? 'the app did not answer /api/health within 30 s' : 'the app stopped while starting:');
    for (const l of S.appTail.slice(-15)) note(l);
    throw new Error('app failed to start');
  }
  S.health = health;
  ok(`app on http://127.0.0.1:${S.port} (${secs(Date.now() - t0)})`);
  onUnexpectedExit(cp, ({ code, signal }) => {
    bad(`the app stopped (${signal || `exit ${code}`}). Its last words:`);
    for (const l of S.appTail.slice(-15)) note(l);
    shutdown('the app stopped', 1);
  });
  return cp;
}

// ------------------------------------------------------------------------------------------------ 4. tunnel

/** First quick-tunnel URL in a cloudflared log line. api.trycloudflare.com also appears in error lines: skip it. */
export function tunnelUrlIn(line) {
  for (const m of String(line).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) {
    if (m[1] !== 'api' && m[1].includes('-')) return m[0];
  }
  return null;
}

async function openTunnel() {
  const bin = process.env.CLOUDFLARED_BIN || which('cloudflared');
  if (!bin) { warn('cloudflared not found (brew install cloudflared): no public URL, so this Mac and USB only'); return null; }
  const metrics = await freePort();
  step('opening a public tunnel (cloudflared quick tunnel)');
  let url = null;
  let registered = false;
  let lastError = '';
  const cp = launch('cloudflared', bin, [
    'tunnel', '--no-autoupdate', '--grace-period', '1s', '--metrics', `127.0.0.1:${metrics}`, '--url', `http://127.0.0.1:${S.port}`,
  ], {
    onLine: (line) => {
      url ||= tunnelUrlIn(line);
      if (/Registered tunnel connection/i.test(line)) registered = true;
      if (/\bERR\b|error|failed/i.test(line)) lastError = line.replace(/^\S+\s+ERR\s+/, '').trim();
    },
  });
  const t0 = Date.now();
  const gotUrl = await waitFor(() => url, 45_000, 200, () => !alive(cp) || !!S.stopping);
  if (!gotUrl) {
    const why = cp.failed ? `could not start ${bin} (${cp.failed.code || cp.failed.message})` : lastError.slice(0, 160);
    warn(`the tunnel did not give a URL${why ? `: ${why}` : ''}`);
    note(`log: ${rel(join(S.logDir, 'cloudflared.log'))}`);
    await stopChild(cp, { killAfterMs: 3000 });
    return null;
  }
  // A URL is not reachability: wait until the edge holds our connection (log line, or cloudflared's own /ready).
  await waitFor(async () => registered || (await getJson(`http://127.0.0.1:${metrics}/ready`, 1000))?.readyConnections > 0, 30_000, 300, () => !alive(cp));
  ok(`tunnel ${gotUrl} (${secs(Date.now() - t0)})`);
  return { cp, url: gotUrl };
}

async function startTunnel() {
  const t = await openTunnel();
  if (!t || S.stopping) return;
  S.publicUrl = t.url;
  step('checking the app through the public URL');
  S.checks = await checkThrough(t.url, S.token, { healthWaitMs: 30_000 });
  reportChecks('through the tunnel', S.checks);
  onUnexpectedExit(t.cp, async ({ code, signal }) => {
    S.publicUrl = null;
    S.checks = null;
    if (S.tunnelRestarts >= 3) { warn('the tunnel keeps closing; carrying on with this Mac and USB only'); return; }
    S.tunnelRestarts++;
    warn(`the tunnel closed (${signal || `exit ${code}`}); reopening. The public URL will change, so re-scan the code${S.tunnelRestarts > 1 ? '' : ' and update the claude.ai connector URL'}.`);
    await sleep(3000);
    if (S.stopping) return;
    await startTunnel();
    if (S.publicUrl && !S.stopping) banner();
  });
}

// ------------------------------------------------------------------------------------------------ 5. checks

/** health, then a live-events (SSE) snapshot and an MCP initialize + tools/list, against any base URL. */
export async function checkThrough(base, token, { healthWaitMs = 0 } = {}) {
  const res = { base };
  const t0 = Date.now();
  let last = '';
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { res.health = { ok: true, body: await r.json().catch(() => null) }; break; }
      last = `HTTP ${r.status}`;
      await r.body?.cancel();
    } catch (e) { last = e.cause?.code || e.message; }
    if (Date.now() - t0 >= healthWaitMs || S.stopping) break;
    await sleep(1500);
  }
  res.health ??= { ok: false, detail: last };
  if (!res.health.ok) return res;
  [res.sse, res.mcp] = await Promise.all([checkSse(base, token), checkMcp(base, token)]);
  return res;
}

async function checkSse(base, token, ms = 10_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/events?t=${encodeURIComponent(token)}&from=up-check`, {
      signal: ac.signal, headers: { accept: 'text/event-stream', 'x-world-token': token },
    });
    if (!r.ok) { await r.body?.cancel(); return { ok: false, detail: `HTTP ${r.status}` }; }
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      if (/^event: snapshot$/m.test(buf)) return { ok: true, ms: Date.now() - t0 };
      if (buf.length > 4_000_000) break;
    }
    return { ok: false, detail: 'the stream ended before the first event' };
  } catch (e) {
    return { ok: false, detail: ac.signal.aborted ? `no event within ${ms / 1000} s (the proxy may be buffering the stream)` : (e.cause?.code || e.message) };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

async function checkMcp(base, token, ms = 10_000) {
  const rpc = async (id, method, params) => {
    const r = await fetch(`${base}/mcp/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(ms),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = /event-stream/.test(r.headers.get('content-type') || '')
      ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) || 'null')
      : JSON.parse(text);
    if (json?.error) throw new Error(json.error.message || 'rpc error');
    return json?.result;
  };
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dreamspace-up', version: '1' } });
    if (!init?.serverInfo) return { ok: false, detail: 'no serverInfo in the initialize answer' };
    let tools = null;
    try { tools = (await rpc(2, 'tools/list', {}))?.tools?.map((t) => t.name) ?? null; } catch { /* the count is a bonus */ }
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, detail: e.cause?.code || e.message };
  }
}

function reportChecks(where, r) {
  if (!r) return;
  if (!r.health.ok) { bad(`${where}: /api/health failed (${r.health.detail})`); return; }
  const parts = [
    'health',
    r.sse.ok ? `live events ${secs(r.sse.ms)}` : null,
    r.mcp.ok ? `MCP${r.mcp.tools ? ` (${r.mcp.tools.length} tools)` : ''}` : null,
  ].filter(Boolean);
  ok(`${where}: ${parts.join(' · ')}`);
  if (!r.sse.ok) {
    bad(`${where}: live events failed (${r.sse.detail})`);
    note('Replies travel over live events, so the phone would not hear the guide. Try again, or:');
    note('TUNNEL_TRANSPORT_PROTOCOL=http2 npm run up     (README › Troubleshooting has more)');
  }
  if (!r.mcp.ok) bad(`${where}: MCP failed (${r.mcp.detail}); the claude.ai connector would not work`);
}

// ------------------------------------------------------------------------------------------------ Quest over USB

async function adbDevices({ startServer = false } = {}) {
  const adb = which('adb');
  if (!adb) return null;
  const serverUp = !(await portFree(5037));
  if (!serverUp && !startServer) return []; // `adb devices` would leave an adb daemon behind; only do that when asked (o)
  if (!serverUp) S.adbStarted = true;
  const r = spawnSync(adb, ['devices'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
}

function adbReverse(serial) {
  if (S.adbReversed.includes(serial)) return true;
  const r = spawnSync(which('adb'), ['-s', serial, 'reverse', `tcp:${S.port}`, `tcp:${S.port}`], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0) S.adbReversed.push(serial);
  return r.status === 0;
}

async function openOnHeadset() {
  const devices = await adbDevices({ startServer: true });
  if (devices === null) { warn('adb is not installed (brew install android-platform-tools)'); return; }
  if (!devices.length) {
    warn('no headset over USB. Turn on developer mode (Meta Horizon app), plug in USB-C, accept "Allow USB debugging" in the headset, then press o again.');
    return;
  }
  const url = `http://localhost:${S.port}/?t=${S.token}`;
  const adb = which('adb');
  for (const serial of devices) {
    if (!adbReverse(serial)) { warn(`adb reverse failed on ${serial}`); continue; }
    const quest = /com\.oculus\.browser/.test(spawnSync(adb, ['-s', serial, 'shell', 'pm', 'list', 'packages', 'com.oculus.browser'], { encoding: 'utf8', timeout: 10_000 }).stdout || '');
    const r = spawnSync(adb, ['-s', serial, 'shell', `am start -a android.intent.action.VIEW -d '${url}'${quest ? ' -p com.oculus.browser' : ''}`], { encoding: 'utf8', timeout: 15_000 });
    if (r.status === 0 && !/Error/.test(r.stdout + r.stderr)) ok(`opened the viewer on ${serial}${quest ? ' (Meta Quest Browser)' : ''}: put the headset on and press Enter VR`);
    else warn(`could not open the browser on ${serial}: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
  }
}

// ------------------------------------------------------------------------------------------------ 6. the banner

function banner() {
  const t = S.token;
  const P = S.publicUrl;
  const local = `http://127.0.0.1:${S.port}`;
  const row = (label, value, hint = '') => say(`  ${c.violet(label.padEnd(7))} ${value}${hint ? `   ${c.dim(hint)}` : ''}`);
  const mark = (on) => (on ? c.teal('✓') : c.dim('·'));
  const h = S.health || {};
  say();
  say(`  ${c.teal('✦')} ${c.bold('Dreamspace is awake')}`);
  say();
  if (P) {
    row('Phone', c.teal(`${P}/phone/?t=${t}`), 'iPhone Safari: scan the code below');
    row('Viewer', `${P}/?t=${t}`, 'any browser, or the Quest Browser');
    row('Claude', `${P}/mcp/${t}`, 'claude.ai › Customize › Connectors › Add custom connector › No sign-in');
  }
  row('Local', `${local}/?t=${t}`, 'this Mac (the emulated Quest has Enter VR)');
  if (S.adbReversed.length) row('Quest', `http://localhost:${S.port}/?t=${t}`, 'over USB (adb reverse is on) · press o to open it there');
  else row('Quest', c.dim(P ? 'open the Viewer link in the Quest Browser, or plug in USB and press o' : 'plug in USB and press o'));
  say();
  const b = h.brains || {};
  row('Brains', `claude ${mark(b.claude)}  ollama ${mark(b.ollama)}  scripted ${mark(b.scripted)}   ${c.dim(`default: ${h.brain || 'auto'}${h.vibe ? ' · vibe mode ready' : ''}`)}`);
  const w = S.whisper;
  row('Voice', `whisper ${w.state === 'ready' ? c.teal('✓') : w.state === 'starting' ? c.violet('…') : c.dim('·')}   ${c.dim(w.detail || 'off')}`);
  if (S.checks?.health?.ok) {
    const k = S.checks;
    row(P ? 'Tunnel' : 'Checks', `health ${mark(true)}  live events ${k.sse.ok ? c.teal('✓') : c.rose('✗')}  MCP ${k.mcp.ok ? c.teal('✓') : c.rose('✗')}${k.mcp.tools ? c.dim(`  (${k.mcp.tools.length} tools)`) : ''}`);
  }
  if (P) {
    say();
    const qr = qrEncode(`${P}/phone/?t=${t}`);
    for (const line of qrToText(qr, { color: COLOR }).split('\n')) say(`  ${line}`);
  } else {
    say();
    note(S.opts.tunnel
      ? 'No public URL (the tunnel did not open), so no phone code. Try npm run up again; the cloudflared log says more.'
      : 'No public URL, so no phone code: the phone needs https for its microphone. Run without --local for the tunnel.');
  }
  say();
  if (P) note('These links carry your world key. Anyone who has them can talk to your world. The tunnel URL changes every run.');
  note(`Logs: ${rel(S.logDir)}/  ·  ${process.stdin.isTTY ? 'u  links and code again   o  open on a USB headset   q  stop' : 'Ctrl+C stops everything'}`);
  say();
}

// ------------------------------------------------------------------------------------------------ shutdown

function restoreTerminal() {
  if (process.stdin.isTTY && process.stdin.isRaw) { try { process.stdin.setRawMode(false); } catch { /* closed */ } }
}

function shutdown(reason = '', code = 0) {
  if (S.stopping) return S.stopping;
  S.streamAppLog = false;
  S.stopping = (async () => {
    say();
    say(`  ${c.violet('☾')} ${reason ? c.dim(`${reason} · `) : ''}letting the world rest…`);
    const p = S.procs;
    // The public URL goes first, so nothing new arrives while the rest winds down.
    await stopChild(p.cloudflared, { killAfterMs: 4000, secondTermAfterMs: 1500 });
    await Promise.all([
      stopChild(p.app, { killAfterMs: 7000 }),
      stopChild(p.whisper, { killAfterMs: 3000 }),
      stopChild(p.ollama, { killAfterMs: 5000 }),
    ]);
    const adb = which('adb');
    for (const serial of S.adbReversed) spawnSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${S.port}`], { timeout: 5000 });
    if (S.adbStarted && adb) spawnSync(adb, ['kill-server'], { timeout: 5000 });
    if (S.whisperTmp) { try { rmSync(S.whisperTmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    const left = Object.entries(p).filter(([, cp]) => alive(cp)).map(([n]) => n);
    if (left.length) warn(`still running: ${left.join(', ')}`);
    else say(`  ${c.teal('✦')} ${c.dim('all quiet. Sleep well.')}`);
    restoreTerminal();
    process.exit(code);
  })();
  return S.stopping;
}

function listenKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (k) => {
    if (k === '\u0003' && S.stopping) {
      // A second Ctrl+C while winding down: stop waiting, hard.
      for (const cp of Object.values(S.procs)) { try { cp.kill('SIGKILL'); } catch { /* gone */ } }
      restoreTerminal();
      process.exit(130);
    }
    if (k === '\u0003' || k === 'q' || k === 'Q' || k === '\u0004') shutdown();
    else if (S.stopping) { /* ignore other keys while stopping */ }
    else if (k === 'u' || k === 'U' || k === '\r' || k === '\n') banner();
    else if (k === 'o' || k === 'O') openOnHeadset().catch((e) => warn(`open on headset: ${e.message}`));
  });
}

// ------------------------------------------------------------------------------------------------ main

function parseArgs(argv) {
  const o = { tunnel: true, whisper: true, ollama: true, port: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--no-tunnel') o.tunnel = false;
    else if (a === '--no-whisper') o.whisper = false;
    else if (a === '--no-ollama') o.ollama = false;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '-h' || a === '--help') o.help = true;
    else o.unknown.push(a);
  }
  return o;
}

const HELP = `
  npm run up                     ollama + whisper + the app + a public tunnel, then links and a QR code for the phone
  npm run up -- --local          no tunnel (this Mac, and a Quest over USB)
  npm run up -- --no-whisper     skip speech-to-text
  npm run up -- --no-ollama      don't start or warm ollama
  npm run up -- --port 8788      another app port (default 8787, or $PORT)

  Keys while running: u links and code again · o open on a USB headset · q or Ctrl+C stop everything
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { say(HELP); return; }
  if (opts.unknown.length) { bad(`unknown option ${opts.unknown.join(' ')}`); say(HELP); process.exit(2); }
  S.opts = opts;

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig === 'SIGINT' ? '' : sig));
  process.on('exit', restoreTerminal);
  const crashed = (e) => { if (!S.stopping) bad(`up.mjs: ${e?.stack || e}`); shutdown('unexpected error', 1); };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);

  say();
  say(`  ${c.teal('✦')} ${c.bold('Dreamspace')} ${c.dim('· waking the world')}`);
  say();

  const envFile = resolve(ROOT, process.env.ENV_FILE || '.env.local');
  const { token, source } = loadEnvAndToken(envFile);
  S.token = token;
  S.port = opts.port || Number(process.env.PORT) || 8787;
  if (!Number.isInteger(S.port) || S.port < 1 || S.port > 65535) { bad(`bad port ${S.port}`); process.exit(2); }
  S.dataDir = resolve(ROOT, process.env.DATA_DIR || '.data');
  S.logDir = join(S.dataDir, 'logs');
  mkdirSync(S.logDir, { recursive: true });
  ok(`world key (token) from ${source}`);
  if (token.length < 16) warn('WORLD_TOKEN is short; anyone who guesses it controls the world over the tunnel');

  if (!(await portFree(S.port))) {
    const h = await getJson(`http://127.0.0.1:${S.port}/api/health`);
    bad(h?.brains ? `Dreamspace is already running on :${S.port} (another npm start or npm run up?)` : `port ${S.port} is busy`);
    note(`Stop it, or pick another port:  npm run up -- --port ${S.port + 1}`);
    process.exit(1);
  }

  if (opts.ollama) await ensureOllama();
  else { S.ollama = { state: 'off', detail: '--no-ollama' }; step('ollama: skipped (--no-ollama)'); }
  if (opts.whisper) await ensureWhisper();
  else { S.whisper = { state: 'off', detail: 'skipped (--no-whisper)' }; step('whisper: skipped (--no-whisper)'); }

  const tunnel = opts.tunnel ? startTunnel() : null; // cloudflared takes a few seconds to hand out a URL: start it now
  try {
    await startApp();
  } catch {
    return shutdown('the app could not start', 1);
  }
  const devices = await adbDevices();
  for (const serial of devices || []) if (adbReverse(serial)) ok(`headset ${serial}: localhost:${S.port} reaches this Mac over USB`);

  if (tunnel) await tunnel;
  if (!S.publicUrl && !S.stopping) {
    S.checks = await checkThrough(`http://127.0.0.1:${S.port}`, S.token);
    reportChecks('local checks', S.checks);
  }
  if (S.stopping) return;
  S.health = (await getJson(`http://127.0.0.1:${S.port}/api/health`, 10_000)) || S.health;
  banner();
  S.streamAppLog = true;
  listenKeys();
}

// ------------------------------------------------------------------------------------------------ QR code
// A small QR encoder: byte mode, versions 1-40, error correction L/M/Q/H (the highest that fits the smallest
// version), automatic mask choice. Follows Project Nayuki's reference implementation (MIT). It was checked by
// decoding its output with macOS CoreImage's QR detector at versions 1-15 and all four error-correction levels.

const QR_ECL = { L: { bits: 1, row: 0 }, M: { bits: 0, row: 1 }, Q: { bits: 3, row: 2 }, H: { bits: 2, row: 3 } };
const QR_ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const QR_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function qrRawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const qrDataCodewords = (ver, row) => Math.floor(qrRawModules(ver) / 8) - QR_ECC_PER_BLOCK[row][ver] * QR_BLOCKS[row][ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], f);
  }
  return r;
}

function qrAlignment(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const stepSize = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const r = [];
  for (let pos = size - 7; r.length < n - 1; pos -= stepSize) r.unshift(pos);
  r.unshift(6);
  return r;
}

const QR_MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function qrPenalty(m) {
  const n = m.length;
  let score = 0;
  let dark = 0;
  const runs = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
    }
  };
  runs((a, b) => m[a][b]);
  runs((a, b) => m[b][a]);
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }
  const P = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b <= n - 11; b++) {
      for (const p of P) {
        if (p.every((v, k) => m[a][b + k] === !!v)) score += 40;
        if (p.every((v, k) => m[b + k][a] === !!v)) score += 40;
      }
    }
  }
  for (const row of m) for (const v of row) if (v) dark++;
  score += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return score;
}

/** Encode text (UTF-8, byte mode) as a QR code: { version, ecc, mask, size, modules[y][x] = dark }. */
export function qrEncode(text, minEcc = 'L') {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const bitsFor = (ver) => 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
  let ver = 1;
  while (ver <= 40 && bitsFor(ver) > qrDataCodewords(ver, QR_ECL[minEcc].row) * 8) ver++;
  if (ver > 40) throw new Error('too long for a QR code');
  let ecc = minEcc;
  for (const e of ['M', 'Q', 'H']) {
    if (QR_ECL[e].row > QR_ECL[ecc].row && bitsFor(ver) <= qrDataCodewords(ver, QR_ECL[e].row) * 8) ecc = e;
  }
  const row = QR_ECL[ecc].row;

  // Data: mode 0100 (byte), count, bytes, terminator, byte padding, 0xEC/0x11 filler.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = qrDataCodewords(ver, row) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  // Error correction per block, then interleave.
  const nBlocks = QR_BLOCKS[row][ver];
  const eccLen = QR_ECC_PER_BLOCK[row][ver];
  const raw = Math.floor(qrRawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecBytes = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecBytes));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) codewords.push(b[i]); });
  }

  // Function patterns.
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = qrAlignment(ver, size);
  const last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask) => {
    const d = (QR_ECL[ecc].bits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Codewords in the zigzag, right to left in column pairs.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  // The mask with the lowest penalty.
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && QR_MASKS[m](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = qrPenalty(mod);
    if (s < bestScore) { best = m; bestScore = s; }
    applyMask(m);
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, ecc, mask: best, size, modules: mod };
}

/**
 * Terminal rendering, two modules per character cell with half blocks. With color, it paints black on white
 * explicitly, so it scans on dark and light terminal themes alike. Without color, light modules are drawn as ink
 * (for dark terminals, like `qrencode -t UTF8`).
 */
export function qrToText(qr, { color = true, border = 4 } = {}) {
  const n = qr.size;
  const full = n + border * 2;
  const dark = (x, y) => {
    const mx = x - border;
    const my = y - border;
    return mx >= 0 && my >= 0 && mx < n && my < n && qr.modules[my][mx];
  };
  const out = [];
  for (let y = 0; y < full; y += 2) {
    let line = '';
    let prev = '';
    for (let x = 0; x < full; x++) {
      const top = dark(x, y);
      const hasBottom = y + 1 < full;
      const bottom = hasBottom && dark(x, y + 1);
      if (color) {
        const code = `\x1b[${top ? '38;5;16' : '38;5;231'};${hasBottom ? (bottom ? '48;5;16' : '48;5;231') : '49'}m`;
        if (code !== prev) { line += code; prev = code; }
        line += '▀';
      } else if (!hasBottom) {
        line += top ? ' ' : '▀';
      } else {
        line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' ';
      }
    }
    out.push(color ? `${line}\x1b[0m` : line);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------ run

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    bad(e?.stack || String(e));
    shutdown('unexpected error', 1);
  });
}
