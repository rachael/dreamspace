# WebXR app (from the Vibe XR starter): instructions for Claude Code

> **Read `BRIEF.md` first**: the owner's goal, hardware, metaprompt, playbook and lessons.

> **This folder is a lean copy of the starter.** `examples/`, `docs/` and `workshop/` were left out to keep context small.
> When you need them, read them from the full reference clone at
> `../pico-workshops/vibe-xr/` (same content as https://pico-workshops.vercel.app/). Don't copy them in wholesale.
>
> **Targets: a Meta Quest 3 (the owner's own headset, main dev device) AND the PICO 4 Ultra loaners at the event.**
> The PICO browser is the stricter of the two, so the rules below (written for PICO) are the common floor: stay inside them
> and the app runs on both. Keep any extra feature in `optionalFeatures`, never `requiredFeatures`.
> - Quest loop: developer mode on, USB-C, `npm run usb` (`adb reverse tcp:5173 tcp:5173`), open `http://localhost:5173` in the Quest Browser.
> - PICO loaners: same `npm run usb` / `node scripts/open-on-headset.mjs`, or `npm run serve` over Tailscale. Never `pico-cli web launch`.

This repo is a **three.js WebXR scene that runs in the PICO browser** on a PICO 4 Ultra.
The person you are working with describes a change in plain English; you edit the scene;
they reload the page on their laptop, then in the headset. Keep that loop fast: small,
working edits, one idea at a time, and tell them what to look at after each one.

It is a web page, not a native PICO app. No Unity, no Android build, no PICO Spatial SDK.

## The loop

1. `npm run dev` serves the repo at http://localhost:5173 (desktop preview, orbit with the mouse).
2. You edit **`src/main.js`**, almost always at a `// ✏️ REMIX HERE` marker.
3. The person reloads the browser tab. There is no build step and no hot reload; the server sends `Cache-Control: no-store`, so a plain reload always gets your latest code.
4. When it looks right on desktop: `npm run serve` publishes it over tailnet HTTPS and prints an `https://<machine>.<tailnet>.ts.net` URL to open in the PICO browser. Then tap **Enter VR** or **Enter AR**.

Before handing back, re-read your edit for syntax errors. A single typo in `src/main.js` gives a black page with no scene, and in the headset there is no console to see why.

## File map

| Path | What it is | Edit it? |
|---|---|---|
| `src/main.js` | The whole scene: lights, room, hero object, input, animation loop. ~170 lines. | **Yes. This is where you work.** |
| `index.html` | Import map (pins three.js), the 2D landing overlay, the VR/AR button slot. | Only for overlay text, or to add an import-map entry. |
| `theme/pico-theme.js`, `theme/pico.css` | Workshop palette and materials (`PICO`, `applyPicoFog`, `picoMaterial`). | No; use it. Read `theme/README.md` for where each value comes from. |
| `assets/` | Put `.glb` / `.gltf` / textures / audio here. | Add files. |
| `examples/` | Finished scenes to copy ideas from: `ar-placer` (AR hit-test placement), `hand-garden` (hand tracking), `portal`, `gallery`, `beat-room`. Each is its own page at `/examples/<name>/`. | Read and borrow from; don't break them. |
| `serve/` | `serve.mjs` (static server, :5173), `start.mjs` (tailnet or USB publish), `serve.sh` / `serve.ps1` wrappers. | Rarely. |
| `scripts/` | Node helpers around PICO CLI + adb: `node scripts/open-on-headset.mjs <url>` (open a URL in the headset's PICO browser over USB; sets up `adb reverse` for localhost URLs), `node scripts/snap.mjs` (screenshot what the headset shows into `captures/`), plus `doctor`, `console`, `perf`, `record`, `usb-reverse`. See `docs/PICO-CLI.md`. | Use them. |
| `docs/`, `workshop/` | Workshop docs and the event run of show. | No. |

## How `src/main.js` is laid out

Top to bottom: imports, renderer/camera/scene plumbing, then these marked sections:

- `REMIX HERE: lights`: hemisphere + key light + a point light that follows the hero.
- `REMIX HERE: the room`: floor disc, grid, glass plinth. Everything added to `room` is **hidden in AR** so the real room shows through. Put scenery in `room`; put things that should also appear in AR directly in `scene`.
- `REMIX HERE: the hero object`: the faceted orb + glow halo. `grabbables` is the list of objects the controllers and hand pinches can grab. Push new objects into it to make them grabbable.
- `REMIX HERE: add more objects below`: the empty slot for new stuff.
- `poke()`: what happens when the hero is clicked (desktop) or touched with an index fingertip (hands).
- `REMIX HERE: the animation loop`: runs every frame with `dt` (seconds since last frame) and `t` (elapsed seconds). Animate with `dt`, never per-frame constants, so it runs the same at 72 and 90 fps.

The input section (controllers, hands, VR/AR buttons, AR passthrough handling) is plumbing. Leave it alone unless the change is about input.

## Theme API (use it instead of raw colours)

```js
import { PICO, applyPicoFog, picoMaterial } from '../theme/pico-theme.js';
PICO.bg, PICO.surface, PICO.ink, PICO.accent, PICO.accent2, PICO.glow, PICO.danger // hex strings
applyPicoFog(scene, THREE)                       // background + fog; already called
applyPicoFog(scene, THREE, { ar: true })         // clears both; main.js does this on entering AR
picoMaterial(THREE, 'glass' | 'glow' | 'matte', { ...overrides })
// glass = dark translucent physical material, glow = unlit bright (no lighting, no emissive),
// matte = standard lit material (defaults to PICO.accent; override color/emissive/flatShading)
```

`glow` is `MeshBasicMaterial`: it has `.color` but no `.emissive`. To make a lit object glow, use `matte` with `{ emissive: PICO.glow, emissiveIntensity: 0.6 }`.

## Hard constraints (the headset will not bend on these)

- **WebXR only.** `immersive-vr` and `immersive-ar` work in the PICO browser, as do **hit-test, anchors, plane detection and hand tracking**. **Camera access, depth sensing, mesh detection, light estimation and DOM overlay are refused**, and there is no eye or face tracking. Never make any of those a `requiredFeatures` entry: the session will fail to start. If someone asks for "the model sees my room", say plainly that the PICO browser does not expose the camera, and offer hit-test or plane detection instead.
- **Never run `pico-cli web launch` against a headset.** On 0.5.0 it installs a 336 MB browser APK on the headset first (its license carries PICO NDA text), targets the OS 6 browser our PICO 4 Ultras don't have, and rewrites `localhost` to `10.0.2.2` (an emulator-only address). Open URLs with `node scripts/open-on-headset.mjs <url>` instead.
- **PICO CLI install is `npm i -g @picoxr/pico-cli`** (binary `pico-cli`). Plain `npm i -g pico-cli` installs an unrelated package.
- **HTTPS or localhost only.** WebXR needs a secure context. `http://192.168.x.x:5173` shows the page but no Enter VR button. Use `npm run serve` (tailnet HTTPS) or `npm run usb` (`adb reverse`, then `http://localhost:5173` in the headset).
- **three.js is pinned to 0.186.1 by the import map in `index.html`.** Import three as `'three'` and addons as `'three/addons/...'` (for example `'three/addons/loaders/GLTFLoader.js'`). Do not `npm install three`, add a bundler, or mix versions. If you need an addon, it is already reachable under `three/addons/`.
- **Mobile GPU, stereo rendering, 72-90 fps.** Everything renders twice. Budget: under ~100 draw calls, under ~300k triangles, few lights (the three here are enough), no real-time shadows unless asked, no post-processing, no `transmission` on physical materials, textures 2048px max. For many copies of one object use `THREE.InstancedMesh` (one draw call) instead of a loop of meshes.
- **Scale is metres.** The floor is y=0, standing eye height is ~1.6, arm's reach is ~0.6 m in front. Things you want to touch go at y 1.0-1.5, z -0.4 to -0.8. Text and UI should be at least 1 m away and large.
- **Comfort.** Never move or rotate the camera yourself in VR (the headset owns it). No flashing faster than a few times a second.

## Recipes

**Add a GLB model** (file in `assets/`, e.g. `assets/robot.glb`), in the "add more objects" slot:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; // put this with the other imports at the top
new GLTFLoader().load('assets/robot.glb', (gltf) => {
  const model = gltf.scene;
  model.position.set(0.8, 0, -1);   // metres; y=0 is the floor
  model.scale.setScalar(0.5);
  scene.add(model);                 // or room.add(model) to hide it in AR
  grabbables.push(model);           // optional: make the whole model grabbable
}, undefined, (err) => console.error('GLB failed to load', err));
```

Paths are relative to `index.html`, so it is `'assets/robot.glb'`, not `'../assets/robot.glb'`. Draco- or meshopt-compressed files need `DRACOLoader` / `MeshoptDecoder` from `three/addons/` too; an uncompressed GLB under ~10 MB is the easy path.

**Animate something:** add to the animation loop, using `t` and `dt`: `thing.rotation.y += dt * 0.5;` or `thing.position.y = 1.2 + Math.sin(t) * 0.1;`.

**Hand tracking:** `renderer.xr.getHand(i).joints['index-finger-tip']` (and `'thumb-tip'`, `'wrist'`, ...) are Object3Ds once hands are tracked; read them with `getWorldPosition`. A pinch fires `selectstart`/`selectend` on `renderer.xr.getController(i)`, so the existing grab code already works with hands. See `examples/hand-garden/`.

**AR placement on real surfaces:** the AR button already requests `hit-test` as optional. The full pattern (reticle, tap to place) is in `examples/ar-placer/`.

**Change the landing overlay text:** edit the `.pico-overlay` block in `index.html`. It is 2D only and does not show inside the headset.

## Testing

1. **Desktop first.** `npm run dev`, open http://localhost:5173, open DevTools, confirm **zero red console errors**, orbit around, click the orb. With no headset, `src/emulator.js` loads an emulated Quest 3 (IWER), so **Enter VR** works on desktop too; give it a few seconds on first load.
2. **Headset.** `npm run serve` and open the printed `https://...ts.net` URL in the PICO browser (the headset needs the Tailscale app, logged in to the same tailnet). No Tailscale? Plug in USB, `npm run usb`, open `http://localhost:5173` in the headset. `node scripts/open-on-headset.mjs <url>` opens it for you over USB; `node scripts/snap.mjs` saves a screenshot of what the headset shows to `captures/` so you can look at it (it is the stereo eye buffer: both eyes side by side). Full command list: `docs/PICO-CLI.md`.
3. After a change, the person must reload the page in the headset browser (exit VR, reload, Enter VR again).

## When a change goes wrong

- Black screen or no orb: a JS error. Check the desktop console; the usual cause is a typo or an import path that isn't `'three/addons/...'`.
- Enter VR button missing in the headset: not a secure context (LAN IP) or not the PICO browser.
- Session fails to start: something optional was made required, or an unsupported feature was requested.
- Stutter in the headset: too many draw calls or triangles. Merge, instance, or simplify.
