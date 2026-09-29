#!/usr/bin/env node
// Dreamspace world tools as a stdio MCP server. The claude brain (server/brains/claude-code.mjs) launches this
// through its --mcp-config; you can also add it to any MCP client by hand:
//   {"mcpServers":{"world":{"command":"node","args":["<repo>/server/mcp/stdio.mjs"],
//                           "env":{"WORLD_URL":"http://127.0.0.1:8787","WORLD_TOKEN":"<token>"}}}}
// Env: WORLD_URL (default http://127.0.0.1:$PORT or :8787), WORLD_TOKEN (default: .env.local),
//      WORLD_TOOLS_EXCLUDE (comma list of tool names to hide, e.g. "say"), WORLD_TOOLS_ONLY (e.g. "look_around"),
//      WORLD_ACTOR / WORLD_FROM (attribution).
// stdout carries the protocol, so every log line goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorldServer, resolveToken, resolveWorldUrl } from './world-tools.mjs';

const log = (...a) => process.stderr.write(`[world-mcp] ${a.join(' ')}\n`);

const worldUrl = resolveWorldUrl();
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const exclude = list(process.env.WORLD_TOOLS_EXCLUDE);
const only = list(process.env.WORLD_TOOLS_ONLY);
// Read the token lazily so a server started before app.mjs wrote .env.local still picks it up.
let token = resolveToken();
const getToken = () => token || (token = resolveToken());

const server = createWorldServer({
  worldUrl,
  token: getToken,
  actor: process.env.WORLD_ACTOR || 'guide',
  from: process.env.WORLD_FROM || 'claude',
  exclude,
  only,
});

const transport = new StdioServerTransport();
let closing = false;
async function shutdown(why) {
  if (closing) return;
  closing = true;
  log(`shutting down (${why})`);
  try { await server.close(); } catch { /* already closed */ }
  process.exit(0);
}

// Never outlive the parent: when claude exits or is killed, our stdin closes.
process.stdin.on('end', () => shutdown('stdin end'));
process.stdin.on('close', () => shutdown('stdin close'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
// If the parent vanishes without closing our pipes (SIGKILL), poll for it being gone.
const parent = process.ppid;
setInterval(() => {
  try { process.kill(parent, 0); } catch { shutdown('parent gone'); }
}, 5000).unref();

await server.connect(transport);
log(`ready -> ${worldUrl}${only.length ? ` (only: ${only.join(', ')})` : ''}${exclude.length ? ` (hidden: ${exclude.join(', ')})` : ''}${getToken() ? '' : ' (no WORLD_TOKEN yet)'}`);
