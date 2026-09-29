// Dreamspace world tools, shared by both MCP transports (stdio for the claude brain, streamable HTTP for a
// claude.ai custom connector). Every tool talks to the running app over HTTP (WORLD_URL + WORLD_TOKEN), so the
// app's world stays the single source of truth. See docs/CONTRACT.md, "MCP".
//
//   look_around                         -> GET  /api/world, rendered as a short description with object ids
//   summon {name, description, where?|position?, scale?, rotationY?}  -> POST /api/op {type:'add'}
//   move   {id, where?|position?, rotationY?}                          -> POST /api/op {type:'move'}
//   remove {id}                         -> POST /api/op {type:'remove'}
//   clear_world                         -> POST /api/op {type:'clear'}
//   set_mood {preset?, fog?, glow?}     -> POST /api/op {type:'mood'}
//   say {text}                          -> opts.say(text) hook if the host gives one, else POST /api/say {text, from}
//
// Tool failures come back as `isError` results with a plain sentence (never a throw), so the model can recover,
// e.g. when the 40-object limit is reached. The token never appears in any tool output or log line.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ARCHETYPES = ['crystal', 'crystal-cluster', 'floating-island', 'portal', 'lantern', 'tree-glow',
  'mushroom-glow', 'rune-stone', 'orb', 'planet', 'moon', 'spaceship', 'obelisk', 'waterfall-light',
  'butterfly-swarm', 'wisp'];
export const MOODS = ['twilight', 'aurora', 'starfall', 'deepsea', 'dawn'];
export const WHERE = ['in_front', 'beside_user', 'far', 'above_user', 'sky'];
export const TOOL_NAMES = ['look_around', 'summon', 'move', 'remove', 'clear_world', 'set_mood', 'say'];

const OP_TIMEOUT_MS = 60_000;   // an add may wait on asset generation (ollama parts can take ~20 s)
const GET_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// Config helpers (also used by stdio.mjs, http.mjs and the claude brain)

/** WORLD_TOKEN from the environment, else from .env.local at the repo root. Never generates one (app.mjs does). */
export function resolveToken(root = ROOT) {
  if (process.env.WORLD_TOKEN) return process.env.WORLD_TOKEN.trim();
  try {
    const txt = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
    const m = /^\s*WORLD_TOKEN\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(txt);
    if (m) return m[1].trim();
  } catch { /* no .env.local yet */ }
  return '';
}

export function resolveWorldUrl() {
  if (process.env.WORLD_URL) return process.env.WORLD_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 8787}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers

