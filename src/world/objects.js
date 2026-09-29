// Dreamspace object layer: renders World.objects (docs/CONTRACT.md), keyed by id.
//
//   const objects = createObjectLayer({ scene, THREE });
//   objects.sync(world)          full diff: adds (scale-in + sparkles), glides moves, removes (sparkle dissolve)
//   objects.apply(op)            incremental; returns true when handled, false when you should re-sync:
//                                  if (!objects.apply(op)) objects.sync(await client.world());
//                                The contract's `add` op carries no id/asset, so a plain add returns false.
//                                An add that carries the resolved object ({...op, id, asset} or op.object) is rendered.
//                                move/remove/clear render directly; mood applies mood.glow to all glows; guide is a no-op.
//   objects.update(dt, t)        every frame
//   objects.pickables            live array of object roots (mutated in place). Push-through for grab code:
//                                  raycaster.intersectObjects(objects.pickables, true) then objects.idOf(hit.object)
//
// Extras: idOf(object3d) -> id | null, get(id) -> root | null, hold(idOrRoot, bool), setGlow(0..1), group, size,
// dispose().
//
// Assets: {type:'archetype'} via buildArchetype, {type:'parts'} via buildParts, {type:'glb'} via GLTFLoader
// (a wisp stands in while it loads and stays if it fails; failures are console.warn, never console.error).
// Archetypes get a placement hint at build time: params.airborne = (y > 0.5 m), so a lantern the server spawns in
// mid-air becomes a floating sky-lantern rather than a lamp post on a rock. Only a new asset rebuilds a model.
//
// Grab interplay with main.js: root.position is always the world truth (spawn scale, float lift and the islet live
// below the root). Any grab style works:
//   - controller.attach(root) / hand.attach(root): "held" while any ancestor is an XR input space (those have
//     matrixAutoUpdate === false: controllers, grips, hands, joints). The layer leaves the transform alone.
//   - release with scene.attach(root), room.attach(root) or removeFromParent(): the layer re-adopts the root into
//     its own group where it was dropped (so it stays visible in AR) and eases it upright.
//   - moving root.position / root.quaternion in place, without re-parenting: the layer adopts the new pose.
//   - hold(idOrRoot, true|false): explicit override for any other scheme.
// Then post the move yourself: client.op({type:'move', id, position, rotationY}). Otherwise the next sync
// glides the object back to the server's position.
// Never adds lights (that would recompile every lit material).

import { buildArchetype, buildParts, createSparkles, createIslet, setArchetypeGlow } from './archetypes.js';

const SPAWN_DUR = 1.1;
const REMOVE_DUR = 0.75;
const MIN_CLEAR = 0.1; // floating things keep their lowest point at least this far above the floor
const AIRBORNE_Y = 0.5; // placement hint for archetypes that come in a ground and an airborne form (lantern)
const DEFAULT_POS = [0, 1, -2];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const easeOutBack = (u, s = 1.4) => { const x = u - 1; return 1 + x * x * ((s + 1) * x + s); };
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const easeInCubic = (u) => u * u * u;
const angleTo = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const sigOf = (asset) => { try { return JSON.stringify(asset ?? null); } catch { return String(Math.random()); } };

