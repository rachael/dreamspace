// src/world/creations.js: hot-loads vibe-mode creations (creations/<slug>.js, written by Claude, validated by
// server/vibe.mjs) into the scene, and keeps a bad one from ever taking the world down.
//
//   const creations = createCreations({ THREE, scene, room });
//   net.onCreation = (evt) => creations.load(evt);        // SSE `creation` {slug, url, action:'upsert'|'remove'}
//   creations.sync(await net.creations());                 // on startup: GET /api/creations (array, {creations}, or {ok, data})
//   creations.setWorld(world);                              // optional: on snapshot/op, so create() sees the world
//   // in the animation loop:
//   creations.update(dt, t);
//
// createCreations({ THREE, scene, room, world?, onError?, baseUrl?, importModule? })
//   → { load(evt) → Promise<bool>, update(dt, t), list(), sync(list) → Promise, setWorld(world), remove(slug), dispose() }
//   onError({slug, message}) is called whenever a creation fails (it also gets a small in-world error chip).
//   importModule(url) defaults to a dynamic import(); baseUrl defaults to document.baseURI (both are for tests).
//
// Each creation module: export default function create({ THREE, scene, room, world, addUpdate }) → Object3D.
// Safety: every import/create()/update runs in try/catch. A failed new version leaves the previous version running.
// An update that throws, or that stays too slow for the headset, is paused (the object stays, frozen) with an error chip.
// The previous version of a slug is fully disposed (geometries, materials, textures, instance buffers, anything
// create() added to scene/room directly). Stale async loads are dropped, so rapid edits never race.

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SPAWN_S = 0.9;      // first appearance: grow in from nothing
const SWAP_S = 0.45;      // a new version of an existing creation: a small breath from 92 %
const REMOVE_S = 0.5;     // removal: shrink away
const CHIP_S = 15;        // error chips fade after this many seconds
const SLOW_MS = 6;        // an update slower than this (per frame)...
const SLOW_FRAMES = 45;   // ...for this many frames in a row gets paused

const errText = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0].slice(0, 160);
const easeOut = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

