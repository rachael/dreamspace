// Streamable-HTTP MCP endpoint for a claude.ai custom connector (Customize > Connectors > Add custom connector,
// URL https://<public-host>/mcp/<WORLD_TOKEN>, Authentication: "No sign-in"). app.mjs mounts it:
//
//   import { handleMcp } from './mcp/http.mjs';
//   if (url.pathname.startsWith('/mcp/')) return handleMcp(req, res, { token, say });   // ctx is optional
//
// Stateless mode, JSON responses only (no text/event-stream), because Cloudflare quick tunnels do not stream SSE.
// A fresh McpServer + transport per POST; GET/DELETE answer 405 (no standalone stream, no sessions).
// The token in the path is checked here too (timing-safe), so the handler is safe even if mounted without auth.
//
// ctx (all optional): { token, worldUrl, say: async (text) => void, body (pre-parsed JSON), log: fn }
// Test with curl (both Accept types are required by the MCP spec):
//   curl -s -X POST http://127.0.0.1:8787/mcp/$WORLD_TOKEN -H 'content-type: application/json' \
//     -H 'accept: application/json, text/event-stream' \
//     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWorldServer, resolveToken, resolveWorldUrl } from './world-tools.mjs';

const MAX_BODY = 1024 * 1024; // 1 MB: tool calls are tiny

function sendJson(res, status, obj, extra = {}) {
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const rpcError = (res, status, code, message, extra) => sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The app's own base URL, from the socket this request arrived on (so tests on any PORT just work). */
function selfUrl(req) {
  const port = req.socket?.localPort;
  let addr = req.socket?.localAddress || '127.0.0.1';
  if (!port) return resolveWorldUrl();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::' || addr === '0.0.0.0') addr = '127.0.0.1';
  return addr.includes(':') ? `http://[${addr}]:${port}` : `http://${addr}:${port}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; req.pause(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleMcp(req, res, ctx = {}) {
  const log = typeof ctx.log === 'function' ? ctx.log : (...a) => console.log('[mcp]', ...a);
  const url = new URL(req.url || '/', 'http://x');
  const segs = url.pathname.split('/').filter(Boolean); // ['mcp', '<token>', ...]
  const expected = ctx.token || resolveToken();
  if (!expected) return sendJson(res, 503, { error: 'no WORLD_TOKEN configured' });
  if (segs[0] !== 'mcp' || !tokenMatches(decodeURIComponent(segs[1] || ''), expected)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    return rpcError(res, 405, -32000, 'Method not allowed: this MCP endpoint is stateless, use POST.', { allow: 'POST' });
  }

  let body = ctx.body ?? req.body;
  if (body === undefined) {
    if (req.readableEnded) return rpcError(res, 400, -32700, 'Request body was already consumed before handleMcp.');
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch (e) {
      if (e?.status === 413) {
        res.on('finish', () => req.destroy()); // answer first, then drop the rest of the upload
        return rpcError(res, 413, -32600, 'Request body too large.', { connection: 'close' });
      }
      return rpcError(res, 400, -32700, 'Parse error: body is not valid JSON.');
    }
  } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try { body = JSON.parse(String(body)); } catch { return rpcError(res, 400, -32700, 'Parse error: body is not valid JSON.'); }
  }
  if (body === undefined) return rpcError(res, 400, -32600, 'Empty request body.');

  for (const m of Array.isArray(body) ? body : [body]) {
    if (m?.method === 'tools/call') log(`tools/call ${String(m.params?.name || '?').slice(0, 40)}`);
    else if (m?.method === 'initialize') log(`initialize from ${String(m.params?.clientInfo?.name || 'client').slice(0, 40)}`);
  }

  const server = createWorldServer({
    worldUrl: ctx.worldUrl || selfUrl(req),
    token: expected,
    actor: 'guide',
    from: ctx.from || 'claude.ai',
    say: typeof ctx.say === 'function' ? ctx.say : undefined,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log('error', e?.message || e);
    rpcError(res, 500, -32603, 'Internal server error.');
  }
}

export default handleMcp;