const r1 = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/** Keep personal details out of the shared world: no email addresses or home-folder paths in names, descriptions or speech. */
export function redact(s) {
  let t = String(s ?? '');
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '(hidden)');
  const home = os.homedir();
  if (home && home.length > 1) t = t.split(home).join('~');
  return t.replace(/(~(?=\/)|\/(?:Users|home)\/[^\s/'"`)]+)(\/[^\s'"`)]*)?/g, 'a private folder');
}
const fmtPos = (p) => (Array.isArray(p) ? `(${p.map(r1).join(', ')})` : '(?)');
const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

/** Human direction of a point relative to where the user starts (origin, facing -z). */
export function relativeTo(p) {
  if (!Array.isArray(p)) return '';
  const [x, y, z] = p.map(Number);
  const d = Math.hypot(x, z);
  if (d < 0.35) return y > 2.2 ? 'overhead' : 'right here';
  const parts = [];
  if (z < -0.3) parts.push('ahead'); else if (z > 0.3) parts.push('behind');
  if (x < -0.3) parts.push('left'); else if (x > 0.3) parts.push('right');
  let dir = parts.join(' ');
  if (Math.abs(x) > 0.3 && Math.abs(z) > 0.3) {
    // name the dominant axis first: "ahead, a little left" reads better than "ahead left"
    dir = Math.abs(z) >= Math.abs(x)
      ? `${parts[0]}${Math.abs(x) < Math.abs(z) * 0.5 ? ', a little ' : ' and '}${parts[1]}`
      : `${parts[1]}${Math.abs(z) < Math.abs(x) * 0.5 ? ', a little ' : ' and '}${parts[0]}`;
  }
  const high = y > 3 ? ', high up' : '';
  return `${d.toFixed(1)} m ${dir}${high}`;
}

function assetLabel(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.type === 'archetype') return a.archetype || 'archetype';
  if (a.type === 'parts') return `${Array.isArray(a.parts) ? a.parts.length : '?'} sculpted parts`;
  if (a.type === 'glb') return 'generated model';
  return a.type || '';
}

/** Short natural-language world summary with ids, for look_around and for the claude brain's per-turn context. */
export function describeWorld(world, { max = 40, compact = false } = {}) {
  if (!world || typeof world !== 'object') return 'The world could not be read.';
  const m = world.mood || {};
  const objs = Array.isArray(world.objects) ? world.objects : [];
  const mood = `${m.preset || 'twilight'} (fog ${r1(m.fog ?? 0.5)}, glow ${r1(m.glow ?? 0.5)})`;
  if (compact) {
    const list = objs.slice(-max).map((o) => `[${o.id}] ${cut(o.name, 40)} ${fmtPos(o.position)}`).join('; ');
    return `mood ${mood}; ${objs.length} object${objs.length === 1 ? '' : 's'}${objs.length ? ': ' + list : ''}`;
  }
  const lines = [`Mood: ${mood}. ${objs.length} of 40 objects.`];
  if (!objs.length) lines.push('The world is empty: just sky, islands and fireflies.');
  for (const o of objs.slice(-max)) {
    const sc = Number(o.scale ?? 1);
    lines.push(`[${o.id}] ${cut(o.name, 60)}: ${cut(o.description, 120)} | at ${fmtPos(o.position)}, ${relativeTo(o.position)}`
      + `${Math.abs(sc - 1) > 0.05 ? `, scale ${r1(sc)}` : ''} | ${assetLabel(o.asset)}${o.createdBy === 'user' ? ', placed by the user' : ''}`);
  }
  if (Array.isArray(world.guide?.position)) lines.push(`You (the guide) float at ${fmtPos(world.guide.position)}.`);
  lines.push('Coordinates are metres. The user started at the origin facing -z; y=0 is the ground; x/z range -15..15, y 0..8.');
  return lines.join('\n');
}

/** Map a semantic `where` to a position (undefined = let the server use its default spawn arc in front). */
export function whereToPosition(where, world, i = 0) {
  const objs = Array.isArray(world?.objects) ? world.objects : [];
  const near = (p) => objs.some((o) => Array.isArray(o.position) && Math.hypot(o.position[0] - p[0], o.position[2] - p[2]) < 0.6);
  const spread = (p) => { const q = [p[0] + 1.2 * i, p[1], p[2]]; return near(q) ? [q[0] + 0.9, q[1], q[2] - 0.4] : q; };
  switch (where) {
    case 'beside_user': {
      // alternate sides so a second "next to me" doesn't land inside the first
      const right = [1.0, 1.0, -0.6], left = [-1.0, 1.0, -0.6];
      return near(right) ? (near(left) ? [1.6, 1.0, -1.2] : left) : right;
    }
    case 'far': return spread([0, 1, -8]);
    case 'above_user': return spread([0, 3, -1.5]);
    case 'sky': return spread([0, 6, -10]);
    default: return undefined; // in_front / anywhere
  }
}

const vec3 = z.array(z.number()).length(3);

// ---------------------------------------------------------------------------------------------------------------
// HTTP client for the app

export function createWorldClient({ worldUrl = resolveWorldUrl(), token = resolveToken(), actor = 'guide', from = 'mcp' } = {}) {
  const base = String(worldUrl).replace(/\/+$/, '');
  async function call(method, p, body, timeoutMs) {
    const headers = { 'x-world-token': typeof token === 'function' ? token() : token, 'x-world-actor': actor, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const code = e?.cause?.code || e?.name;
      if (code === 'ECONNREFUSED') throw new ToolError(`The Dreamspace app is not running at ${base}.`);
      if (code === 'TimeoutError' || code === 'AbortError') throw new ToolError('The world took too long to answer. Try again in a moment.');
      throw new ToolError(`Could not reach the world (${code || 'network error'}).`);
    }
    let data = null;
    const txt = await res.text();
    try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
    if (res.status === 401) throw new ToolError('The world rejected the access token (WORLD_TOKEN mismatch).');
    if (!res.ok) throw new ToolError(cut(data?.error || data?.message || `The world answered HTTP ${res.status}.`, 300), res.status);
    return data;
  }
  return {
    base, actor, from,
    world: () => call('GET', '/api/world', undefined, GET_TIMEOUT_MS),
    op: async (op) => {
      const data = await call('POST', '/api/op', op, OP_TIMEOUT_MS);
      if (data && data.ok === false) throw new ToolError(cut(data.error || 'The world refused that change.', 300));
      return data;
    },
    say: (text) => call('POST', '/api/say', { text, from }, GET_TIMEOUT_MS),
  };
}

class ToolError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const guard = (fn) => async (args) => {
  try { return await fn(args || {}); } catch (e) { return fail(e instanceof ToolError ? e.message : `Something went wrong: ${cut(e?.message || e, 200)}`); }
};

/** Resolve an id the model gave us; accept a unique name match as a courtesy (voice users say names, not ids). */
function resolveId(world, id) {
  const objs = Array.isArray(world?.objects) ? world.objects : [];
  const want = String(id ?? '').trim().replace(/^\[|\]$/g, '');
  const exact = objs.find((o) => o.id === want);
  if (exact) return exact;
  const low = want.toLowerCase();
  const byName = objs.filter((o) => String(o.name).toLowerCase() === low);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new ToolError(`Several objects are called "${want}" (${byName.map((o) => o.id).join(', ')}). Use one id.`);
  if (!want) throw new ToolError('Give the object id (from look_around).');
  // Unknown here, but the server may still know it: an object whose asset was swapped keeps its old id as an alias.
  return { id: want, name: want, position: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Tool registration

export const SERVER_INSTRUCTIONS = `Dreamspace is a calm sci-fi and fantasy world the user is exploring in VR (Quest browser) or on their phone. \
These tools let you act as the world's guide: look_around shows what is there (with object ids), summon creates objects, \
move/remove/clear_world rearrange them, set_mood changes the sky and light, and say makes the in-world guide speak a line aloud. \
Coordinates are metres; the user starts at the origin facing -z and y=0 is the ground, so things 1.5-3 m ahead (z -1.5..-3) \
at y 0..1.5 are comfortable to see. Prefer the "where" shortcut over raw positions. Keep spoken lines short, warm and calm.`;

/**
 * Register the world tools on an McpServer.
 * opts: { worldUrl, token (string | () => string), actor, from, exclude: string[], only: string[], say: async (text) => void }
 */
export function registerWorldTools(server, opts = {}) {
  const client = opts.client || createWorldClient(opts);
  const exclude = new Set(opts.exclude || []);
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const reg = (name, config, handler) => {
    if (exclude.has(name) || (only && !only.has(name))) return;
    server.registerTool(name, config, guard(handler));
  };

  reg('look_around', {
    title: 'Look around',
    description: 'Describe the world right now: the mood and every object with its [id], name, position and direction from the user. Use the ids with move and remove.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => ok(describeWorld(await client.world())));

  reg('summon', {
    title: 'Summon an object',
    description: `Create one object in the world (call it once per object: "three lanterns" is three calls). `
      + `name: a short noun, ideally one of: ${ARCHETYPES.join(', ')} (other names get a generated look). `
      + `description: one vivid line about shape, colour, glow and material. `
      + `Placement: "where" (${WHERE.join(', ')}; default in_front) or an exact position [x,y,z] in metres (user starts at origin facing -z, y=0 ground).`,
    inputSchema: {
      name: z.string().min(1).describe('Short name, e.g. "crystal" or "lantern" (max 60 chars)'),
      description: z.string().min(1).describe('One vivid line: colour, glow, material, mood (max 300 chars)'),
      where: z.enum(WHERE).optional().describe('Semantic placement; ignored when position is given'),
      position: vec3.optional().describe('[x, y, z] metres; x/z in -15..15, y in 0..8'),
      scale: z.number().optional().describe('Uniform scale 0.1..4, default 1'),
      rotationY: z.number().optional().describe('Yaw in radians'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name, description, where, position, scale, rotationY }) => {
    const op = { type: 'add', name: cut(redact(name), 60), description: cut(redact(description), 300) };
    let pos = position;
    if (!pos && where && where !== 'in_front') {
      let world = null;
      try { world = await client.world(); } catch { /* place without collision info */ }
      pos = whereToPosition(where, world);
    }
    if (pos) op.position = [clamp(pos[0], -15, 15), clamp(pos[1], 0, 8), clamp(pos[2], -15, 15)];
    if (Number.isFinite(scale)) op.scale = clamp(scale, 0.1, 4);
    if (Number.isFinite(rotationY)) op.rotationY = rotationY;
    const data = await client.op(op);
    const objs = Array.isArray(data?.world?.objects) ? data.world.objects : [];
    const mine = (data?.object?.id && data.object)
      || objs.filter((o) => o.name === op.name).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      || objs[objs.length - 1];
    if (!mine) return ok(`Summoned ${op.name}.`);
    return ok(`Summoned [${mine.id}] ${mine.name} at ${fmtPos(mine.position)}, ${relativeTo(mine.position)} (${assetLabel(mine.asset)}). The world now has ${objs.length} object${objs.length === 1 ? '' : 's'}.`);
  });

  reg('move', {
    title: 'Move an object',
    description: 'Move an existing object by id (from look_around). Give "where" (beside_user brings it next to the user, far sends it away) or an exact position [x,y,z].',
    inputSchema: {
      id: z.string().min(1).describe('Object id, e.g. "o3"'),
      where: z.enum(WHERE).optional(),
      position: vec3.optional().describe('[x, y, z] metres'),
      rotationY: z.number().optional().describe('Yaw in radians'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, where, position, rotationY }) => {
    const world = await client.world();
    const obj = resolveId(world, id);
    let pos = position;
    if (!pos) {
      pos = whereToPosition(where || 'in_front', { objects: world.objects.filter((o) => o.id !== obj.id) });
      if (!pos) pos = [clamp(obj.position?.[0] ?? 0, -1.2, 1.2), 1.0, -2.0]; // in_front: a comfortable spot ahead
    }
    const op = { type: 'move', id: obj.id, position: [clamp(pos[0], -15, 15), clamp(pos[1], 0, 8), clamp(pos[2], -15, 15)] };
    if (Number.isFinite(rotationY)) op.rotationY = rotationY;
    const data = await client.op(op);
    const now = data?.world?.objects?.find((o) => o.id === obj.id);
    return ok(`Moved [${obj.id}] ${obj.name} to ${fmtPos(now?.position || op.position)}, ${relativeTo(now?.position || op.position)}.`);
  });

  reg('remove', {
    title: 'Remove an object',
    description: 'Remove one object by id (from look_around). Only remove what the user asked about.',
    inputSchema: { id: z.string().min(1).describe('Object id, e.g. "o3"') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const obj = resolveId(await client.world(), id);
    const data = await client.op({ type: 'remove', id: obj.id });
    const n = data?.world?.objects?.length;
    return ok(`Removed [${obj.id}] ${obj.name}.${Number.isFinite(n) ? ` ${n} object${n === 1 ? '' : 's'} remain.` : ''}`);
  });

  reg('clear_world', {
    title: 'Clear the world',
    description: 'Remove every object (the sky, islands and mood stay). Only when the user clearly asks to clear, reset or wipe everything.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    await client.op({ type: 'clear' });
    return ok('The world is clear: every object is gone.');
  });

  reg('set_mood', {
    title: 'Set the mood',
    description: `Change the sky and light. preset: ${MOODS.join(', ')}. fog 0..1 (higher is mistier and darker), glow 0..1 (how bright crystals, fireflies and aurora shine). Give any subset.`,
    inputSchema: {
      preset: z.enum(MOODS).optional(),
      fog: z.number().optional().describe('0..1'),
      glow: z.number().optional().describe('0..1'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ preset, fog, glow }) => {
    const op = { type: 'mood' };
    if (preset) op.preset = preset;
    if (Number.isFinite(fog)) op.fog = clamp(fog, 0, 1);
    if (Number.isFinite(glow)) op.glow = clamp(glow, 0, 1);
    if (Object.keys(op).length === 1) return fail('Give a preset, fog or glow.');
    const data = await client.op(op);
    const m = data?.world?.mood || op;
    return ok(`Mood is now ${m.preset || 'unchanged'} (fog ${r1(m.fog ?? op.fog ?? 0.5)}, glow ${r1(m.glow ?? op.glow ?? 0.5)}).`);
  });

  reg('say', {
    title: 'Speak in the world',
    description: 'Make the in-world guide say a short line: it appears as a speech bubble and is spoken aloud on the headset and phone. One or two short sentences, no markdown.',
    inputSchema: { text: z.string().min(1).describe('What the guide says (max 400 chars)') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ text }) => {
    const line = cut(redact(text).replace(/[*_`#>]/g, ''), 400);
    if (typeof opts.say === 'function') { await opts.say(line); return ok('Said it in the world.'); }
    try {
      await client.say(line);
    } catch (e) {
      if (e instanceof ToolError && (e.status === 404 || e.status === 405)) {
        return fail('This Dreamspace server has no /api/say endpoint yet, so the guide cannot speak this line.');
      }
      throw e;
    }
    return ok('Said it in the world.');
  });

  return client;
}

/** A ready McpServer carrying the world tools. */
export function createWorldServer(opts = {}) {
  const server = new McpServer(
    { name: 'dreamspace-world', title: 'Dreamspace world', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerWorldTools(server, opts);
  return server;
}