export function createCreations({ THREE, scene, room = null, world = null, onError, baseUrl, importModule } = {}) {
  if (!THREE || !scene) throw new Error('createCreations({ THREE, scene, room }): THREE and scene are required');
  const entries = new Map();   // slug → entry
  const anims = [];            // running scale animations
  const bursts = [];           // spawn shimmer rings
  let worldSnap = world;
  let clock = 0;
  let disposed = false;
  const doImport = importModule || ((u) => import(/* @vite-ignore */ u));
  const base = () => baseUrl || (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' && location.href) || 'http://localhost/';

  const chips = new THREE.Group();
  chips.name = 'creation-chips';
  scene.add(chips);

  // ---------- helpers ----------
  function entryFor(slug) {
    let e = entries.get(slug);
    if (!e) {
      e = { slug, url: null, status: 'loading', error: null, seq: 0, holder: null, root: null, extras: [], updates: [], pivot: new THREE.Vector3(),
        top: 1.6, paused: false, slow: 0, chip: null, chipT: 0 };
      entries.set(slug, e);
    }
    return e;
  }

  function resolveUrl(slug, url) {
    const u = new URL(url || `/creations/${slug}.js?v=${Date.now()}`, base());
    if (!u.pathname.endsWith(`/creations/${slug}.js`)) throw new Error(`refusing to load ${u.pathname}: not /creations/${slug}.js`);
    if (u.origin !== new URL(base()).origin) throw new Error(`refusing to load from another origin (${u.origin})`);
    return u.href;
  }

  function snapshotWorld() {
    const w = worldSnap;
    if (!w || typeof w !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify({
        mood: w.mood ?? null,
        objects: (w.objects || []).slice(0, 40).map((o) => ({ id: o.id, name: o.name, description: o.description, position: o.position, scale: o.scale, rotationY: o.rotationY })),
      }));
    } catch { return null; }
  }

  function disposeTree(obj) {
    if (!obj) return;
    obj.traverse?.((o) => {
      try {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
          m.dispose?.();
        }
        if (o.isInstancedMesh || o.isBatchedMesh) o.dispose?.();
      } catch { /* keep going: disposal must never throw into the frame loop */ }
    });
    obj.removeFromParent?.();
  }

  function retire(e, dur) {
    const { holder, extras } = e;
    for (const x of extras) disposeTree(x);
    e.extras = [];
    if (!holder) return;
    if (dur > 0) anims.push({ holder, pivot: e.pivot.clone(), t0: clock, dur, from: holder.scale.x || 1, to: 0.001, done: () => disposeTree(holder) });
    else disposeTree(holder);
  }

  function report(e, message) {
    e.error = message;
    try { console.warn(`[creations] ${e.slug}: ${message}`); } catch {}
    try { onError?.({ slug: e.slug, message }); } catch {}
    showChip(e, message);
  }

  // ---------- in-world error chip (a small canvas sprite above the creation) ----------
  function showChip(e, message) {
    hideChip(e);
    if (typeof document === 'undefined') return;
    try {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 112;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(10, 15, 36, 0.86)';
      g.strokeStyle = 'rgba(255, 184, 107, 0.9)';
      g.lineWidth = 4;
      g.beginPath(); g.roundRect ? g.roundRect(4, 4, 504, 104, 26) : g.rect(4, 4, 504, 104); g.fill(); g.stroke();
      g.fillStyle = '#ffb86b'; g.beginPath(); g.arc(52, 56, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0a0f24'; g.font = 'bold 28px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', 52, 57);
      g.textAlign = 'left'; g.fillStyle = '#ffe2c4'; g.font = '600 26px system-ui, sans-serif'; g.fillText(e.slug.replace(/-/g, ' '), 88, 38);
      g.fillStyle = '#cfd8ff'; g.font = '20px system-ui, sans-serif';
      let line = message;
      while (line.length > 8 && g.measureText(line).width > 400) line = line.slice(0, -2);
      g.fillText(line === message ? line : line + '…', 88, 76);
      const tex = new THREE.CanvasTexture(c);
      if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      const chip = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      chip.scale.set(0.8, 0.175, 1);
      chip.renderOrder = 10;
      if (e.holder) chip.position.set(e.pivot.x, e.top + 0.25, e.pivot.z);
      else chip.position.set(0, 1.9, -2.2);
      chips.add(chip);
      e.chip = chip; e.chipT = clock;
    } catch { /* a chip is a nicety */ }
  }

  function hideChip(e) {
    if (e.chip) { disposeTree(e.chip); e.chip = null; }
  }

  // ---------- spawn shimmer: one expanding, fading ring at the creation's base ----------
  let ringGeo = null;
  function burst(e, radius) {
    try {
      ringGeo ||= new THREE.RingGeometry(0.94, 1, 64);
      const mat = new THREE.MeshBasicMaterial({ color: '#6ee7ff', transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(e.pivot.x, Math.max(0.02, e.bottom + 0.02), e.pivot.z);
      (e.holder?.parent || scene).add(ring);
      bursts.push({ ring, t0: clock, dur: 1.2, r: Math.max(0.4, Math.min(radius, 6)) });
    } catch {}
  }

  // ---------- load one version ----------
  async function upsert(slug, url) {
    const e = entryFor(slug);
    const seq = ++e.seq;
    let href;
    try { href = resolveUrl(slug, url); } catch (err) { report(e, errText(err)); if (!e.root) e.status = 'error'; return false; }
    let mod;
    try { mod = await doImport(href); } catch (err) {
      if (seq !== e.seq || disposed) return false;
      if (!e.root) e.status = 'error';
      report(e, `could not load: ${errText(err)}`);
      return false;
    }
    if (seq !== e.seq || disposed) return false;           // superseded by a newer version or a removal
    const create = mod && mod.default;
    if (typeof create !== 'function') { if (!e.root) e.status = 'error'; report(e, 'the module has no default export create()'); return false; }

    const updates = [];
    const sceneBefore = new Set(scene.children);
    const roomBefore = new Set(room ? room.children : []);
    const added = () => [
      ...scene.children.filter((o) => !sceneBefore.has(o)),
      ...(room ? room.children.filter((o) => !roomBefore.has(o)) : []),
    ];
    let root;
    try {
      root = create({ THREE, scene, room, world: snapshotWorld(), addUpdate: (fn) => { if (typeof fn === 'function') updates.push(fn); } });
    } catch (err) {
      for (const o of added()) disposeTree(o);
      if (!e.root) e.status = 'error';
      report(e, `create() threw: ${errText(err)}`);
      return false;
    }
    if (root && typeof root.then === 'function') {
      for (const o of added()) disposeTree(o);
      if (!e.root) e.status = 'error';
      report(e, 'create() must return an Object3D, not a Promise');
      return false;
    }
    let extras = added().filter((o) => o !== root);
    if (!root || !root.isObject3D) {
      if (!extras.length) { if (!e.root) e.status = 'error'; report(e, 'create() returned nothing to show'); return false; }
      root = new THREE.Group();                             // lenient: adopt whatever it added itself
      for (const o of extras) root.add(o);
      extras = [];
    }

    // swap: retire the previous version, then place the new one inside a holder we can scale about its centre
    const firstTime = !e.root;
    retire(e, 0);
    hideChip(e);
    const holder = new THREE.Group();
    holder.name = `creation:${slug}`;
    holder.userData.creation = slug;
    holder.add(root);
    (root.userData?.hideInAR && room ? room : scene).add(holder);
    try {
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      if (!box.isEmpty() && [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)) {
        box.getCenter(e.pivot); e.top = box.max.y; e.bottom = box.min.y;
        e.radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
      } else { root.getWorldPosition(e.pivot); e.top = e.pivot.y + 0.5; e.bottom = 0; e.radius = 1; }
    } catch { e.pivot.set(0, 1, -3); e.top = 1.5; e.bottom = 0; e.radius = 1; }

    Object.assign(e, { url, holder, root, extras, updates, status: 'ok', error: null, paused: false, slow: 0 });
    const from = firstTime ? 0.001 : 0.92;
    holder.scale.setScalar(from);
    holder.position.copy(e.pivot).multiplyScalar(1 - from);
    anims.push({ holder, pivot: e.pivot.clone(), t0: clock, dur: firstTime ? SPAWN_S : SWAP_S, from, to: 1 });
    if (firstTime) burst(e, e.radius);
    return true;
  }

  function remove(slug) {
    const e = entries.get(slug);
    if (!e) return false;
    e.seq++;                                                // cancels any load still in flight
    hideChip(e);
    retire(e, REMOVE_S);
    entries.delete(slug);
    return true;
  }

  // ---------- public API ----------
  function load(evt) {
    if (disposed || !evt || typeof evt.slug !== 'string' || !SLUG_RE.test(evt.slug)) return Promise.resolve(false);
    if (evt.action === 'remove') return Promise.resolve(remove(evt.slug));
    return upsert(evt.slug, evt.url);
  }

  function sync(listOrResponse) {
    const arr = Array.isArray(listOrResponse) ? listOrResponse
      : Array.isArray(listOrResponse?.creations) ? listOrResponse.creations
        : Array.isArray(listOrResponse?.data) ? listOrResponse.data : [];   // net client wraps arrays as {ok, data}
    const keep = new Set();
    const jobs = [];
    for (const c of arr) {
      if (!c || typeof c.slug !== 'string' || !SLUG_RE.test(c.slug)) continue;
      keep.add(c.slug);
      const e = entries.get(c.slug);
      if (!e || e.url !== c.url) jobs.push(upsert(c.slug, c.url));
    }
    for (const slug of [...entries.keys()]) if (!keep.has(slug)) remove(slug);
    return Promise.all(jobs);
  }

  function update(dt, t) {
    if (disposed) return;
    clock += dt;
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i];
      const p = (clock - a.t0) / a.dur;
      const s = a.from + (a.to - a.from) * easeOut(p);
      a.holder.scale.setScalar(s);
      a.holder.position.copy(a.pivot).multiplyScalar(1 - s);   // scale about the creation's centre, not the origin
      if (p >= 1) { anims.splice(i, 1); a.done?.(); }
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const p = (clock - b.t0) / b.dur;
      if (p >= 1) { b.ring.material.dispose(); b.ring.removeFromParent(); bursts.splice(i, 1); continue; }
      b.ring.scale.setScalar(b.r * (0.25 + 1.0 * easeOut(p)));
      b.ring.material.opacity = 0.7 * (1 - p);
    }
    for (const e of entries.values()) {
      if (e.chip && clock - e.chipT > CHIP_S) {
        const f = 1 - (clock - e.chipT - CHIP_S) / 1.5;
        if (f <= 0) hideChip(e); else e.chip.material.opacity = f;
      }
      if (e.status !== 'ok' || e.paused || !e.updates.length) continue;
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      for (const fn of e.updates) {
        try { fn(dt, t); } catch (err) {
          e.paused = true;
          report(e, `paused: ${errText(err)}`);
          break;
        }
      }
      if (typeof performance !== 'undefined') {
        const ms = performance.now() - t0;
        e.slow = ms > SLOW_MS ? e.slow + 1 : Math.max(0, e.slow - 2);
        if (e.slow > SLOW_FRAMES) { e.paused = true; report(e, 'paused: too heavy for the headset'); }
      }
    }
  }

  function list() {
    return [...entries.values()].map((e) => ({ slug: e.slug, url: e.url, status: e.paused ? 'paused' : e.status, error: e.error }));
  }

  function setWorld(w) { worldSnap = w || null; }

  function dispose() {
    for (const slug of [...entries.keys()]) { const e = entries.get(slug); e.seq++; hideChip(e); retire(e, 0); entries.delete(slug); }
    for (const a of anims.splice(0)) a.done?.();
    for (const b of bursts.splice(0)) { b.ring.material.dispose(); b.ring.removeFromParent(); }
    ringGeo?.dispose();
    chips.removeFromParent();
    disposed = true;
  }

  return { load, update, list, sync, setWorld, remove, dispose };
}
