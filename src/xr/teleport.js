// src/xr/teleport.js — user-initiated teleport for Dreamspace: the ONLY way the viewpoint ever changes, and only on the
// user's own action. Owner: client-io. Contract: docs/CONTRACT.md ("Client modules" → src/xr/teleport.js).
//
//   import { createTeleport } from './xr/teleport.js';
//   const teleport = createTeleport({ THREE, renderer, scene, camera,
//     targets: () => islandTops,     // walkable meshes (island tops, platforms); or mark any mesh userData.teleport = true
//     blockers: grabbables,          // a hand pinch that starts on one of these is a grab, not a teleport
//   });
//   // in the animation loop (before renderer.render):  teleport.update(dt, t);
//
// Controls:
// - Controllers: push a thumbstick forward → a glowing arc + landing ring; let go → you're there. Pull back to cancel.
// - Hands: pinch and hold (~0.45 s) without pointing at something grabbable → arc; release the pinch → you're there.
// - Optional snap turn (thumbstick left/right) with `snapTurnDegrees: 30`; off by default.
// How: the XR reference space is offset (renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(t))). The camera is
// never touched. Your head lands on the target point (not the tracking origin), with a 0.25 s soft blink. Off in AR.
// Budget: ≤ 4 draw calls while aiming or blinking, 0 when idle. Nothing is allocated per frame.
// Don't pass `room` or anything containing the sky dome as a target: the dome would catch every arc.

// ---------------------------------------------------------------------------------------------------------------
// Rig math (pure; exported for tests). world = RotY(yaw) · base + pos, where base is the headset's own space.

/** The originOffset for getOffsetReferenceSpace() that realises the rig (it is the inverse of the rig transform). */
export function rigToOffset(rig) {
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  // RotY(-yaw) · pos
  const x = c * rig.pos.x - s * rig.pos.z;
  const z = s * rig.pos.x + c * rig.pos.z;
  return {
    position: { x: -x, y: -rig.pos.y, z: -z, w: 1 },
    orientation: { x: 0, y: Math.sin(-rig.yaw / 2), z: 0, w: Math.cos(-rig.yaw / 2) },
  };
}

/** Move the rig so the head (world xz) lands on target xz and the floor under it is at target.y. */
export function teleportRig(rig, head, target) {
  rig.pos.x += target.x - head.x;
  rig.pos.z += target.z - head.z;
  rig.pos.y = target.y;
  return rig;
}

/** Rotate the rig by `angle` (radians, + = turn left) about the vertical line through the head. */
export function turnRig(rig, head, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = rig.pos.x - head.x;
  const dz = rig.pos.z - head.z;
  rig.pos.x = head.x + c * dx + s * dz;
  rig.pos.z = head.z - s * dx + c * dz;
  rig.yaw += angle;
  return rig;
}

/**
 * An XRRigidTransform that works for real browsers AND the IWER emulator: IWER ≤ 2.5's getOffsetReferenceSpace() reads its
 * argument as a raw column-major mat4 (it calls mat4.clone on it), so a spec transform alone gives NaN poses there.
 * Mirroring .matrix into indexed properties 0..15 satisfies both; spec implementations ignore the extra properties.
 */
export function makeOffsetTransform(offset, XRRT = globalThis.XRRigidTransform) {
  const xf = new XRRT(offset.position, offset.orientation);
  try {
    const m = xf.matrix;
    if (m && m.length === 16) for (let i = 0; i < 16; i++) if (!(i in xf)) Object.defineProperty(xf, i, { value: m[i] });
  } catch { /* frozen/odd implementation: the spec path still works */ }
  return xf;
}

// ---------------------------------------------------------------------------------------------------------------

function radialTexture(THREE, size, alphaAt) {
  const data = new Uint8Array(size * size * 4);
  const h = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - h, y + 0.5 - h) / h;
      const a = Math.max(0, Math.min(1, alphaAt(r)));
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function finite3(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }

