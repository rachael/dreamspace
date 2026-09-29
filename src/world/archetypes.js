// Dreamspace archetypes: the curated objects the guide can summon.
//
//   buildArchetype(THREE, name, params) -> Object3D            (docs/CONTRACT.md)
//
// Every archetype is built from a handful of shared materials and merged, vertex-coloured geometry, so each one
// costs <= 4 draw calls and < 5k triangles (the grounded ones include their optional floating "islet").
// three.js is passed in, so this file has no imports and also loads in Node for tests.
//
// What a built root carries (root.userData):
//   archetype   the resolved name ('wisp' when the name was unknown; `fallback: true` then)
//   anchor      'ground' (origin at the base) or 'float' (origin at the visual centre)
//   bottom      for 'float': metres from the origin down to the lowest point (so a layer can keep it off the floor)
//   height, footprint, radius   rough metres, for labels, sparkles and islets
//   accent      '#rrggbb', the object's main glow colour (sparkles, UI)
//   update(dt, t)        gentle idle animation; always present, call it every frame
//   setFloating(bool)    ground archetypes only show a small floating rock ("islet") under them when true
//   dispose()            releases cached geometry (shared materials stay alive)
//
// params: { color?: css colour (main glow / tint), accent?: css colour (secondary), variant?: int }
// Incoming colours are gently "dreamified" (no pure primaries) so anything a model picks still fits the palette.
//
// Extra exports (used by objects.js and the preview): ARCHETYPES, normalizeArchetypeName, disposeArchetype,
// buildParts, sanitizeParts, createSparkles, createIslet, setArchetypeGlow, archetypeKit.

export const ARCHETYPES = [
  'crystal', 'crystal-cluster', 'floating-island', 'portal', 'lantern', 'tree-glow', 'mushroom-glow', 'rune-stone',
  'orb', 'planet', 'moon', 'spaceship', 'obelisk', 'waterfall-light', 'butterfly-swarm', 'wisp',
];
const ARCH_SET = new Set(ARCHETYPES);
const ALIASES = {
  gem: 'crystal', shard: 'crystal', crystals: 'crystal-cluster', cluster: 'crystal-cluster', geode: 'crystal-cluster',
  island: 'floating-island', 'sky-island': 'floating-island', 'floating-rock': 'floating-island',
  gate: 'portal', gateway: 'portal', doorway: 'portal', rift: 'portal', vortex: 'portal',
  lamp: 'lantern', 'lamp-post': 'lantern', lamppost: 'lantern', 'paper-lantern': 'lantern', 'sky-lantern': 'lantern',
  tree: 'tree-glow', 'glowing-tree': 'tree-glow', 'glow-tree': 'tree-glow', willow: 'tree-glow',
  mushroom: 'mushroom-glow', mushrooms: 'mushroom-glow', 'glowing-mushroom': 'mushroom-glow', fungus: 'mushroom-glow', toadstool: 'mushroom-glow',
  rune: 'rune-stone', runestone: 'rune-stone', 'standing-stone': 'rune-stone', menhir: 'rune-stone', monolith: 'obelisk',
  sphere: 'orb', 'glowing-orb': 'orb', globe: 'orb', 'ringed-planet': 'planet', saturn: 'planet', world: 'planet',
  ship: 'spaceship', starship: 'spaceship', 'space-ship': 'spaceship', rocket: 'spaceship', ufo: 'spaceship',
  pillar: 'obelisk', spire: 'obelisk', waterfall: 'waterfall-light', 'light-fall': 'waterfall-light', fountain: 'waterfall-light',
  butterfly: 'butterfly-swarm', butterflies: 'butterfly-swarm', swarm: 'butterfly-swarm', moths: 'butterfly-swarm',
  light: 'wisp', 'will-o-wisp': 'wisp', firefly: 'wisp', fireflies: 'wisp', spirit: 'wisp', sprite: 'wisp',
};

