#!/usr/bin/env node
// Smoke test for the Dreamspace server (server/app.mjs). Zero dependencies.
//   node server/smoke.mjs          (npm run smoke)
//   node server/smoke.mjs --keep   keep the temp data dir and print the app log
//
// Starts the app on a random free port in 18000-18999 with a temp DATA_DIR and a temp env file, so it never touches
// .data/ or .env.local. It never talks to a model: brains are limited to `scripted` (BRAINS_ENABLED) and assets to
// `archetype` (ASSET_PROVIDERS), and speech-to-text goes to a fake whisper-server started here.
// Checks: health, static safety, auth (401), world ops + limits + spacing, SSE (snapshot first, op, chat, status, pings),
// the long-poll twin /api/events/poll,
// a chat round-trip with brain=scripted, /api/say, /api/stt, the vibe + MCP mounts (including an MCP tool call that
// changes the world), persistence across a restart, clean shutdown, and first-run token generation.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, 'app.mjs');
const KEEP = process.argv.includes('--keep');
const T0 = Date.now();

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  -> ${String(detail).slice(0, 300)}` : ''}`); }
  return !!ok;
}
const section = (s) => console.log(`\n${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ ports + processes

function canListen(port) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}
async function freePort(avoid = []) {
  for (let i = 0; i < 80; i++) {
    const p = 18000 + Math.floor(Math.random() * 1000);
    if (!avoid.includes(p) && await canListen(p)) return p;
  }
  throw new Error('no free port in 18000-18999');
}

const children = new Set();
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

/** Start the app; resolves once /api/health answers. Retries on another port if the chosen one got taken. */
async function startApp(env, { tries = 3 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const port = await freePort();
    const childEnv = { ...process.env, ...env, PORT: String(port) };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete childEnv[k];
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const child = spawn(process.execPath, [APP], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const app = { child, port, base: `http://127.0.0.1:${port}`, log: '', exited: null };
    child.stdout.on('data', (b) => { app.log += b; });
    child.stderr.on('data', (b) => { app.log += b; });
    child.on('exit', (code, signal) => { app.exited = { code, signal }; children.delete(child); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !app.exited) {
      try {
        const r = await fetch(`${app.base}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { await r.text(); return app; }
      } catch { /* not up yet */ }
      await sleep(150);
    }
    if (app.exited && /busy|EADDRINUSE/.test(app.log) && attempt < tries) continue;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    throw new Error(`app did not start (attempt ${attempt}):\n${app.log.slice(-2000)}`);
  }
  throw new Error('app did not start');
}

async function stopApp(app, signal = 'SIGTERM', timeoutMs = 8000) {
  if (!app || app.exited) return app?.exited;
  app.child.kill(signal);
  const deadline = Date.now() + timeoutMs;
  while (!app.exited && Date.now() < deadline) await sleep(50);
  if (!app.exited) { app.child.kill('SIGKILL'); await sleep(100); return null; }
  return app.exited;
}

// ------------------------------------------------------------------------------------------------ http helpers

function client(base, token) {
  return async function api(method, path, { body, raw, tok = token, headers = {}, contentType } = {}) {
    const h = { ...headers };
    if (tok) h['x-world-token'] = tok;
    let payload;
    if (raw !== undefined) { payload = raw; if (contentType) h['content-type'] = contentType; }
    else if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, headers: r.headers, text, json };
  };
}

/** Minimal SSE reader: collects events, counts `: ping` comments, and lets tests wait for a matching event. */
function openSse(url) {
  const sse = { events: [], pings: 0, status: null, contentType: '', closed: false };
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  sse.ready = new Promise((resolveReady, rejectReady) => {
    const req = http.get(url, (res) => {
      sse.status = res.statusCode;
      sse.contentType = res.headers['content-type'] || '';
      resolveReady();
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          let comment = false;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) { comment = true; if (/^:\s*ping/.test(line)) sse.pings++; continue; }
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) { if (comment) notify(); continue; }
          let parsed;
          try { parsed = JSON.parse(data.join('\n')); } catch { parsed = data.join('\n'); }
          sse.events.push({ event, data: parsed });
        }
        notify();
      });
      res.on('end', () => { sse.closed = true; notify(); });
      res.on('error', () => { sse.closed = true; notify(); });
    });
    req.on('error', (e) => { sse.closed = true; rejectReady(e); notify(); });
    sse.close = () => { try { req.destroy(); } catch { /* gone */ } };
  });
  /** Wait for the first event (after index `from`) matching pred. Resolves to the event or null on timeout. */
  sse.waitFor = (pred, timeoutMs = 5000, from = 0) => new Promise((resolveWait) => {
    let done = false;
    const test = () => {
      if (done) return;
      const hit = sse.events.slice(from).find((e) => { try { return pred(e); } catch { return false; } });
      if (hit || sse.closed) { done = true; waiters.delete(test); clearTimeout(t); resolveWait(hit || null); }
    };
    const t = setTimeout(() => { done = true; waiters.delete(test); resolveWait(null); }, timeoutMs);
    waiters.add(test);
    test();
  });
  sse.mark = () => sse.events.length;
  return sse;
}

// ------------------------------------------------------------------------------------------------ fake whisper-server

function startFakeWhisper(port) {
  const seen = { requests: 0, lastFieldOk: false, lastFormat: '' };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    if (req.method === 'POST' && req.url === '/inference') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.requests++;
        const body = Buffer.concat(chunks).toString('latin1');
        const ct = String(req.headers['content-type'] || '');
        // Like the real whisper-server: multipart with a field named `file`, else 400.
        seen.lastFieldOk = ct.startsWith('multipart/form-data') && /name="file"; filename="audio\.\w+"/.test(body);
        seen.lastFormat = /name="response_format"\r\n\r\n(\w+)/.exec(body)?.[1] || '';
        if (!seen.lastFieldOk) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Invalid request'); return; }
        const text = body.includes('SILENCE') ? ' [BLANK_AUDIO]\n' : ' Make the fog a little darker, please.\n';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, seen, close: () => new Promise((c) => server.close(c)) })));
}

// ------------------------------------------------------------------------------------------------ the test

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'dreamspace-smoke-'));
  const dataDir = join(tmp, 'data');
  const envFile = join(tmp, 'env.local');
  const TOKEN = `smoke_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const whisperPort = await freePort();
  const whisper = await startFakeWhisper(whisperPort);
  const baseEnv = {
    DATA_DIR: dataDir, ENV_FILE: envFile, WORLD_TOKEN: TOKEN,
    BRAINS_ENABLED: 'scripted', ASSET_PROVIDERS: 'archetype', SSE_PING_MS: '400',
    WHISPER_URL: `http://127.0.0.1:${whisperPort}`, WORLD_URL: undefined,
  };
  let app = await startApp(baseEnv);
  const api = client(app.base, TOKEN);
  console.log(`Dreamspace smoke test: app on :${app.port}, fake whisper on :${whisperPort}, data ${dataDir}`);

  try {
    // ---------------------------------------------------------------- health
    section('health');
    const h = await api('GET', '/api/health', { tok: null });
    check('GET /api/health is public and ok', h.status === 200 && h.json?.ok === true, h.text);
    check('health has the contract shape', h.json && typeof h.json.brains?.ollama === 'boolean' && typeof h.json.brains?.claude === 'boolean'
      && typeof h.json.brains?.scripted === 'boolean' && typeof h.json.stt?.whisper === 'boolean' && Array.isArray(h.json.assets), h.text);
    check('health sees the (fake) whisper-server', h.json?.stt?.whisper === true, h.text);
    check('health lists asset providers', h.json?.assets?.length >= 1, h.text);
    const scripted = h.json?.brains?.scripted === true;
    console.log(`        (brains: ${JSON.stringify(h.json?.brains)}, assets: ${JSON.stringify(h.json?.assets)}, vibe: ${h.json?.vibe})`);

    // ---------------------------------------------------------------- static
    section('static files');
    const idx = await api('GET', '/', { tok: null });
    check('GET / serves index.html', idx.status === 200 && /text\/html/.test(idx.headers.get('content-type') || ''), idx.status);
    check('static responses are no-store', /no-store/.test(idx.headers.get('cache-control') || ''), idx.headers.get('cache-control'));
    const js = await api('GET', '/src/main.js', { tok: null });
    check('GET /src/main.js is javascript', js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''), js.status);
    const headIdx = await fetch(`${app.base}/`, { method: 'HEAD' });
    check('HEAD / works', headIdx.status === 200);
    for (const p of ['/.env.local', '/.data/world.json', '/.git/config', '/server/app.mjs', '/SERVER/app.mjs', '/server/world.mjs',
      '/node_modules/zod/package.json', '/package.json', '/BRIEF.md', '/models/ggml-base.en.bin', '/%2e%2e/%2e%2e/etc/passwd', '/src/%2e%2e/.env.local', '/..%2f.env.local']) {
      const r = await api('GET', p, { tok: null });
      check(`never serves ${p}`, r.status === 404 || r.status === 400 || r.status === 403, `${r.status} ${r.text.slice(0, 80)}`);
    }
    const ph = await api('GET', '/phone?t=abc', { tok: null });
    check('/phone redirects to /phone/ keeping the query', ph.status === 302 && ph.headers.get('location') === '/phone/?t=abc', `${ph.status} ${ph.headers.get('location')}`);

    // ---------------------------------------------------------------- auth
    section('auth');
    for (const [m, p] of [['GET', '/api/world'], ['POST', '/api/op'], ['POST', '/api/chat'], ['POST', '/api/brain'], ['POST', '/api/stt'], ['POST', '/api/say'], ['GET', '/api/creations'], ['POST', '/api/vibe']]) {
      const r = await api(m, p, { tok: null, body: m === 'POST' ? {} : undefined });
      check(`${m} ${p} without a token -> 401 {error:'unauthorized'}`, r.status === 401 && r.json?.error === 'unauthorized', `${r.status} ${r.text.slice(0, 80)}`);
    }
    const bad = await api('GET', '/api/world', { tok: 'wrong-token' });
    check('a wrong token -> 401', bad.status === 401, bad.status);
    const viaQuery = await api('GET', `/api/world?t=${encodeURIComponent(TOKEN)}`, { tok: null });
    check('?t= token works', viaQuery.status === 200, viaQuery.status);
    const viaBearer = await api('GET', '/api/world', { tok: null, headers: { authorization: `Bearer ${TOKEN}` } });
    check('Authorization: Bearer works', viaBearer.status === 200, viaBearer.status);
    const sseNoAuth = openSse(`${app.base}/api/events`);
    await sseNoAuth.ready.catch(() => {});
    check('SSE without a token -> 401', sseNoAuth.status === 401, sseNoAuth.status);
    sseNoAuth.close();
    const mcpBad = await api('POST', '/mcp/not-the-token', { tok: null, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    check('/mcp/<wrong token> -> 401', mcpBad.status === 401, mcpBad.status);
    const unknown = await api('GET', '/api/nope');
    check('unknown /api route -> 404 JSON', unknown.status === 404 && unknown.json?.error, unknown.status);
    const wrongMethod = await api('DELETE', '/api/world');
    check('wrong method -> 405', wrongMethod.status === 405, wrongMethod.status);

    // ---------------------------------------------------------------- SSE + world ops
    section('SSE and world ops');
    const sse = openSse(`${app.base}/api/events?t=${encodeURIComponent(TOKEN)}&from=smoke`);
    await sse.ready;
    check('SSE answers text/event-stream', sse.status === 200 && /text\/event-stream/.test(sse.contentType), `${sse.status} ${sse.contentType}`);
    const first = await sse.waitFor(() => true, 3000);
    check('the first SSE event is a snapshot', first?.event === 'snapshot' && Array.isArray(first.data?.objects) && Number.isInteger(first.data?.version), JSON.stringify(first)?.slice(0, 200));

    let w = (await api('GET', '/api/world')).json;
    check('GET /api/world has the World shape', w && Number.isInteger(w.version) && w.mood?.preset && Array.isArray(w.objects) && Array.isArray(w.guide?.position), JSON.stringify(w)?.slice(0, 200));

    let mark = sse.mark();
    const add1 = await api('POST', '/api/op', { body: { type: 'add', name: 'crystal', description: 'a tall violet crystal humming softly', position: [1, 0, -2] } });
    check('add -> 200 {ok, world}', add1.status === 200 && add1.json?.ok === true && add1.json?.world?.objects?.length === w.objects.length + 1, add1.text.slice(0, 200));
    const o1 = add1.json?.object;
    check('add resolves an archetype asset (crystal)', o1?.asset?.type === 'archetype' && o1.asset.archetype === 'crystal', JSON.stringify(o1?.asset));
    check('user adds are createdBy:user', o1?.createdBy === 'user', o1?.createdBy);
    const opEv = await sse.waitFor((e) => e.event === 'op' && e.data?.op?.type === 'add', 3000, mark);
    check('SSE op event for the add', !!opEv && opEv.data.world_version === add1.json.world.version, JSON.stringify(opEv)?.slice(0, 200));
    check('the op event carries the new object (id + asset)', opEv?.data?.op?.id === o1?.id && opEv?.data?.op?.object?.asset?.type === 'archetype', JSON.stringify(opEv?.data?.op)?.slice(0, 200));

    const add2 = await api('POST', '/api/op', { body: { type: 'add', name: 'x'.repeat(90), description: 'y'.repeat(400), position: [99, -3, -99], scale: 12 } });
    const o2 = add2.json?.object;
    check('clamps position (x/z to +-15, y to 0..8)', JSON.stringify(o2?.position) === JSON.stringify([15, 0, -15]), JSON.stringify(o2?.position));
    check('clamps scale to 4', o2?.scale === 4, o2?.scale);
    check('cuts name to 60 and description to 300', o2?.name?.length === 60 && o2?.description?.length === 300, `${o2?.name?.length}/${o2?.description?.length}`);

    const add3 = await api('POST', '/api/op', { body: { type: 'add', name: 'orb', description: 'a softly glowing teal orb' } });
    const p3 = add3.json?.object?.position || [];
    const dist = Math.hypot(p3[0], p3[2]);
    check('default spawn: 1.5-3 m in front, y 0..1.5', add3.status === 200 && dist >= 1.5 && dist <= 3.1 && p3[2] < 0 && p3[1] >= 0 && p3[1] <= 1.5, JSON.stringify(p3));
    const gap = Math.hypot(p3[0] - 1, p3[2] + 2);
    check('default spawn does not overlap the last object', gap > 0.5, gap.toFixed(2));
    const guideAdd = await api('POST', '/api/op', { body: { type: 'add', name: 'lantern', description: 'a paper lantern' }, headers: { 'x-world-actor': 'guide' } });
    check('x-world-actor: guide -> createdBy:guide', guideAdd.json?.object?.createdBy === 'guide', guideAdd.json?.object?.createdBy);

    // spacing: summoning the same big thing at the same spot again must not stack it into a wall
    const portalA = await api('POST', '/api/op', { body: { type: 'add', name: 'portal', description: 'a violet portal', position: [0.5, 0, -2.6] } });
    const portalB = await api('POST', '/api/op', { body: { type: 'add', name: 'portal', description: 'another violet portal', position: [0.6, 0, -2.6] } });
    const pa = portalA.json?.object?.position || [], pb = portalB.json?.object?.position || [];
    const pgap = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
    check('a crowded add is nudged outward (portals >= 2 m apart)', portalA.status === 200 && portalB.status === 200
      && pgap >= 2 && pb[2] < 0, `${JSON.stringify(pa)} ${JSON.stringify(pb)} gap ${pgap.toFixed(2)}`);
    const portalC = await api('POST', '/api/op', { body: { type: 'add', name: 'portal', description: 'a third portal' } });
    const pc = portalC.json?.object?.position || [];
    check('a spawned portal keeps 2 m from the others', [pa, pb].every((q) => Math.hypot(q[0] - pc[0], q[2] - pc[2]) >= 2), JSON.stringify(pc));
    for (const r of [portalA, portalB, portalC]) if (r.json?.object?.id) await api('POST', '/api/op', { body: { type: 'remove', id: r.json.object.id } });

    const mv = await api('POST', '/api/op', { body: { type: 'move', id: o1?.id, position: [2, 20, -3], rotationY: 1 } });
    check('move -> 200 and clamps y to 8', mv.status === 200 && JSON.stringify(mv.json?.object?.position) === JSON.stringify([2, 8, -3]), mv.text.slice(0, 200));
    const mvBad = await api('POST', '/api/op', { body: { type: 'move', id: 'o999', position: [0, 0, 0] } });
    check('move of an unknown id -> 400 {error}', mvBad.status === 400 && typeof mvBad.json?.error === 'string', mvBad.text);
    const mood = await api('POST', '/api/op', { body: { type: 'mood', preset: 'aurora', fog: 7, glow: -1 } });
    check('mood -> preset set, fog/glow clamped to 0..1', mood.status === 200 && mood.json?.world?.mood?.preset === 'aurora' && mood.json.world.mood.fog === 1 && mood.json.world.mood.glow === 0, JSON.stringify(mood.json?.world?.mood));
    const moodBad = await api('POST', '/api/op', { body: { type: 'mood', preset: 'lava' } });
    check('mood with an unknown preset -> 400', moodBad.status === 400, moodBad.text);
    const guideOp = await api('POST', '/api/op', { body: { type: 'guide', position: [-1, 1.4, -1.2], mood: 'curious' } });
    check('guide op -> 200', guideOp.status === 200 && guideOp.json?.world?.guide?.mood === 'curious', guideOp.text.slice(0, 200));
    const rm = await api('POST', '/api/op', { body: { type: 'remove', id: o2?.id } });
    check('remove -> 200', rm.status === 200 && !rm.json?.world?.objects?.some((o) => o.id === o2?.id), rm.text.slice(0, 120));
    const rmAgain = await api('POST', '/api/op', { body: { type: 'remove', id: o2?.id } });
    check('remove again -> 400', rmAgain.status === 400, rmAgain.status);
    const bogus = await api('POST', '/api/op', { body: { type: 'explode' } });
    check('unknown op type -> 400', bogus.status === 400 && bogus.json?.error, bogus.text);
    const notObj = await api('POST', '/api/op', { body: '[1,2,3]' });
    check('non-object op -> 400', notObj.status === 400, notObj.status);
    const badJson = await api('POST', '/api/op', { body: '{"type":' });
    check('malformed JSON -> 400', badJson.status === 400, badJson.status);
    const empty = await api('POST', '/api/op', { raw: '', contentType: 'application/json' });
    check('empty op body -> 400', empty.status === 400, empty.status);

    // limit: 40 objects
    w = (await api('GET', '/api/world')).json;
    let lastAdd = null;
    for (let i = w.objects.length; i < 40; i++) lastAdd = await api('POST', '/api/op', { body: { type: 'add', name: `wisp ${i}`, description: 'a tiny wandering light', position: [(i % 10) - 5, 1, -4 - Math.floor(i / 10)] } });
    const count40 = (await api('GET', '/api/world')).json?.objects?.length;
    check('the world holds up to 40 objects', count40 === 40 && (lastAdd === null || lastAdd.status === 200), count40);
    const over = await api('POST', '/api/op', { body: { type: 'add', name: 'one too many', description: 'x' } });
    check('the 41st add -> 400 with a friendly error', over.status === 400 && /full|40/.test(over.json?.error || ''), over.text);
    const versions = sse.events.filter((e) => e.event === 'op').map((e) => e.data.world_version);
    check('op events arrive in order with increasing world_version', versions.length >= 40 && versions.every((v, i) => i === 0 || v > versions[i - 1]), versions.slice(-5).join(','));
    mark = sse.mark();
    const clr = await api('POST', '/api/op', { body: { type: 'clear' } });
    check('clear removes objects only (mood kept)', clr.status === 200 && clr.json?.world?.objects?.length === 0 && clr.json.world.mood.preset === 'aurora', clr.text.slice(0, 160));
    check('SSE op event for clear', !!(await sse.waitFor((e) => e.event === 'op' && e.data?.op?.type === 'clear', 3000, mark)));
    await sleep(900);
    check('SSE ": ping" comments keep the stream alive', sse.pings >= 1, `pings=${sse.pings}`);

    // ---------------------------------------------------------------- chat
    section(`chat (brain=scripted${scripted ? '' : ': not available, expecting the friendly fallback'})`);
    const noText = await api('POST', '/api/chat', { body: { text: '   ', from: 'phone' } });
    check('chat without text -> 400', noText.status === 400, noText.status);
    const badBrain = await api('POST', '/api/chat', { body: { text: 'hi', brain: 'gpt' } });
    check('chat with an unknown brain -> 400', badBrain.status === 400, badBrain.status);
    mark = sse.mark();
    const chat = await api('POST', '/api/chat', { body: { text: 'hello there', from: 'phone', brain: 'scripted' } });
    const cid = chat.json?.id;
    check('POST /api/chat -> 202 {id}', chat.status === 202 && typeof cid === 'string' && cid.length > 0, chat.text);
    const userEv = await sse.waitFor((e) => e.event === 'chat' && e.data?.id === cid, 3000, mark);
    check('SSE chat event for the user message', userEv?.data?.role === 'user' && userEv.data.text === 'hello there' && userEv.data.from === 'phone', JSON.stringify(userEv?.data));
    const guideEv = await sse.waitFor((e) => e.event === 'chat' && e.data?.role === 'guide' && e.data?.replyTo === cid, 10000, mark);
    check('SSE chat event with the guide reply', !!guideEv && typeof guideEv.data.text === 'string' && guideEv.data.text.length > 0, JSON.stringify(guideEv?.data));
    if (scripted) {
      check('the reply came from the scripted brain', guideEv?.data?.brain === 'scripted', guideEv?.data?.brain);
      const thinking = await sse.waitFor((e) => e.event === 'status' && e.data?.thinking === true, 100, mark);
      const calm = await sse.waitFor((e) => e.event === 'status' && e.data?.thinking === false, 3000, mark);
      check('status thinking:true then thinking:false', !!thinking && !!calm, JSON.stringify([thinking?.data, calm?.data]));
      mark = sse.mark();
      const c2 = await api('POST', '/api/chat', { body: { text: 'could you add a glowing crystal near me', from: 'xr', brain: 'scripted' } });
      const addEv = await sse.waitFor((e) => e.event === 'op' && e.data?.op?.type === 'add', 8000, mark);
      check('scripted "add a crystal" changes the world (op add over SSE)', !!addEv && addEv.data.op.createdBy === 'guide', JSON.stringify(addEv?.data?.op)?.slice(0, 200));
      const r2 = await sse.waitFor((e) => e.event === 'chat' && e.data?.replyTo === c2.json?.id, 8000, mark);
      check('...and the guide says something about it', !!r2 && r2.data.text.length > 0, JSON.stringify(r2?.data));
    } else {
      const errEv = await sse.waitFor((e) => e.event === 'error', 2000, mark);
      check('no brain: an SSE error event explains it', !!errEv, JSON.stringify(errEv?.data));
    }

    // ---------------------------------------------------------------- brain + say
    section('long-poll events (for clients that cannot stream)');
    const pollNoAuth = await api('GET', '/api/events/poll', { tok: null });
    check('poll without a token -> 401', pollNoAuth.status === 401, pollNoAuth.status);
    const p0 = await api('GET', '/api/events/poll');
    check('poll with no `from` -> {snapshot, last}', p0.status === 200 && Array.isArray(p0.json?.snapshot?.objects) && Number.isInteger(p0.json?.last), p0.text.slice(0, 160));
    const pFuture = await api('GET', '/api/events/poll?from=999999999');
    check('poll from an unknown future id (a server restart) -> snapshot', !!pFuture.json?.snapshot, pFuture.text.slice(0, 120));
    const pNow = await api('GET', `/api/events/poll?from=${p0.json?.last}&wait=0`);
    check('poll from the latest id, no wait -> {events:[], last}', pNow.status === 200 && Array.isArray(pNow.json?.events) && pNow.json.events.length === 0 && pNow.json.last >= p0.json?.last, pNow.text.slice(0, 160));
    let tPoll = Date.now();
    const held = api('GET', `/api/events/poll?from=${pNow.json?.last}&wait=15000`);
    await sleep(300);
    await api('POST', '/api/say', { body: { text: 'A long poll hears me.', from: 'mcp' } });
    const heldRes = await held;
    const heldMs = Date.now() - tPoll;
    const heardEv = heldRes.json?.events?.find((e) => e.event === 'chat' && /long poll hears me/.test(e.data?.text || ''));
    check('a waiting poll resolves as soon as something is broadcast', heldRes.status === 200 && !!heardEv && heldMs < 3000 && heldMs >= 250, `${heldMs} ms ${heldRes.text.slice(0, 160)}`);
    check('poll events carry {id, event, data} and `last` is the newest id', Number.isInteger(heardEv?.id) && heldRes.json.last === heldRes.json.events.at(-1).id, heldRes.text.slice(0, 160));
    tPoll = Date.now();
    const idle = await api('GET', `/api/events/poll?from=${heldRes.json?.last}&wait=600`);
    check('an idle poll returns empty after `wait`', idle.status === 200 && idle.json?.events?.length === 0 && Date.now() - tPoll >= 550, `${Date.now() - tPoll} ms`);
    if (scripted) {
      // A whole chat turn over polling only: the user line, status and the guide reply.
      let cursor = idle.json?.last;
      const pc = await api('POST', '/api/chat', { body: { text: 'what is around me', from: 'phone', brain: 'scripted' } });
      const got = [];
      const until = Date.now() + 10000;
      while (Date.now() < until && !got.some((e) => e.event === 'chat' && e.data?.replyTo === pc.json?.id)) {
        const r = await api('GET', `/api/events/poll?from=${cursor}&wait=5000`);
        if (r.json?.snapshot) break;
        got.push(...(r.json?.events || []));
        cursor = r.json?.last ?? cursor;
      }
      check('a chat turn is fully visible over polling (user line, status, guide reply)', got.some((e) => e.event === 'chat' && e.data?.id === pc.json?.id)
        && got.some((e) => e.event === 'status') && got.some((e) => e.event === 'chat' && e.data?.replyTo === pc.json?.id), got.map((e) => e.event).join(','));
    }

    section('brain picker and say');
    mark = sse.mark();
    const setB = await api('POST', '/api/brain', { body: { brain: 'scripted' } });
    check('POST /api/brain {brain:scripted} -> {brain}', setB.status === 200 && setB.json?.brain === 'scripted', setB.text);
    const setBad = await api('POST', '/api/brain', { body: { brain: 'skynet' } });
    check('POST /api/brain with an unknown brain -> 400', setBad.status === 400, setBad.status);
    const h2 = await api('GET', '/api/health', { tok: null });
    check('health reports the default brain', h2.json?.brain === 'scripted', h2.json?.brain);
    const say = await api('POST', '/api/say', { body: { text: 'Look up: the aurora is waking.', from: 'mcp' } });
    const sayEv = await sse.waitFor((e) => e.event === 'chat' && e.data?.role === 'guide' && /aurora is waking/.test(e.data.text), 3000, mark);
    check('POST /api/say -> a guide chat event', say.status === 200 && !!sayEv && sayEv.data.brain === 'claude', `${say.status} ${JSON.stringify(sayEv?.data)}`);
    const sayEmpty = await api('POST', '/api/say', { body: { text: '' } });
    check('say without text -> 400', sayEmpty.status === 400, sayEmpty.status);

    // ---------------------------------------------------------------- stt
    section('speech-to-text proxy');
    const fakeWebm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);
    const stt = await api('POST', '/api/stt', { raw: fakeWebm, contentType: 'audio/webm;codecs=opus' });
    check('POST /api/stt -> {text} from whisper', stt.status === 200 && stt.json?.text === 'Make the fog a little darker, please.', stt.text);
    check('forwarded as multipart field "file" with response_format=json', whisper.seen.lastFieldOk && whisper.seen.lastFormat === 'json', JSON.stringify(whisper.seen));
    const sttMp4 = await api('POST', '/api/stt', { raw: Buffer.concat([Buffer.from('....ftypmp42'), Buffer.alloc(500)]), contentType: 'audio/mp4' });
    check('audio/mp4 (iOS Safari) works too', sttMp4.status === 200 && sttMp4.json?.text?.length > 0, sttMp4.text);
    const blank = await api('POST', '/api/stt', { raw: Buffer.from('SILENCE'.repeat(50)), contentType: 'audio/webm' });
    check('[BLANK_AUDIO] becomes ""', blank.status === 200 && blank.json?.text === '', blank.text);
    const sttEmpty = await api('POST', '/api/stt', { raw: Buffer.alloc(0), contentType: 'audio/webm' });
    check('empty audio -> 400', sttEmpty.status === 400, sttEmpty.status);
    await whisper.close();
    const sttDown = await api('POST', '/api/stt', { raw: fakeWebm, contentType: 'audio/webm' });
    check('whisper not running -> 503', sttDown.status === 503, `${sttDown.status} ${sttDown.text}`);

    // ---------------------------------------------------------------- mounted modules
    section('vibe and MCP mounts');
    const cr = await api('GET', '/api/creations');
    if (h.json?.vibe) {
      check('GET /api/creations -> 200 JSON list', cr.status === 200 && (Array.isArray(cr.json) || Array.isArray(cr.json?.creations)), `${cr.status} ${cr.text.slice(0, 120)}`);
      const vs = await api('GET', '/api/vibe');
      check('GET /api/vibe -> 200 status', vs.status === 200 && vs.json && typeof vs.json === 'object', `${vs.status} ${vs.text.slice(0, 120)}`);
      const vbad = await api('POST', '/api/vibe', { body: { text: '' } });
      check('POST /api/vibe without text -> 400 (no claude run)', vbad.status === 400, `${vbad.status} ${vbad.text.slice(0, 120)}`);
    } else {
      check('GET /api/creations without vibe.mjs -> 503 JSON', cr.status === 503 && cr.json?.error, cr.status);
    }
    const mcpUrl = `/mcp/${encodeURIComponent(TOKEN)}`;
    const mcpHeaders = { accept: 'application/json, text/event-stream' };
    const init = await api('POST', mcpUrl, { tok: null, headers: mcpHeaders, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } } });
    if (init.status === 503) {
      check('MCP: without server/mcp/http.mjs -> 503 JSON-RPC error', !!init.json?.error, init.text);
    } else {
      check('MCP initialize -> 200 with serverInfo', init.status === 200 && !!init.json?.result?.serverInfo, `${init.status} ${init.text.slice(0, 200)}`);
      const list = await api('POST', mcpUrl, { tok: null, headers: mcpHeaders, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
      const names = (list.json?.result?.tools || []).map((t) => t.name);
      check('MCP tools/list has the world tools', ['look_around', 'summon', 'set_mood'].every((n) => names.includes(n)), names.join(','));
      mark = sse.mark();
      const summon = await api('POST', mcpUrl, { tok: null, headers: mcpHeaders, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'summon', arguments: { name: 'portal', description: 'a ring of violet light' } } } });
      const sEv = await sse.waitFor((e) => e.event === 'op' && e.data?.op?.type === 'add' && e.data.op.name === 'portal', 5000, mark);
      check('MCP summon -> the world changes (op add over SSE, createdBy guide)', summon.status === 200 && !summon.json?.result?.isError && sEv?.data?.op?.createdBy === 'guide', `${summon.text.slice(0, 200)}`);
      const look = await api('POST', mcpUrl, { tok: null, headers: mcpHeaders, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'look_around', arguments: {} } } });
      const lookText = look.json?.result?.content?.[0]?.text || '';
      check('MCP look_around describes the world with ids', /portal/.test(lookText) && /\[o\d+\]/.test(lookText), lookText.slice(0, 200));
      mark = sse.mark();
      const saidMcp = await api('POST', mcpUrl, { tok: null, headers: mcpHeaders, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'say', arguments: { text: 'Welcome back, traveller.' } } } });
      const saidEv = await sse.waitFor((e) => e.event === 'chat' && /Welcome back, traveller/.test(e.data?.text || ''), 3000, mark);
      check('MCP say -> a guide chat event', saidMcp.status === 200 && !!saidEv && saidEv.data.role === 'guide', `${saidMcp.text.slice(0, 160)}`);
      const mcpGet = await api('GET', mcpUrl, { tok: null });
      check('GET /mcp/<token> -> 405 (stateless endpoint)', mcpGet.status === 405, mcpGet.status);
    }

    // ---------------------------------------------------------------- persistence + shutdown
    section('persistence and shutdown');
    const before = (await api('GET', '/api/world')).json;
    sse.close();
    const t0 = Date.now();
    const exit = await stopApp(app, 'SIGTERM');
    check('SIGTERM shuts down cleanly and quickly', exit && exit.code === 0 && Date.now() - t0 < 6000, `${JSON.stringify(exit)} in ${Date.now() - t0} ms`);
    check('world.json was written to DATA_DIR', existsSync(join(dataDir, 'world.json')));
    app = await startApp(baseEnv);
    const api2 = client(app.base, TOKEN);
    const after = (await api2('GET', '/api/world')).json;
    check('the world survives a restart (version, mood, objects)', after?.version === before?.version && after?.mood?.preset === before?.mood?.preset
      && JSON.stringify(after?.objects?.map((o) => o.id)) === JSON.stringify(before?.objects?.map((o) => o.id)), `${before?.version} -> ${after?.version}`);
    const addAfter = await api2('POST', '/api/op', { body: { type: 'add', name: 'moon', description: 'a pale moon' } });
    const maxBefore = Math.max(0, ...(before?.objects || []).map((o) => Number(o.id.slice(1))));
    check('ids keep counting after a restart (never reused)', Number(addAfter.json?.object?.id?.slice(1)) > maxBefore, addAfter.json?.object?.id);
    const h3 = await api2('GET', '/api/health', { tok: null });
    check('the default brain survives a restart', h3.json?.brain === 'scripted', h3.json?.brain);
    await stopApp(app);

    // ---------------------------------------------------------------- first run: token generation
    section('first run without WORLD_TOKEN (and with no brain at all)');
    const genEnv = join(tmp, 'generated.env');
    app = await startApp({ ...baseEnv, WORLD_TOKEN: undefined, ENV_FILE: genEnv, DATA_DIR: join(tmp, 'data2'), BRAINS_ENABLED: 'none' });
    const genText = existsSync(genEnv) ? readFileSync(genEnv, 'utf8') : '';
    const gen = /^WORLD_TOKEN=([A-Za-z0-9_-]+)$/m.exec(genText)?.[1] || '';
    check('a 24-byte base64url token is generated and saved', gen.length === 32, genText.replace(/=.*/, '=<hidden>'));
    const genApi = client(app.base, gen);
    check('the generated token works', (await genApi('GET', '/api/world')).status === 200);
    check('...and the old one does not', (await genApi('GET', '/api/world', { tok: TOKEN })).status === 401);
    const sse2 = openSse(`${app.base}/api/events?t=${encodeURIComponent(gen)}`);
    await sse2.ready;
    const lonely = await genApi('POST', '/api/chat', { body: { text: 'is anyone there?', from: 'phone' } });
    const kind = await sse2.waitFor((e) => e.event === 'chat' && e.data?.replyTo === lonely.json?.id, 5000);
    check('no brain available: still a friendly guide reply', lonely.status === 202 && kind?.data?.role === 'guide' && /moment/.test(kind.data.text), JSON.stringify(kind?.data));
    check('...plus an SSE error event saying why', !!(await sse2.waitFor((e) => e.event === 'error', 2000)));
    sse2.close();
    await stopApp(app);
    app = await startApp({ ...baseEnv, WORLD_TOKEN: undefined, ENV_FILE: genEnv, DATA_DIR: join(tmp, 'data2') });
    check('a restart reuses the saved token', (await client(app.base, gen)('GET', '/api/world')).status === 200);
    await stopApp(app);
  } finally {
    await stopApp(app, 'SIGKILL').catch(() => {});
    try { await whisper.close(); } catch { /* already closed */ }
    if (KEEP) console.log(`\n(kept ${tmp})\n--- last app log ---\n${app.log.slice(-4000)}`);
    else rmSync(tmp, { recursive: true, force: true });
    if (failed && !KEEP) console.log(`\n--- last app log ---\n${app.log.slice(-3000)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - T0) / 1000).toFixed(1)} s${failed ? `\nFailed: ${failures.join('; ')}` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`\nsmoke test crashed: ${e.stack || e}`);
  process.exitCode = 1;
}).finally(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
});