function asList(v) {
  try { const r = typeof v === 'function' ? v() : v; return Array.isArray(r) ? r : r ? [r] : []; } catch { return []; }
}

export function createTeleport(opts = {}) {
  const {
    THREE, renderer, scene,
    floorY = 0, floorRadius = 12, floorCenter = [0, 0],
    maxSlope = 0.65, holdTime = 0.45, snapTurnDegrees = 0,
    arcSpeed = 8, gravity = 9.8, arcSegments = 36, arcStep = 0.04,
    blink = true, allowInAR = false,
    colors = {},
  } = opts;
  if (!THREE || !renderer || !scene) throw new Error('createTeleport({THREE, renderer, scene, ...}) is required');
  const xr = renderer.xr;
  const extraTargets = new Set();
  let enabled = opts.enabled !== false;
  let broken = false;

  const COL_VALID = new THREE.Color(colors.valid ?? 0x9ff3ff);
  const COL_INVALID = new THREE.Color(colors.invalid ?? 0x7d6aa6);
  const COL_MARK = new THREE.Color(colors.marker ?? 0xb4fff0);

  // ---- visuals (created once; hidden when idle) ----
  const group = new THREE.Group();
  group.name = 'teleport-ui';
  scene.add(group);

  const N = arcSegments + 1;
  const arcPos = new Float32Array(N * 3);
  const arcGeo = new THREE.BufferGeometry();
  const arcAttr = new THREE.BufferAttribute(arcPos, 3);
  arcAttr.setUsage(THREE.DynamicDrawUsage);
  arcGeo.setAttribute('position', arcAttr);
  const dotTex = radialTexture(THREE, 32, (r) => (r < 1 ? (1 - r) ** 1.6 : 0));
  const arcMat = new THREE.PointsMaterial({
    size: 0.045, map: dotTex, color: COL_VALID.clone(), transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
  });
  const arc = new THREE.Points(arcGeo, arcMat);
  arc.frustumCulled = false;
  arc.visible = false;
  arc.renderOrder = 10;
  group.add(arc);

  const ringTex = radialTexture(THREE, 128, (r) => Math.max(Math.exp(-(((r - 0.8) / 0.07) ** 2)), 0.28 * Math.max(0, 1 - r / 0.8) ** 1.5));
  const ringGeo = new THREE.PlaneGeometry(0.8, 0.8);
  const markMat = new THREE.MeshBasicMaterial({
    map: ringTex, color: COL_MARK.clone(), transparent: true, opacity: 0.9, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  const marker = new THREE.Mesh(ringGeo, markMat);
  marker.visible = false;
  marker.renderOrder = 11;
  group.add(marker);

  const rippleMat = markMat.clone();
  const ripple = new THREE.Mesh(ringGeo, rippleMat);
  ripple.visible = false;
  group.add(ripple);

  const blinkMat = new THREE.MeshBasicMaterial({
    color: 0x03060d, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false,
  });
  const blinkMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), blinkMat);
  blinkMesh.frustumCulled = false;
  blinkMesh.renderOrder = 9999;
  blinkMesh.visible = false;
  group.add(blinkMesh);

  // ---- scratch (no per-frame allocation) ----
  const V = () => new THREE.Vector3();
  const head = V();
  const origin = V(), dir = V(), vel = V(), prev = V(), cur = V(), seg = V(), pt = V();
  const hitPoint = V(), hitNormal = V(), aimPoint = V(), aimNormal = V(), goPoint = V(), goNormal = V();
  const quat = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const raycaster = new THREE.Raycaster();
  if (opts.camera) raycaster.camera = opts.camera; // three needs it to raycast sprites
  const hits = [];
  const targetList = [];
  let targetsAt = -1;

  // ---- session state ----
  const rig = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  let session = null;
  let base = null;
  let isAR = false;
  let haveHead = false;
  let aim = null;              // {source, mode:'stick'|'pinch', valid}
  let pinch = null;            // {source, t0, blocked}
  let clock = 0;
  let verifyFrames = 0;
  const sticks = { left: { latched: false, cancel: false }, right: { latched: false, cancel: false }, none: { latched: false, cancel: false } };
  const fx = { blink: 0, blinkPhase: null, blinkT: 0, blinkOut: 0.08, blinkIn: 0.18, pending: null, ripple: -1, pulse: 0 };

  // ---- session lifecycle ----
  function beginSession() {
    endSession();
    session = xr.getSession?.() || null;
    if (!session) return;
    base = xr.getReferenceSpace?.() || null; // at 'sessionstart' three still has its own (un-offset) space
    rig.pos.x = rig.pos.y = rig.pos.z = 0; rig.yaw = 0;
    const mode = session.environmentBlendMode;
    isAR = !!mode && mode !== 'opaque';
    broken = false;
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('selectend', onSelectEnd);
    session.addEventListener('inputsourceschange', onSourcesChange);
  }
  function endSession() {
    if (session) {
      try {
        session.removeEventListener('selectstart', onSelectStart);
        session.removeEventListener('selectend', onSelectEnd);
        session.removeEventListener('inputsourceschange', onSourcesChange);
      } catch { /* session gone */ }
    }
    session = null; base = null; aim = null; pinch = null; haveHead = false; verifyFrames = 0;
    fx.blinkPhase = null; fx.pending = null; fx.ripple = -1;
    arc.visible = marker.visible = ripple.visible = blinkMesh.visible = false;
  }
  xr.addEventListener?.('sessionstart', beginSession);
  xr.addEventListener?.('sessionend', endSession);

  function active() { return enabled && !broken && !!base && (!isAR || allowInAR); }

  // ---- targets ----
  function collectTargets() {
    // Refresh at most twice a second (a scene traversal is cheap but not free).
    if (targetsAt >= 0 && clock - targetsAt < 0.5) return targetList;
    targetsAt = clock;
    targetList.length = 0;
    for (const o of asList(opts.targets)) if (o && o.isObject3D) targetList.push(o);
    for (const o of extraTargets) targetList.push(o);
    scene.traverseVisible((o) => {
      if (o.userData && (o.userData.teleport === true || o.userData.walkable === true) && !targetList.includes(o)) targetList.push(o);
    });
    return targetList;
  }
  function visibleChain(o) {
    for (let p = o; p; p = p.parent) if (!p.visible || p.userData?.teleport === false) return false;
    return true;
  }
  function onFloor(p) { return Math.hypot(p.x - floorCenter[0], p.z - floorCenter[1]) <= floorRadius; }

  // Casts the arc; fills arcPos; returns the number of points. Sets hitPoint/hitNormal and returns validity via aim.valid.
  function castArc() {
    vel.copy(dir).multiplyScalar(arcSpeed);
    prev.copy(origin);
    arcPos[0] = prev.x; arcPos[1] = prev.y; arcPos[2] = prev.z;
    const list = collectTargets();
    let count = 1;
    let valid = false;
    for (let i = 1; i <= arcSegments; i++) {
      const t = i * arcStep;
      cur.set(origin.x + vel.x * t, origin.y + vel.y * t - 0.5 * gravity * t * t, origin.z + vel.z * t);
      seg.subVectors(cur, prev);
      const len = seg.length();
      if (len > 1e-6) seg.divideScalar(len);
      let best = Infinity;
      let kind = 0; // 0 none, 1 floor, 2 mesh
      if (prev.y >= floorY && cur.y < floorY) {
        const f = (prev.y - floorY) / (prev.y - cur.y);
        pt.lerpVectors(prev, cur, f);
        if (onFloor(pt)) { best = f * len; kind = 1; hitPoint.copy(pt); hitPoint.y = floorY; hitNormal.set(0, 1, 0); }
      }
      if (list.length && len > 1e-6) {
        raycaster.set(prev, seg);
        raycaster.near = 0;
        raycaster.far = len;
        hits.length = 0;
        try { raycaster.intersectObjects(list, true, hits); } catch { hits.length = 0; }
        for (let k = 0; k < hits.length; k++) {
          const h = hits[k];
          if (!h.face || !visibleChain(h.object)) continue; // points/lines/sprites and hidden things don't count
          if (h.distance < best) {
            best = h.distance; kind = 2;
            hitPoint.copy(h.point);
            hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
          }
          break;
        }
      }
      if (kind) {
        arcPos[i * 3] = hitPoint.x; arcPos[i * 3 + 1] = hitPoint.y; arcPos[i * 3 + 2] = hitPoint.z;
        count = i + 1;
        valid = kind === 1 || hitNormal.y >= maxSlope; // walls and undersides stop the arc but aren't walkable
        break;
      }
      arcPos[i * 3] = cur.x; arcPos[i * 3 + 1] = cur.y; arcPos[i * 3 + 2] = cur.z;
      count = i + 1;
      prev.copy(cur);
      if (cur.y < floorY - 20) break; // fell past everything
    }
    return { count, valid };
  }

  // ---- input ----
  function rayFrom(source, frame, space) {
    const pose = frame?.getPose?.(source.targetRaySpace, space);
    if (!pose) return false;
    const p = pose.transform.position;
    const q = pose.transform.orientation;
    origin.set(p.x, p.y, p.z);
    quat.set(q.x, q.y, q.z, q.w);
    dir.set(0, 0, -1).applyQuaternion(quat);
    return finite3(origin);
  }

  function isBlocked(source, frame) {
    try { if (typeof opts.isBlocked === 'function' && opts.isBlocked(source)) return true; } catch { /* */ }
    const list = asList(opts.blockers);
    if (!list.length) return false;
    if (!rayFrom(source, frame, xr.getReferenceSpace())) return false;
    raycaster.set(origin, dir);
    raycaster.near = 0;
    raycaster.far = 8;
    hits.length = 0;
    try { raycaster.intersectObjects(list, true, hits); } catch { return false; }
    return hits.some((h) => visibleChain(h.object));
  }

  function onSelectStart(e) {
    const src = e.inputSource;
    if (!src || !src.hand || aim || !active()) return; // controllers use the thumbstick; the trigger stays "grab"
    pinch = { source: src, t0: clock, blocked: isBlocked(src, e.frame) };
  }
  function onSelectEnd(e) {
    const src = e.inputSource;
    if (aim && aim.source === src && aim.mode === 'pinch') commitAim();
    if (pinch && pinch.source === src) pinch = null;
  }
  function onSourcesChange(e) {
    for (const s of e.removed || []) {
      if (aim && aim.source === s) cancelAim();
      if (pinch && pinch.source === s) pinch = null;
    }
  }

  function axis(ax, i) { const v = +ax[i]; return Number.isFinite(v) ? v : 0; } // IWER reports null for missing axes

  function pollSticks() {
    const snapRad = (snapTurnDegrees * Math.PI) / 180;
    for (const src of session.inputSources || []) {
      if (src.hand || !src.gamepad) continue;
      const ax = src.gamepad.axes || [];
      const x = ax.length >= 4 ? axis(ax, 2) : axis(ax, 0);
      const y = ax.length >= 4 ? axis(ax, 3) : axis(ax, 1);
      const st = sticks[src.handedness] || sticks.none;
      const mag = Math.hypot(x, y);
      if (aim && aim.source === src) {
        if (y > 0.6) { cancelAim(); st.cancel = true; continue; }   // pulled back: never mind
        if (mag < 0.3) commitAim();                                 // let go: teleport
        continue;
      }
      if (st.cancel) { if (mag < 0.3) st.cancel = false; continue; } // wait for the stick to centre after a cancel
      if (!aim && !fx.blinkPhase && y < -0.7 && Math.abs(x) < 0.7) { startAim(src, 'stick'); continue; }
      if (snapRad > 0) {
        if (!st.latched && Math.abs(x) > 0.75 && Math.abs(y) < 0.6) { st.latched = true; snapTurn(x > 0 ? -snapRad : snapRad, src); }
        else if (Math.abs(x) < 0.3) st.latched = false;
      }
    }
  }

  // ---- aiming ----
  function startAim(source, mode) {
    aim = { source, mode, valid: false };
    targetsAt = -1;
  }
  function cancelAim() {
    aim = null;
    arc.visible = false;
    marker.visible = false;
  }
  function updateAim(frame, space) {
    if (!rayFrom(aim.source, frame, space)) { arc.visible = false; marker.visible = false; aim.valid = false; return; }
    const { count, valid } = castArc();
    aim.valid = valid;
    arcGeo.setDrawRange(0, count);
    arcAttr.needsUpdate = true;
    arcMat.color.copy(valid ? COL_VALID : COL_INVALID);
    arcMat.opacity = valid ? 0.95 : 0.5;
    arc.visible = true;
    if (valid) {
      aimPoint.copy(hitPoint);
      aimNormal.copy(hitNormal);
      marker.position.copy(hitPoint).addScaledVector(hitNormal, 0.012);
      marker.quaternion.setFromUnitVectors(Z, hitNormal);
      marker.visible = true;
    } else marker.visible = false;
  }
  function commitAim() {
    const a = aim;
    cancelAim();
    if (!a || !a.valid) return;
    if (fx.blinkPhase) return;
    pulse(a.source, 0.25, 30);
    goPoint.copy(aimPoint); goNormal.copy(aimNormal); // the destination is fixed now, whatever gets aimed at next
    go(() => {
      teleportRig(rig, head, goPoint);
      if (applyRig()) {
        ripple.position.copy(goPoint).addScaledVector(goNormal, 0.01);
        ripple.quaternion.setFromUnitVectors(Z, goNormal);
        fx.ripple = 0;
        notify(goPoint.x, goPoint.z);
      }
    }, 0.08);
  }
  function snapTurn(angle, src) {
    if (!haveHead) return;
    pulse(src, 0.12, 20);
    go(() => { turnRig(rig, head, angle); if (applyRig()) notify(head.x, head.z); }, 0.05);
  }
  function go(action, outTime) {
    if (fx.blinkPhase) return; // one move at a time
    if (!blink) { action(); return; }
    fx.pending = action; fx.blinkOut = outTime; fx.blinkPhase = 'out'; fx.blinkT = 0;
    blinkMesh.visible = true;
  }

  function applyRig() {
    if (!base) return false;
    try {
      const space = base.getOffsetReferenceSpace(makeOffsetTransform(rigToOffset(rig)));
      xr.setReferenceSpace(space);
      verifyFrames = 10;
      return true;
    } catch (err) {
      console.warn('[teleport] could not offset the reference space; teleport disabled', err);
      broken = true;
      return false;
    }
  }
  function revert(reason) {
    console.warn('[teleport] ' + reason + '; back to the original space, teleport disabled');
    try { xr.setReferenceSpace(base); } catch { /* */ }
    rig.pos.x = rig.pos.y = rig.pos.z = 0; rig.yaw = 0;
    broken = true;
    cancelAim();
  }
  function notify(x, z) {
    if (typeof opts.onTeleport !== 'function') return;
    try { opts.onTeleport({ position: [x, rig.pos.y, z], rotationY: rig.yaw }); } catch (err) { console.error(err); }
  }
  function pulse(src, intensity, ms) {
    try { src?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms)?.catch?.(() => {}); } catch { /* no haptics */ }
  }

  // ---- effects ----
  function animateFx(dt) {
    if (fx.blinkPhase) {
      blinkMesh.position.copy(head);
      fx.blinkT += dt;
      if (fx.blinkPhase === 'out') {
        blinkMat.opacity = Math.min(1, fx.blinkT / fx.blinkOut);
        if (fx.blinkT >= fx.blinkOut) {
          blinkMat.opacity = 1;
          const act = fx.pending; fx.pending = null;
          try { act?.(); } catch (err) { console.error('[teleport]', err); }
          fx.blinkPhase = 'in'; fx.blinkT = 0;
        }
      } else {
        blinkMat.opacity = Math.max(0, 1 - fx.blinkT / fx.blinkIn);
        if (fx.blinkT >= fx.blinkIn) { fx.blinkPhase = null; blinkMesh.visible = false; blinkMat.opacity = 0; }
      }
    }
    if (fx.ripple >= 0) {
      fx.ripple += dt;
      const k = fx.ripple / 0.9;
      if (k >= 1) { fx.ripple = -1; ripple.visible = false; }
      else {
        ripple.visible = true;
        ripple.scale.setScalar(1 + k * 1.6);
        rippleMat.opacity = 0.8 * (1 - k) * (1 - k);
      }
    }
    if (marker.visible) {
      fx.pulse += dt;
      const s = 1 + Math.sin(fx.pulse * 4) * 0.06;
      marker.scale.set(s, s, s);
    }
  }

  // ---- per frame ----
  function update(dt = 0) {
    dt = Math.min(Math.max(+dt || 0, 0), 0.1);
    clock += dt;
    if (!xr.isPresenting) { if (session) endSession(); return; }
    if (!session) beginSession();
    const frame = xr.getFrame?.();
    const space = xr.getReferenceSpace?.();
    if (!frame || !space) return;
    const vp = frame.getViewerPose?.(space);
    if (vp && finite3(vp.transform.position)) {
      const p = vp.transform.position;
      head.set(p.x, p.y, p.z);
      haveHead = true;
      verifyFrames = 0;
    } else if (vp && verifyFrames > 0) {
      revert('the offset reference space gave an invalid pose'); // e.g. an emulator that reads the offset differently
      return;
    } else if (verifyFrames > 0) verifyFrames--;
    animateFx(dt);
    if (!active() || !session) { if (aim) cancelAim(); pinch = null; return; }
    pollSticks();
    if (pinch && !pinch.blocked && !aim && !fx.blinkPhase && clock - pinch.t0 >= holdTime) startAim(pinch.source, 'pinch');
    if (aim) updateAim(frame, space);
  }

  return {
    update,
    /** Add/remove a walkable mesh at runtime (island tops, platforms). */
    addTarget(o) { if (o) { extraTargets.add(o); targetsAt = -1; } },
    removeTarget(o) { extraTargets.delete(o); targetsAt = -1; },
    setEnabled(on) { enabled = !!on; if (!enabled) { cancelAim(); pinch = null; } },
    /** Back to where the session started. Only call this from a user action (e.g. a "return home" button). */
    reset() {
      if (!base) return;
      go(() => { rig.pos.x = rig.pos.y = rig.pos.z = 0; rig.yaw = 0; try { xr.setReferenceSpace(base); } catch { /* */ } }, 0.08);
    },
    get aiming() { return !!aim; },
    get enabled() { return enabled && !broken; },
    /** Where the user is standing in world coordinates: [x, floor y, z] (head x/z), or null outside XR. */
    get position() { return haveHead && session ? [head.x, rig.pos.y, head.z] : null; },
    get rotationY() { return rig.yaw; },
    group,
    dispose() {
      endSession();
      xr.removeEventListener?.('sessionstart', beginSession);
      xr.removeEventListener?.('sessionend', endSession);
      scene.remove(group);
      arcGeo.dispose(); arcMat.dispose(); dotTex.dispose(); ringTex.dispose(); ringGeo.dispose();
      markMat.dispose(); rippleMat.dispose(); blinkMat.dispose(); blinkMesh.geometry.dispose();
    },
  };
}

export default createTeleport;
