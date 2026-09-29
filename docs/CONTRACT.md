# Contract: Dreamspace (working name)

Every builder codes against this file. If you need to change it, don't change it silently: say so in your final report.
Read `BRIEF.md` for the why. Read `CLAUDE.md` for the three.js/WebXR hard constraints (perf budget, `optionalFeatures` only,
never move the user's viewpoint programmatically, three 0.186.1 via the import map).

## What it is
A calm sci-fi/fantasy world you explore in WebXR, with a companion **guide** you talk to by voice or text. You talk from
the XR viewer or from an **iPhone page** (AirPods, hands-free). The guide answers and **changes the world**: it summons objects,
moves them, changes the mood, and describes what's around. The guide's brain is swappable: a local **ollama** model, **Claude Code
CLI** (`claude -p`, her subscription, never the API) or a **scripted** offline brain. Asset generation is swappable too:
curated **archetypes** now, **LLM primitive parts** now, **Meshy** later.

## Topology (one server, one public URL)
```
iPhone Safari  /phone/   ─┐  (SSE + POST, token)
XR viewer      /         ─┼──  server/app.mjs  :8787  ──  brains (ollama :11434 | claude -p | scripted)
Desktop (emulated Quest) ─┘         │                  ──  assets (archetype | parts via ollama | meshy stub)
claude.ai connector      /mcp/<token>  (remote MCP)   ──  whisper-server :8178 (optional STT)
Public HTTPS: cloudflared quick tunnel → :8787
```
- Port **8787**: `server/app.mjs` serves the static repo root (same no-store caching as `serve/serve.mjs`) **and** the API. The old `npm run dev` on 5173 stays as-is for the plain starter.
- Everything under `/api/*` and `/mcp/*` requires the token. Static files don't.

## Env and ports (so parallel tests never collide)
- `server/app.mjs` honours `PORT` (default 8787) and `DATA_DIR` (default `.data`). Tests **must** use their own `PORT` (pick 18000–18999) and a temp `DATA_DIR`.
- MCP tools reach the app at `WORLD_URL` (default `http://127.0.0.1:8787`) with `WORLD_TOKEN`.
- `OLLAMA_URL` (default `http://127.0.0.1:11434`), `OLLAMA_MODEL` (default `qwen2.5:3b`, already pulled), `WHISPER_URL` (default `http://127.0.0.1:8178`).
- Installed on this Mac: node 25, ollama (running, qwen2.5:3b), cloudflared, whisper-cpp (brew), claude CLI 2.1.x (logged in), `@modelcontextprotocol/sdk` 1.30 + zod 3 in node_modules. **Builders never run npm install**. If you truly need a package, report it.

## Auth
- Token: `process.env.WORLD_TOKEN`, else read from `.env.local` (`WORLD_TOKEN=...`), else generate 24 random bytes (base64url) and write `.env.local`. `.env.local` is gitignored.
- Clients send `?t=<token>` on first load. The page stores it in `localStorage['dreamspace.token']` and strips it from the URL with `history.replaceState`. API calls use the header `x-world-token`, except SSE (EventSource can't set headers), which uses `?t=`.
- Missing or bad token → 401 JSON `{error:'unauthorized'}`.

## HTTP API (JSON, UTF-8)
| Method, path | Body / query | Response |
|---|---|---|
| `GET /api/health` | — (no token needed) | `{ok:true, brains:{ollama:bool, claude:bool, scripted:true}, stt:{whisper:bool}, assets:[names]}` |
| `GET /api/world` | — | `World` |
| `GET /api/events?t=` | SSE | events below; the first event is always `snapshot` |
| `POST /api/chat` | `{text, from:'phone'\|'xr'\|'desktop', brain?:'ollama'\|'claude'\|'scripted'}` | `202 {id}`; the reply arrives over SSE |
| `POST /api/op` | `Op` | `200 {ok:true, world}` or `400 {error}`. For direct manipulation (the user grabbed and moved something) |
| `POST /api/brain` | `{brain}` | `{brain}`: sets the default brain |
| `POST /api/stt` | raw audio body (`audio/webm` or `audio/mp4`) | `{text}`, proxied to whisper-server; `503` if it's not running |

## SSE events (`event:` name, `data:` JSON)
- `snapshot`: `World`
- `op`: `{op: Op, world_version}`: an op was applied. Clients apply it incrementally, or refetch.
- `chat`: `{id, role:'user'|'guide', from, text, brain?}`: every user message and guide reply, broadcast to all clients.
- `status`: `{thinking:bool, brain, detail?}`: the guide is thinking. Drives the UI and the guide's animation.
- `error`: `{message}`
- A comment line `: ping` every 15 s keeps tunnels alive.

## World model (`server/world.mjs` owns it)
```js
World = { version: int, mood: Mood, objects: Obj[], guide: { position:[x,y,z], mood:string } }
Mood  = { preset: 'twilight'|'aurora'|'starfall'|'deepsea'|'dawn', fog: 0..1, glow: 0..1 }   // environment look
Obj   = { id:string, name:string, description:string, asset: Asset, position:[x,y,z], rotationY:number,
          scale:number, createdBy:'guide'|'user', createdAt:number }
Asset = { type:'archetype', archetype:string, params:{ color?:string, variant?:int, [k]:any } }
      | { type:'parts', parts: Part[] }            // max 24 parts
      | { type:'glb', url:string }                  // Meshy later
Part  = { shape:'box'|'sphere'|'cylinder'|'cone'|'torus'|'icosahedron'|'capsule'|'octahedron',
          size:[x,y,z], position:[x,y,z], rotation:[x,y,z], color:'#rrggbb', material:'matte'|'glow'|'glass', emissive?:0..1 }
Op    = { type:'add', name, description, position?, scale?, rotationY? }   // server resolves the asset via the AssetProvider
      | { type:'move', id, position, rotationY? } | { type:'remove', id } | { type:'clear' }
      | { type:'mood', preset?, fog?, glow? } | { type:'guide', position?, mood? }
```
- Server-side limits (clamp, don't crash): at most **40 objects** (adding more rejects with `error`), position x/z in [-15, 15] and y in [0, 8], scale in [0.1, 4], name ≤ 60 chars, description ≤ 300 chars.
- Default spawn: when `add` has no position, place it 1.5–3 m in front of the origin at y 0–1.5 in a spread arc, not overlapping the last object.
- The world persists to `.data/world.json` (gitignored). `clear` resets objects only.
- Exports: `createWorld({file})` → `{ get(), apply(op) → {ok, world, error?}, describe() → string, on(fn) }`. `describe()` is a short natural-language summary for brains.

## Brains (`server/brains/*.mjs`)
Each exports `default async function create(ctx)` → `{ name, available: async () => bool, respond: async ({text, history, world, from}) => ({ reply, ops }) }`.
- `ops` are `Op[]` for the server to apply, in order. The claude brain may apply ops itself through MCP and return `ops: []`.
- `history`: the last 12 `{role, text}`. `reply` is ≤ 2 short spoken sentences: it's voice-first, so no markdown and no lists.
- `server/brains/index.mjs` picks one: a requested brain that's available, else the default (`claude` if available, else `ollama`, else `scripted`).
- **ollama**: model from `OLLAMA_MODEL` (default `qwen2.5:3b`). Use `/api/chat` with `format` set to a JSON schema `{reply, ops}`, `stream:false`. Validate, then drop invalid ops.
- **claude** (`claude-code.mjs`): spawns the `claude` CLI on her subscription. Never set `ANTHROPIC_API_KEY`, and remove it from the child env if present. **Security is non-negotiable:**
  - `cwd` is an empty scratch dir (`.data/claude-cwd/`)
  - `--strict-mcp-config --mcp-config <file with only the world MCP server>`
  - tools limited to the world MCP tools (`--tools`/`--allowedTools mcp__world__*`; confirm flags in `claude --help`), Bash/Read/Write/Edit/WebFetch disallowed
  - never `--dangerously-skip-permissions`, never `bypassPermissions`
  - verify empirically that "list my files" and "send an email" both fail through this brain
  - keep one persistent session (`--session-id`/`--resume`, or stream-json input) so each utterance isn't a cold start
  - timeout 60 s → friendly reply
- **scripted**: keyword rules ("crystal", "portal", "tree", "clear", "darker", "what's here") so the whole app demos with no model at all.
- The system prompt lives in `server/brains/persona.mjs` (export `persona(world)`): a warm, calm guide in a sci-fi/fantasy dreamscape, playful and brief. It lists the ops and the archetype names.

## Assets (`server/assets/*.mjs`)
Each provider exports `default { name, available: async () => bool, generate: async ({name, description}) => Asset | null }`.
`server/assets/index.mjs` exports `resolveAsset({name, description})`: try `archetype` (keyword match), then `parts` (ollama JSON, ≤ 24 parts, validated), then fall back to archetype `'wisp'`. `meshy` is a stub: if `MESHY_API_KEY` is set, it calls the Meshy text-to-3D API (document the endpoint and flow in comments, poll with a timeout) and returns `{type:'glb', url}`; otherwise `available()` is false. Order is configurable with `ASSET_PROVIDERS=archetype,parts,meshy`.
**Archetype names (shared with the client renderer):** `crystal, crystal-cluster, floating-island, portal, lantern, tree-glow, mushroom-glow, rune-stone, orb, planet, moon, spaceship, obelisk, waterfall-light, butterfly-swarm, wisp`.

## MCP (`server/mcp/`)
- `world-tools.mjs`: tool definitions shared by both transports: `look_around` (returns `describe()`), `summon {name, description, position?, scale?}`, `move {id, position}`, `remove {id}`, `clear_world`, `set_mood {preset?, fog?, glow?}`, `say {text}` (shows a guide speech bubble and is spoken on clients as a `chat` guide event). Tools call the running app over HTTP (`http://127.0.0.1:8787/api/...` with the token), so there's a single source of truth.
- `stdio.mjs`: stdio MCP server using `@modelcontextprotocol/sdk` (installed). Used by the claude brain.
- `http.mjs`: exports `handleMcp(req, res, ctx)`, a streamable-HTTP MCP endpoint mounted by `app.mjs` at `/mcp/<token>`, for a claude.ai custom connector (the token is in the path because connectors can't add headers). Stateless mode is fine.

## Client modules (browser, ES modules, three via the import map)
- `src/net/client.js`: `connect({onSnapshot, onOp, onChat, onStatus, onError})` → `{ send(text, brain?), op(op), setBrain(b), world() }`. Handles the token from `?t=`/localStorage, and reconnects with backoff.
- `src/world/environment.js`: `createEnvironment({scene, room, THREE, renderer})` → `{ setMood(mood), update(dt, t), setAR(bool) }`. Sky dome shader, floating islands, fireflies (one `Points`), a distant ringed planet, a slow aurora. Everything decorative goes in `room` (hidden in AR). **Budget: ≤ 30 draw calls, ≤ 120k tris.**
- `src/world/archetypes.js`: `buildArchetype(THREE, name, params)` → `Object3D`, for every archetype name above, beautiful but cheap (≤ 4 draw calls, ≤ 5k tris each; shared geometries and materials).
- `src/world/objects.js`: `createObjectLayer({scene, THREE})` → `{ sync(world), apply(op), update(dt,t), pickables }`. Renders `archetype`/`parts`/`glb` (GLTFLoader) with a gentle spawn animation (scale in and sparkle) and removal fade. Keyed by id.
- `src/world/guide.js`: `createGuide({scene, THREE, camera})` → `{ say(text), setThinking(bool), update(dt,t), object3d }`. A floating wisp companion that drifts near the user (in front and to the left, never blocking the view) and shows a speech bubble (canvas texture) that fades after a few seconds.
- `src/ui/panel3d.js`: `createChatPanel({THREE, camera})`: a small in-XR chat log panel (canvas texture), wrist-attached or floating low-left, with the last 4 lines.
- `src/voice/index.js`: `createVoice({onFinal, onInterim, onState})` → `{ start(), stop(), speak(text) → Promise, supported:{stt, tts}, mode }`. Providers: `web-speech` (webkitSpeechRecognition + speechSynthesis) and `whisper` (MediaRecorder → POST /api/stt). **Rules:** start only on a user gesture (iOS). Pause recognition while speaking (no self-hearing). Hands-free mode auto-restarts recognition after each utterance or `end` event. Always keep a text fallback.
- `src/xr/teleport.js`: user-initiated teleport (thumbstick forward, or pinch-and-hold ray to the floor or an island) by offsetting the reference space. It's the only allowed viewpoint change, and it's always the user's action.
- `src/main.js` (integrator): wires everything into the existing starter plumbing (keep controllers, hands and the VR/AR buttons; `src/emulator.js` stays the first import).
- `index.html` (integrator): the desktop overlay becomes the Dreamspace title, a text input, a mic button, a brain picker and the "open on phone" hint.
- `phone/index.html`, `phone/phone.js`, `phone/phone.css`, `phone/manifest.webmanifest`: the iPhone page. A big tap-to-talk button plus a **hands-free toggle**, a live transcript, the chat log, a text box, the guide's replies spoken through `speechSynthesis` (AirPods) and a brain picker. Optional: a small live window into the world (iframe `/?embed=1`, where the viewer hides its overlay). Add-to-home-screen ready. Dark, calm, and matching the theme.

## Vibe mode: voice-code the world (`server/vibe.mjs`, `src/world/creations.js`)
She wants to "vibe build a WebXR app by voice": say what you want, and Claude writes code that appears live in the world.
- `POST /api/vibe {text, from}` → `202 {id}`. The server runs the `claude` CLI (subscription) with **cwd = `creations/`**, tools limited to
  Read/Write/Edit/Glob inside that directory (no Bash, no web, no MCP except world `look_around`), and `--permission-mode acceptEdits`
  so edits inside cwd are allowed and anything outside is refused. Verify empirically: a write to `../src/main.js` must fail.
  Keep one persistent session so follow-ups ("make it bigger", "now make them orbit") work.
- A creation is `creations/<slug>.js`: `export default function create({ THREE, scene, room, world, addUpdate }) { ...; return object3d }`,
  where `addUpdate(fn(dt,t))` registers an animation. It imports nothing else: three is passed in. `creations/README.md` (owned by vibe) holds the
  rules Claude follows there: the perf budget, metres, no camera moves, calm sci-fi/fantasy style.
- After a run, the server validates each changed file (`node --check`, plus `import`/`fetch`/`eval`/`document.cookie`/`localStorage` banned via a simple lint)
  and broadcasts SSE `creation {slug, url:'/creations/<slug>.js?v=<mtime>', action:'upsert'|'remove'}` plus a `chat` guide line summarising what changed.
- `src/world/creations.js`: `createCreations({THREE, scene, room})` → `{ load(evt), update(dt,t), list() }`. It dynamic-imports with a cache-bust, disposes the
  previous version of a slug, and wraps `create`/updates in try/catch so a bad creation shows an error chip instead of killing the scene.
- `GET /api/creations` lists the current ones on load. Phone and viewer both get a "Vibe" toggle: in vibe mode, utterances go to `/api/vibe` instead of `/api/chat`.

## Ops and scripts
- `package.json` scripts: `start` (`node server/app.mjs`), `tunnel` (cloudflared quick tunnel to 8787), `up` (`node scripts/up.mjs`: checks ollama and starts it if needed, starts whisper-server if the model exists, starts the app and the tunnel, prints the public viewer URL + phone URL with the token, and a terminal QR code for the phone URL), `smoke` (`node server/smoke.mjs`).
- `.gitignore` adds `.env.local`, `.data/`, `models/`, `node_modules/`.
- Whisper model file: `models/ggml-base.en.bin` (gitignored). `scripts/up.mjs` downloads it on first run if missing (~140 MB).

## File ownership (one owner per file; never edit another builder's files; never run git)
| Builder | Owns |
|---|---|
| server-core | `server/app.mjs`, `server/world.mjs`, `server/smoke.mjs`, `server/stt.mjs` |
| brains | `server/brains/index.mjs`, `ollama.mjs`, `scripted.mjs`, `persona.mjs` |
| claude-bridge | `server/brains/claude-code.mjs`, `server/mcp/*` |
| assets | `server/assets/*` |
| environment | `src/world/environment.js` |
| archetypes | `src/world/archetypes.js`, `src/world/objects.js` |
| guide-ui | `src/world/guide.js`, `src/ui/panel3d.js` |
| client-io | `src/net/client.js`, `src/voice/index.js`, `src/xr/teleport.js` |
| phone | `phone/*` |
| vibe | `server/vibe.mjs`, `src/world/creations.js`, `creations/README.md` (server-core mounts `/api/vibe`, `/api/creations` by importing `handleVibe(req,res,ctx)` / `listCreations()` from `server/vibe.mjs`) |
| ops | `package.json`, `scripts/up.mjs`, `.gitignore`, `README.md` |
| integrator (after the builders) | `src/main.js`, `index.html` |

## Themes: voice-swappable looks (next phase, built by the themes workflow; current builders ignore this section)
Her words: "the looks can be swapped depending on what I say to the voice agent running the experience :) we will go through the environment together. The voice agent can narrate and be the one taking the ideas."
- A theme is `src/world/themes/<key>.js`: `export default { key, label, blurb, moods?, create({THREE, scene, room, renderer}) → { update(dt,t), setMood(mood), setAR(bool), dispose() } }`.
  Each theme has the same budget as the environment (≤ 30 draw calls, ≤ 120k tris), puts everything in `room`, and handles every mood preset. `blurb` is 1–2 sentences the guide can narrate.
- `src/world/themes/index.js` holds the registry and loader: `createThemeHost({THREE, scene, room, renderer})` → `{ set(key) (crossfade, disposing the old one), update, setMood, setAR, list() }`. The existing `environment.js` becomes the `twilight` theme, or its host.
- World gains `theme: string` (default `'twilight'`). Op `{type:'theme', name}` is validated against `server/themes.mjs` (keys, labels, blurbs, shared by the brains and MCP). SSE `op` carries it like any op.
- Brains: persona, scripted and ollama learn themes ("take me somewhere bioluminescent", "next world", "show me around"). A **tour**: the guide steps through the themes one at a time, narrating each blurb and asking what she thinks. Her ideas during the tour ("more fireflies here", "make it warmer") become ops or vibe requests. MCP gets `set_theme {name}` and `list_themes`.
- Hackathon integration: another Claude Code session (building her hackathon app) will use Dreamspace as a frontend surface. Keep the HTTP/SSE/MCP API stable and documented; coordinate through Rae.

## Hackathon surface (DuploCloud hack day, 2026-09-29; requested by the hackathon-app Claude session, `projects-d9`)
Dreamspace is one surface of her "voice-agent metaharness": one Claude across mobile voice, claude.ai, Claude Code, Band.ai and Dreamspace, sharing a hosted **contextlog** MCP. Today she has AirPods + web, no headset.
- **Stable API:** don't break the `/api/*` + SSE + `/mcp/<token>` shapes. `scripts/up.mjs` writes the current public base URL (no token) to `.data/public-url` on every start. The token is stable across restarts (`.env.local`).
- **Spatial voice (a):** an optional path. `POST /api/tts {text}` renders speech locally with macOS `say` (convert to m4a/wav with `afconvert`) and returns an audio URL/bytes. The client plays it through WebAudio: `PannerNode` (`panningModel:'HRTF'`) at the guide's world position, updated every frame, plus a subtle delay/echo chain. It has a toggle (on by default when supported), and plain `speechSynthesis` is the fallback. The guide's light pulses and moves with the voice.
- **While you were away (b):** env `CONTEXTLOG_URL` + `CONTEXTLOG_TOKEN`. On a session's first connect, the server reads a `context_state`-style summary, and the guide greets her with it in ≤ 2 sentences. Stubbed and silent until configured.
- **Idea capture (c):** when she proposes a change or idea, the guide says "logged that as an idea" and the server POSTs `{text, source:'dreamspace', ts}` to contextlog `/api/{token}/ideas` (see Contextlog wiring). Otherwise it appends to `.data/ideas.jsonl`. `GET /api/ideas` lists them. Brains get an `idea` op, or equivalent: `{type:'idea', text}`.
- **Event mirror:** when `CONTEXTLOG_EVENTS_URL` is set, `op`/`chat` events are forwarded (batched, best-effort, never blocking).
- **Demo safety (d, hard rule, all brains):** the guide never raises health, disability, benefits or income topics. The persona rule is backed by a server-side reply filter that swaps any such reply for a gentle redirect. On-topic: the sponsors, Dreamspace, voice-agent infrastructure.

### Contextlog wiring (live 2026-09-29, from projects-d9)
- Base `CONTEXTLOG_URL` (default `http://127.0.0.1:7779`; a public Vultr `https://<ip>.sslip.io` URL comes later). The token is **not copied** into this repo: the server reads
  `CONTEXTLOG_TOKEN` at runtime from `CONTEXTLOG_ENV_FILE` (default `../claude-app-contextational-analysis/.env.local`), or from the env if set. It is never logged, never sent to clients, never committed.
  The token goes in the URL **path**.
- `GET  {base}/api/{token}/while-away?surface=spatial` → `{now, since, ambient_notes:[{ts,title,text,location,people}], queued_ideas:[], guidance}`. Already demo-safe server-side, and our filter still applies. Used for the first-connect greeting.
- `POST {base}/api/{token}/ideas {text, source:'rae'|'claude-agreed', surface:'spatial', context}` → `{ok, id, say}`. The guide speaks `say`. On failure, fall back to `.data/ideas.jsonl`.
- `POST {base}/api/{token}/ambient {text, title, source:'dreamspace', tags:['world-event']}`. Keep it **sparse**: batched summaries (e.g. "Rae toured 3 worlds and summoned a portal"), at most one per few minutes, never every op.
- MCP alternative: `POST {base}/mcp/{token}`, tools `while_away`, `idea_log`, `ideas_list`, `context_ping`, `ambient_ingest` (surface `'spatial'`).
- Never open a tunnel for contextlog; its public URL comes from its own hosting.