export function createObjectLayer({ scene, THREE, parent = null } = {}) {
  const T = THREE;
  const group = new T.Group();
  group.name = 'dreamspace-objects';
  (parent || scene).add(group);

  const live = new Map(); // id -> entry
  const dying = []; // entries (or ghosts of swapped models) fading out
  const effects = []; // sparkle bursts
  const zombies = new Map(); // finalized roots that might get re-attached by grab code -> expiry time
  const pickables = [];
  const glb = createGlbCache(T);
  const warned = new Set();
  let synced = false;
  let clock = 0;
  const euler = new T.Euler(0, 0, 0, 'YXZ');

  // ------------------------------------------------------------------ models
  function makeModel(e, asset) {
    const a = asset && typeof asset === 'object' ? asset : {};
    try {
      if (a.type === 'archetype') {
        const params = a.params && typeof a.params === 'object' ? a.params : {};
        return buildArchetype(T, a.archetype, { ...params, airborne: e.target.pos.y > AIRBORNE_Y });
      }
      if (a.type === 'parts' && Array.isArray(a.parts) && a.parts.length) return buildParts(T, a.parts, a.params || {});
      if (a.type === 'glb' && typeof a.url === 'string' && a.url) {
        loadGlb(e, a);
        return buildArchetype(T, 'wisp', a.params || {});
      }
    } catch (err) {
      console.warn(`[objects] could not build "${e.id}", showing a wisp`, err);
    }
    return buildArchetype(T, 'wisp', {});
  }

  function loadGlb(e, asset) {
    const token = ++e.token;
    glb.get(asset.url).then(
      (handle) => {
        if (live.get(e.id) !== e || e.token !== token) { handle.release(); return; }
        let model;
        try { model = handle.instantiate(); } catch (err) { handle.release(); console.warn(`[objects] glb "${asset.url}" could not be placed, keeping the wisp`, err); return; }
        swapModel(e, model);
      },
      (err) => { if (e.token === token) console.warn(`[objects] glb "${asset.url}" failed, keeping the wisp:`, err?.message || err); },
    );
  }

  // ------------------------------------------------------------------ entries
  function create(obj, delay) {
    const root = new T.Group();
    root.rotation.order = 'YXZ';
    const holder = new T.Group();
    holder.name = 'holder';
    root.add(holder);
    const e = {
      id: obj.id, obj, root, holder, model: null, sig: sigOf(obj.asset), token: 0,
      state: 'spawning', age: -delay, sparkled: false, lift: 0, rise: -0.12, floating: null, held: false,
      pinned: false, wrote: false, lastPos: new T.Vector3(), lastQuat: new T.Quaternion(),
      yaw: 0, tiltX: 0, tiltZ: 0, target: { pos: new T.Vector3(), yaw: 0, scale: 1 },
    };
    describe(e, obj);
    setTargets(e, obj, true);
    e.model = makeModel(e, obj.asset);
    holder.add(e.model);
    holder.scale.setScalar(1e-4);
    holder.visible = delay <= 0;
    group.add(root);
    pickables.push(root);
    live.set(obj.id, e);
    return e;
  }

  function describe(e, obj) {
    e.root.name = `object:${obj.id}`;
    Object.assign(e.root.userData, {
      objectId: obj.id,
      name: String(obj.name ?? ''),
      description: String(obj.description ?? ''),
      createdBy: obj.createdBy,
    });
  }

  function setTargets(e, obj, snap) {
    const p = Array.isArray(obj.position) && obj.position.length >= 3 ? obj.position : null;
    const t = e.target;
    if (p) t.pos.set(num(p[0], DEFAULT_POS[0]), num(p[1], DEFAULT_POS[1]), num(p[2], DEFAULT_POS[2]));
    else if (snap) t.pos.set(...DEFAULT_POS);
    t.yaw = num(obj.rotationY, t.yaw);
    t.scale = clamp(num(obj.scale, 1), 0.05, 8);
    if (snap) {
      e.root.position.copy(t.pos);
      e.yaw = t.yaw;
      e.root.rotation.set(0, t.yaw, 0);
      e.root.scale.setScalar(t.scale);
    }
  }

  function upsert(obj, delay = 0) {
    const e = live.get(obj.id);
    if (!e) return create(obj, delay);
    const sig = sigOf(obj.asset);
    e.obj = obj;
    describe(e, obj);
    if (!e.held) setTargets(e, obj, false); // first, so a rebuilt model gets the new placement hint
    if (sig !== e.sig) { e.sig = sig; e.token++; swapModel(e, makeModel(e, obj.asset)); }
    return e;
  }

  // old model dissolves where it stands, the new one scales in inside the same root
  function swapModel(e, model) {
    if (e.model) {
      const g = new T.Group();
      g.position.copy(e.root.position); g.quaternion.copy(e.root.quaternion); g.scale.copy(e.root.scale);
      const h = new T.Group();
      h.position.copy(e.holder.position); h.scale.copy(e.holder.scale);
      g.add(h);
      h.add(e.model);
      group.add(g);
      const ghost = { id: e.id, root: g, holder: h, model: e.model, age: 0, from: h.scale.x, ghost: true };
      burst(ghost, 'dissolve');
      dying.push(ghost);
    }
    e.model = model;
    e.holder.add(model);
    e.holder.scale.setScalar(1e-4);
    e.holder.visible = true;
    e.state = 'spawning';
    e.age = 0;
    e.sparkled = false;
    e.floating = null;
  }

  function kill(e, delay = 0) {
    if (live.get(e.id) === e) live.delete(e.id);
    const i = pickables.indexOf(e.root);
    if (i >= 0) pickables.splice(i, 1);
    e.token++;
    e.state = 'removing';
    e.age = -delay;
    e.from = e.holder.scale.x;
    e.dissolved = false;
    dying.push(e);
  }

  function finalize(e) {
    const r = e.root;
    r.removeFromParent();
    r.visible = false;
    try { e.model?.userData?.dispose?.(); } catch (err) { warnOnce('dispose', err); }
    if (!e.ghost) zombies.set(r, clock + 30);
  }

  function burst(e, mode) {
    const ud = e.model?.userData || {};
    const ws = e.root.scale.x || 1;
    const R = clamp((ud.radius || 0.5) * ws, 0.2, 3);
    const float = ud.anchor !== 'ground';
    const fx = createSparkles(T, {
      color: ud.accent || '#bfefff', radius: R, mode, count: mode === 'spawn' ? 28 : 22,
      height: float ? R : clamp((ud.height || 1) * ws, 0.3, 6),
    });
    fx.object3d.position.copy(e.root.position);
    fx.object3d.position.y += float ? (e.lift || 0) * ws - R * 0.5 : 0;
    group.add(fx.object3d);
    effects.push(fx);
  }

  function warnOnce(key, err) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[objects] ${key}:`, err);
  }

  // ------------------------------------------------------------------ per frame
  // XR input spaces (controller target ray, grip, hand and its joints) are posed by the XR system, so three.js gives
  // them matrixAutoUpdate = false. A root under one of them is being held.
  function heldByInput(r) {
    for (let p = r.parent; p && p !== scene; p = p.parent) if (p.matrixAutoUpdate === false) return true;
    return false;
  }

  // take the root back where the user left it: into our group (visible in AR too), same world pose, then ease upright
  function adopt(e) {
    const r = e.root;
    if (r.parent !== group) group.attach(r);
    euler.setFromQuaternion(r.quaternion, 'YXZ');
    e.yaw = euler.y; e.tiltX = euler.x; e.tiltZ = euler.z;
    e.target.pos.copy(r.position);
    e.target.yaw = euler.y;
  }

  function stepLive(e, dt, t) {
    const r = e.root;
    // grab interplay: held -> hands off; released (re-parented, unpinned, or moved in place) -> adopt that pose
    const held = e.pinned || (r.parent !== group && r.parent !== null && heldByInput(r));
    if (!held) {
      const movedInPlace = e.wrote && (r.position.distanceToSquared(e.lastPos) > 1e-10 || r.quaternion.angleTo(e.lastQuat) > 1e-5);
      if (r.parent !== group || e.held || movedInPlace) adopt(e);
    }
    e.held = held;

    const k = 1 - Math.exp(-dt * 4);
    if (!e.held) {
      r.position.lerp(e.target.pos, k);
      e.yaw += angleTo(e.yaw, e.target.yaw) * k;
      e.tiltX *= 1 - k; e.tiltZ *= 1 - k;
      r.rotation.set(e.tiltX, e.yaw, e.tiltZ, 'YXZ');
      const s = r.scale.x + (e.target.scale - r.scale.x) * k;
      r.scale.setScalar(s);
      e.lastPos.copy(r.position); e.lastQuat.copy(r.quaternion); e.wrote = true;
    } else e.wrote = false;

    // spawn: scale in with a soft overshoot and a small rise, sparkles at the start
    e.age += dt;
    if (e.state === 'spawning') {
      if (e.age < 0) { e.holder.visible = false; }
      else {
        e.holder.visible = true;
        if (!e.sparkled) { e.sparkled = true; burst(e, 'spawn'); }
        const u = Math.min(1, e.age / SPAWN_DUR);
        e.holder.scale.setScalar(Math.max(1e-4, easeOutBack(u, 1.3)));
        e.rise = -0.12 * (1 - easeOutCubic(u));
        if (u >= 1) { e.state = 'idle'; e.rise = 0; }
      }
    }
    placeModel(e, dt);
    tickModel(e, dt, t);
  }

  function placeModel(e, dt) {
    const ud = e.model.userData || {};
    const ws = e.root.scale.y || 1;
    const y = e.root.position.y;
    if (ud.anchor === 'ground') {
      e.lift = 0;
      const floating = y > (e.floating ? 0.1 : 0.16);
      if (floating !== e.floating) { e.floating = floating; ud.setFloating?.(floating); }
    } else {
      const want = Math.max(0, (MIN_CLEAR - (y - (ud.bottom || 0) * ws)) / ws);
      e.lift += (want - e.lift) * (1 - Math.exp(-dt * 5));
      if (e.floating === null) { e.lift = want; e.floating = false; }
    }
    e.holder.position.y = e.lift + e.rise;
  }

  function tickModel(e, dt, t) {
    try { e.model.userData?.update?.(dt, t); } catch (err) { warnOnce(`update ${e.model.userData?.archetype}`, err); }
  }

  function stepDying(e, dt, t) {
    e.age += dt;
    if (e.age < 0) { tickModel(e, dt, t); return true; }
    if (!e.ghost && !e.dissolved) { e.dissolved = true; burst(e, 'dissolve'); }
    const u = Math.min(1, e.age / REMOVE_DUR);
    e.holder.scale.setScalar(Math.max(1e-4, (e.from ?? 1) * (1 - easeInCubic(u))));
    e.holder.position.y += dt * 0.18;
    tickModel(e, dt, t);
    return u < 1;
  }

  function update(dt, t) {
    dt = clamp(Number(dt) || 0, 0, 0.1);
    t = Number.isFinite(t) ? t : clock + dt;
    clock = t;
    for (const e of live.values()) stepLive(e, dt, t);
    for (let i = dying.length - 1; i >= 0; i--) {
      if (!stepDying(dying[i], dt, t)) { finalize(dying[i]); dying.splice(i, 1); }
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      if (!fx.update(dt)) { fx.object3d.removeFromParent(); fx.dispose(); effects.splice(i, 1); }
    }
    if (zombies.size) {
      for (const [r, until] of zombies) {
        if (r.parent) r.removeFromParent(); // grab code re-attached a removed object
        if (clock > until) zombies.delete(r);
      }
    }
  }

  // ------------------------------------------------------------------ public
  function sync(world) {
    if (!world || typeof world !== 'object') return;
    if (world.mood && world.mood.glow != null) setGlow(world.mood.glow);
    const list = Array.isArray(world.objects) ? world.objects : [];
    const first = !synced;
    synced = true;
    const seen = new Set();
    let n = 0;
    for (const o of list) {
      if (!o || typeof o !== 'object' || o.id == null) continue;
      const id = String(o.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const isNew = !live.has(id);
      upsert({ ...o, id }, first && isNew ? Math.min(n++ * 0.07, 1.6) : 0);
    }
    for (const [id, e] of [...live]) if (!seen.has(id)) kill(e);
  }

  function apply(op) {
    if (!op || typeof op !== 'object') return false;
    switch (op.type) {
      case 'add': {
        const o = [op.object, op.obj, op].find((x) => x && typeof x === 'object' && x.id != null && x.asset);
        if (!o) return false;
        upsert({ ...o, id: String(o.id) }, 0);
        return true;
      }
      case 'move': {
        const e = live.get(String(op.id));
        if (!e) return false;
        const o = { ...e.obj };
        if (Array.isArray(op.position)) o.position = op.position;
        if (op.rotationY != null) o.rotationY = op.rotationY;
        if (op.scale != null) o.scale = op.scale;
        e.obj = o;
        if (!e.held) setTargets(e, o, false);
        return true;
      }
      case 'remove': {
        const e = live.get(String(op.id));
        if (e) kill(e);
        return true;
      }
      case 'clear': {
        let i = 0;
        for (const e of [...live.values()]) kill(e, Math.min(i++ * 0.05, 1.2));
        return true;
      }
      case 'mood':
        if (op.glow != null) setGlow(op.glow);
        return true;
      case 'guide':
        return true;
      default:
        return false;
    }
  }

  function setGlow(g) {
    const x = Number(g);
    if (Number.isFinite(x)) setArchetypeGlow(T, clamp(x, 0, 1));
  }

  function idOf(obj) {
    for (let o = obj; o; o = o.parent) if (o.userData && o.userData.objectId != null) return o.userData.objectId;
    return null;
  }

  function get(id) { return live.get(String(id))?.root ?? null; }

  // explicit grab override: hold(id, true) freezes the layer's hands-off state; hold(id, false) adopts the pose
  function hold(ref, on = true) {
    const id = ref && ref.isObject3D ? idOf(ref) : ref;
    const e = id == null ? null : live.get(String(id));
    if (!e) return false;
    e.pinned = !!on;
    return true;
  }

  function dispose() {
    for (const e of [...live.values(), ...dying]) { e.root.removeFromParent(); try { e.model?.userData?.dispose?.(); } catch {} }
    for (const fx of effects) { fx.object3d.removeFromParent(); fx.dispose(); }
    live.clear(); dying.length = 0; effects.length = 0; pickables.length = 0; zombies.clear();
    group.removeFromParent();
  }

  return {
    sync, apply, update, pickables, idOf, get, hold, setGlow, dispose, group,
    get size() { return live.size; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// GLB loading: one cached load per URL, refcounted clones, normalised to ~1.2 m standing on y=0
// ---------------------------------------------------------------------------------------------------------------
function createGlbCache(T) {
  const map = new Map();
  let libs = null;
  const loadLibs = () => (libs ??= Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/utils/SkeletonUtils.js'),
  ]).then(([L, S]) => ({ loader: new L.GLTFLoader(), clone: S.clone })).catch((err) => { libs = null; throw err; }));

  function disposeScene(root) {
    root.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose?.();
      }
    });
  }

  function get(url) {
    let ent = map.get(url);
    if (!ent) {
      ent = { refs: 0, gltf: null, clone: null };
      ent.promise = loadLibs().then(({ loader, clone }) => new Promise((res, rej) => {
        loader.load(url, (g) => { ent.gltf = g; ent.clone = clone; res(ent); }, undefined, rej);
      }));
      ent.promise.catch(() => { if (map.get(url) === ent) map.delete(url); });
      map.set(url, ent);
    }
    ent.refs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--ent.refs <= 0 && map.get(url) === ent) {
        map.delete(url);
        if (ent.gltf) disposeScene(ent.gltf.scene);
      }
    };
    return ent.promise.then(
      () => ({ release, instantiate: () => normalizeGlb(T, ent.clone(ent.gltf.scene), ent.gltf.animations || [], release) }),
      (err) => { release(); throw err; },
    );
  }
  return { get };
}

function normalizeGlb(T, scene, animations, release) {
  const wrap = new T.Group();
  wrap.name = 'glb';
  const box = new T.Box3().setFromObject(scene);
  const size = box.getSize(new T.Vector3()), centre = box.getCenter(new T.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const s = Number.isFinite(maxDim) && maxDim > 1e-6 ? 1.2 / maxDim : 1;
  scene.scale.multiplyScalar(s);
  scene.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
  wrap.add(scene);
  let mixer = null;
  if (animations.length) {
    mixer = new T.AnimationMixer(scene);
    mixer.clipAction(animations[0]).play();
  }
  const foot = Math.max(size.x, size.z) * s / 2 || 0.4;
  const islet = createIslet(T, foot);
  islet.visible = false;
  wrap.add(islet);
  Object.assign(wrap.userData, {
    archetype: 'glb', anchor: 'ground', bottom: 0, height: size.y * s || 1, footprint: foot, radius: 0.7, accent: '#bfefff',
    update(dt) { mixer?.update(dt); },
    setFloating(on) { islet.visible = !!on; },
    dispose() { mixer?.stopAllAction(); islet.userData.dispose(); release(); },
  });
  return wrap;
}