export function normalizeArchetypeName(name) {
  const s = String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!s) return null;
  if (ARCH_SET.has(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  const one = s.replace(/e?s$/, '');
  if (ARCH_SET.has(one)) return one;
  if (ALIASES[one]) return ALIASES[one];
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// palette (sRGB hex; three converts to linear)
// ---------------------------------------------------------------------------------------------------------------
const PAL = {
  stone: '#3d3a5c', stoneLight: '#625c8a', stoneDark: '#1f1c35',
  moss: '#2c7a6a', mossLight: '#5cc7a6',
  bark: '#2a2340', barkLight: '#5a4a80',
  hull: '#aab4d8', hullDark: '#3f4570', silver: '#dde4f7',
  stem: '#dcd4f2', pale: '#dfe2f6',
  teal: '#3fe6cc', cyan: '#72e6ff', violet: '#a78bff', magenta: '#ff7fd6', amber: '#ffc46b', rose: '#ff9fbf',
  ice: '#c4f1ff', gold: '#ffd98a', sky: '#8a9cff', lilac: '#c9b6ff', white: '#ffffff',
};
const DEFAULTS = {
  'crystal': ['cyan', 'violet'], 'crystal-cluster': ['violet', 'cyan'], 'floating-island': ['teal', 'magenta'],
  'portal': ['violet', 'cyan'], 'lantern': ['amber', 'rose'], 'tree-glow': ['teal', 'magenta'],
  'mushroom-glow': ['cyan', 'magenta'], 'rune-stone': ['cyan', 'teal'], 'orb': ['lilac', 'cyan'],
  'planet': ['sky', 'gold'], 'moon': ['pale', 'lilac'], 'spaceship': ['cyan', 'magenta'], 'obelisk': ['violet', 'cyan'],
  'waterfall-light': ['ice', 'teal'], 'butterfly-swarm': ['cyan', 'magenta'], 'wisp': ['ice', 'lilac'],
};
const VARIANTS = { lantern: 2, 'floating-island': 3, 'mushroom-glow': 3, 'crystal-cluster': 3, 'tree-glow': 2, 'butterfly-swarm': 2 };

// ---------------------------------------------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------------------------------------------
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const noop = () => {};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash3(i, j, k, s) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 1440662683) ^ Math.imul(s | 0, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
// smooth value noise in [-1, 1]
function noise3(x, y, z, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, s);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
const fbm = (x, y, z, s = 0) => noise3(x, y, z, s) * 0.65 + noise3(x * 2.1, y * 2.1, z * 2.1, s + 7) * 0.35;

// ---------------------------------------------------------------------------------------------------------------
// the kit: shared materials, textures, geometry cache (one per THREE namespace)
// ---------------------------------------------------------------------------------------------------------------
const KITS = new WeakMap();
export function archetypeKit(THREE) {
  let k = KITS.get(THREE);
  if (!k) { k = createKit(THREE); KITS.set(THREE, k); }
  return k;
}

// Additive things must fade to black in fog, not to the fog colour (that would make distant glows brighter).
const ADDITIVE_FOG = `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float dsFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float dsFog = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb *= 1.0 - dsFog;
#endif`;

// Camera-facing quads: every sprite is 4 vertices sharing a centre; `corner` pushes them apart in view space.
// Works per eye in XR, has no max point size, and scales with the object (spawn scale-in shrinks halos too).
// corner.z pulls a sprite toward the viewer (x its size) so a halo glows over its object, like bloom.
const SPRITE_PROJECT = `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
float dsScale = length( modelViewMatrix[ 0 ].xyz );
mvPosition.xy += corner.xy * spriteSize * 0.5 * dsScale;
mvPosition.z += corner.z * spriteSize * dsScale;
gl_Position = projectionMatrix * mvPosition;`;

function createKit(T) {
  const U = { glow: { value: 1 }, rimColor: { value: new T.Color('#8fb3ff') } };

  // Lit material with per-vertex emissive ("emis" attribute), a soft fresnel rim and a small self-glow,
  // so objects read as luminous in a dim twilight scene and still take the scene's lights.
  const lit = (kind, side) => {
    const glass = kind === 'glass';
    const m = new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: glass ? 0.22 : 0.86,
      metalness: glass ? 0.1 : 0.02,
      transparent: glass,
      opacity: glass ? 0.3 : 1,
      depthWrite: !glass,
      side: side ?? T.FrontSide,
    });
    if (side === T.DoubleSide) m.forceSinglePass = true; // one draw call (thin sheets only)
    const rim = { value: glass ? 1.15 : 0.32 };
    m.onBeforeCompile = (s) => {
      s.uniforms.dsGlow = U.glow;
      s.uniforms.dsRimColor = U.rimColor;
      s.uniforms.dsRim = rim;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float emis;\nvarying float vDsEmis;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvDsEmis = emis;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDsEmis;\nuniform float dsGlow;\nuniform float dsRim;\nuniform vec3 dsRimColor;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb *= 1.0 - 0.85 * clamp( vDsEmis, 0.0, 1.0 );')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	float dsFacing = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
	float dsFres = pow( 1.0 - dsFacing, ${glass ? '2.2' : '3.5'} );
	totalEmissiveRadiance += vColor.rgb * ( vDsEmis * dsGlow + 0.06 );
	totalEmissiveRadiance += mix( dsRimColor, vColor.rgb, 0.55 ) * dsFres * dsRim * ( 0.55 + 0.45 * dsGlow );
	${glass ? 'diffuseColor.a = clamp( diffuseColor.a + dsFres * 0.6 + vDsEmis * 0.3, 0.0, 1.0 );' : ''}`);
    };
    m.customProgramCacheKey = () => `dreamspace-lit-${kind}`;
    m.name = `dreamspace-${kind}${side === T.DoubleSide ? '-2s' : ''}`;
    return m;
  };

  const additive = (map, { sprite = false, side = T.FrontSide, name }) => {
    const m = new T.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, side,
    });
    m.forceSinglePass = true; // additive: order does not matter, so a double-sided sheet stays one draw call
    m.onBeforeCompile = (s) => {
      if (sprite) {
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 corner;\nattribute float spriteSize;')
          .replace('#include <project_vertex>', SPRITE_PROJECT);
      }
      s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', ADDITIVE_FOG);
    };
    m.customProgramCacheKey = () => `dreamspace-add-${sprite ? 'sprite' : 'sheet'}`;
    m.name = name;
    return m;
  };

  const tex = {
    dot: dataTex(T, 64, 64, dotTexel),
    star: dataTex(T, 64, 64, starTexel),
    swirl: dataTex(T, 128, 128, swirlTexel),
    streak: dataTex(T, 64, 128, streakTexel, true),
  };
  const mats = {
    body: lit('body'),
    glass: lit('glass'),
    glass2: lit('glass', T.DoubleSide),
    halo: additive(tex.dot, { sprite: true, name: 'dreamspace-halo' }),
    sparkle: additive(tex.star, { sprite: true, name: 'dreamspace-sparkle' }),
    swirl: additive(tex.swirl, { side: T.DoubleSide, name: 'dreamspace-swirl' }),
    curtain: additive(tex.streak, { side: T.DoubleSide, name: 'dreamspace-curtain' }),
  };

  const cache = new Map(); // key -> { geo, refs }
  const kit = {
    T, U, tex, mats, cache,
    geo(key, build, refs) {
      let e = cache.get(key);
      if (!e) { e = { geo: build(), refs: 0 }; cache.set(key, e); }
      e.refs++;
      refs.push(key);
      return e.geo;
    },
    release(keys) {
      for (const key of keys) {
        const e = cache.get(key);
        if (!e) continue;
        if (--e.refs <= 0) { e.geo.dispose(); cache.delete(key); }
      }
      keys.length = 0;
    },
    setGlow(g) {
      const x = clamp01(Number.isFinite(g) ? g : 0.5);
      U.glow.value = 0.55 + 0.9 * x;
      const s = 0.75 + 1.2 * x;
      for (const m of [mats.halo, mats.sparkle, mats.swirl, mats.curtain]) m.color.setScalar(s);
    },
  };
  kit.setGlow(0.5);
  return kit;
}

// Mood glow (0..1, default 0.5) scales every emissive, halo and light-sheet at once. One uniform, no recompiles.
export function setArchetypeGlow(THREE, glow) { archetypeKit(THREE).setGlow(glow); }

function dataTex(T, w, h, fn, repeat = false) {
  const d = new Uint8Array(w * h * 4);
  const out = [1, 1, 1, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn((x + 0.5) / w, (y + 0.5) / h, out);
      const i = (y * w + x) * 4;
      d[i] = clamp01(out[0]) * 255; d[i + 1] = clamp01(out[1]) * 255; d[i + 2] = clamp01(out[2]) * 255; d[i + 3] = clamp01(out[3]) * 255;
    }
  }
  const t = new T.DataTexture(d, w, h, T.RGBAFormat);
  t.magFilter = T.LinearFilter;
  t.minFilter = T.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  if (repeat) { t.wrapS = T.ClampToEdgeWrapping; t.wrapT = T.RepeatWrapping; }
  t.needsUpdate = true;
  return t;
}
function dotTexel(u, v, o) {
  const r = Math.hypot(u - 0.5, v - 0.5) * 2;
  o[0] = o[1] = o[2] = 1;
  o[3] = (Math.exp(-r * r * 4.2) * 0.8 + Math.exp(-r * r * 26) * 0.5) * (1 - smooth(0.72, 1, r));
}
function starTexel(u, v, o) {
  const x = Math.abs(u - 0.5), y = Math.abs(v - 0.5), r = Math.hypot(x, y) * 2;
  const rays = Math.exp(-y * 70) * Math.exp(-x * 7) + Math.exp(-x * 70) * Math.exp(-y * 7);
  const d1 = Math.abs(x - y), diag = Math.exp(-d1 * 60) * Math.exp(-(x + y) * 10) * 0.35;
  o[0] = o[1] = o[2] = 1;
  o[3] = (Math.exp(-r * r * 60) + rays * 0.9 + diag + Math.exp(-r * r * 9) * 0.3) * (1 - smooth(0.8, 1, r));
}
function swirlTexel(u, v, o) {
  const x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
  const arms = Math.pow(0.5 + 0.5 * Math.cos(a * 3 - r * 8.5), 2.5);
  const fine = 0.5 + 0.5 * Math.cos(a * 7 + r * 13 + fbm(x * 3, y * 3, 0.5) * 2);
  const center = Math.exp(-r * r * 7) * 0.85;
  const ring = Math.exp(-Math.pow((r - 0.93) / 0.06, 2)) * 0.7;
  const val = (arms * 0.55 * (0.25 + 0.75 * r) + fine * 0.12 * r + center + ring) * (1 - smooth(0.96, 1.0, r));
  o[0] = o[1] = o[2] = 1;
  o[3] = val;
}
function streakTexel(u, v, o) {
  // vertical light streaks that tile in v; soft edges across u
  const cols = 14, cu = u * cols, ci = Math.floor(cu), cf = cu - ci;
  const col = (i) => 0.5 + 0.5 * hash3(i, 3, 1, 11);
  const ph = (i) => 0.5 + 0.5 * hash3(i, 5, 2, 17);
  const s = cf * cf * (3 - 2 * cf);
  let val = 0;
  for (const [i, wgt] of [[ci, 1 - s], [ci + 1, s]]) {
    const f1 = fract(v * 2 + ph(i)), f2 = fract(v * 3 + ph(i + 40));
    const dash = (f) => smooth(0, 0.08, f) * (1 - smooth(0.12, 1, f));
    val += wgt * (0.25 + 0.75 * col(i)) * (dash(f1) * 0.8 + dash(f2) * 0.5);
  }
  const edge = Math.pow(Math.sin(u * Math.PI), 0.8);
  o[0] = o[1] = o[2] = 1;
  o[3] = (val * 0.9 + 0.14) * edge;
}

// ---------------------------------------------------------------------------------------------------------------
// Mixer: merges many primitives into one non-indexed geometry with position, normal, color and emis
// ---------------------------------------------------------------------------------------------------------------
class Mixer {
  constructor(T) { this.T = T; this.P = []; this.N = []; this.C = []; this.E = []; this.UV = []; }
  // o: { m: Matrix4, color: Color, emis: number, flat: bool, deform(v, n?), paint(lp, ln, c, wp, wn) -> emis?, double: bool }
  add(geo, o = {}) {
    const T = this.T;
    let g = geo;
    if (o.deform) {
      g = g.clone();
      const p = g.attributes.position, v = new T.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); o.deform(v); p.setXYZ(i, v.x, v.y, v.z); }
      if (!o.flat) g.computeVertexNormals();
    }
    g = g.index ? g.toNonIndexed() : (g === geo ? g.clone() : g);
    if (o.flat || !g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position, nor = g.attributes.normal, uvA = g.attributes.uv;
    const m = o.m || IDENT(T);
    const nm = new T.Matrix3().getNormalMatrix(m);
    const flip = m.determinant() < 0;
    const base = o.color || WHITE(T);
    const emis = o.emis ?? 0;
    const c = new T.Color(), lp = new T.Vector3(), ln = new T.Vector3(), wp = new T.Vector3(), wn = new T.Vector3();
    const start = this.P.length / 3;
    for (let i = 0; i < pos.count; i++) {
      lp.fromBufferAttribute(pos, i); ln.fromBufferAttribute(nor, i);
      wp.copy(lp).applyMatrix4(m); wn.copy(ln).applyMatrix3(nm).normalize();
      c.copy(base);
      let e = emis;
      if (o.paint) { const r = o.paint(lp, ln, c, wp, wn); if (typeof r === 'number') e = r; }
      this.P.push(wp.x, wp.y, wp.z); this.N.push(wn.x, wn.y, wn.z); this.C.push(c.r, c.g, c.b); this.E.push(e);
      if (uvA) this.UV.push(uvA.getX(i), uvA.getY(i)); else this.UV.push(0, 0);
    }
    if (flip) this._reverse(start, pos.count);
    if (o.double) this._backfaces(start, pos.count);
    return this;
  }
  _reverse(start, count) {
    for (let t = 0; t < count / 3; t++) {
      const a = start + t * 3 + 1, b = start + t * 3 + 2;
      for (const [arr, n] of [[this.P, 3], [this.N, 3], [this.C, 3], [this.E, 1], [this.UV, 2]]) {
        for (let k = 0; k < n; k++) { const x = arr[a * n + k]; arr[a * n + k] = arr[b * n + k]; arr[b * n + k] = x; }
      }
    }
  }
  _backfaces(start, count) {
    for (let t = 0; t < count / 3; t++) {
      for (const j of [0, 2, 1]) {
        const i = start + t * 3 + j;
        this.P.push(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]);
        this.N.push(-this.N[i * 3], -this.N[i * 3 + 1], -this.N[i * 3 + 2]);
        this.C.push(this.C[i * 3], this.C[i * 3 + 1], this.C[i * 3 + 2]);
        this.E.push(this.E[i]);
        this.UV.push(this.UV[i * 2], this.UV[i * 2 + 1]);
      }
    }
  }
  get count() { return this.P.length / 3; }
  build({ uv = false } = {}) {
    const T = this.T, g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(this.P), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array(this.N), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(this.C), 3));
    g.setAttribute('emis', new T.BufferAttribute(new Float32Array(this.E), 1));
    if (uv) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(this.UV), 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
let _ident = null, _white = null;
const IDENT = (T) => (_ident ??= new T.Matrix4());
const WHITE = (T) => (_white ??= new T.Color(1, 1, 1));

// merge raw geometries (position + normal only) in a shared local frame, so a paint() can use that frame
function mergeRaw(T, parts) {
  const P = [], N = [];
  const v = new T.Vector3();
  for (const [geo, m] of parts) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    if (m) g.applyMatrix4(m);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i); P.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i); N.push(v.x, v.y, v.z);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new T.BufferAttribute(new Float32Array(N), 3));
  return g;
}

function M(T, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new T.Matrix4().compose(new T.Vector3(px, py, pz), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new T.Vector3(sx, sy, sz));
}
// matrix that stands a y-up primitive between a and b (the primitive is centred, so it goes to the midpoint)
function between(T, a, b, sx = 1, sz = sx) {
  const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
  return { m: new T.Matrix4().compose(A.add(B).multiplyScalar(0.5), q, new T.Vector3(sx, 1, sz)), len };
}
// tilt +y toward the horizontal direction `ang` by `tilt` radians, with its base at p
function tiltM(T, p, ang, tilt, spin = 0, s = 1) {
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(Math.sin(ang), 0, -Math.cos(ang)).normalize(), tilt);
  q.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), spin));
  return new T.Matrix4().compose(new T.Vector3(...p), q, new T.Vector3(s, s, s));
}

// a hexagonal crystal, base at y=0, optional lower point (double-terminated)
function crystalGeo(T, r, hs, ht, hb = 0, sides = 6) {
  const parts = [
    [new T.CylinderGeometry(r * 0.9, r, hs, sides, 1, true), M(T, 0, hs / 2, 0)],
    [new T.ConeGeometry(r * 0.9, ht, sides, 1, true), M(T, 0, hs + ht / 2, 0)],
  ];
  if (hb > 0) parts.push([new T.ConeGeometry(r, hb, sides, 1, true), M(T, 0, -hb / 2, 0, Math.PI, 0, 0)]);
  return mergeRaw(T, parts);
}

// ---------------------------------------------------------------------------------------------------------------
// Field: a bag of soft glow sprites (halos, motes, fireflies) in one draw call, animated on the CPU
// ---------------------------------------------------------------------------------------------------------------
class Field {
  constructor(T) { this.T = T; this.list = []; this.mesh = null; this.dynamic = false; }
  // motion: { t: 'drift'|'orbit'|'rise'|'fall'|'stream'|'spiral'|'ext', ...params, pulse, pw, tw, tws, ph }
  add(x, y, z, size, color, alpha = 1, motion = null) {
    this.list.push({ x, y, z, size, r: color.r, g: color.g, b: color.b, a: alpha, m: motion, ph: motion?.ph ?? Math.random() * TAU, pull: motion?.pull ?? 0.3 });
    return this.list.length - 1;
  }
  build(material) {
    const T = this.T, n = this.list.length;
    const g = new T.BufferGeometry();
    const cor = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint16Array(n * 6);
    const UV = [0, 0, 1, 0, 1, 1, 0, 1];
    for (let i = 0; i < n; i++) {
      const z = this.list[i].pull;
      cor.set([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z], i * 12); uv.set(UV, i * 8);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.pos = new T.BufferAttribute(new Float32Array(n * 12), 3);
    this.siz = new T.BufferAttribute(new Float32Array(n * 4), 1);
    this.col = new T.BufferAttribute(new Float32Array(n * 16), 4);
    g.setAttribute('position', this.pos);
    g.setAttribute('corner', new T.BufferAttribute(cor, 3));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setAttribute('spriteSize', this.siz);
    g.setAttribute('color', this.col);
    g.setIndex(new T.BufferAttribute(idx, 1));
    this.dynamic = this.list.some((s) => s.m);
    if (this.dynamic) for (const a of [this.pos, this.siz, this.col]) a.setUsage(T.DynamicDrawUsage);
    this.geo = g;
    this.write(0);
    g.computeBoundingSphere();
    const mesh = new T.Mesh(g, material);
    mesh.name = 'field';
    mesh.frustumCulled = false;
    mesh.raycast = noop;
    mesh.renderOrder = 2;
    this.mesh = mesh;
    return mesh;
  }
  setPos(i, x, y, z) { const s = this.list[i]; s.x = x; s.y = y; s.z = z; }
  update(t) { if (this.dynamic && this.mesh) this.write(t); }
  write(t) {
    const P = this.pos.array, S = this.siz.array, Cc = this.col.array, o = SCR;
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i];
      evalMotion(s, t, o);
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        P[v * 3] = o.x; P[v * 3 + 1] = o.y; P[v * 3 + 2] = o.z;
        S[v] = o.size;
        Cc[v * 4] = s.r; Cc[v * 4 + 1] = s.g; Cc[v * 4 + 2] = s.b; Cc[v * 4 + 3] = o.a;
      }
    }
    this.pos.needsUpdate = true; this.siz.needsUpdate = true; this.col.needsUpdate = true;
  }
}
const SCR = { x: 0, y: 0, z: 0, size: 0, a: 0 };
function evalMotion(s, t, o) {
  let x = s.x, y = s.y, z = s.z, size = s.size, a = s.a;
  const m = s.m, ph = s.ph;
  if (m) {
    switch (m.t) {
      case 'drift': {
        const r = m.r ?? 0.1, w = m.w ?? 0.6;
        x += Math.sin(t * w * 0.9 + ph) * r;
        y += Math.sin(t * w * 1.3 + ph * 1.7) * r * 0.6;
        z += Math.cos(t * w * 0.77 + ph * 0.6) * r;
        break;
      }
      case 'orbit': {
        const ang = (m.a0 ?? 0) + t * (m.speed ?? 0.3) + (m.sync ? 0 : ph);
        const R = m.r ?? 0.3;
        if (m.plane === 'xy') {
          x = (m.cx ?? 0) + Math.sin(ang) * R; y = (m.cy ?? 0) + Math.cos(ang) * R;
          z = s.z + Math.sin(t * 0.7 + ph) * (m.bob ?? 0);
        } else {
          x = (m.cx ?? 0) + Math.sin(ang) * R; z = (m.cz ?? 0) + Math.cos(ang) * R;
          y = s.y + Math.sin(t * 0.8 + ph) * (m.bob ?? 0.03);
        }
        break;
      }
      case 'rise': case 'fall': {
        const u = fract(ph * 0.159 + t * (m.speed ?? 0.25)), sp = m.spread ?? 0.05;
        x += Math.sin(u * 9 + ph) * sp; z += Math.cos(u * 7 + ph) * sp;
        y += (m.t === 'rise' ? 1 : -1) * u * (m.h ?? 0.6);
        a *= Math.sin(u * Math.PI); size *= 1 - 0.3 * u;
        break;
      }
      case 'stream': {
        const u = fract(ph * 0.159 + t * (m.speed ?? 1));
        x += (m.dx ?? 0) * u; y += (m.dy ?? 0) * u; z += (m.dz ?? 0) * u;
        a *= (1 - u) * Math.min(1, u * 8); size *= 1 - 0.5 * u;
        break;
      }
      case 'spiral': {
        const u = fract(ph * 0.159 + t * (m.speed ?? 0.2)), R = (m.r ?? 0.8) * (1 - u), ang = ph + u * (m.turns ?? 5);
        x = (m.cx ?? 0) + Math.sin(ang) * R; y = (m.cy ?? 0) + Math.cos(ang) * R;
        a *= Math.sin(u * Math.PI);
        break;
      }
      default: break;
    }
    if (m.pulse) size *= 1 + m.pulse * Math.sin(t * (m.pw ?? 1.2) + ph);
    if (m.tw) a *= 1 - m.tw * (0.5 + 0.5 * Math.sin(t * (m.tws ?? 2) + ph * 2.3));
  }
  o.x = x; o.y = y; o.z = z; o.size = size; o.a = a;
}

// ---------------------------------------------------------------------------------------------------------------
// colours
// ---------------------------------------------------------------------------------------------------------------
const _hsl = { h: 0, s: 0, l: 0 };
function parseColor(T, value, fallbackHex, { minL = 0.45, maxL = 0.82, maxS = 0.85 } = {}) {
  const c = new T.Color(fallbackHex);
  if (value == null || value === '') return c;
  try {
    if (typeof value === 'number' && Number.isFinite(value)) c.setHex(value & 0xffffff);
    else if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      const hex = s.replace(/^#/, '').replace(/^0x/, '');
      if (/^[0-9a-f]{6}$/.test(hex)) c.set('#' + hex);
      else if (/^[0-9a-f]{3}$/.test(hex)) c.set('#' + hex);
      else if (T.Color.NAMES && T.Color.NAMES[s.replace(/[\s-]/g, '')] !== undefined) c.setHex(T.Color.NAMES[s.replace(/[\s-]/g, '')]);
      else if (/^(rgb|hsl)a?\([\d\s.,%]+\)$/.test(s)) c.setStyle(s);
      else return c;
    } else return c;
  } catch { return new T.Color(fallbackHex); }
  // "dreamify": soften pure primaries and too-dark or too-bright picks, keep the hue
  c.getHSL(_hsl, T.SRGBColorSpace);
  c.setHSL(_hsl.h, Math.min(_hsl.s, maxS), clamp(_hsl.l, minL, maxL), T.SRGBColorSpace);
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// build context
// ---------------------------------------------------------------------------------------------------------------
function makeCtx(k, name, params) {
  const T = k.T;
  const nv = VARIANTS[name] || 1;
  const variant = ((Math.trunc(Number(params.variant)) || 0) % nv + nv) % nv;
  const [dt, da] = DEFAULTS[name];
  const tint = parseColor(T, params.color, PAL[dt]);
  const accent = parseColor(T, params.accent, PAL[da]);
  const seed = hashStr(name) ^ Math.imul(variant + 1, 7919);
  const keyT = `${name}|${variant}|${tint.getHexString()}|${accent.getHexString()}`;
  const keyU = `${name}|${variant}`;
  const root = new T.Group();
  const body = new T.Group();
  body.name = 'body';
  root.add(body);
  const A = {
    T, k, name, variant, tint, accent, root, body, refs: [], owned: [], fields: [],
    ph: Math.random() * TAU,
    rng: (label = '') => mulberry32(seed ^ hashStr(label)),
    c: (hex) => new T.Color(PAL[hex] ?? hex),
    lite: (c, t) => c.clone().lerp(WHITE(T), t),
    dim: (c, f) => c.clone().multiplyScalar(f),
    mix: () => new Mixer(T),
    // cached geometry; tinted = depends on the colours, else shared across colours
    geo: (sub, build, tinted = true) => k.geo(`${tinted ? keyT : keyU}:${sub}`, build, A.refs),
    mesh: (geo, mat = 'body', name2 = '') => { const m = new T.Mesh(geo, k.mats[mat]); m.name = name2; return m; },
    field: () => new Field(T),
    fieldMesh: (f, mat = 'halo') => { const m = f.build(k.mats[mat]); A.owned.push(f.geo); A.fields.push(f); return m; },
  };
  return A;
}

// ---------------------------------------------------------------------------------------------------------------
// the builders. Each adds meshes to A.body and returns { anchor, bottom?, height, footprint, radius, update }
// ---------------------------------------------------------------------------------------------------------------
const B = {};

// A single floating, double-terminated crystal with a bright core and three orbiting shards.
B['crystal'] = (A) => {
  const { T, tint, accent } = A;
  const bob = new T.Group();
  A.body.add(bob);
  const gem = A.mesh(A.geo('gem', () => {
    const mx = A.mix();
    const main = crystalGeo(T, 0.15, 0.5, 0.34, 0.26);
    const twin = crystalGeo(T, 0.07, 0.16, 0.13, 0.05);
    const tip = A.lite(tint, 0.45);
    const paint = (h0, h1) => (lp, ln, c) => { const u = clamp01((lp.y - h0) / (h1 - h0)); c.copy(tint).lerp(tip, u); return 0.18 + 0.2 * u; };
    mx.add(main, { flat: true, paint: paint(-0.26, 0.84), m: M(T, 0, -0.29, 0) });
    mx.add(twin, { flat: true, paint: paint(-0.05, 0.29), m: tiltM(T, [0.06, -0.2, 0.03], 0.9, 0.75, 0.3) });
    mx.add(twin, { flat: true, paint: paint(-0.05, 0.29), m: tiltM(T, [-0.05, -0.12, -0.05], 3.8, 0.6, 0.1, 0.8) });
    return mx.build();
  }), 'glass', 'gem');
  bob.add(gem);
  const orbit = A.mesh(A.geo('core', () => {
    const mx = A.mix();
    const oct = new T.OctahedronGeometry(1);
    mx.add(oct, { flat: true, m: M(T, 0, 0.02, 0, 0, 0, 0, 0.055, 0.34, 0.055), paint: (lp, ln, c) => { c.copy(A.lite(tint, 0.5 + 0.4 * (1 - Math.abs(lp.y)))); return 1; } });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      mx.add(oct, { flat: true, color: A.lite(accent, 0.2), emis: 0.95, m: M(T, Math.sin(a) * 0.36, (i - 1) * 0.12, Math.cos(a) * 0.36, 0.4, a, 0.3, 0.03, 0.055, 0.03) });
    }
    return mx.build();
  }), 'body', 'core');
  bob.add(orbit);
  const f = A.field();
  const r = A.rng('field');
  f.add(0, 0, 0, 1.3, tint, 0.42, { pulse: 0.07, pw: 1.1 });
  f.add(0, 0.02, 0, 0.42, A.lite(tint, 0.4), 0.6, { pulse: 0.1, pw: 1.7 });
  for (let i = 0; i < 6; i++) {
    f.add((r() - 0.5) * 0.7, (r() - 0.5) * 0.8, (r() - 0.5) * 0.7, 0.035 + r() * 0.03, i % 2 ? accent : A.lite(tint, 0.3), 0.9, { t: 'drift', r: 0.12, w: 0.5, tw: 0.6 });
  }
  bob.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.62, height: 1.2, footprint: 0.3, radius: 0.6,
    update(dt, t) {
      gem.rotation.y += dt * 0.22;
      orbit.rotation.y -= dt * 0.55;
      bob.position.y = Math.sin(t * 0.8 + A.ph) * 0.05;
    },
  };
};

// A mossy rock with a spray of glass crystals, glowing cores and little shards.
B['crystal-cluster'] = (A) => {
  const { T, tint, accent } = A;
  const r = A.rng('layout');
  const n = 6 + A.variant;
  const xs = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * TAU + r() * 0.6, d = i === 0 ? 0.02 : 0.13 + r() * 0.2;
    const h = i === 0 ? 0.95 : lerp(0.72, 0.28, d / 0.33) * (0.8 + r() * 0.35);
    xs.push({ ang, d, h, rad: h * 0.12 + 0.02, tilt: i === 0 ? 0.05 : 0.25 + d * 1.3 + r() * 0.15, spin: r() * TAU, acc: i % 3 === 2 });
  }
  const lean = (x) => tiltM(T, [Math.cos(x.ang) * x.d, 0.06, Math.sin(x.ang) * x.d], x.ang, x.tilt, x.spin); // leans outward
  const baseMesh = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const rockC = A.c('stone'), moss = A.c('moss');
    mx.add(new T.IcosahedronGeometry(1, 1), {
      flat: true, m: M(T, 0, 0.02, 0, 0, 0.3, 0, 0.56, 0.2, 0.5),
      deform: (v) => v.multiplyScalar(1 + fbm(v.x * 2, v.y * 2, v.z * 2, 3) * 0.16),
      paint: (lp, ln, c, wp, wn) => {
        c.copy(rockC).lerp(A.c('stoneDark'), clamp01(-lp.y));
        if (wn.y > 0.55) c.lerp(moss, 0.7);
        return 0;
      },
    });
    for (const x of xs) {
      const m = lean(x);
      mx.add(new T.CylinderGeometry(x.rad * 0.3, x.rad * 0.35, x.h * 0.8, 4), {
        m: m.clone().multiply(M(T, 0, x.h * 0.42, 0)), color: A.lite(x.acc ? accent : tint, 0.55), emis: 1,
      });
    }
    const oct = new T.OctahedronGeometry(1);
    for (let i = 0; i < 7; i++) {
      const a = r() * TAU, d = 0.3 + r() * 0.22;
      mx.add(oct, { flat: true, color: A.lite(i % 2 ? accent : tint, 0.25), emis: 0.9, m: M(T, Math.cos(a) * d, 0.08 + r() * 0.05, Math.sin(a) * d, r(), r() * 3, r(), 0.025, 0.05, 0.025) });
    }
    return mx.build();
  }), 'body', 'rock');
  const glass = A.mesh(A.geo('glass', () => {
    const mx = A.mix();
    for (const x of xs) {
      const g = crystalGeo(T, x.rad, x.h * 0.78, x.h * 0.22);
      const col = x.acc ? accent : tint, tip = A.lite(col, 0.5);
      mx.add(g, {
        flat: true, m: lean(x),
        paint: (lp, ln, c) => { const u = clamp01(lp.y / x.h); c.copy(col).lerp(tip, u); return 0.15 + 0.25 * u; },
      });
    }
    return mx.build();
  }), 'glass', 'crystals');
  A.body.add(baseMesh, glass);
  const f = A.field();
  const fr = A.rng('field');
  f.add(0, 0.45, 0, 1.6, tint, 0.34, { pulse: 0.06, pw: 0.9 });
  for (const x of xs) {
    const p = new T.Vector3(0, x.h * 0.95, 0).applyMatrix4(lean(x));
    f.add(p.x, p.y, p.z, 0.16 + x.h * 0.12, A.lite(x.acc ? accent : tint, 0.3), 0.55, { tw: 0.5, tws: 1.1 + fr() });
  }
  for (let i = 0; i < 6; i++) {
    f.add((fr() - 0.5) * 0.5, 0.15 + fr() * 0.3, (fr() - 0.5) * 0.5, 0.03 + fr() * 0.02, i % 2 ? accent : A.lite(tint, 0.4), 0.9, { t: 'rise', h: 0.9, speed: 0.08 + fr() * 0.06, spread: 0.06 });
  }
  A.body.add(A.fieldMesh(f));
  return { anchor: 'ground', height: 1.05, footprint: 0.6, radius: 0.7, update: noop };
};

// A floating rock island: mossy top, glowing veins and roots, a tiny tree / crystals / shrine, and a trickle of light.
B['floating-island'] = (A) => {
  const { T, tint, accent } = A;
  const bob = new T.Group();
  A.body.add(bob);
  const rock = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const r = A.rng('island');
    const moss = A.c('moss'), mossL = A.c('mossLight'), stone = A.c('stone'), dark = A.c('stoneDark');
    mx.add(new T.IcosahedronGeometry(1, 2), {
      flat: true, m: M(T, 0, 0, 0, 0, 0, 0, 0.78),
      deform: (v) => {
        const n = fbm(v.x * 1.7, v.y * 1.7, v.z * 1.7, 5);
        if (v.y > 0) { v.y = v.y * 0.14 + 0.02 * n; v.x *= 1 + n * 0.08; v.z *= 1 + n * 0.08; }
        else { const d = -v.y; const k = 1 - 0.82 * Math.pow(d, 1.25); v.x *= k * (1 + n * 0.2); v.z *= k * (1 + n * 0.2); v.y = -d * (0.95 + n * 0.25); }
      },
      paint: (lp, ln, c, wp, wn) => {
        if (wn.y > 0.5 && lp.y > -0.08) { c.copy(mossL).lerp(moss, clamp01(Math.hypot(lp.x, lp.z) * 1.1)); return 0.03; }
        const d = clamp01(-lp.y);
        c.copy(stone).lerp(dark, d);
        const vein = smooth(0.35, 0.62, fbm(lp.x * 4, lp.y * 4, lp.z * 4, 9));
        if (vein > 0) { c.lerp(A.lite(tint, 0.2), vein); return vein * 0.95; }
        return 0;
      },
    });
    // hanging roots with glowing tips
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + r() * 0.5, d = 0.1 + r() * 0.16, len = 0.25 + r() * 0.28;
      const top = [Math.cos(a) * d, -0.4, Math.sin(a) * d], bot = [top[0] * 1.3, top[1] - len, top[2] * 1.3];
      const { m, len: L } = between(T, top, bot);
      mx.add(new T.CylinderGeometry(0.008, 0.02, L, 5, 1, true), { m, color: A.c('bark') });
      mx.add(new T.IcosahedronGeometry(0.028, 0), { flat: true, m: M(T, ...bot), color: A.lite(i % 2 ? accent : tint, 0.3), emis: 1 });
    }
    // top decoration
    const v = A.variant;
    if (v === 0) {
      const trunk = between(T, [0.05, 0.05, -0.02], [0.02, 0.5, 0]);
      mx.add(new T.CylinderGeometry(0.025, 0.05, trunk.len, 6), { m: trunk.m, color: A.c('barkLight') });
      for (const [x, y, z, s] of [[0, 0.62, 0, 0.2], [0.1, 0.55, 0.06, 0.13], [-0.09, 0.56, -0.05, 0.12]]) {
        mx.add(new T.IcosahedronGeometry(1, 1), {
          flat: true, m: M(T, x, y, z, 0, r() * 3, 0, s, s * 0.8, s),
          paint: (lp, ln, c) => { c.copy(tint).lerp(A.lite(tint, 0.35), clamp01(lp.y * 0.5 + 0.5)); return 0.35 + 0.3 * clamp01(lp.y); },
        });
      }
    } else if (v === 1) {
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7, d = i ? 0.14 : 0, h = i ? 0.22 + r() * 0.15 : 0.5;
        mx.add(crystalGeo(T, h * 0.14, h * 0.75, h * 0.25), {
          flat: true, m: tiltM(T, [Math.cos(a) * d - 0.1, 0.03, Math.sin(a) * d], a, d * 2.2),
          paint: (lp, ln, c) => { const u = clamp01(lp.y / h); c.copy(i % 2 ? accent : tint).lerp(WHITE(T), u * 0.4); return 0.5 + 0.4 * u; },
        });
      }
    } else {
      for (const x of [-0.16, 0.16]) mx.add(new T.BoxGeometry(0.07, 0.34, 0.07), { flat: true, m: M(T, x, 0.2, -0.05), color: A.c('stoneLight') });
      mx.add(new T.BoxGeometry(0.46, 0.06, 0.1), { m: M(T, 0, 0.4, -0.05), color: A.c('stoneLight') });
      mx.add(new T.OctahedronGeometry(0.06), { flat: true, m: M(T, 0, 0.22, -0.05, 0, 0.4, 0, 1, 1.5, 1), color: A.lite(accent, 0.3), emis: 1 });
    }
    return mx.build();
  }), 'body', 'island');
  const trickle = A.mesh(A.geo('trickle', () => {
    const mx = A.mix();
    const col = A.lite(tint, 0.35);
    const g0 = new T.PlaneGeometry(0.1, 0.95, 1, 6);
    g0.translate(0, -0.455, 0);
    mx.add(g0, { m: M(T, 0.77, 0.02, 0.24, 0, Math.PI / 2 - 0.3, 0), color: col });
    const g = mx.build({ uv: true });
    return withAlpha(T, g, (p) => smooth(0.02, -0.06, p.y) * (1 - smooth(-0.5, -0.92, p.y)));
  }), 'curtain', 'trickle');
  bob.add(rock, trickle);
  const f = A.field();
  const fr = A.rng('field');
  f.add(0, -0.35, 0, 1.25, tint, 0.32, { pulse: 0.05, pw: 0.7 });
  f.add(0, 0.45, 0, 0.8, A.lite(A.variant === 2 ? accent : tint, 0.2), 0.36, { pulse: 0.08 });
  f.add(0.77, 0.0, 0.24, 0.3, A.lite(tint, 0.3), 0.35, { pulse: 0.15, pw: 2 });
  for (let i = 0; i < 9; i++) {
    const a = fr() * TAU, d = 0.35 + fr() * 0.55;
    f.add(Math.cos(a) * d, -0.4 + fr() * 1.0, Math.sin(a) * d, 0.03 + fr() * 0.025, i % 3 ? A.lite(tint, 0.4) : accent, 0.9, { t: 'drift', r: 0.15, w: 0.35, tw: 0.6, tws: 1.3 });
  }
  bob.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 1.0, height: 1.7, footprint: 0.8, radius: 0.95,
    update(dt, t) {
      bob.position.y = Math.sin(t * 0.5 + A.ph) * 0.06;
      bob.rotation.y += dt * 0.04;
      bob.rotation.z = Math.sin(t * 0.37 + A.ph) * 0.015;
      A.k.tex.streak.offset.y = (t * 0.45) % 1;
    },
  };
};

// Bake a per-vertex alpha into a geometry (turns the colour attribute into RGBA) for the additive sheets.
function withAlpha(T, g, alphaAt) {
  const c = g.attributes.color, p = g.attributes.position, out = new Float32Array(c.count * 4), v = new T.Vector3();
  for (let i = 0; i < c.count; i++) {
    v.fromBufferAttribute(p, i);
    out[i * 4] = c.getX(i); out[i * 4 + 1] = c.getY(i); out[i * 4 + 2] = c.getZ(i); out[i * 4 + 3] = clamp01(alphaAt(v, i));
  }
  g.setAttribute('color', new T.BufferAttribute(out, 4));
  g.deleteAttribute('emis');
  g.deleteAttribute('normal');
  return g;
}

// A ring of standing stones with glowing runes and a slow violet vortex.
B['portal'] = (A) => {
  const { T, tint, accent } = A;
  const CY = 1.2, R = 0.92;
  const frame = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const r = A.rng('stones');
    const stone = A.c('stone'), light = A.c('stoneLight'), moss = A.c('moss');
    const paintStone = (lp, ln, c, wp, wn) => { c.copy(stone).lerp(light, clamp01(wp.y / 2.2) * 0.6); if (wn.y > 0.6) c.lerp(moss, 0.55); return 0; };
    mx.add(new T.CylinderGeometry(1.0, 1.08, 0.12, 12), { flat: true, m: M(T, 0, 0.06, 0), paint: paintStone, deform: (v) => { v.y += fbm(v.x * 3, 0, v.z * 3, 2) * 0.012; } });
    mx.add(new T.TorusGeometry(0.86, 0.012, 4, 64), { m: M(T, 0, 0.125, 0, Math.PI / 2, 0, 0), color: A.lite(accent, 0.2), emis: 0.9 });
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = Math.sin(a) * R, y = CY + Math.cos(a) * R;
      const w = 0.36 + r() * 0.06, h = 0.3 + r() * 0.08, d = 0.3;
      mx.add(new T.BoxGeometry(1, 1, 1, 1, 1, 1), {
        flat: true, m: M(T, x, y, 0, 0, 0, -a, w, h, d),
        deform: (v) => { v.x *= 1 + hash3(Math.sign(v.x), Math.sign(v.y), i, 4) * 0.12; v.y *= 1 + hash3(Math.sign(v.y), i, 2, 5) * 0.12; },
        paint: paintStone,
      });
      for (const side of [1, -1]) {
        mx.add(new T.BoxGeometry(0.03, 0.13 + r() * 0.05, 0.02), { m: M(T, x * 0.97, y * 1 + (CY - y) * 0.03, side * (d / 2 + 0.004), 0, 0, -a + (r() - 0.5) * 0.6), color: A.lite(i % 3 ? tint : accent, 0.35), emis: 1 });
      }
    }
    for (const sx of [-1, 1]) {
      mx.add(new T.BoxGeometry(0.34, 0.5, 0.36, 1, 2, 1), { flat: true, m: M(T, sx * 0.62, 0.36, 0, 0, 0, sx * 0.25), paint: paintStone, deform: (v) => { v.x *= 1 + hash3(Math.sign(v.x), Math.sign(v.y) + 3, sx, 8) * 0.1; } });
    }
    mx.add(new T.TorusGeometry(R - 0.17, 0.02, 6, 72), { m: M(T, 0, CY, 0), color: A.lite(tint, 0.35), emis: 1 });
    return mx.build();
  }), 'body', 'frame');
  const swirl = A.mesh(A.geo('swirl', () => {
    const mx = A.mix();
    mx.add(new T.CircleGeometry(R - 0.17, 48), {
      paint: (lp, ln, c) => { const u = clamp01(Math.hypot(lp.x, lp.y) / (R - 0.17)); c.copy(A.lite(tint, 0.55 * (1 - u))).lerp(accent, u * u * 0.35); return 0; },
    });
    const g = mx.build({ uv: true });
    return withAlpha(T, g, (p) => 0.95 - 0.2 * clamp01(Math.hypot(p.x, p.y) / (R - 0.17)));
  }), 'swirl', 'vortex');
  swirl.position.set(0, CY, 0);
  swirl.raycast = noop;
  A.body.add(frame, swirl);
  const f = A.field();
  f.add(0, CY, 0.02, 1.9, tint, 0.3, { pulse: 0.05, pw: 0.6 });
  f.add(0, CY, 0.05, 0.7, A.lite(tint, 0.5), 0.45, { pulse: 0.12, pw: 1.3 });
  for (let i = 0; i < 12; i++) {
    f.add(0, CY, 0.06, 0.04, i % 3 ? A.lite(tint, 0.4) : accent, 0.9, { t: 'spiral', r: R - 0.1, cy: CY, turns: 4 + (i % 3), speed: 0.12 + (i % 4) * 0.02 });
  }
  for (let i = 0; i < 6; i++) f.add(0, CY, 0, 0.05, A.lite(accent, 0.3), 0.8, { t: 'orbit', plane: 'xy', r: R + 0.05, cy: CY, speed: 0.15, bob: 0.1, tw: 0.5 });
  A.body.add(A.fieldMesh(f));
  return {
    anchor: 'ground', height: 2.25, footprint: 1.0, radius: 1.2,
    update(dt, t) {
      swirl.rotation.z -= dt * 0.35;
      const s = 1 + Math.sin(t * 0.6 + A.ph) * 0.02;
      swirl.scale.set(s, s, 1);
    },
  };
};

// Variant 0: an iron lamp post with a swaying lantern. Variant 1: a floating paper sky-lantern.
B['lantern'] = (A) => {
  const { T, tint, accent } = A;
  const metal = A.c('#3a3552'), metalL = A.c('#6a6296');
  if (A.variant === 1) {
    const bob = new T.Group();
    A.body.add(bob);
    const pts = [[0.001, -0.2], [0.07, -0.2], [0.14, -0.14], [0.17, -0.02], [0.16, 0.1], [0.11, 0.18], [0.06, 0.2], [0.001, 0.2]].map(([x, y]) => new T.Vector2(x, y));
    const shell = A.mesh(A.geo('paper', () => {
      const mx = A.mix();
      mx.add(new T.LatheGeometry(pts, 14), {
        paint: (lp, ln, c) => {
          const u = clamp01((lp.y + 0.2) / 0.4);
          const rib = 0.5 + 0.5 * Math.cos(Math.atan2(lp.z, lp.x) * 14);
          c.copy(A.lite(tint, 0.45 * (1 - u))).lerp(accent, u * 0.25);
          if (Math.abs(lp.y) > 0.185) { c.copy(metal); return 0; }
          return 0.62 + 0.3 * (1 - u) - rib * 0.06;
        },
      });
      mx.add(new T.CylinderGeometry(0.06, 0.07, 0.02, 10), { m: M(T, 0, -0.2, 0), color: metalL });
      mx.add(new T.CylinderGeometry(0.004, 0.004, 0.12, 4), { m: M(T, 0, -0.27, 0), color: A.lite(accent, 0.2), emis: 0.6 });
      return mx.build();
    }), 'body', 'paper-lantern');
    bob.add(shell);
    const f = A.field();
    f.add(0, -0.03, 0, 1.0, tint, 0.5, { pulse: 0.06, pw: 3.1 });
    f.add(0, -0.08, 0, 0.3, A.lite(tint, 0.6), 0.75, { pulse: 0.1, pw: 5.3 });
    for (let i = 0; i < 4; i++) f.add(0, -0.2, 0, 0.03, A.lite(tint, 0.4), 0.9, { t: 'fall', h: 0.5, speed: 0.18 + i * 0.05, spread: 0.05 });
    bob.add(A.fieldMesh(f));
    return {
      anchor: 'float', bottom: 0.3, height: 0.6, footprint: 0.2, radius: 0.35,
      update(dt, t) {
        bob.position.y = Math.sin(t * 0.7 + A.ph) * 0.06;
        bob.rotation.y += dt * 0.15;
        bob.rotation.z = Math.sin(t * 0.5 + A.ph) * 0.05;
      },
    };
  }
  const post = A.mesh(A.geo('post', () => {
    const mx = A.mix();
    mx.add(new T.CylinderGeometry(0.16, 0.2, 0.1, 8), { flat: true, m: M(T, 0, 0.05, 0), color: A.c('stone') });
    mx.add(new T.CylinderGeometry(0.1, 0.13, 0.14, 8), { flat: true, m: M(T, 0, 0.17, 0), color: metal });
    mx.add(new T.CylinderGeometry(0.032, 0.045, 1.56, 8), { m: M(T, 0, 1.0, 0), paint: (lp, ln, c) => { c.copy(metal).lerp(metalL, clamp01(lp.y + 0.5) * 0.5); return 0; } });
    for (const y of [0.45, 1.5]) mx.add(new T.TorusGeometry(0.05, 0.012, 5, 16), { m: M(T, 0, y, 0, Math.PI / 2, 0, 0), color: A.lite(tint, 0.2), emis: 0.55 });
    mx.add(new T.TorusGeometry(0.16, 0.02, 6, 18, Math.PI), { m: M(T, 0.16, 1.76, 0), color: metal });
    mx.add(new T.ConeGeometry(0.03, 0.1, 6), { m: M(T, 0, 1.83, 0), color: metalL });
    mx.add(new T.IcosahedronGeometry(0.028, 0), { flat: true, m: M(T, 0.32, 1.765, 0), color: metalL });
    return mx.build();
  }), 'body', 'post');
  const pivot = new T.Group();
  pivot.position.set(0.32, 1.74, 0);
  const lamp = A.mesh(A.geo('lamp', () => {
    const mx = A.mix();
    mx.add(new T.CylinderGeometry(0.005, 0.005, 0.08, 4), { m: M(T, 0, -0.04, 0), color: metal });
    mx.add(new T.ConeGeometry(0.105, 0.08, 6), { flat: true, m: M(T, 0, -0.11, 0), color: metal });
    mx.add(new T.CylinderGeometry(0.075, 0.075, 0.2, 6, 1, true), {
      flat: true, m: M(T, 0, -0.25, 0),
      paint: (lp, ln, c) => { const u = clamp01(0.5 - lp.y * 2.5); c.copy(A.lite(tint, 0.3 * u)); return 0.55 + 0.35 * u; },
    });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      mx.add(new T.BoxGeometry(0.012, 0.22, 0.012), { m: M(T, Math.sin(a) * 0.082, -0.25, Math.cos(a) * 0.082), color: metalL });
    }
    mx.add(new T.CylinderGeometry(0.085, 0.06, 0.035, 6), { flat: true, m: M(T, 0, -0.37, 0), color: metal });
    mx.add(new T.IcosahedronGeometry(0.045, 1), { flat: true, m: M(T, 0, -0.26, 0, 0, 0, 0, 1, 1.4, 1), color: A.lite(tint, 0.65), emis: 1 });
    return mx.build();
  }), 'body', 'lantern');
  pivot.add(lamp);
  const f = A.field();
  f.add(0, -0.25, 0, 1.15, tint, 0.55, { pulse: 0.05, pw: 2.7 });
  f.add(0, -0.26, 0, 0.4, A.lite(tint, 0.6), 0.9, { pulse: 0.09, pw: 4.9 });
  for (let i = 0; i < 3; i++) f.add(0, -0.25, 0, 0.025, i ? A.lite(accent, 0.3) : A.lite(tint, 0.5), 0.9, { t: 'orbit', r: 0.2 + i * 0.05, speed: 0.6 + i * 0.25, bob: 0.08, tw: 0.4 });
  pivot.add(A.fieldMesh(f));
  A.body.add(post, pivot);
  return {
    anchor: 'ground', height: 1.95, footprint: 0.3, radius: 1.0,
    update(dt, t) {
      pivot.rotation.z = Math.sin(t * 0.9 + A.ph) * 0.07;
      pivot.rotation.x = Math.sin(t * 0.67 + A.ph * 1.3) * 0.05;
    },
  };
};

// A bioluminescent tree: twisting trunk, glowing canopy blobs, hanging light-drops and fireflies.
B['tree-glow'] = (A) => {
  const { T, tint, accent } = A;
  const sway = new T.Group();
  A.body.add(sway);
  const r0 = A.rng('tree');
  const tall = A.variant === 1;
  const trunkPts = tall
    ? [[0, 0, 0], [0.06, 0.5, 0.03], [-0.05, 1.05, 0], [0.04, 1.55, -0.02], [0, 1.9, 0]]
    : [[0, 0, 0], [0.05, 0.45, 0.02], [-0.04, 0.95, 0], [0.03, 1.32, -0.02]];
  const top = trunkPts[trunkPts.length - 1];
  const canopy = [];
  {
    const r = A.rng('canopy');
    const cy = top[1] + (tall ? 0.15 : 0.35), n = tall ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + r() * 0.5, d = i === 0 ? 0 : 0.28 + r() * 0.2;
      const y = cy + (i === 0 ? 0.22 : (r() - 0.35) * (tall ? 0.7 : 0.35) - d * 0.3);
      canopy.push([Math.cos(a) * d, y, Math.sin(a) * d, 0.2 + r() * 0.13 + (i === 0 ? 0.08 : 0)]);
    }
  }
  const drops = [];
  {
    const r = A.rng('drops');
    for (let i = 0; i < 8; i++) {
      const c = canopy[1 + (i % (canopy.length - 1))];
      const len = 0.12 + r() * 0.28;
      drops.push({ x: c[0] * 1.15, y0: c[1] - c[3] * 0.6, len, z: c[2] * 1.15, acc: i % 3 !== 1 });
    }
  }
  const tree = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const bark = A.c('bark'), barkL = A.c('barkLight');
    const barkPaint = (lp, ln, c, wp) => {
      c.copy(bark).lerp(barkL, clamp01(wp.y / 2) * 0.7);
      const v = smooth(0.45, 0.7, fbm(wp.x * 7, wp.y * 5, wp.z * 7, 13));
      if (v > 0) { c.lerp(tint, v * 0.8); return v * 0.8; }
      return 0;
    };
    for (let i = 0; i < trunkPts.length - 1; i++) {
      const a = trunkPts[i], b = trunkPts[i + 1];
      const t0 = i / (trunkPts.length - 1), t1 = (i + 1) / (trunkPts.length - 1);
      const { m, len } = between(T, a, b);
      mx.add(new T.CylinderGeometry(lerp(0.13, 0.05, t1), lerp(0.13, 0.05, t0), len * 1.08, 8, 3), { m, paint: barkPaint });
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const { m, len } = between(T, [0, 0.12, 0], [Math.cos(a) * 0.3, -0.02, Math.sin(a) * 0.3]);
      mx.add(new T.CylinderGeometry(0.02, 0.06, len, 6), { m, paint: barkPaint });
    }
    const nb = tall ? 5 : 4;
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * TAU + r0() * 0.6, y = top[1] - 0.25 + r0() * 0.2, L = 0.35 + r0() * 0.2;
      const s = [top[0] * 0.8, y, top[2] * 0.8], e = [s[0] + Math.cos(a) * L, y + L * 0.75, s[2] + Math.sin(a) * L];
      const { m, len } = between(T, s, e);
      mx.add(new T.CylinderGeometry(0.018, 0.04, len, 6), { m, paint: barkPaint });
    }
    const ico = new T.IcosahedronGeometry(1, 1);
    const hi = A.lite(tint, 0.3), lo = A.dim(tint, 0.22), spk = A.lite(accent, 0.35);
    canopy.forEach(([x, y, z, s], i) => {
      mx.add(ico, {
        flat: true, m: M(T, x, y, z, 0, i, 0, s, s * 0.82, s),
        deform: (v) => v.multiplyScalar(1 + noise3(v.x * 2 + i, v.y * 2, v.z * 2, 21) * 0.14),
        paint: (lp, ln, c, wp) => {
          const u = clamp01(lp.y * 0.5 + 0.5);
          c.copy(lo).lerp(hi, u * u);
          const sp = smooth(0.42, 0.62, noise3(wp.x * 9, wp.y * 9, wp.z * 9, 23));
          if (sp > 0) { c.lerp(spk, sp); return 1; }
          return 0.25 + 0.6 * u * u;
        },
      });
    });
    for (const d of drops) {
      mx.add(new T.CylinderGeometry(0.004, 0.004, d.len, 3, 1, true), { m: M(T, d.x, d.y0 - d.len / 2, d.z), color: A.lite(tint, 0.2), emis: 0.5 });
      mx.add(new T.IcosahedronGeometry(0.032, 0), { flat: true, m: M(T, d.x, d.y0 - d.len, d.z, 0, 0, 0, 1, 1.35, 1), color: A.lite(d.acc ? accent : tint, 0.3), emis: 1 });
    }
    return mx.build();
  }), 'body', 'tree');
  sway.add(tree);
  const f = A.field();
  const fr = A.rng('field');
  f.add(0, canopy[0][1], 0, 1.6, tint, 0.3, { pulse: 0.05, pw: 0.5 });
  for (const d of drops) f.add(d.x, d.y0 - d.len, d.z, 0.15, A.lite(d.acc ? accent : tint, 0.2), 0.6, { pulse: 0.15, pw: 1 + fr(), tw: 0.3 });
  for (let i = 0; i < 9; i++) {
    const a = fr() * TAU, d = 0.35 + fr() * 0.55;
    f.add(Math.cos(a) * d, 0.4 + fr() * (top[1] + 0.2), Math.sin(a) * d, 0.035, i % 2 ? A.lite(accent, 0.3) : A.lite(tint, 0.5), 0.95, { t: 'drift', r: 0.22, w: 0.4 + fr() * 0.3, tw: 0.75, tws: 1.2 + fr() });
  }
  sway.add(A.fieldMesh(f));
  return {
    anchor: 'ground', height: canopy[0][1] + 0.4, footprint: 0.6, radius: 1.1,
    update(dt, t) {
      sway.rotation.z = Math.sin(t * 0.55 + A.ph) * 0.014;
      sway.rotation.x = Math.sin(t * 0.43 + A.ph * 1.7) * 0.01;
    },
  };
};

// A family of glowing mushrooms on a mossy mound, with rising spores.
B['mushroom-glow'] = (A) => {
  const { T, tint, accent } = A;
  const r = A.rng('shrooms');
  const n = 3 + A.variant;
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + r() * 0.8, d = i === 0 ? 0 : 0.14 + r() * 0.14;
    const h = i === 0 ? 0.55 + r() * 0.15 : 0.18 + r() * 0.28;
    list.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, h, cr: h * 0.42 + 0.03, lean: i === 0 ? 0 : 0.12 + r() * 0.2, a, acc: i % 3 === 1 });
  }
  const mesh = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    mx.add(new T.IcosahedronGeometry(1, 1), {
      flat: true, m: M(T, 0, -0.02, 0, 0, 0.4, 0, 0.42, 0.1, 0.36),
      deform: (v) => v.multiplyScalar(1 + fbm(v.x * 2, v.y, v.z * 2, 31) * 0.2),
      paint: (lp, ln, c, wp, wn) => { c.copy(A.c('stoneDark')).lerp(A.c('moss'), wn.y > 0.4 ? 0.8 : 0.2); return 0; },
    });
    for (const s of list) {
      const col = s.acc ? accent : tint;
      const topP = [s.x + Math.cos(s.a) * s.lean * s.h, s.h, s.z + Math.sin(s.a) * s.lean * s.h];
      const mid = [lerp(s.x, topP[0], 0.4), s.h * 0.5, lerp(s.z, topP[2], 0.4)];
      const stem = A.c('stem');
      for (const [a, b, r1, r2] of [[[s.x, 0, s.z], mid, s.h * 0.075 + 0.012, s.h * 0.06 + 0.01], [mid, topP, s.h * 0.06 + 0.01, s.h * 0.05 + 0.008]]) {
        const { m, len } = between(T, a, b);
        mx.add(new T.CylinderGeometry(r2, r1, len * 1.05, 8), { m, paint: (lp, ln, c, wp) => { c.copy(stem).lerp(col, 0.15); return 0.12 + 0.3 * clamp01(wp.y / s.h); } });
      }
      const tilt = new T.Quaternion().setFromAxisAngle(new T.Vector3(Math.sin(s.a), 0, -Math.cos(s.a)), -s.lean * 0.9);
      const capM = new T.Matrix4().compose(new T.Vector3(...topP), tilt, new T.Vector3(s.cr, s.cr * 0.6, s.cr));
      mx.add(new T.SphereGeometry(1, 16, 6, 0, TAU, 0, Math.PI / 2), {
        m: capM,
        deform: (v) => { v.y += Math.sin(Math.atan2(v.z, v.x) * 5) * 0.04 * (1 - v.y); },
        paint: (lp, ln, c) => { const u = clamp01(lp.y); c.copy(col).lerp(A.lite(col, 0.5), u * 0.6); return 0.5 + 0.35 * u; },
      });
      mx.add(new T.CircleGeometry(0.97, 16), {
        m: capM.clone().multiply(M(T, 0, 0.005, 0, Math.PI / 2, 0, 0)),
        paint: (lp, ln, c) => { const u = clamp01(Math.hypot(lp.x, lp.y)); c.copy(A.lite(col, 0.55)).lerp(A.dim(col, 0.4), 1 - u); return 0.35 + 0.6 * u; },
      });
      for (let k = 0; k < 5; k++) {
        const aa = k * 2.4 + s.a, rr = 0.35 + (k % 2) * 0.3;
        const p = new T.Vector3(Math.cos(aa) * rr, Math.sqrt(Math.max(0, 1 - rr * rr)) * 0.98, Math.sin(aa) * rr).applyMatrix4(capM);
        mx.add(new T.IcosahedronGeometry(s.cr * 0.1, 0), { flat: true, m: new T.Matrix4().compose(p, tilt, new T.Vector3(1, 0.5, 1)), color: A.lite(col, 0.7), emis: 1 });
      }
    }
    return mx.build();
  }), 'body', 'mushrooms');
  A.body.add(mesh);
  const f = A.field();
  const fr = A.rng('field');
  for (const s of list) {
    const col = s.acc ? accent : tint;
    const tx = s.x + Math.cos(s.a) * s.lean * s.h, tz = s.z + Math.sin(s.a) * s.lean * s.h;
    f.add(tx, s.h + s.cr * 0.1, tz, s.cr * 4.2, col, 0.34, { pulse: 0.08, pw: 0.8 + fr() * 0.5, pull: 0.12 });
    f.add(tx, s.h - 0.02, tz, s.cr * 1.6, A.lite(col, 0.4), 0.35, { pulse: 0.1, pw: 1.1 + fr(), pull: 0.1 });
    for (let k = 0; k < 2; k++) f.add(tx, s.h, tz, 0.028, A.lite(col, 0.5), 0.95, { t: 'rise', h: 0.55 + fr() * 0.3, speed: 0.1 + fr() * 0.08, spread: 0.07, tw: 0.3 });
  }
  A.body.add(A.fieldMesh(f));
  return { anchor: 'ground', height: list[0].h + 0.3, footprint: 0.42, radius: 0.55, update: noop };
};

// A mossy standing stone with glowing glyphs and three small rune tablets circling it.
B['rune-stone'] = (A) => {
  const { T, tint, accent } = A;
  const W = 0.62, H = 1.36, D = 0.3;
  const glyphY = [0.46, 0.74, 1.02];
  const stone = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const r = A.rng('glyphs');
    const st = A.c('stone'), lt = A.c('stoneLight'), dk = A.c('stoneDark'), moss = A.c('moss');
    mx.add(new T.BoxGeometry(1, 1, 1, 3, 6, 2), {
      flat: true, m: M(T, 0, H / 2 - 0.05, 0),
      deform: (v) => {
        const u = v.y + 0.5;
        v.x *= W * (1 - 0.22 * u); v.z *= D * (1 - 0.12 * u);
        v.y = v.y * H - Math.pow(Math.abs(v.x) / (W * 0.4), 2) * 0.08 * u;
        const n = fbm(v.x * 5, v.y * 4, v.z * 5, 41) * 0.03;
        v.x += n; v.z += n * (v.z > 0 ? 0.25 : 1); v.y += n * 0.5;
      },
      paint: (lp, ln, c, wp, wn) => {
        c.copy(dk).lerp(st, clamp01(wp.y / 0.6)).lerp(lt, clamp01((wp.y - 0.6) / 0.8) * 0.6);
        const mm = fbm(wp.x * 6, wp.y * 6, wp.z * 6, 43);
        if (wn.y > 0.5 || (wp.y < 0.3 && mm > -0.1) || mm > 0.45) c.lerp(moss, 0.65);
        return 0;
      },
    });
    const glyphCol = A.lite(tint, 0.4);
    const faceZ = (y) => (D / 2) * (1 - 0.12 * clamp01((y + 0.05) / H));
    for (const gy of glyphY) {
      const strokes = 3 + Math.floor(r() * 3);
      for (let k = 0; k < strokes; k++) {
        const ang = [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4][Math.floor(r() * 4)];
        const len = 0.09 + r() * 0.1;
        mx.add(new T.BoxGeometry(0.03, len, 0.024), { m: M(T, (r() - 0.5) * 0.12, gy + (r() - 0.5) * 0.1, faceZ(gy) + 0.006, 0, 0, ang), color: glyphCol, emis: 1 });
      }
      mx.add(new T.IcosahedronGeometry(0.014, 0), { m: M(T, 0, gy + 0.14, faceZ(gy + 0.14) + 0.008), color: A.lite(accent, 0.3), emis: 1 });
    }
    for (let i = 0; i < 5; i++) {
      const a = r() * TAU, d = 0.36 + r() * 0.12, s = 0.04 + r() * 0.05;
      mx.add(new T.IcosahedronGeometry(1, 0), { flat: true, m: M(T, Math.cos(a) * d, s * 0.4, Math.sin(a) * d, r(), r(), r(), s, s * 0.7, s), color: i === 2 ? A.lite(accent, 0.2) : st, emis: i === 2 ? 0.8 : 0 });
    }
    return mx.build();
  }), 'body', 'stone');
  const orbit = A.mesh(A.geo('tablets', () => {
    const mx = A.mix();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU, y = 0.95 + (i - 1) * 0.12;
      const m = new T.Matrix4().compose(new T.Vector3(Math.sin(a) * 0.5, y, Math.cos(a) * 0.5), new T.Quaternion().setFromEuler(new T.Euler(0.1, a, 0.15 * (i - 1))), new T.Vector3(1, 1, 1));
      mx.add(new T.BoxGeometry(0.11, 0.15, 0.018), { flat: true, m, color: A.c('stoneLight') });
      mx.add(new T.BoxGeometry(0.018, 0.1, 0.006), { m: m.clone().multiply(M(T, 0, 0, 0.011)), color: A.lite(tint, 0.4), emis: 1 });
      mx.add(new T.BoxGeometry(0.06, 0.016, 0.006), { m: m.clone().multiply(M(T, 0, 0.026, 0.011)), color: A.lite(tint, 0.4), emis: 1 });
    }
    return mx.build();
  }), 'body', 'tablets');
  A.body.add(stone, orbit);
  const f = A.field();
  f.add(0, 0.74, D / 2 + 0.1, 1.0, tint, 0.36, { pulse: 0.1, pw: 0.7 });
  for (const gy of glyphY) f.add(0, gy, D / 2 + 0.03, 0.28, A.lite(tint, 0.3), 0.4, { pulse: 0.15, pw: 0.9 + gy });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    f.add(0, 0.95 + (i - 1) * 0.12, 0, 0.3, A.lite(tint, 0.3), 0.55, { t: 'orbit', r: 0.53, a0: a + A.ph, sync: true, speed: 0.3, bob: 0 });
  }
  const fr = A.rng('field');
  for (let i = 0; i < 5; i++) f.add((fr() - 0.5) * 0.8, 0.1, (fr() - 0.5) * 0.6, 0.03, A.lite(accent, 0.3), 0.9, { t: 'rise', h: 1.5, speed: 0.06 + fr() * 0.05, spread: 0.1, tw: 0.4 });
  A.body.add(A.fieldMesh(f));
  return {
    anchor: 'ground', height: H + 0.1, footprint: 0.45, radius: 0.8,
    update(dt, t) { orbit.rotation.y = A.ph + t * 0.3; },
  };
};

// A glass orb around a bright core, circled by two thin rings.
B['orb'] = (A) => {
  const { T, tint, accent } = A;
  const bob = new T.Group();
  A.body.add(bob);
  const core = A.mesh(A.geo('core', () => {
    const mx = A.mix();
    mx.add(new T.IcosahedronGeometry(0.12, 2), { flat: true, paint: (lp, ln, c) => { c.copy(A.lite(tint, 0.55)); return 1; } });
    const beads = new T.IcosahedronGeometry(0.018, 0);
    for (const [rx, rz, col] of [[1.2, 0.4, accent], [-0.75, -0.9, tint]]) {
      const rm = M(T, 0, 0, 0, rx, 0, rz);
      mx.add(new T.TorusGeometry(0.34, 0.006, 4, 72), { m: rm, color: A.lite(col, 0.3), emis: 0.9 });
      for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU; mx.add(beads, { m: rm.clone().multiply(M(T, Math.cos(a) * 0.34, Math.sin(a) * 0.34, 0)), color: A.lite(col, 0.5), emis: 1 }); }
    }
    return mx.build();
  }), 'body', 'core');
  const shell = A.mesh(A.geo('shell', () => {
    const mx = A.mix();
    mx.add(new T.SphereGeometry(0.24, 24, 16), { paint: (lp, ln, c) => { c.copy(A.lite(tint, 0.3)); return 0.1; } });
    return mx.build();
  }), 'glass', 'shell');
  bob.add(core, shell);
  const f = A.field();
  f.add(0, 0, 0, 1.25, tint, 0.34, { pulse: 0.07, pw: 1.0, pull: 0.12 });
  f.add(0, 0, 0, 0.36, A.lite(tint, 0.5), 0.6, { pulse: 0.1, pw: 1.9, pull: 0 });
  for (let i = 0; i < 6; i++) f.add(0, (i - 2.5) * 0.05, 0, 0.03, i % 2 ? accent : A.lite(tint, 0.4), 0.9, { t: 'orbit', r: 0.42 + (i % 3) * 0.05, speed: 0.4 + i * 0.07, bob: 0.06, tw: 0.4 });
  bob.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.4, height: 0.8, footprint: 0.3, radius: 0.5,
    update(dt, t) {
      core.rotation.y += dt * 0.5;
      core.rotation.x = Math.sin(t * 0.3 + A.ph) * 0.35;
      bob.position.y = Math.sin(t * 0.9 + A.ph) * 0.04;
    },
  };
};

// A small ringed planet with a soft atmosphere and a tiny moon.
B['planet'] = (A) => {
  const { T, tint, accent } = A;
  const tilt = new T.Group();
  tilt.rotation.set(0.12, 0, 0.38);
  A.body.add(tilt);
  const spin = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const dark = A.dim(tint, 0.45), light = A.lite(tint, 0.3), pale = A.lite(accent, 0.2);
    mx.add(new T.SphereGeometry(0.42, 36, 22), {
      paint: (lp, ln, c) => {
        const lat = lp.y / 0.42;
        const w = fbm(lp.x * 5, lp.y * 3, lp.z * 5, 51);
        const band = 0.5 + 0.5 * Math.sin(lat * 10 + w * 2.2);
        c.copy(dark).lerp(light, band);
        if (band > 0.85) c.lerp(pale, (band - 0.85) * 3);
        const pole = smooth(0.72, 0.95, Math.abs(lat));
        if (pole > 0) { c.lerp(A.lite(accent, 0.3), pole * 0.7); return pole * 0.55; }
        return 0.04;
      },
    });
    const ringIn = 0.58, ringOut = 0.95;
    mx.add(new T.RingGeometry(ringIn, ringOut, 72, 4), {
      double: true, m: M(T, 0, 0, 0, -Math.PI / 2, 0, 0),
      paint: (lp, ln, c) => {
        const u = (Math.hypot(lp.x, lp.y) - ringIn) / (ringOut - ringIn);
        const b = 0.5 + 0.5 * Math.sin(u * 23) * Math.sin(u * 7 + 1);
        c.copy(A.dim(accent, 0.35)).lerp(A.lite(accent, 0.25), b);
        if (u > 0.55 && u < 0.6) c.multiplyScalar(0.25);
        return 0.22 + 0.25 * b;
      },
    });
    return mx.build();
  }), 'body', 'planet');
  const atmo = A.mesh(A.geo('atmo', () => {
    const mx = A.mix();
    mx.add(new T.SphereGeometry(0.455, 28, 18), { color: A.lite(tint, 0.35), emis: 0.06 });
    return mx.build();
  }), 'glass', 'atmosphere');
  atmo.raycast = noop;
  tilt.add(spin, atmo);
  const moonOrbit = new T.Group();
  const moon = A.mesh(A.geo('moon', () => {
    const mx = A.mix();
    mx.add(new T.IcosahedronGeometry(0.06, 1), { flat: true, m: M(T, 0, 0.08, 1.12), color: A.c('pale'), emis: 0.15 });
    return mx.build();
  }, false), 'body', 'moonlet');
  moonOrbit.add(moon);
  A.body.add(moonOrbit);
  const f = A.field();
  f.add(0, 0, 0, 1.9, tint, 0.3, { pulse: 0.04, pw: 0.5, pull: 0 });
  for (let i = 0; i < 7; i++) f.add(0, 0, 0, 0.03, A.lite(accent, 0.4), 0.8, { t: 'orbit', r: 0.62 + i * 0.045, speed: 0.12 + (i % 3) * 0.04, bob: 0.004, tw: 0.6 });
  tilt.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.52, height: 1.1, footprint: 0.5, radius: 1.1,
    update(dt, t) {
      spin.rotation.y += dt * 0.1;
      moonOrbit.rotation.y = A.ph + t * 0.3;
      A.body.position.y = Math.sin(t * 0.4 + A.ph) * 0.04;
    },
  };
};

// A pale cratered moon with a soft glow.
B['moon'] = (A) => {
  const { T, tint, accent } = A;
  const craters = [];
  {
    const r = A.rng('craters');
    for (let i = 0; i < 16; i++) {
      const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z);
      craters.push({ d: new T.Vector3(Math.cos(a) * s, z, Math.sin(a) * s), r: 0.12 + r() * r() * 0.3 });
    }
  }
  const R = 0.34;
  const moon = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const base = tint, dark = A.dim(tint, 0.35).lerp(A.c('stone'), 0.45);
    const dn = new T.Vector3();
    const craterAt = (v) => {
      dn.copy(v).normalize();
      let h = 0, floor = 0;
      for (const c of craters) {
        const d = Math.acos(clamp(dn.dot(c.d), -1, 1)) / c.r;
        if (d < 1) { h -= 0.07 * c.r * (1 - d * d); floor = Math.max(floor, 1 - d * d); }
        h += 0.035 * c.r * Math.exp(-Math.pow((d - 1) / 0.2, 2));
      }
      return { h, floor };
    };
    mx.add(new T.SphereGeometry(R, 40, 26), {
      deform: (v) => { const { h } = craterAt(v); v.multiplyScalar(1 + (h + fbm(v.x * 20, v.y * 20, v.z * 20, 61) * 0.004) / R); },
      paint: (lp, ln, c) => {
        const { floor } = craterAt(lp);
        const maria = smooth(0.05, 0.5, fbm(lp.x * 4, lp.y * 4, lp.z * 4, 63));
        c.copy(base).lerp(dark, clamp01(maria * 0.75 + floor * 0.45));
        return 0.1 + 0.08 * (1 - maria);
      },
    });
    return mx.build();
  }), 'body', 'moon');
  A.body.add(moon);
  const f = A.field();
  f.add(0, 0, 0, 1.6, A.lite(tint, 0.1), 0.34, { pulse: 0.04, pw: 0.4, pull: 0 });
  f.add(0, 0, 0, 1.0, A.lite(accent, 0.3), 0.3, { pulse: 0.06, pw: 0.7, pull: 0 });
  const fr = A.rng('field');
  for (let i = 0; i < 5; i++) f.add((fr() - 0.5) * 1, (fr() - 0.5) * 0.9, (fr() - 0.5) * 1, 0.025, A.lite(accent, 0.4), 0.8, { t: 'drift', r: 0.1, w: 0.3, tw: 0.7 });
  A.body.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.36, height: 0.72, footprint: 0.35, radius: 0.5,
    update(dt, t) {
      moon.rotation.y += dt * 0.05;
      A.body.position.y = Math.sin(t * 0.35 + A.ph) * 0.03;
    },
  };
};

// A small, sleek craft hovering on two soft engines. The nose points +x (you see its profile by default).
B['spaceship'] = (A) => {
  const { T, tint, accent } = A;
  const hover = new T.Group();
  A.body.add(hover);
  const hull = A.mesh(A.geo('hull', () => {
    const mx = A.mix();
    const hullC = A.c('hull'), dark = A.c('hullDark'), silver = A.c('silver');
    const prof = [[0.001, 0], [0.1, 0.02], [0.16, 0.18], [0.18, 0.5], [0.16, 0.85], [0.11, 1.1], [0.05, 1.3], [0.001, 1.42]].map(([x, y]) => new T.Vector2(x, y));
    mx.add(new T.LatheGeometry(prof, 14), {
      m: M(T, -0.71, 0, 0, 0, 0, -Math.PI / 2, 1, 1, 1).premultiply(M(T, 0, 0, 0, 0, 0, 0, 1, 0.72, 1)),
      paint: (lp, ln, c, wp, wn) => {
        c.copy(dark).lerp(hullC, clamp01(wn.y * 0.6 + 0.6)).lerp(silver, smooth(0.6, 1, wn.y) * 0.5);
        if (Math.abs(wn.y) < 0.2 && wp.x > -0.45 && wp.x < 0.45) { c.copy(A.lite(tint, 0.3)); return 0.85; }
        return 0;
      },
    });
    const wing = (side) => {
      const g = new T.BoxGeometry(1, 1, 1, 2, 1, 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), t = z + 0.5;
        const x0 = lerp(-0.36, -0.46, t), x1 = lerp(0.22, -0.24, t);
        p.setXYZ(i, lerp(x0, x1, x + 0.5), y * lerp(0.035, 0.018, t) + t * 0.06 - 0.03, lerp(0.1, 0.7, t));
      }
      g.computeVertexNormals();
      mx.add(g, {
        flat: true, m: M(T, 0, 0, 0, 0, 0, 0, 1, 1, side),
        paint: (lp, ln, c) => { const t = lp.z; c.copy(hullC).lerp(dark, t * 0.5); if (t > 0.62) { c.copy(A.lite(side > 0 ? tint : accent, 0.2)); return 0.8; } return 0; },
      });
      mx.add(new T.IcosahedronGeometry(0.024, 0), { m: M(T, -0.36, 0.035, side * 0.72), color: A.lite(side > 0 ? tint : accent, 0.4), emis: 1 });
    };
    wing(1); wing(-1);
    const fin = new T.BoxGeometry(1, 1, 1);
    {
      const p = fin.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i) + 0.5, z = p.getZ(i);
        p.setXYZ(i, lerp(lerp(-0.62, -0.3, x + 0.5), lerp(-0.66, -0.52, x + 0.5), y), 0.08 + y * 0.26, z * lerp(0.03, 0.012, y));
      }
      fin.computeVertexNormals();
    }
    mx.add(fin, { flat: true, paint: (lp, ln, c, wp) => { c.copy(hullC).lerp(A.lite(accent, 0.2), smooth(0.28, 0.34, wp.y)); return smooth(0.28, 0.34, wp.y) * 0.9; } });
    for (const side of [1, -1]) {
      mx.add(new T.CylinderGeometry(0.06, 0.075, 0.44, 12), { m: M(T, -0.43, -0.03, side * 0.25, 0, 0, Math.PI / 2), paint: (lp, ln, c, wp, wn) => { c.copy(dark).lerp(hullC, clamp01(wn.y * 0.5 + 0.5)); return 0; } });
      mx.add(new T.TorusGeometry(0.066, 0.012, 6, 20), { m: M(T, -0.655, -0.03, side * 0.25, 0, Math.PI / 2, 0), color: A.lite(tint, 0.3), emis: 1 });
      mx.add(new T.CircleGeometry(0.058, 16), { m: M(T, -0.652, -0.03, side * 0.25, 0, -Math.PI / 2, 0), color: A.lite(tint, 0.7), emis: 1 });
    }
    for (let i = 0; i < 3; i++) mx.add(new T.IcosahedronGeometry(0.014, 0), { m: M(T, -0.15 + i * 0.18, -0.13, 0), color: A.lite(accent, 0.4), emis: 1 });
    return mx.build();
  }), 'body', 'hull');
  const canopy = A.mesh(A.geo('canopy', () => {
    const mx = A.mix();
    mx.add(new T.SphereGeometry(1, 20, 12), { m: M(T, 0.28, 0.09, 0, 0, 0, -0.12, 0.27, 0.1, 0.12), paint: (lp, ln, c) => { c.copy(A.lite(tint, 0.2)); return 0.25; } });
    return mx.build();
  }), 'glass', 'canopy');
  hover.add(hull, canopy);
  const f = A.field();
  for (const side of [1, -1]) {
    f.add(-0.68, -0.03, side * 0.25, 0.4, A.lite(tint, 0.3), 0.75, { pulse: 0.12, pw: 5.5 });
    f.add(-0.75, -0.03, side * 0.25, 0.9, tint, 0.22, { pulse: 0.08, pw: 3.1 });
    for (let i = 0; i < 6; i++) f.add(-0.68, -0.03, side * 0.25, 0.05, A.lite(tint, 0.5), 0.9, { t: 'stream', dx: -0.9, dy: 0, dz: side * 0.04, speed: 0.9 + i * 0.08 });
    f.add(-0.36, 0.035, side * 0.72, 0.13, A.lite(side > 0 ? tint : accent, 0.3), 0.7, { tw: 0.8, tws: 3.2, ph: side > 0 ? 0 : Math.PI });
  }
  f.add(0, -0.18, 0, 1.1, tint, 0.22, { pulse: 0.05, pw: 0.9 });
  hover.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.3, height: 0.7, footprint: 0.7, radius: 0.9,
    update(dt, t) {
      hover.position.y = Math.sin(t * 0.9 + A.ph) * 0.05;
      hover.rotation.x = Math.sin(t * 0.6 + A.ph) * 0.05;
      hover.rotation.z = Math.sin(t * 0.45 + A.ph * 1.3) * 0.03;
    },
  };
};

// A dark tapering obelisk with glowing bands and inscriptions, and a crystal capstone floating above it.
B['obelisk'] = (A) => {
  const { T, tint, accent } = A;
  const Y0 = 0.26, SH = 2.0, rb = 0.22, rt = 0.15;
  const body = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const r = A.rng('marks');
    const dk = A.c('stoneDark'), st = A.c('stone');
    mx.add(new T.BoxGeometry(0.9, 0.12, 0.9), { flat: true, m: M(T, 0, 0.06, 0), color: dk });
    mx.add(new T.BoxGeometry(0.66, 0.14, 0.66), { flat: true, m: M(T, 0, 0.19, 0), color: st });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      mx.add(new T.BoxGeometry(0.64, 0.012, 0.012), { m: M(T, Math.sin(a) * 0.327, 0.262, Math.cos(a) * 0.327, 0, a, 0), color: A.lite(tint, 0.3), emis: 0.9 });
    }
    const rows = 16, bands = new Set([3, 7, 11]);
    mx.add(new T.CylinderGeometry(rt, rb, SH, 4, rows, true), {
      flat: true, m: M(T, 0, Y0 + SH / 2, 0, 0, Math.PI / 4, 0),
      paint: (lp, ln, c) => {
        const row = Math.round((lp.y / SH + 0.5) * rows);
        c.copy(dk).lerp(st, clamp01(lp.y / SH + 0.5) * 0.6);
        if (bands.has(row)) { c.copy(A.lite(tint, 0.35)); return 0.95; }
        return 0;
      },
    });
    const faceOff = (v) => lerp(rb, rt, v) * Math.SQRT1_2 + 0.004;
    for (const [sx, sz, rot] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
      for (let k = 0; k < 11; k++) {
        const v = 0.08 + k * 0.078 + r() * 0.02;
        if ([3, 7, 11].some((b) => Math.abs(v * 16 - b) < 0.7)) continue;
        const o = faceOff(v), w = 0.03 + r() * 0.05;
        mx.add(new T.BoxGeometry(w, 0.022 + r() * 0.02, 0.01), { m: M(T, sx * o + (sz ? (r() - 0.5) * 0.05 : 0), Y0 + v * SH, sz * o + (sx ? (r() - 0.5) * 0.05 : 0), 0, rot, 0), color: A.lite(k % 4 === 0 ? accent : tint, 0.4), emis: 1 });
      }
    }
    mx.add(new T.ConeGeometry(rt, 0.24, 4), { flat: true, m: M(T, 0, Y0 + SH + 0.12, 0, 0, Math.PI / 4, 0), paint: (lp, ln, c) => { c.copy(A.lite(tint, 0.4)); return 0.9; } });
    return mx.build();
  }), 'body', 'obelisk');
  const cap = new T.Group();
  cap.position.y = 2.78;
  const gem = A.mesh(A.geo('cap', () => {
    const mx = A.mix();
    mx.add(new T.OctahedronGeometry(1), { flat: true, m: M(T, 0, 0, 0, 0, 0, 0, 0.12, 0.22, 0.12), paint: (lp, ln, c) => { c.copy(tint).lerp(WHITE(T), 0.35 + 0.35 * lp.y); return 0.85; } });
    for (let i = 0; i < 2; i++) mx.add(new T.OctahedronGeometry(1), { flat: true, m: M(T, i ? 0.24 : -0.24, i ? 0.06 : -0.05, 0, 0, 0, 0, 0.03, 0.06, 0.03), color: A.lite(accent, 0.3), emis: 1 });
    return mx.build();
  }), 'body', 'capstone');
  cap.add(gem);
  const f = A.field();
  f.add(0, 0, 0, 1.1, tint, 0.45, { pulse: 0.08, pw: 0.9 });
  f.add(0, 0, 0, 0.4, A.lite(tint, 0.5), 0.8, { pulse: 0.12, pw: 1.6 });
  const fr = A.rng('field');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    f.add(Math.sin(a) * 0.3, -2.6 + fr() * 0.3, Math.cos(a) * 0.3, 0.03, i % 2 ? A.lite(accent, 0.3) : A.lite(tint, 0.4), 0.9, { t: 'rise', h: 2.5, speed: 0.05 + fr() * 0.04, spread: 0.08, tw: 0.3 });
  }
  cap.add(A.fieldMesh(f));
  A.body.add(body, cap);
  return {
    anchor: 'ground', height: 3.0, footprint: 0.5, radius: 1.5,
    update(dt, t) {
      gem.rotation.y += dt * 0.4;
      cap.position.y = 2.78 + Math.sin(t * 0.8 + A.ph) * 0.05;
    },
  };
};

// A rock outcrop that pours a curtain of light into a glowing pool.
B['waterfall-light'] = (A) => {
  const { T, tint, accent } = A;
  const LIP = 1.95;
  const rocks = A.mesh(A.geo('body', () => {
    const mx = A.mix();
    const r = A.rng('rocks');
    const st = A.c('stone'), dk = A.c('stoneDark'), moss = A.c('moss');
    const rock = (x, y, z, sx, sy, sz, seed) => mx.add(new T.IcosahedronGeometry(1, 1), {
      flat: true, m: M(T, x, y, z, 0, seed, 0, sx, sy, sz),
      deform: (v) => v.multiplyScalar(1 + fbm(v.x * 2 + seed, v.y * 2, v.z * 2, 71) * 0.2),
      paint: (lp, ln, c, wp, wn) => {
        c.copy(dk).lerp(st, clamp01(wp.y / 1.5) * 0.8);
        if (wn.y > 0.35) c.lerp(moss, 0.75);
        const vein = smooth(0.4, 0.65, fbm(wp.x * 5, wp.y * 5, wp.z * 5, 73));
        if (vein > 0) { c.lerp(A.lite(tint, 0.2), vein); return vein * 0.9; }
        return 0;
      },
    });
    rock(0, 1.0, -0.42, 0.62, 1.05, 0.34, 1);
    rock(-0.5, 0.55, -0.3, 0.36, 0.6, 0.34, 2);
    rock(0.52, 0.65, -0.32, 0.36, 0.72, 0.32, 3);
    rock(0, LIP - 0.02, -0.14, 0.44, 0.13, 0.3, 4);
    rock(-0.3, 1.55, -0.3, 0.3, 0.4, 0.3, 5);
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * (0.02 + (i / 7) * 0.96), d = 0.55 + r() * 0.06, s = 0.1 + r() * 0.07;
      rock(Math.cos(a) * d, s * 0.35, 0.22 + Math.sin(a) * d * 0.75, s * 1.3, s * 0.8, s, 10 + i);
    }
    mx.add(new T.CircleGeometry(0.5, 28), {
      m: M(T, 0, 0.035, 0.28, -Math.PI / 2, 0, 0, 1, 0.8, 1),
      paint: (lp, ln, c) => { const u = clamp01(Math.hypot(lp.x, lp.y) / 0.5); c.copy(A.lite(tint, 0.45 * (1 - u))).lerp(accent, u * 0.25); return 0.95 - 0.35 * u; },
    });
    return mx.build();
  }), 'body', 'rocks');
  const curtain = A.mesh(A.geo('curtain', () => {
    const mx = A.mix();
    const sheet = (w, zoff, vscale, colr) => {
      const g = new T.PlaneGeometry(w, LIP, 1, 12);
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i) + LIP / 2, v = clamp01(y / LIP);
        p.setXYZ(i, p.getX(i) * (0.8 + 0.25 * (1 - v)), y, 0.02 + zoff + 0.2 * Math.pow(1 - v, 1.6));
        uv.setY(i, uv.getY(i) * vscale);
      }
      mx.add(g, { color: colr });
    };
    sheet(0.46, 0, 1.4, A.lite(tint, 0.3));
    sheet(0.3, 0.025, 2.3, A.lite(tint, 0.6));
    const g = mx.build({ uv: true });
    return withAlpha(T, g, (p) => smooth(LIP, LIP - 0.12, p.y) * (0.55 + 0.45 * smooth(0, 0.4, p.y)));
  }), 'curtain', 'lightfall');
  curtain.raycast = noop;
  A.body.add(rocks, curtain);
  const f = A.field();
  const fr = A.rng('field');
  f.add(0, 0.12, 0.26, 1.0, tint, 0.5, { pulse: 0.1, pw: 1.3 });
  f.add(0, LIP, 0.05, 0.55, A.lite(tint, 0.4), 0.3, { pulse: 0.08 });
  f.add(0, 1.0, 0.1, 1.7, tint, 0.14, { pulse: 0.05, pw: 0.6 });
  for (let i = 0; i < 8; i++) f.add((fr() - 0.5) * 0.5, 0.08, 0.25 + (fr() - 0.5) * 0.3, 0.035, i % 3 ? A.lite(tint, 0.5) : accent, 0.85, { t: 'rise', h: 0.7, speed: 0.12 + fr() * 0.1, spread: 0.12, tw: 0.3 });
  for (let i = 0; i < 6; i++) f.add((fr() - 0.5) * 0.35, LIP - 0.05, 0.08, 0.03, A.lite(tint, 0.7), 0.9, { t: 'fall', h: 1.7, speed: 0.3 + fr() * 0.2, spread: 0.02 });
  A.body.add(A.fieldMesh(f));
  return {
    anchor: 'ground', height: 2.15, footprint: 0.75, radius: 1.1,
    update(dt, t) { A.k.tex.streak.offset.y = (t * 0.45) % 1; },
  };
};
// A loose swarm of glowing butterflies (instanced wings) fluttering around a point.
B['butterfly-swarm'] = (A) => {
  const { T, tint, accent } = A;
  const n = A.variant === 1 ? 16 : 11;
  const wingGeo = A.geo('wing', () => {
    const mx = A.mix();
    const g = new T.BufferGeometry();
    // fore wing + hind wing as fans from the root (x = span, z = forward)
    const fore = [[0, 0.01], [0.05, 0.075], [0.11, 0.085], [0.13, 0.04], [0.09, 0.0], [0, -0.005]];
    const hind = [[0, -0.005], [0.07, -0.01], [0.09, -0.05], [0.055, -0.085], [0.015, -0.05]];
    const P = [];
    for (const poly of [fore, hind]) for (let i = 1; i < poly.length - 1; i++) P.push(poly[0][0], 0, poly[0][1], poly[i + 1][0], 0, poly[i + 1][1], poly[i][0], 0, poly[i][1]);
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3));
    g.computeVertexNormals();
    mx.add(g, {
      double: true,
      paint: (lp, ln, c) => { const u = clamp01(Math.hypot(lp.x, lp.z) / 0.13); c.copy(A.lite(tint, 0.6 * (1 - u))).lerp(accent, smooth(0.65, 1, u) * 0.8); return 0.75 + 0.25 * (1 - u); },
    });
    return mx.build();
  });
  const wings = new T.InstancedMesh(wingGeo, A.k.mats.body, n * 2);
  wings.name = 'wings';
  wings.frustumCulled = false;
  wings.instanceMatrix.setUsage(T.DynamicDrawUsage);
  A.owned.push({ dispose: () => wings.dispose() });
  A.body.add(wings);
  const r = A.rng('flight');
  const bugs = [];
  for (let i = 0; i < n; i++) {
    bugs.push({ cx: (r() - 0.5) * 0.5, cy: (r() - 0.5) * 0.35, cz: (r() - 0.5) * 0.5, rx: 0.18 + r() * 0.2, ry: 0.06 + r() * 0.1, w: 0.35 + r() * 0.35, ph: r() * TAU, fl: 7 + r() * 3, s: 0.8 + r() * 0.5 });
  }
  const f = A.field();
  f.add(0, 0, 0, 1.5, tint, 0.2, { pulse: 0.05, pw: 0.6 });
  const halo = bugs.map((b, i) => f.add(0, 0, 0, 0.22, i % 3 ? A.lite(tint, 0.3) : accent, 0.75, { t: 'ext', tw: 0.4, tws: 1.5 }));
  A.body.add(A.fieldMesh(f));
  const mBug = new T.Matrix4(), mWing = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), pos = new T.Vector3(), sc = new T.Vector3();
  const place = (t) => {
    for (let i = 0; i < n; i++) {
      const b = bugs[i], a = t * b.w + b.ph + A.ph;
      const x = b.cx + Math.sin(a) * b.rx, y = b.cy + Math.sin(a * 1.7 + b.ph) * b.ry, z = b.cz + Math.cos(a * 0.8) * b.rx;
      const vx = Math.cos(a) * b.rx, vz = -Math.sin(a * 0.8) * 0.8 * b.rx;
      const yaw = Math.atan2(vx, vz);
      const flap = Math.sin(t * b.fl + b.ph) * 0.95 + 0.25;
      pos.set(x, y, z); e.set(-0.15, yaw, 0); q.setFromEuler(e); sc.setScalar(b.s);
      mBug.compose(pos, q, sc);
      for (const side of [1, -1]) {
        e.set(0, 0, side * flap); q.setFromEuler(e);
        mWing.compose(pos.set(0, 0, 0), q, sc.set(side, 1, 1));
        wings.setMatrixAt(i * 2 + (side > 0 ? 0 : 1), mWing.premultiply(mBug));
        pos.set(x, y, z); sc.setScalar(b.s);
      }
      f.setPos(halo[i], x, y, z);
    }
    wings.instanceMatrix.needsUpdate = true;
  };
  place(0);
  return {
    anchor: 'float', bottom: 0.5, height: 1.0, footprint: 0.5, radius: 0.8,
    update(dt, t) { place(t); },
  };
};

// A small floating light: a bright core inside a soft glass flame, trailing motes. Also the fallback archetype.
B['wisp'] = (A) => {
  const { T, tint, accent } = A;
  const drift = new T.Group();
  A.body.add(drift);
  const core = A.mesh(A.geo('core', () => {
    const mx = A.mix();
    mx.add(new T.IcosahedronGeometry(0.055, 2), { color: A.lite(tint, 0.7), emis: 1 });
    return mx.build();
  }), 'body', 'core');
  const flame = A.mesh(A.geo('flame', () => {
    const mx = A.mix();
    const pts = [[0.001, -0.1], [0.06, -0.08], [0.085, -0.02], [0.07, 0.05], [0.04, 0.12], [0.001, 0.2]].map(([x, y]) => new T.Vector2(x, y));
    mx.add(new T.LatheGeometry(pts, 16), { paint: (lp, ln, c) => { const u = clamp01((lp.y + 0.1) / 0.3); c.copy(A.lite(tint, 0.3)).lerp(accent, u * 0.5); return 0.3 + 0.2 * (1 - u); } });
    return mx.build();
  }), 'glass', 'flame');
  drift.add(core, flame);
  const f = A.field();
  f.add(0, 0.01, 0, 0.95, tint, 0.5, { pulse: 0.08, pw: 1.4 });
  f.add(0, 0, 0, 0.3, A.lite(tint, 0.6), 0.85, { pulse: 0.12, pw: 2.3 });
  for (let i = 0; i < 7; i++) f.add(0, (i - 3) * 0.03, 0, 0.025 + (i % 3) * 0.008, i % 2 ? accent : A.lite(tint, 0.5), 0.9, { t: 'orbit', r: 0.14 + (i % 3) * 0.05, speed: 0.7 + i * 0.13, bob: 0.05, tw: 0.4 });
  for (let i = 0; i < 4; i++) f.add(0, 0.05, 0, 0.022, A.lite(tint, 0.5), 0.9, { t: 'rise', h: 0.35, speed: 0.3 + i * 0.07, spread: 0.04 });
  drift.add(A.fieldMesh(f));
  return {
    anchor: 'float', bottom: 0.2, height: 0.45, footprint: 0.15, radius: 0.35,
    update(dt, t) {
      const p = A.ph;
      drift.position.set(Math.sin(t * 0.5 + p) * 0.05, Math.sin(t * 0.9 + p) * 0.06, Math.cos(t * 0.4 + p) * 0.04);
      flame.scale.set(1, 1 + Math.sin(t * 2.6 + p) * 0.06, 1);
      flame.rotation.y += dt * 0.6;
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// the islet: a small shared floating rock shown under ground archetypes when they hover
// ---------------------------------------------------------------------------------------------------------------
function isletMesh(A) {
  const { T, k } = A;
  const geo = k.geo('islet', () => {
    const mx = new Mixer(T);
    const moss = new T.Color(PAL.moss), mossL = new T.Color(PAL.mossLight), st = new T.Color(PAL.stone), dk = new T.Color(PAL.stoneDark), glow = new T.Color(PAL.teal);
    mx.add(new T.IcosahedronGeometry(1, 2), {
      flat: true,
      deform: (v) => {
        const n = fbm(v.x * 1.8, v.y * 1.8, v.z * 1.8, 81);
        if (v.y > 0) { v.y = v.y * 0.05 - 0.015; v.x *= 1 + n * 0.06; v.z *= 1 + n * 0.06; }
        else { const d = -v.y; const kk = 1 - 0.8 * Math.pow(d, 1.2); v.x *= kk * (1 + n * 0.18); v.z *= kk * (1 + n * 0.18); v.y = -d * (0.75 + n * 0.2) - 0.015; }
      },
      paint: (lp, ln, c, wp, wn) => {
        if (wn.y > 0.6) { c.copy(mossL).lerp(moss, clamp01(Math.hypot(lp.x, lp.z))); return 0; }
        c.copy(st).lerp(dk, clamp01(-lp.y * 1.3));
        const vein = smooth(0.4, 0.65, fbm(lp.x * 4, lp.y * 4, lp.z * 4, 83));
        if (vein > 0) { c.lerp(glow, vein * 0.8); return vein * 0.8; }
        return 0;
      },
    });
    for (let i = 0; i < 3; i++) {
      const a = i * 2.2 + 0.5, d = 0.18 + i * 0.07;
      mx.add(new T.ConeGeometry(0.05, 0.22, 5), { flat: true, m: M(T, Math.cos(a) * d, -0.62 + i * 0.1, Math.sin(a) * d, Math.PI, 0, 0), color: glow.clone().lerp(WHITE(T), 0.3), emis: 0.9 });
    }
    return mx.build();
  }, A.refs);
  const m = new T.Mesh(geo, k.mats.body);
  m.name = 'islet';
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// public: buildArchetype
// ---------------------------------------------------------------------------------------------------------------
export function buildArchetype(THREE, name, params = {}) {
  const k = archetypeKit(THREE);
  const resolved = normalizeArchetypeName(name);
  const n = resolved || 'wisp';
  const p = params && typeof params === 'object' ? params : {};
  const A = makeCtx(k, n, p);
  let info;
  try {
    info = B[n](A);
  } catch (err) {
    // never let one bad build take the scene down: release what we took and fall back to a wisp
    k.release(A.refs);
    for (const o of A.owned) o.dispose?.();
    console.warn(`[archetypes] building "${n}" failed, using wisp`, err);
    if (n === 'wisp') throw err;
    return buildArchetype(THREE, 'wisp', { color: p.color });
  }
  const root = A.root;
  root.name = `archetype:${n}`;
  let islet = null;
  if (info.anchor === 'ground') {
    islet = isletMesh(A);
    const s = Math.max(0.28, info.footprint * 1.3);
    islet.scale.set(s, s * 0.9, s);
    root.add(islet);
  }
  const fields = A.fields;
  const upd = info.update || noop;
  Object.assign(root.userData, {
    archetype: n,
    fallback: !resolved,
    anchor: info.anchor,
    bottom: info.bottom ?? 0,
    height: info.height,
    footprint: info.footprint,
    radius: info.radius,
    accent: '#' + A.tint.getHexString(),
    accent2: '#' + A.accent.getHexString(),
    variant: A.variant,
    update(dt, t) {
      upd(dt, t);
      for (let i = 0; i < fields.length; i++) fields[i].update(t);
    },
    setFloating(on) { if (islet) islet.visible = !!on; },
    dispose() {
      k.release(A.refs);
      for (const o of A.owned) o.dispose?.();
      A.owned.length = 0;
    },
  });
  root.userData.update(0, 0);
  return root;
}

export function disposeArchetype(obj) { obj?.userData?.dispose?.(); }

// A standalone islet (used under GLB models). mesh.userData.dispose() releases it.
export function createIslet(THREE, footprint = 0.5) {
  const k = archetypeKit(THREE), refs = [];
  const m = isletMesh({ T: THREE, k, refs });
  const s = Math.max(0.28, footprint * 1.3);
  m.scale.set(s, s * 0.9, s);
  m.userData.dispose = () => k.release(refs);
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// public: buildParts (Asset {type:'parts'}): primitive parts merged by material into <= 3 draw calls
// ---------------------------------------------------------------------------------------------------------------
const SHAPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosahedron', 'capsule', 'octahedron']);
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const vec3 = (a, d) => (Array.isArray(a) && a.length >= 3 ? [num(a[0], d[0]), num(a[1], d[1]), num(a[2], d[2])] : d.slice());

export function sanitizeParts(parts) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const raw of parts.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue;
    const shape = SHAPES.has(raw.shape) ? raw.shape : 'box';
    const size = vec3(raw.size, [0.3, 0.3, 0.3]).map((v) => clamp(Math.abs(v), 0.02, 2));
    const position = vec3(raw.position, [0, size[1] / 2, 0]).map((v) => clamp(v, -3, 3));
    const rotation = vec3(raw.rotation, [0, 0, 0]).map((v) => clamp(v, -TAU, TAU));
    const material = ['matte', 'glow', 'glass'].includes(raw.material) ? raw.material : 'matte';
    const emissive = raw.emissive == null ? null : clamp01(num(raw.emissive, 0));
    out.push({ shape, size, position, rotation, color: typeof raw.color === 'string' ? raw.color : '#8fa3c8', material, emissive });
  }
  return out;
}

function unitShape(T, shape, size) {
  switch (shape) {
    case 'sphere': return { g: new T.SphereGeometry(0.5, 20, 14), s: size };
    case 'cylinder': return { g: new T.CylinderGeometry(0.5, 0.5, 1, 16), s: size };
    case 'cone': return { g: new T.ConeGeometry(0.5, 1, 16), s: size };
    case 'icosahedron': return { g: new T.IcosahedronGeometry(0.5, 1), s: size, flat: true };
    case 'octahedron': return { g: new T.OctahedronGeometry(0.5), s: size, flat: true };
    case 'capsule': {
      const r = size[0] / 2;
      return { g: new T.CapsuleGeometry(r, Math.max(0, size[1] - size[0]), 4, 12), s: [1, 1, size[2] / size[0]] };
    }
    case 'torus': {
      const tube = Math.min(size[1] / 2, size[0] / 4), R = Math.max(size[0] / 2 - tube, tube * 1.2);
      const g = new T.TorusGeometry(R, tube, 8, 28);
      g.rotateX(Math.PI / 2);
      return { g, s: [1, 1, size[2] / size[0]] };
    }
    case 'box':
    default: return { g: new T.BoxGeometry(1, 1, 1), s: size, flat: true };
  }
}

export function buildParts(THREE, rawParts, params = {}) {
  const T = THREE, k = archetypeKit(T);
  const parts = sanitizeParts(rawParts);
  if (!parts.length) return buildArchetype(T, 'wisp', params);
  const root = new T.Group();
  root.name = 'parts';
  const body = new T.Group();
  body.name = 'body';
  root.add(body);
  const bodyMx = new Mixer(T), glassMx = new Mixer(T);
  const f = new Field(T);
  const glows = [];
  const box = new T.Box3(), tmp = new T.Box3();
  let accent = null;
  for (const p of parts) {
    const { g, s, flat } = unitShape(T, p.shape, p.size);
    const m = M(T, p.position[0], p.position[1], p.position[2], p.rotation[0], p.rotation[1], p.rotation[2], s[0], s[1], s[2]);
    const glow = p.material === 'glow';
    const col = parseColor(T, p.color, '#8fa3c8', glow ? { minL: 0.5, maxL: 0.85 } : { minL: 0.12, maxL: 0.86 });
    const e = glow ? Math.max(0.6, p.emissive ?? 0.9) : p.material === 'glass' ? (p.emissive ?? 0.15) : (p.emissive ?? 0) * 0.9;
    const target = p.material === 'glass' ? glassMx : bodyMx;
    const before = target.count;
    target.add(g, {
      m, flat,
      paint: glow ? (lp, ln, c) => { c.copy(col); return e; } : (lp, ln, c, wp) => { c.copy(col).multiplyScalar(0.85 + 0.2 * clamp01(wp.y)); return e; },
    });
    if (glow) { glows.push({ p: p.position, s: Math.max(...p.size), c: col }); accent ??= col; }
    tmp.makeEmpty();
    const P = target.P;
    for (let i = before; i < target.count; i++) tmp.expandByPoint(new T.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    box.union(tmp);
  }
  // stand it on y=0, centred on x/z; shrink anything taller or wider than 3 m
  const size = box.getSize(new T.Vector3()), centre = box.getCenter(new T.Vector3());
  const fit = Math.min(1, 3 / Math.max(size.x, size.y, size.z, 0.01));
  const shift = M(T, -centre.x * fit, -box.min.y * fit, -centre.z * fit, 0, 0, 0, fit);
  const owned = [];
  const place = (mx, mat, name) => {
    if (!mx.count) return;
    const g = mx.build();
    g.applyMatrix4(shift);
    g.computeBoundingSphere();
    const mesh = new T.Mesh(g, k.mats[mat]);
    mesh.name = name;
    owned.push(g);
    body.add(mesh);
  };
  place(bodyMx, 'body', 'parts-body');
  place(glassMx, 'glass', 'parts-glass');
  const fields = [];
  if (glows.length) {
    for (const gl of glows.slice(0, 10)) {
      const v = new T.Vector3(...gl.p).applyMatrix4(shift);
      f.add(v.x, v.y, v.z, clamp(gl.s * fit * 2.4, 0.15, 1.6), gl.c, 0.32, { pulse: 0.08, pw: 0.8 + Math.random() });
    }
    const top = size.y * fit;
    for (let i = 0; i < 4; i++) f.add((Math.random() - 0.5) * size.x * fit, top * (0.3 + Math.random() * 0.6), (Math.random() - 0.5) * size.z * fit, 0.03, glows[i % glows.length].c, 0.85, { t: 'drift', r: 0.12, w: 0.5, tw: 0.6 });
    const fm = f.build(k.mats.halo);
    owned.push(f.geo);
    fields.push(f);
    body.add(fm);
  }
  const refs = [];
  const A = { T, k, refs };
  const islet = isletMesh(A);
  const foot = Math.max(size.x, size.z) * fit / 2;
  const s = Math.max(0.25, foot * 1.25);
  islet.scale.set(s, s * 0.9, s);
  root.add(islet);
  const col = accent ?? parseColor(T, parts[0].color, '#8fa3c8');
  Object.assign(root.userData, {
    archetype: 'parts', anchor: 'ground', bottom: 0, height: size.y * fit, footprint: foot, radius: Math.max(size.x, size.y, size.z) * fit * 0.6,
    accent: '#' + col.getHexString(), accent2: '#' + col.getHexString(),
    update(dt, t) { for (const fl of fields) fl.update(t); },
    setFloating(on) { islet.visible = !!on; },
    dispose() { for (const g of owned) g.dispose(); owned.length = 0; k.release(refs); },
  });
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// public: createSparkles, a short-lived burst for spawns ('spawn') and removals ('dissolve')
//   const s = createSparkles(THREE, { color:'#9fe', radius:0.6, mode:'spawn' }); parent.add(s.object3d);
//   each frame: if (!s.update(dt)) { parent.remove(s.object3d); s.dispose(); }
// ---------------------------------------------------------------------------------------------------------------
export function createSparkles(THREE, { color = '#bfefff', radius = 0.5, count = 26, mode = 'spawn', height = 0 } = {}) {
  const T = THREE, k = archetypeKit(T);
  const base = parseColor(T, color, '#bfefff');
  const lite = base.clone().lerp(new T.Color(1, 1, 1), 0.45);
  const f = new Field(T);
  const ps = [];
  const R = Math.max(0.15, radius);
  const up = mode === 'dissolve';
  const flash = f.add(0, height * 0.5, 0, 0.01, lite, 0.5, { t: 'ext' });
  for (let i = 0; i < count; i++) {
    const dir = new T.Vector3(Math.random() * 2 - 1, Math.random() * 1.4 - 0.4, Math.random() * 2 - 1).normalize();
    const start = up
      ? new T.Vector3((Math.random() - 0.5) * R * 1.4, Math.random() * Math.max(height, R), (Math.random() - 0.5) * R * 1.4)
      : dir.clone().multiplyScalar(R * 0.15).add(new T.Vector3(0, height * 0.5, 0));
    const vel = up ? new T.Vector3((Math.random() - 0.5) * 0.15, 0.25 + Math.random() * 0.35, (Math.random() - 0.5) * 0.15) : dir.multiplyScalar(R * (0.9 + Math.random() * 1.3));
    const idx = f.add(start.x, start.y, start.z, 0.04, i % 3 ? lite : base, 0, { t: 'ext' });
    ps.push({ idx, p: start, v: vel, life: 0.9 + Math.random() * 0.7, delay: up ? Math.random() * 0.35 : Math.random() * 0.08, size: (0.035 + Math.random() * 0.05) * (0.6 + R * 0.6) });
  }
  const mesh = f.build(k.mats.sparkle);
  mesh.name = 'sparkles';
  mesh.renderOrder = 3;
  let age = 0;
  const S = f.list;
  return {
    object3d: mesh,
    update(dt) {
      age += dt;
      let alive = false;
      const fa = Math.min(1, age / 0.55);
      S[flash].size = R * (up ? 1.6 : 2.6) * Math.sin(fa * Math.PI * 0.5);
      S[flash].a = (1 - fa) * (up ? 0.25 : 0.45);
      if (fa < 1) alive = true;
      for (const q of ps) {
        const t = age - q.delay, s = S[q.idx];
        if (t < 0) { s.a = 0; alive = true; continue; }
        const u = t / q.life;
        if (u >= 1) { s.a = 0; continue; }
        alive = true;
        const drag = Math.exp(-dt * (up ? 0.3 : 2.4));
        q.v.multiplyScalar(drag);
        if (up) q.v.x += Math.sin(age * 3 + q.idx) * dt * 0.1;
        q.p.addScaledVector(q.v, dt);
        s.x = q.p.x; s.y = q.p.y; s.z = q.p.z;
        s.size = q.size * (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) * 0.6);
        s.a = Math.min(1, u * 8) * (1 - u) * (0.7 + 0.3 * Math.sin(age * 9 + q.idx));
      }
      f.dynamic = true;
      f.update(age);
      return alive;
    },
    dispose() { f.geo.dispose(); },
  };
}
