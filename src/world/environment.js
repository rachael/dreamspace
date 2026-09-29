// Dreamspace environment: the calm sci-fi / fantasy world around the user.
//
//   import { createEnvironment } from './world/environment.js';
//   const env = createEnvironment({ scene, room, THREE, renderer });
//   env.setMood({ preset: 'aurora', fog: 0.4, glow: 0.7 });   // partial moods are fine; colours glide over ~4 s
//   env.update(dt, t);                                          // every frame
//   env.setAR(true | false);                                    // AR hides everything and clears fog/background
//
// What's in it (13 draw calls, ~16k triangles; budget is 30 / 120k):
//   sky dome (gradient, horizon haze, sunset glow, faint star band, deep-sea caustics) · soft twinkling stars (Points)
//   · gentle meteors (starfall) · slow aurora ribbons · ringed planet + ring (with planet shadow) + crescent moon + halos
//   · the floating ground platform you stand on + 5 floating islands + drifting rocks (one merged mesh, glowing veins)
//   · bioluminescent crystals (one merged mesh) · fireflies (one Points) · rune circle at your feet · a sea of clouds far below.
//
// Rules this module keeps:
//   - Everything lives in one group inside `room`, so it is hidden in AR. It adds NO lights (other builders' materials
//     stay exactly as they were lit); read `env.palette` if you want to tint your own lights to the mood.
//   - It owns scene.fog (linear THREE.Fog, same type as applyPicoFog, so no shader recompiles) and scene.background
//     while not in AR. In AR (setAR(true), room hidden, or a non-opaque XR session) it clears both and never re-asserts.
//   - Sky layers (dome, stars, planet, moon, aurora, meteors) follow the viewer's position, so they sit "at infinity".
//     The viewpoint itself is never touched.
//   - All animation is slow (periods of 10 s+), no flashing. three.js is passed in; this file imports nothing.

const E_TAU = Math.PI * 2;
const MOOD_TAU = 1.4;   // seconds; mood colours converge in ~4-5 s
const NGLOW = 12;       // glow pools (crystal clusters + rune) that light the terrain

// ---------------------------------------------------------------------------------------------------------------
// Mood presets. Colours are sRGB hex as you'd pick them; THREE.Color converts to linear so lerps look natural.
// ---------------------------------------------------------------------------------------------------------------
export const MOODS = {
  // deep teal horizon -> violet -> indigo; rose afterglow; subtle aurora
  twilight: {
    top: '#0c0a2c', mid: '#2c2268', horizon: '#236e7e', below: '#07131f',
    sunGlow: '#e67c9c', sunGlowAmt: 0.55, stars: 0.85, band: 0.7,
    auroraA: '#43e8c4', auroraB: '#8d5cff', aurora: 0.42, meteors: 0.12,
    fogColor: '#1b4257', fogNear: 10, fogFar: 75,
    flyA: '#ffd98a', flyB: '#9dffd6', flies: 0.9, drift: 0,
    crysA: '#63f2ff', crysB: '#b88cff', rune: '#7fe9ff',
    moss: '#1f5752', rock: '#2d2748', vein: '#5ff0dc',
    ambSky: '#4a5f9a', ambGround: '#170f2c', key: '#ffb8cc', keyAmt: 0.9,
    haze: 0.12, caustics: 0, clouds: 0.85,
  },
  // dark clear night, bright aurora curtains, many stars
  aurora: {
    top: '#020612', mid: '#081a30', horizon: '#0e3d4a', below: '#020a10',
    sunGlow: '#3fd6a8', sunGlowAmt: 0.22, stars: 1.25, band: 1.0,
    auroraA: '#4dffae', auroraB: '#b46cff', aurora: 1.15, meteors: 0.08,
    fogColor: '#0b2531', fogNear: 12, fogFar: 85,
    flyA: '#a8ffdc', flyB: '#7ad8ff', flies: 0.8, drift: 0,
    crysA: '#58ffd0', crysB: '#6fa8ff', rune: '#6dffc8',
    moss: '#123f3a', rock: '#1c2336', vein: '#4dffb0',
    ambSky: '#2f7078', ambGround: '#07121a', key: '#a8ecff', keyAmt: 0.6,
    haze: 0.06, caustics: 0, clouds: 0.7,
  },
  // indigo night full of stars; meteors glide; the fireflies become gently falling starlight
  starfall: {
    top: '#060418', mid: '#1b1446', horizon: '#3d2f73', below: '#0a0719',
    sunGlow: '#a48cff', sunGlowAmt: 0.3, stars: 1.5, band: 1.2,
    auroraA: '#7f84ff', auroraB: '#e38cff', aurora: 0.22, meteors: 1.0,
    fogColor: '#1d1842', fogNear: 12, fogFar: 85,
    flyA: '#fff3d4', flyB: '#cbbaff', flies: 1.1, drift: -1,
    crysA: '#cdb8ff', crysB: '#ffd68f', rune: '#cdbbff',
    moss: '#28214f', rock: '#2b2549', vein: '#b9a8ff',
    ambSky: '#4d4592', ambGround: '#0f0b24', key: '#dccfff', keyAmt: 0.7,
    haze: 0.08, caustics: 0, clouds: 0.75,
  },
  // underwater: light from above, caustics, thick teal haze, plankton rising
  deepsea: {
    top: '#0b4d66', mid: '#05304a', horizon: '#04283d', below: '#010810',
    sunGlow: '#1fc6d6', sunGlowAmt: 0.15, stars: 0.3, band: 0,
    auroraA: '#28e6d6', auroraB: '#2a6dff', aurora: 0.5, meteors: 0,
    fogColor: '#063349', fogNear: 3, fogFar: 38,
    flyA: '#74f8ff', flyB: '#3f8fff', flies: 1.0, drift: 0.55,
    crysA: '#38f6e2', crysB: '#3f7dff', rune: '#40f2e2',
    moss: '#0d3a48', rock: '#0e2135', vein: '#38eaff',
    ambSky: '#237a92', ambGround: '#020b16', key: '#72e2ff', keyAmt: 0.55,
    haze: 0.55, caustics: 1, clouds: 0.6,
  },
  // soft lavender sky, peach horizon, rose-quartz crystals
  dawn: {
    top: '#34487e', mid: '#7a78b4', horizon: '#f2ac92', below: '#2c2642',
    sunGlow: '#ffc48c', sunGlowAmt: 0.95, stars: 0.1, band: 0,
    auroraA: '#ffb6d3', auroraB: '#a88cff', aurora: 0.12, meteors: 0,
    fogColor: '#9a8db4', fogNear: 12, fogFar: 90,
    flyA: '#ffe6a8', flyB: '#ffc4d8', flies: 0.45, drift: 0,
    crysA: '#ffc2e2', crysB: '#9fd9ff', rune: '#ffd7a6',
    moss: '#2f4f4f', rock: '#5e4d6e', vein: '#ffd7a6',
    ambSky: '#a4b2e0', ambGround: '#3d2c44', key: '#ffd3aa', keyAmt: 1.1,
    haze: 0.35, caustics: 0, clouds: 0.95,
  },
};
export const MOOD_NAMES = Object.freeze(Object.keys(MOODS));
export const DEFAULT_MOOD = Object.freeze({ preset: 'twilight', fog: 0.35, glow: 0.6 });

const COLOR_KEYS = ['top', 'mid', 'horizon', 'below', 'sunGlow', 'auroraA', 'auroraB', 'fogColor', 'flyA', 'flyB',
  'crysA', 'crysB', 'rune', 'moss', 'rock', 'vein', 'ambSky', 'ambGround', 'key'];
const NUM_KEYS = ['sunGlowAmt', 'stars', 'band', 'aurora', 'meteors', 'fogNear', 'fogFar', 'flies', 'drift', 'keyAmt',
  'haze', 'caustics', 'clouds', 'fogAmt', 'glowMul'];

// ---------------------------------------------------------------------------------------------------------------
// Layout (metres; the user stands at the origin facing -z; az is degrees clockwise from -z toward +x)
// ---------------------------------------------------------------------------------------------------------------
const SUN = { az: 72, el: 4 };                        // the unseen sun just below the horizon: afterglow + key light
const PLANET = { az: -38, el: 21, dist: 62, r: 7 };   // ringed gas giant, front-left, gibbous
const MOON = { az: 44, el: 31, dist: 58, r: 2.1 };    // crescent, front-right
const GROUND_R = 9;                                   // the floating platform you stand on
const CLOUD_Y = -22;                                  // sea of clouds far below
const ISLANDS = [
  { c: [-10.5, 3.4, -13.0], R: 3.3, depth: 6.2, seed: 101 },  // front-left, under the planet
  { c: [12.8, 5.4, -19.5], R: 4.2, depth: 7.6, seed: 202 },   // front-right, under the moon
  { c: [-2.5, 9.0, -31.0], R: 2.5, depth: 4.8, seed: 303 },   // far and high, straight ahead
  { c: [-17.0, 2.0, 6.5], R: 3.6, depth: 6.4, seed: 404 },    // behind-left
  { c: [15.5, 2.8, 9.8], R: 2.8, depth: 5.2, seed: 505 },     // behind-right
];
const PLATFORM_CLUSTERS = [40, 100, 155, 205, 260, 318]; // crystal clusters on the platform rim; front stays open

// ---------------------------------------------------------------------------------------------------------------
// GLSL. Written GLSL1-style (attribute/varying/texture2D/gl_FragColor); three maps it to GLSL 3 for WebGL2.
// ---------------------------------------------------------------------------------------------------------------
const GLSL_HASH = /* glsl */`
float envHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float envHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;
// Push a vertex to the far plane (sky "at infinity"): never clipped by camera.far, behind everything.
const GLSL_FAR = /* glsl */`
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position.z = 0.0;
#else
  gl_Position.z = gl_Position.w * 0.999999;
#endif
`;
const GLSL_OUT = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
const GLSL_DITHER = /* glsl */`
  gl_FragColor.rgb += (envHash12(gl_FragCoord.xy) - 0.5) / 255.0; // hides 8-bit banding in dark gradients
`;
// Islands bob slowly; the ground platform (isle 0) never moves.
const GLSL_BOB = /* glsl */`
float envBob(float isle, float t) {
  if (isle < 0.5) return 0.0;
  float amp = isle > 5.5 ? 0.22 : 0.14;
  return sin(t * (0.21 + fract(isle * 0.37) * 0.08) + isle * 1.71) * amp;
}
`;

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  ${GLSL_FAR}
}`;
const SKY_FS = /* glsl */`
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uBelow;
uniform vec3 uSunGlow; uniform float uSunGlowAmt; uniform vec3 uSunDir;
uniform vec3 uBandN; uniform float uBand; uniform float uFogAmt;
uniform float uCaustics; uniform float uTime; uniform sampler2D uNoise;
varying vec3 vDir;
${GLSL_HASH}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.42, h));
  col = mix(col, uTop, smoothstep(0.28, 1.0, h));
  col = mix(col, uBelow, smoothstep(0.0, 0.34, -h));
  // horizon haze band: thicker when foggy
  col += uHorizon * exp(-abs(h) * mix(11.0, 4.5, uFogAmt)) * (0.16 + 0.22 * uFogAmt);
  // afterglow of the hidden sun, hugging the horizon
  float s = max(dot(d, uSunDir), 0.0);
  float hug = exp(-abs(h - 0.02) * 5.5);
  col += uSunGlow * uSunGlowAmt * (pow(s, 4.0) * 0.6 * hug + pow(s, 28.0) * 0.5);
  // faint galactic band arching overhead (seam-free: no atan)
  float bd = dot(d, uBandN);
  float bandMask = exp(-bd * bd * 28.0) * smoothstep(-0.04, 0.3, h);
  float bn = 0.55 + 0.25 * sin(dot(d, vec3(3.1, 1.7, -2.3)) * 2.6) * sin(dot(d, vec3(-1.3, 2.9, 2.1)) * 3.7)
               + 0.2 * sin(dot(d, vec3(4.7, -3.1, 1.9)) * 2.1);
  col += mix(uMid * 1.6, vec3(0.7, 0.72, 1.0), 0.25) * bandMask * bn * 0.08 * uBand;
  // deep-sea caustics: light rippling on a surface far above
  if (uCaustics > 0.001) {
    vec2 q = d.xz / (max(h, 0.0) + 0.3) * 3.2;
    float c1 = texture2D(uNoise, q * 0.8 + vec2(uTime * 0.011, uTime * 0.007)).g;
    float c2 = texture2D(uNoise, q * 1.25 - vec2(uTime * 0.008, -uTime * 0.010)).g;
    float c = clamp(1.0 - abs(c1 - c2) * 9.0, 0.0, 1.0);
    c = c * c * c;
    col += uTop * 0.6 * c * smoothstep(0.3, 0.9, h) * uCaustics;
  }
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
  ${GLSL_DITHER}
}`;

const STARS_VS = /* glsl */`
attribute float aSize; attribute float aPhase; attribute float aTint;
uniform float uTime; uniform float uStars; uniform float uPx;
varying vec3 vCol; varying float vSharp;
void main() {
  vec3 d = normalize(position);
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  ${GLSL_FAR}
  float tw = 0.7 + 0.3 * sin(uTime * (0.5 + aPhase * 1.3) + aPhase * 37.0);
  float horizon = smoothstep(-0.03, 0.2, d.y);
  float size = aSize * uPx * (0.85 + 0.15 * min(uStars, 1.5));
  gl_PointSize = max(size, 1.5);
  vSharp = mix(0.6, 2.5, smoothstep(2.0, 7.0, size));
  vec3 tint = aTint < 0.33 ? vec3(0.75, 0.85, 1.0) : (aTint < 0.66 ? vec3(1.0, 0.92, 0.8) : vec3(0.88, 0.8, 1.0));
  vCol = tint * tw * horizon * uStars;
}`;
const STARS_FS = /* glsl */`
varying vec3 vCol; varying float vSharp;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = pow(max(1.0 - dot(c, c), 0.0), vSharp);
  gl_FragColor = vec4(vCol * a, 1.0);
  ${GLSL_OUT}
}`;

const METEOR_VS = /* glsl */`
attribute vec2 aCorner; attribute float aSeed;
uniform float uTime; uniform float uMeteors;
varying vec2 vC; varying float vFade;
float envH1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float period = 8.0 + aSeed * 9.0;
  float cyc = uTime / period + aSeed * 7.31;
  float k = floor(cyc);
  float p = fract(cyc) / 0.3;            // visible for 30% of its period (~3-5 s), slow and soft
  float isOn = step(p, 1.0);
  p = clamp(p, 0.0, 1.0);
  float az = envH1(k * 12.9898 + aSeed * 78.233) * 6.2831853;
  float el = 0.42 + envH1(k * 39.3468 + aSeed * 11.135) * 0.55;
  vec3 start = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  vec3 upT = vec3(-sin(az) * sin(el), cos(el), cos(az) * sin(el));
  vec3 eastT = vec3(cos(az), 0.0, sin(az));
  float side = envH1(k * 3.7 + aSeed * 5.1) > 0.5 ? 1.0 : -1.0;
  vec3 travel = normalize(-upT * 0.8 + eastT * 0.6 * side);
  float headA = p * 0.5;
  float tailA = max(headA - 0.12 * smoothstep(0.0, 0.25, p), 0.0);
  float ang = mix(tailA, headA, aCorner.x);
  vec3 dir = start * cos(ang) + travel * sin(ang);
  vec3 pos = dir * 55.0;
  pos += normalize(cross(travel, dir)) * aCorner.y * mix(0.02, 0.16, aCorner.x) * isOn;
  vC = aCorner;
  vFade = sin(p * 3.14159265) * uMeteors * isOn;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;
const METEOR_FS = /* glsl */`
uniform vec3 uMeteorCol;
varying vec2 vC; varying float vFade;
void main() {
  float along = vC.x;
  float s = abs(vC.y);
  float a = along * along * along * (1.0 - s * s) * vFade;
  vec3 col = mix(uMeteorCol, vec3(1.0, 0.97, 0.92), along * along) * a * 1.3;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;

const AURORA_VS = /* glsl */`
attribute float aSeed;
uniform float uTime;
varying vec2 vUv; varying float vSeed;
void main() {
  vec3 p = position;
  vec2 radial = normalize(p.xz);
  float w = sin(uv.x * 7.0 + uTime * 0.13 + aSeed * 5.0) * 1.8 + sin(uv.x * 17.0 - uTime * 0.21 + aSeed * 2.0) * 0.6;
  p.xz += radial * w * (0.4 + 0.6 * uv.y);
  p.y += sin(uv.x * 5.0 + uTime * 0.09 + aSeed) * 0.8;
  vUv = uv; vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const AURORA_FS = /* glsl */`
uniform vec3 uAurA; uniform vec3 uAurB; uniform float uAurora; uniform float uGlowMul; uniform float uTime;
uniform sampler2D uNoise;
varying vec2 vUv; varying float vSeed;
void main() {
  float x = vUv.x; float y = vUv.y;
  float n = texture2D(uNoise, vec2(x * 3.0 + uTime * 0.006 + vSeed, 0.37 * vSeed)).r;
  // big, slowly sliding clumps: each ribbon breaks into separate curtains with dark sky between them
  float clumpN = texture2D(uNoise, vec2(x * 1.4 - uTime * 0.0035 + vSeed * 0.53, 0.71 + vSeed * 0.19)).r;
  float clumps = smoothstep(0.36, 0.64, clumpN);
  // vertical rays at two scales, drifting sideways
  float rays = 0.6 + 0.25 * sin(x * 140.0 + n * 9.0 + uTime * 0.25) + 0.15 * sin(x * 330.0 - n * 7.0 - uTime * 0.37);
  // soft, ragged lower border (no hard hem line), brightest just above it, then a long fade upward
  float yb = y - (n - 0.5) * 0.14;
  float onset = smoothstep(0.0, 0.1, y) * smoothstep(0.02, 0.22, yb);
  float border = exp(-(yb - 0.22) * (yb - 0.22) * 60.0) * 0.45;
  float curtain = onset * (pow(clamp(1.0 - y, 0.0, 1.0), 1.7) + border);
  float ends = pow(max(sin(3.14159265 * x), 0.0), 1.3);
  float drift = 0.8 + 0.2 * sin(uTime * 0.3 + x * 7.0 + vSeed * 3.0);
  float I = curtain * rays * clumps * ends * (0.45 + 0.8 * n) * drift;
  vec3 col = mix(uAurA, uAurB, smoothstep(0.2, 0.9, y)) * I * uAurora * uGlowMul * 0.6;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;

// planet + moon share a vertex shader
const BODY_VS = /* glsl */`
varying vec3 vN; varying vec3 vObj; varying vec3 vWorld;
void main() {
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const PLANET_FS = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uKey; uniform vec3 uAmbSky; uniform vec3 uHazeColor; uniform float uHaze;
uniform vec3 uBandA; uniform vec3 uBandB; uniform vec3 uBandC; uniform vec3 uAtmo; uniform float uTime;
uniform sampler2D uNoise;
varying vec3 vN; varying vec3 vObj; varying vec3 vWorld;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 o = normalize(vObj);
  float warp = (texture2D(uNoise, o.xz * 0.9 + vec2(uTime * 0.002, 0.0)).r - 0.5) * 0.12 + sin(o.x * 9.0 + o.z * 5.0) * 0.015;
  float b = o.y + warp;
  vec3 base = mix(uBandA, uBandB, sin(b * 22.0) * 0.5 + 0.5);
  base = mix(base, uBandC, (sin(b * 9.0 + 1.3) * 0.5 + 0.5) * 0.45);
  base *= 0.75 + 0.25 * (1.0 - abs(o.y));
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.12, 0.55, ndl);
  vec3 col = base * (uKey * lit * 1.1 + uAmbSky * 0.18);
  float fres = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 3.0);
  col += uAtmo * fres * (0.25 + 0.9 * smoothstep(-0.3, 0.6, ndl));
  col = mix(col, uHazeColor, clamp(uHaze + (1.0 - lit) * 0.3, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;
const MOON_FS = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uKey; uniform vec3 uAmbSky; uniform vec3 uHazeColor; uniform float uHaze;
uniform sampler2D uNoise;
varying vec3 vN; varying vec3 vObj; varying vec3 vWorld;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 o = normalize(vObj);
  float m1 = texture2D(uNoise, o.xy * 0.7 + 0.3).r;
  float m2 = texture2D(uNoise, o.zy * 1.3 + 0.1).b;
  float maria = smoothstep(0.45, 0.65, m1) * 0.35 + smoothstep(0.62, 0.75, m2) * 0.2;
  vec3 base = vec3(0.86, 0.87, 0.95) * (1.0 - maria);
  float lit = smoothstep(-0.05, 0.35, dot(N, uSunDir));
  vec3 col = base * (mix(uKey, vec3(1.0), 0.5) * lit + uAmbSky * 0.07);
  col += vec3(0.7, 0.75, 1.0) * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 4.0) * 0.12 * lit;
  col = mix(col, uHazeColor * 0.9, clamp(uHaze + (1.0 - lit) * 0.72, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;
const RING_VS = /* glsl */`
varying float vR; varying vec3 vWorld;
void main() {
  vR = length(position.xy);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const RING_FS = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uKey; uniform vec3 uAmbSky; uniform vec3 uHazeColor; uniform float uHaze;
uniform vec3 uBandA; uniform vec3 uBandB; uniform vec3 uPlanetPos; uniform float uPlanetR;
uniform float uRin; uniform float uRout; uniform sampler2D uNoise;
varying float vR; varying vec3 vWorld;
void main() {
  float r = (vR - uRin) / (uRout - uRin);
  float t1 = texture2D(uNoise, vec2(r * 1.7, 0.21)).b;
  float bands = smoothstep(0.25, 0.75, t1);
  float gap = smoothstep(0.02, 0.05, abs(r - 0.62));
  float edge = smoothstep(0.0, 0.06, r) * smoothstep(1.0, 0.85, r);
  float alpha = (0.25 + 0.6 * bands) * gap * edge;
  vec3 rel = vWorld - uPlanetPos;
  float along = dot(rel, uSunDir);
  float perp = length(rel - along * uSunDir);
  float shadow = along < 0.0 ? smoothstep(uPlanetR * 0.92, uPlanetR * 1.08, perp) : 1.0;
  vec3 col = mix(uBandB, uBandA, t1) * (uKey * (0.3 + 0.8 * shadow) + uAmbSky * 0.15);
  col = mix(col, uHazeColor, uHaze);
  gl_FragColor = vec4(col, alpha * (1.0 - uHaze * 0.5));
  ${GLSL_OUT}
}`;
const HALO_VS = /* glsl */`
attribute vec2 aCorner; attribute float aRadius; attribute float aKind;
varying vec2 vC; varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xy += aCorner * aRadius;
  vC = aCorner; vKind = aKind;
  gl_Position = projectionMatrix * mv;
}`;
const HALO_FS = /* glsl */`
uniform vec3 uAtmo; uniform vec3 uKey; uniform float uHaze;
varying vec2 vC; varying float vKind;
void main() {
  float r2 = dot(vC, vC);
  float g = max(exp(-r2 * 4.0) - exp(-4.0), 0.0);
  vec3 col = vKind < 0.5 ? uAtmo * 0.3 : mix(uKey, vec3(0.85, 0.9, 1.0), 0.6) * 0.07;
  gl_FragColor = vec4(col * g * (1.0 - uHaze * 0.6), 1.0);
  ${GLSL_OUT}
}`;

const TERRAIN_VS = /* glsl */`
attribute float aTop; attribute float aIsle; attribute float aShade; attribute float aDepth;
uniform float uTime;
varying vec3 vN; varying vec3 vWorld; varying vec3 vStatic;
varying float vTop; varying float vShade; varying float vDepth; varying float vFogDepth;
${GLSL_BOB}
void main() {
  vec4 ws = modelMatrix * vec4(position, 1.0);
  vStatic = ws.xyz;
  ws.y += envBob(aIsle, uTime);
  vWorld = ws.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vTop = aTop; vShade = aShade; vDepth = aDepth;
  vec4 mv = viewMatrix * ws;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const TERRAIN_FS = /* glsl */`
#define NGLOW ${NGLOW}
uniform vec3 uMoss; uniform vec3 uRock; uniform vec3 uVein;
uniform vec3 uAmbSky; uniform vec3 uAmbGround; uniform vec3 uKey; uniform vec3 uSunDir;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
uniform float uGlowMul; uniform float uTime; uniform sampler2D uNoise;
uniform vec4 uGlowPts[NGLOW]; uniform vec3 uGlowCols[NGLOW];
varying vec3 vN; varying vec3 vWorld; varying vec3 vStatic;
varying float vTop; varying float vShade; varying float vDepth; varying float vFogDepth;
${GLSL_HASH}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  float n1 = texture2D(uNoise, vStatic.xz * 0.11 + vStatic.y * 0.05).r;
  vec3 rock = uRock * (0.7 + 0.6 * vShade) * mix(1.0, 0.35, vDepth);
  float n2 = texture2D(uNoise, vStatic.xz * 0.023 + 0.37).b;
  vec3 moss = uMoss * (0.93 + 0.1 * vShade) * (0.78 + 0.44 * n1) * (0.82 + 0.36 * n2);
  vec3 alb = mix(rock, moss, vTop);
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
  float wrapL = max(dot(N, uSunDir) * 0.6 + 0.4, 0.0);
  vec3 col = alb * (amb * 1.6 + uKey * wrapL * 0.9);
  // pools of light around crystal clusters and the rune circle
  vec3 glow = vec3(0.0);
  for (int i = 0; i < NGLOW; i++) {
    vec3 dv = vStatic - uGlowPts[i].xyz;
    float q = max(1.0 - dot(dv, dv) / (uGlowPts[i].w * uGlowPts[i].w), 0.0);
    glow += uGlowCols[i] * q * q;
  }
  col += (alb * 3.0 + 0.06) * glow * uGlowMul;
  // bioluminescent veins on mossy tops; slow ripples of light travel outward through them
  // distance to the noise contour in metres (value / gradient), so lines keep a fixed width and never balloon
  vec2 vuv = vStatic.xz * 0.05 + vec2(0.13, 0.71);
  float v = texture2D(uNoise, vuv).g;
  float vx = texture2D(uNoise, vuv + vec2(0.01, 0.0)).g;
  float vz = texture2D(uNoise, vuv + vec2(0.0, 0.01)).g;
  float grad = max(length(vec2(vx - v, vz - v)) * 5.0, 0.04);   // per metre (0.01 uv = 0.2 m)
  float cdist = abs(v - 0.5) / grad;                           // the v = 0.5 contour: long meandering veins
  float aa = max(fwidth(cdist), 0.002);
  float vein = (1.0 - smoothstep(0.016 - aa, 0.016 + aa, cdist)) * clamp(0.02 / (aa + 0.006), 0.0, 1.0);
  float pulse = 0.5 + 0.5 * sin(length(vStatic.xz) * 0.8 - uTime * 0.45);
  float clearRune = smoothstep(2.3, 3.2, length(vStatic.xz));   // veins stop short of the rune circle
  col += uVein * vein * (0.08 + 0.5 * pulse * pulse * pulse) * uGlowMul * vTop * clearRune;
  // sky rim on rock so island silhouettes read against the clouds
  col += uAmbSky * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 3.0) * 0.1 * (1.0 - vTop);
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vFogDepth));
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
  ${GLSL_DITHER}
}`;

const CRYSTAL_VS = /* glsl */`
attribute float aHue; attribute float aPhase; attribute float aH; attribute float aIsle;
uniform float uTime;
varying vec3 vN; varying vec3 vWorld; varying float vHue; varying float vPhase; varying float vH; varying float vFogDepth;
${GLSL_BOB}
void main() {
  vec4 ws = modelMatrix * vec4(position, 1.0);
  ws.y += envBob(aIsle, uTime);
  vWorld = ws.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vHue = aHue; vPhase = aPhase; vH = aH;
  vec4 mv = viewMatrix * ws;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const CRYSTAL_FS = /* glsl */`
uniform vec3 uCrysA; uniform vec3 uCrysB; uniform float uGlowMul; uniform float uTime;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
varying vec3 vN; varying vec3 vWorld; varying float vHue; varying float vPhase; varying float vH; varying float vFogDepth;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 base = mix(uCrysA, uCrysB, vHue);
  float facet = 0.55 + 0.45 * abs(dot(N, normalize(vec3(0.4, 0.8, 0.45))));
  float fres = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.5);
  float pulse = 0.78 + 0.22 * sin(uTime * 0.7 + vPhase * 6.2831853);
  float core = mix(0.55, 1.0, smoothstep(0.0, 0.9, vH));
  vec3 col = base * facet * core * pulse * (0.35 + 0.65 * uGlowMul);
  col += mix(base, vec3(1.0), 0.55) * fres * 0.5 * uGlowMul;
  col += vec3(1.0) * smoothstep(0.93, 1.0, vH) * 0.25 * uGlowMul;
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vFogDepth) * 0.85);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;

const FLY_VS = /* glsl */`
attribute vec4 aSeed; attribute float aSize;
uniform float uTime; uniform float uDrift; uniform float uViewH; uniform float uFlies; uniform float uGlowMul;
uniform vec3 uFlyA; uniform vec3 uFlyB; uniform float uFogNear; uniform float uFogFar;
varying vec3 vCol; varying float vI;
void main() {
  vec3 p = position;
  vec4 s = aSeed;
  float t = uTime;
  p.x += sin(t * (0.11 + s.x * 0.12) + s.y * 6.2831853) * (0.6 + s.z * 0.8);
  p.z += cos(t * (0.09 + s.y * 0.10) + s.z * 6.2831853) * (0.6 + s.x * 0.8);
  p.y += sin(t * (0.17 + s.z * 0.15) + s.w * 6.2831853) * 0.35;
  // vertical drift (starfall: falls like snow; deepsea: rises like plankton), wrapped within [0.2, 6.2] m
  float H = 6.0;
  float y = mod(p.y - 0.2 + uDrift * (0.5 + s.w), H);
  float edgeFade = smoothstep(0.0, 0.6, y) * smoothstep(H, H - 0.6, y);
  p.y = y + 0.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.05);
  float px = aSize * projectionMatrix[1][1] * uViewH * 0.5 / dist;
  float blink = 0.35 + 0.65 * pow(max(0.5 + 0.5 * sin(t * (0.5 + s.x * 0.9) + s.y * 40.0), 0.0), 3.0);
  vI = blink * edgeFade * uFlies * uGlowMul;
  vI *= 1.0 - smoothstep(uFogNear, uFogFar, dist) * 0.85;
  vI *= smoothstep(0.35, 0.9, dist);          // never a bright blob in your face
  vI *= clamp(px / 2.0, 0.15, 1.0);           // tiny far sprites fade instead of flickering
  gl_PointSize = clamp(px, 2.0, 48.0);
  vCol = mix(uFlyA, uFlyB, s.z);
}`;
const FLY_FS = /* glsl */`
varying vec3 vCol; varying float vI;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float edge = max(1.0 - r2, 0.0);
  float core = exp(-r2 * 14.0);
  float halo = exp(-r2 * 3.5) * 0.35;
  vec3 col = (vCol * (core * 0.6 + halo) + vec3(core * 0.4)) * edge * vI;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;

const RUNE_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RUNE_FS = /* glsl */`
uniform float uTime; uniform float uGlowMul; uniform vec3 uRune; uniform float uSize;
varying vec2 vUv;
${GLSL_HASH}
float envSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a; vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float envBit(float bits, float k) { return mod(floor(bits / exp2(k) + 0.001), 2.0); }
// one glyph in a [-1,1] box: a spine plus strokes chosen by the bits of a hash
float envGlyph(vec2 q, float id) {
  float bits = floor(envHash11(id * 7.13 + 1.7) * 256.0);
  float d = envSeg(q, vec2(0.0, -0.85), vec2(0.0, 0.85));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, 0.85), vec2(0.6, 0.85)), envBit(bits, 0.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, -0.85), vec2(0.6, -0.85)), envBit(bits, 1.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, -0.5), vec2(0.6, 0.5)), envBit(bits, 2.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, 0.5), vec2(0.6, -0.5)), envBit(bits, 3.0)));
  d = min(d, mix(1e3, abs(length(q - vec2(0.0, 0.1)) - 0.42), envBit(bits, 4.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, 0.0), vec2(0.0, 0.55)), envBit(bits, 5.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(0.0, 0.55), vec2(0.6, 0.0)), envBit(bits, 6.0)));
  d = min(d, mix(1e3, envSeg(q, vec2(-0.6, -0.3), vec2(-0.6, 0.85)), envBit(bits, 7.0)));
  return d;
}
void main() {
  vec2 p = (vUv - 0.5) * uSize;             // metres, centred on the user
  vec2 fw = fwidth(p);
  float px = max(max(fw.x, fw.y), 1e-4);   // metres per pixel, for anti-aliasing (computed outside any branch)
  float r = length(p);
  float a = atan(p.y, p.x);
  float I = 0.0;
  // rings
  I += 1.0 - smoothstep(0.012 - px, 0.012 + px, abs(r - 2.05));
  I += (1.0 - smoothstep(0.006 - px, 0.006 + px, abs(r - 1.97))) * 0.8;
  I += (1.0 - smoothstep(0.008 - px, 0.008 + px, abs(r - 1.62))) * 0.9;
  I += (1.0 - smoothstep(0.006 - px, 0.006 + px, abs(r - 1.18))) * 0.7;
  I += (1.0 - smoothstep(0.005 - px, 0.005 + px, abs(r - 0.42))) * 0.5;
  // tick marks between the two outer rings
  float ta = a / 6.2831853 * 90.0;
  float tick = abs(fract(ta) - 0.5) * 6.2831853 / 90.0 * r;
  I += (1.0 - smoothstep(0.005 - px, 0.005 + px, tick)) * step(abs(r - 2.01), 0.035) * 0.6;
  // rune band, turning very slowly
  float N = 30.0;
  float cellA = 6.2831853 / N;
  float aa = (a + uTime * 0.025) / cellA;
  float ci = floor(aa);
  float idx = mod(ci, N);
  vec2 q = vec2((aa - ci - 0.5) * cellA * 1.795 / 0.13, (r - 1.795) / 0.105);
  float gd = envGlyph(q, idx) * 0.105;
  float inBand = step(abs(r - 1.795), 0.16);
  I += (1.0 - smoothstep(0.011 - px, 0.011 + px, gd)) * inBand * (0.8 + 0.2 * sin(idx * 1.7));
  // hexagram, counter-rotating
  float hr = 1.18;
  float ha = -uTime * 0.018;
  vec2 v0 = hr * vec2(cos(ha), sin(ha));
  vec2 v1 = hr * vec2(cos(ha + 2.0943951), sin(ha + 2.0943951));
  vec2 v2 = hr * vec2(cos(ha + 4.1887902), sin(ha + 4.1887902));
  vec2 w0 = hr * vec2(cos(ha + 1.0471976), sin(ha + 1.0471976));
  vec2 w1 = hr * vec2(cos(ha + 3.1415927), sin(ha + 3.1415927));
  vec2 w2 = hr * vec2(cos(ha + 5.2359878), sin(ha + 5.2359878));
  float hd = min(min(envSeg(p, v0, v1), envSeg(p, v1, v2)), envSeg(p, v2, v0));
  hd = min(hd, min(min(envSeg(p, w0, w1), envSeg(p, w1, w2)), envSeg(p, w2, w0)));
  I += (1.0 - smoothstep(0.007 - px, 0.007 + px, hd)) * 0.75;
  float dots = min(min(min(length(p - v0), length(p - v1)), min(length(p - v2), length(p - w0))), min(length(p - w1), length(p - w2)));
  I += (1.0 - smoothstep(0.045 - px, 0.045 + px, dots)) * 0.9;
  // a soft highlight sweeps around (~18 s per turn); the whole circle breathes
  float sweep = pow(max(0.5 + 0.5 * cos(a - uTime * 0.35), 0.0), 12.0);
  float breathe = 0.82 + 0.18 * sin(uTime * 0.5);
  float zf = (r - 1.8) / 0.35;
  float fill = exp(-zf * zf) * 0.085 + exp(-r * r / 4.8) * 0.025;
  float fade = 1.0 - smoothstep(2.15, 2.28, r);
  vec3 col = (uRune * (I * (0.7 + 0.55 * sweep) * breathe + fill) + vec3(I * 0.07)) * uGlowMul * fade * 0.72;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUT}
}`;

const CLOUD_VS = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const CLOUD_FS = /* glsl */`
uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uBelow; uniform vec3 uSunGlow; uniform vec3 uSunDir;
uniform float uSunGlowAmt; uniform float uTime; uniform float uClouds; uniform sampler2D uNoise;
varying vec3 vWorld;
void main() {
  vec2 uv = vWorld.xz * 0.012 + vec2(uTime * 0.0025, uTime * 0.0012);
  float n = texture2D(uNoise, uv).r * 0.62 + texture2D(uNoise, uv * 2.9 + vec2(0.37, 0.11) - uTime * 0.0017).b * 0.38;
  float dens = smoothstep(0.32, 0.78, n);
  vec2 rel = vWorld.xz - cameraPosition.xz;
  float dist = length(rel);
  vec3 col = mix(mix(uBelow, uMid, 0.25), mix(uHorizon, uMid, 0.3) * 1.3, dens);
  vec2 sunXZ = normalize(uSunDir.xz);
  float toward = max(dot(rel / max(dist, 0.001), sunXZ), 0.0);
  col += uSunGlow * uSunGlowAmt * pow(toward, 3.0) * dens * 0.35;
  col = mix(col, uHorizon * 0.7 + uBelow * 0.3, smoothstep(25.0, 85.0, dist) * 0.8);
  float alpha = mix(0.25, 0.9, dens) * (1.0 - smoothstep(60.0, 87.0, dist)) * uClouds;
  gl_FragColor = vec4(col, alpha);
  ${GLSL_OUT}
}`;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers (no three imports: THREE is passed in)
// ---------------------------------------------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dirAzEl(az, el) { // degrees -> unit [x,y,z]; az clockwise from -z toward +x
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function num01(v, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? clamp01(n) : fallback;
}

// Tileable RGBA noise (value-noise fBm per channel). r: smooth, g: veins/caustics, b: fine grain. Mipmapped.
function makeNoiseTexture(THREE, size = 128) {
  const data = new Uint8Array(size * size * 4);
  const chans = [
    { seed: 11, periods: [4, 8, 16, 32], amps: [0.5, 0.25, 0.15, 0.1] },
    { seed: 23, periods: [4, 8, 16], amps: [0.55, 0.3, 0.15] },
    { seed: 37, periods: [16, 32, 64], amps: [0.5, 0.3, 0.2] },
  ];
  const fade = (t) => t * t * (3 - 2 * t);
  const acc = new Float32Array(size * size);
  for (let c = 0; c < 3; c++) {
    acc.fill(0);
    const { seed, periods, amps } = chans[c];
    periods.forEach((P, oi) => {
      const rnd = mulberry32(seed * 131 + oi * 7);
      const lat = new Float32Array(P * P);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < size; y++) {
        const fy = (y / size) * P, iy = Math.floor(fy), ty = fade(fy - iy);
        const y0 = iy % P, y1 = (iy + 1) % P;
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * P, ix = Math.floor(fx), tx = fade(fx - ix);
          const x0 = ix % P, x1 = (ix + 1) % P;
          const a = lat[y0 * P + x0], b = lat[y0 * P + x1], cc = lat[y1 * P + x0], d = lat[y1 * P + x1];
          acc[y * size + x] += ((a + (b - a) * tx) + ((cc + (d - cc) * tx) - (a + (b - a) * tx)) * ty) * amps[oi];
        }
      }
    });
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < acc.length; i++) { if (acc[i] < mn) mn = acc[i]; if (acc[i] > mx) mx = acc[i]; }
    const span = mx - mn || 1;
    for (let i = 0; i < acc.length; i++) data[i * 4 + c] = Math.round(((acc[i] - mn) / span) * 255);
  }
  for (let i = 0; i < size * size; i++) data[i * 4 + 3] = 255;
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Accumulates flat-shaded, non-indexed triangles with scalar custom attributes.
// `outward` (optional) flips a triangle so its normal faces that way, which also fixes the winding for FrontSide.
class TriBuilder {
  constructor(attrNames) { this.pos = []; this.nor = []; this.names = attrNames; this.attrs = {}; for (const n of attrNames) this.attrs[n] = []; }
  tri(a, b, c, attrs, outward) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    let order = [0, 1, 2];
    if (outward && nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { order = [0, 2, 1]; nx = -nx; ny = -ny; nz = -nz; }
    const pts = [a, b, c];
    for (const i of order) {
      const p = pts[i];
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      for (const n of this.names) { const v = attrs[n]; this.attrs[n].push(Array.isArray(v) ? v[i] : (v ?? 0)); }
    }
  }
  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    for (const n of this.names) g.setAttribute(n, new THREE.Float32BufferAttribute(this.attrs[n], 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// createEnvironment
// ---------------------------------------------------------------------------------------------------------------
export function createEnvironment(opts = {}) {
  const THREE = opts.THREE || globalThis.THREE;
  const { scene, renderer = null } = opts;
  if (!THREE) throw new Error('createEnvironment: pass { THREE }');
  if (!scene) throw new Error('createEnvironment: pass { scene }');
  let room = opts.room;
  if (!room) { room = new THREE.Group(); room.name = 'room'; scene.add(room); }
  const withGround = opts.ground !== false;   // the floating platform under the user (on by default)
  const withClouds = opts.clouds !== false;   // the sea of clouds far below (on by default)

  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  const root = new THREE.Group(); root.name = 'environment';
  const skyGroup = new THREE.Group(); skyGroup.name = 'env-sky';   // follows the viewer: sky "at infinity"
  root.add(skyGroup);
  room.add(root);

  // ---------- mood state: current (lerped) and target ----------
  const cur = {}, tgt = {};
  for (const k of COLOR_KEYS) { cur[k] = new THREE.Color(); tgt[k] = new THREE.Color(); }
  for (const k of NUM_KEYS) { cur[k] = 0; tgt[k] = 0; }
  let mood = { ...DEFAULT_MOOD };
  function computeTargets() {
    const p = MOODS[mood.preset];
    for (const k of COLOR_KEYS) tgt[k].set(p[k]);
    for (const k of NUM_KEYS) if (k in p) tgt[k] = p[k];
    tgt.fogNear = p.fogNear * (1.3 - 0.6 * mood.fog);
    tgt.fogFar = p.fogFar * (1.6 - 1.2 * mood.fog);
    tgt.fogAmt = mood.fog;
    tgt.glowMul = 0.3 + 1.4 * mood.glow;
  }
  function snapMood() {
    for (const k of COLOR_KEYS) cur[k].copy(tgt[k]);
    for (const k of NUM_KEYS) cur[k] = tgt[k];
  }
  computeTargets(); snapMood();

  const keyScaled = new THREE.Color();
  const hazeColor = new THREE.Color();
  const sunDir = new THREE.Vector3(...dirAzEl(SUN.az, SUN.el)).normalize();

  // ---------- shared uniforms (same objects referenced by every material) ----------
  const noiseTex = track(makeNoiseTexture(THREE));
  const U = {
    uTime: { value: 0 }, uNoise: { value: noiseTex }, uSunDir: { value: sunDir }, uGlowMul: { value: 1 },
    uFogColor: { value: cur.fogColor }, uFogNear: { value: 10 }, uFogFar: { value: 75 }, uFogAmt: { value: 0.35 },
    uTop: { value: cur.top }, uMid: { value: cur.mid }, uHorizon: { value: cur.horizon }, uBelow: { value: cur.below },
    uSunGlow: { value: cur.sunGlow }, uSunGlowAmt: { value: 0 },
    uStars: { value: 1 }, uBand: { value: 1 }, uCaustics: { value: 0 }, uPx: { value: 1 }, uViewH: { value: 1000 },
    uAurA: { value: cur.auroraA }, uAurB: { value: cur.auroraB }, uAurora: { value: 0 },
    uMeteors: { value: 0 }, uMeteorCol: { value: cur.flyA },
    uFlyA: { value: cur.flyA }, uFlyB: { value: cur.flyB }, uFlies: { value: 1 }, uDrift: { value: 0 },
    uCrysA: { value: cur.crysA }, uCrysB: { value: cur.crysB }, uRune: { value: cur.rune },
    uMoss: { value: cur.moss }, uRock: { value: cur.rock }, uVein: { value: cur.vein },
    uAmbSky: { value: cur.ambSky }, uAmbGround: { value: cur.ambGround }, uKey: { value: keyScaled },
    uHaze: { value: 0.1 }, uHazeColor: { value: hazeColor }, uClouds: { value: 1 },
    uBandA: { value: new THREE.Color('#b89ad6') }, uBandB: { value: new THREE.Color('#ead4c6') },
    uBandC: { value: new THREE.Color('#5a7fb0') }, uAtmo: { value: new THREE.Color('#9ab4ff') },
  };
  const pick = (...names) => Object.fromEntries(names.map((n) => [n, U[n]]));
  const shader = (params) => track(new THREE.ShaderMaterial(params));
  function addObj(parent, obj, name, renderOrder = 0) {
    obj.name = name;
    obj.frustumCulled = false; // positions are generated or displaced in shaders; bounds would lie
    obj.renderOrder = renderOrder;
    obj.matrixAutoUpdate = true;
    parent.add(obj);
    return obj;
  }

  // ================= SKY DOME (at infinity) =================
  const skyMat = shader({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false,
    uniforms: {
      ...pick('uTop', 'uMid', 'uHorizon', 'uBelow', 'uSunGlow', 'uSunGlowAmt', 'uSunDir', 'uBand', 'uFogAmt', 'uCaustics', 'uTime', 'uNoise'),
      uBandN: { value: new THREE.Vector3(0.62, 0.35, 0.7).normalize() },
    },
  });
  // drawn last among opaques so terrain early-z rejects hidden sky pixels
  const sky = addObj(skyGroup, new THREE.Mesh(track(new THREE.SphereGeometry(50, 32, 16)), skyMat), 'env-sky-dome', 50);
  const camWorld = new THREE.Vector3();
  let haveCam = false;
  sky.onBeforeRender = (_r, _s, cam) => { camWorld.setFromMatrixPosition(cam.matrixWorld); haveCam = true; };

  // ================= STARS =================
  {
    const rnd = mulberry32(7);
    const N = 1500;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), tint = new Float32Array(N);
    const bn = new THREE.Vector3(0.62, 0.35, 0.7).normalize();
    const bu = new THREE.Vector3().crossVectors(bn, new THREE.Vector3(0, 1, 0)).normalize();
    const bv = new THREE.Vector3().crossVectors(bn, bu).normalize();
    const d = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      if (rnd() < 0.3) { // concentrated along the galactic band
        const th = rnd() * E_TAU, off = (rnd() + rnd() + rnd() - 1.5) * 0.12;
        d.copy(bu).multiplyScalar(Math.cos(th)).addScaledVector(bv, Math.sin(th)).addScaledVector(bn, off).normalize();
        if (d.y < -0.2) d.y = -d.y;
      } else {
        const y = rnd() * 1.2 - 0.2, phi = rnd() * E_TAU, rr = Math.sqrt(1 - y * y);
        d.set(rr * Math.cos(phi), y, rr * Math.sin(phi));
      }
      pos[i * 3] = d.x * 50; pos[i * 3 + 1] = d.y * 50; pos[i * 3 + 2] = d.z * 50;
      size[i] = 1.8 + Math.pow(rnd(), 6) * 4.2;
      phase[i] = rnd(); tint[i] = rnd();
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
    const m = shader({
      vertexShader: STARS_VS, fragmentShader: STARS_FS, uniforms: pick('uTime', 'uStars', 'uPx'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    addObj(skyGroup, new THREE.Points(g, m), 'env-stars', -30);
  }

  // ================= METEORS (starfall) =================
  {
    const M = 6;
    const pos = new Float32Array(M * 4 * 3), corner = new Float32Array(M * 4 * 2), seed = new Float32Array(M * 4);
    const idx = [];
    const cs = [[0, -1], [1, -1], [0, 1], [1, 1]];
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < 4; j++) {
        const v = i * 4 + j;
        pos[v * 3 + 2] = -55; corner[v * 2] = cs[j][0]; corner[v * 2 + 1] = cs[j][1]; seed[v] = (i + 0.5) / M;
      }
      const b = i * 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setIndex(idx);
    const m = shader({
      vertexShader: METEOR_VS, fragmentShader: METEOR_FS, uniforms: pick('uTime', 'uMeteors', 'uMeteorCol'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
    });
    addObj(skyGroup, new THREE.Mesh(g, m), 'env-meteors', -29);
  }

  // ================= PLANET + RING + MOON + HALOS =================
  const planetPos = new THREE.Vector3(...dirAzEl(PLANET.az, PLANET.el)).multiplyScalar(PLANET.dist);
  const moonPos = new THREE.Vector3(...dirAzEl(MOON.az, MOON.el)).multiplyScalar(MOON.dist);
  const bodyU = pick('uSunDir', 'uKey', 'uAmbSky', 'uHazeColor', 'uHaze', 'uNoise');
  const planet = addObj(skyGroup, new THREE.Mesh(track(new THREE.SphereGeometry(PLANET.r, 64, 40)), shader({
    vertexShader: BODY_VS, fragmentShader: PLANET_FS,
    uniforms: { ...bodyU, ...pick('uBandA', 'uBandB', 'uBandC', 'uAtmo', 'uTime') },
  })), 'env-planet');
  planet.position.copy(planetPos);
  planet.rotation.set(0.28, 0, 0.36); // tilt: the ring shows as an open ellipse
  const RIN = PLANET.r * 1.36, ROUT = PLANET.r * 2.3;
  const ringU = { ...bodyU, ...pick('uBandA', 'uBandB'), uPlanetPos: { value: new THREE.Vector3() },
    uPlanetR: { value: PLANET.r }, uRin: { value: RIN }, uRout: { value: ROUT } };
  const ring = addObj(planet, new THREE.Mesh(track(new THREE.RingGeometry(RIN, ROUT, 160, 1)), shader({
    vertexShader: RING_VS, fragmentShader: RING_FS, uniforms: ringU,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  })), 'env-planet-ring', -28);
  ring.rotation.x = -Math.PI / 2; // into the planet's equatorial plane
  ring.onBeforeRender = () => { ringU.uPlanetPos.value.setFromMatrixPosition(planet.matrixWorld); };
  const moon = addObj(skyGroup, new THREE.Mesh(track(new THREE.SphereGeometry(MOON.r, 40, 24)), shader({
    vertexShader: BODY_VS, fragmentShader: MOON_FS, uniforms: bodyU,
  })), 'env-moon');
  moon.position.copy(moonPos);
  {
    const bodies = [[planetPos, PLANET.r * 1.9, 0], [moonPos, MOON.r * 2.4, 1]];
    const pos = [], corner = [], radius = [], kind = [], idx = [];
    bodies.forEach(([c, r, k], i) => {
      for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { pos.push(c.x, c.y, c.z); corner.push(cx, cy); radius.push(r); kind.push(k); }
      const b = i * 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    });
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
    g.setAttribute('aRadius', new THREE.Float32BufferAttribute(radius, 1));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    g.setIndex(idx);
    addObj(skyGroup, new THREE.Mesh(g, shader({
      vertexShader: HALO_VS, fragmentShader: HALO_FS, uniforms: pick('uAtmo', 'uKey', 'uHaze'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
    })), 'env-halos', -27);
  }

  // ================= AURORA (three ribbons, one draw call) =================
  // A high canopy in front (its lower edge just clears the planet, the moon hangs right under it) plus two low
  // curtains behind. About 225° of sky in total, and the shader breaks each ribbon into separate clumps.
  {
    const DEG = Math.PI / 180;
    const ribbons = [ // az: degrees clockwise from -z; base elevation eases elA -> elB along the ribbon; tall: degrees
      { az0: -62, az1: 64, R: 42, elA: 27, elB: 30, tall: 22, seed: 0.3 },
      { az0: -160, az1: -108, R: 46, elA: 12, elB: 16, tall: 17, seed: 1.7 },
      { az0: 112, az1: 166, R: 46, elA: 15, elB: 11, tall: 16, seed: 3.1 },
    ];
    const SEG = 110;
    const pos = [], uv = [], seedA = [], idx = [];
    ribbons.forEach((rb, ri) => {
      const base = ri * (SEG + 1) * 2;
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const az = (rb.az0 + (rb.az1 - rb.az0) * u) * DEG;
        const R = rb.R + Math.sin(u * 9 + rb.seed) * 3 + Math.sin(u * 23 + rb.seed * 2) * 1.2; // folds
        const el0 = rb.elA + (rb.elB - rb.elA) * u + Math.sin(u * 5 + rb.seed) * 1.5;
        const el1 = el0 + rb.tall * (0.8 + 0.2 * Math.sin(u * 7 + rb.seed * 3));
        const R1 = R * 1.04, y = R * Math.tan(el0 * DEG), yTop = R1 * Math.tan(el1 * DEG);
        pos.push(Math.sin(az) * R, y, -Math.cos(az) * R, Math.sin(az) * R1, yTop, -Math.cos(az) * R1);
        uv.push(u, 0, u, 1);
        seedA.push(rb.seed, rb.seed);
        if (i < SEG) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
    });
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seedA, 1));
    g.setIndex(idx);
    addObj(skyGroup, new THREE.Mesh(g, shader({
      vertexShader: AURORA_VS, fragmentShader: AURORA_FS, uniforms: pick('uAurA', 'uAurB', 'uAurora', 'uGlowMul', 'uTime', 'uNoise'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
    })), 'env-aurora', -26);
  }

  // ================= TERRAIN: ground platform + floating islands + drifting rocks (one mesh) =================
  const glowSlots = []; // { pos:[x,y,z], radius, kind:'rune'|'crystal', hue, strength }
  const islandInfo = [];
  const crystalsB = new TriBuilder(['aHue', 'aPhase', 'aH', 'aIsle']);
  const terrainB = new TriBuilder(['aTop', 'aIsle', 'aShade', 'aDepth']);

  function addCrystal(base, axis, h, w, spin, attrs) {
    // hexagonal crystal: pointed tip, short buried point below. axis: unit [x,y,z]
    const ax = new THREE.Vector3(...axis).normalize();
    const ref = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, ref).normalize();
    const v = new THREE.Vector3().crossVectors(ax, u).normalize();
    const B = new THREE.Vector3(...base);
    const at = (along, rad, ang) => {
      const p = B.clone().addScaledVector(ax, along)
        .addScaledVector(u, Math.cos(ang) * rad).addScaledVector(v, Math.sin(ang) * rad);
      return [p.x, p.y, p.z];
    };
    const r0 = [], r1 = [];
    for (let i = 0; i < 6; i++) { const ang = spin + (i / 6) * E_TAU; r0.push(at(0, w, ang)); r1.push(at(h * 0.72, w * 0.9, ang)); }
    const tip = at(h, 0, 0), bot = at(-h * 0.12, 0, 0);
    const out = (a, b, c) => { // outward = away from the crystal axis
      const cx = (a[0] + b[0] + c[0]) / 3 - B.x, cy = (a[1] + b[1] + c[1]) / 3 - B.y, cz = (a[2] + b[2] + c[2]) / 3 - B.z;
      const along = cx * ax.x + cy * ax.y + cz * ax.z;
      return [cx - ax.x * along, cy - ax.y * along, cz - ax.z * along];
    };
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      crystalsB.tri(r0[i], r0[j], r1[i], { ...attrs, aH: [0, 0, 0.72] }, out(r0[i], r0[j], r1[i]));
      crystalsB.tri(r0[j], r1[j], r1[i], { ...attrs, aH: [0, 0.72, 0.72] }, out(r0[j], r1[j], r1[i]));
      crystalsB.tri(r1[i], r1[j], tip, { ...attrs, aH: [0.72, 0.72, 1] }, out(r1[i], r1[j], tip));
      crystalsB.tri(r0[i], bot, r0[j], { ...attrs, aH: [0, 0, 0] }, out(r0[i], bot, r0[j]));
    }
  }
  function crystalCluster(rnd, base, scale, isle, spread) {
    const hue = rnd() < 0.5 ? rnd() * 0.35 : 0.65 + rnd() * 0.35;
    const mainH = scale * (0.85 + rnd() * 0.3);
    addCrystal(base, [(rnd() - 0.5) * 0.2, 1, (rnd() - 0.5) * 0.2], mainH, mainH * 0.13, rnd() * E_TAU,
      { aHue: hue, aPhase: rnd(), aIsle: isle });
    const n = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * E_TAU + rnd() * 0.6;
      const d = spread * (0.35 + rnd() * 0.45);
      const tilt = 0.25 + rnd() * 0.45;
      const h = mainH * (0.3 + rnd() * 0.45);
      const b = [base[0] + Math.cos(a) * d, base[1] - 0.02, base[2] + Math.sin(a) * d];
      addCrystal(b, [Math.cos(a) * tilt, 1, Math.sin(a) * tilt], h, h * (0.13 + rnd() * 0.05), rnd() * E_TAU,
        { aHue: Math.min(1, Math.max(0, hue + (rnd() - 0.5) * 0.3)), aPhase: rnd(), aIsle: isle });
    }
    return hue;
  }

  // one floating landmass: domed mossy top, a rocky lip, and an underside tapering to a point
  function addLandmass({ c, R, depth, seed, isle, segs, flat }) {
    const rnd = mulberry32(seed);
    const [cx, cy, cz] = c;
    const ph = [rnd() * E_TAU, rnd() * E_TAU, rnd() * E_TAU];
    const outline = flat
      ? (a) => 1 + 0.06 * Math.sin(3 * a + ph[0]) + 0.04 * Math.sin(7 * a + ph[1]) + 0.02 * Math.sin(13 * a + ph[2])
      : (a) => 1 + 0.12 * Math.sin(3 * a + ph[0]) + 0.07 * Math.sin(5 * a + ph[1]) + 0.04 * Math.sin(9 * a + ph[2]);
    const rot = rnd() * E_TAU;
    const angles = Array.from({ length: segs }, (_, j) => rot + (j / segs) * E_TAU);
    const domeH = flat ? 0 : 0.18 * R;
    const topY = (f) => cy + domeH * (1 - f * f);
    const lip = 0.3 + 0.1 * R;
    const shade = () => rnd();
    const up = [0, 1, 0];
    const radial = (a, b, cc) => [(a[0] + b[0] + cc[0]) / 3 - cx, 0, (a[2] + b[2] + cc[2]) / 3 - cz];

    // --- top rings
    let rings;
    if (flat) {
      const radii = [1.6, 3.2, 4.8, 6.3, 7.5];
      rings = radii.map((r) => angles.map((a) => [cx + Math.sin(a) * r, cy, cz - Math.cos(a) * r]));
      rings.push(angles.map((a) => { const r = R * outline(a); return [cx + Math.sin(a) * r, cy - 0.08, cz - Math.cos(a) * r]; }));
    } else {
      rings = [0.45, 0.8, 1].map((f) => angles.map((a) => {
        const r = R * outline(a) * f;
        return [cx + Math.sin(a) * r, topY(f) + (f < 1 ? (rnd() - 0.5) * 0.06 * R : (rnd() - 0.5) * 0.04 * R), cz - Math.cos(a) * r];
      }));
    }
    const center = [cx, topY(0), cz];
    const topAttr = { aTop: 1, aIsle: isle, aDepth: 0 };
    for (let j = 0; j < segs; j++) {
      const k = (j + 1) % segs;
      terrainB.tri(center, rings[0][j], rings[0][k], { ...topAttr, aShade: shade() }, up);
      for (let r = 0; r + 1 < rings.length; r++) {
        const a0 = rings[r][j], a1 = rings[r][k], b0 = rings[r + 1][j], b1 = rings[r + 1][k];
        terrainB.tri(a0, b0, a1, { ...topAttr, aShade: shade() }, up);
        terrainB.tri(a1, b0, b1, { ...topAttr, aShade: shade() }, up);
      }
    }
    // --- lip + underside
    const edge = rings[rings.length - 1];
    const lipRing = edge.map((p) => [cx + (p[0] - cx) * 1.02, p[1] - lip, cz + (p[2] - cz) * 1.02]);
    const under = [lipRing];
    const fr = [0.93, 0.78, 0.58, 0.38, 0.18], fy = [0.1, 0.27, 0.5, 0.71, 0.89];
    for (let r = 0; r < fr.length; r++) {
      under.push(angles.map((a0) => {
        const a = a0 + (r + 1) * 0.07;
        const rr = R * outline(a) * fr[r] * (1 + (rnd() - 0.5) * 0.24);
        return [cx + Math.sin(a) * rr, cy - lip - depth * fy[r] + (rnd() - 0.5) * 0.06 * depth, cz - Math.cos(a) * rr];
      }));
    }
    const tip = [cx + (rnd() - 0.5) * R * 0.2, cy - lip - depth, cz + (rnd() - 0.5) * R * 0.2];
    const depthOf = (p) => Math.min(1, Math.max(0, (cy - p[1]) / (depth + lip)));
    const bands = [edge, ...under];
    for (let j = 0; j < segs; j++) {
      const k = (j + 1) % segs;
      for (let r = 0; r + 1 < bands.length; r++) {
        const a0 = bands[r][j], a1 = bands[r][k], b0 = bands[r + 1][j], b1 = bands[r + 1][k];
        terrainB.tri(a0, b0, a1, { aTop: 0, aIsle: isle, aShade: shade(), aDepth: [depthOf(a0), depthOf(b0), depthOf(a1)] }, radial(a0, b0, a1));
        terrainB.tri(a1, b0, b1, { aTop: 0, aIsle: isle, aShade: shade(), aDepth: [depthOf(a1), depthOf(b0), depthOf(b1)] }, radial(a1, b0, b1));
      }
      const last = under[under.length - 1];
      terrainB.tri(last[j], tip, last[k], { aTop: 0, aIsle: isle, aShade: shade(), aDepth: [depthOf(last[j]), 1, depthOf(last[k])] }, radial(last[j], tip, last[k]));
    }
    return { rnd, outline, topY, lip, under, angles };
  }

  function addRock(rnd, c, s, isle) { // small drifting rock: a jittered icosahedron
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const p = ico.attributes.position;
    const jit = new Map();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * E_TAU, rnd() * E_TAU, rnd() * E_TAU));
    const v = new THREE.Vector3();
    const pts = [];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
      if (!jit.has(key)) jit.set(key, 0.75 + rnd() * 0.5);
      v.multiplyScalar(s * jit.get(key)).applyQuaternion(q);
      v.y *= 0.7;
      pts.push([c[0] + v.x, c[1] + v.y, c[2] + v.z]);
    }
    ico.dispose();
    for (let i = 0; i < pts.length; i += 3) {
      const a = pts[i], b = pts[i + 1], cc = pts[i + 2];
      const out = [(a[0] + b[0] + cc[0]) / 3 - c[0], (a[1] + b[1] + cc[1]) / 3 - c[1], (a[2] + b[2] + cc[2]) / 3 - c[2]];
      const mossy = out[1] / (Math.hypot(...out) || 1) > 0.55 ? 1 : 0;
      terrainB.tri(a, b, cc, { aTop: mossy, aIsle: isle, aShade: rnd(), aDepth: mossy ? 0 : 0.35 }, out);
    }
  }

  // the rune circle's light on the floor is glow slot 0
  glowSlots.push({ pos: [0, 0.3, 0], radius: 3.2, kind: 'rune', strength: 0.3 });

  const teleportTargets = [];
  const colliderMat = track(new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  let rockIsle = 6;

  if (withGround) {
    addLandmass({ c: [0, -0.004, 0], R: GROUND_R, depth: 8, seed: 42, isle: 0, segs: 48, flat: true });
    const rnd = mulberry32(4242);
    for (const az of PLATFORM_CLUSTERS) {
      const a = (az + (rnd() - 0.5) * 10) * Math.PI / 180;
      const r = 7.0 + rnd() * 0.9;
      const base = [Math.sin(a) * r, -0.05, -Math.cos(a) * r];
      const hue = crystalCluster(rnd, base, 0.8 + rnd() * 0.6, 0, 0.55);
      glowSlots.push({ pos: [base[0], 0.35, base[2]], radius: 2.4, kind: 'crystal', hue, strength: 0.55 });
    }
    for (let i = 0; i < 7; i++) { // rocks drifting just past the edge
      const a = rnd() * E_TAU, r = 10.5 + rnd() * 3.5;
      addRock(rnd, [Math.sin(a) * r, -1.6 + rnd() * 3.4, -Math.cos(a) * r], 0.3 + rnd() * 0.6, rockIsle++);
    }
    const col = new THREE.Mesh(track(new THREE.CircleGeometry(GROUND_R * 0.88, 40)), colliderMat);
    col.rotation.x = -Math.PI / 2;
    col.userData = { teleport: true, kind: 'ground' };
    addObj(root, col, 'env-ground-collider');
    col.visible = false;
    teleportTargets.push(col);
  }

  ISLANDS.forEach((isl, i) => {
    const isle = i + 1;
    const L = addLandmass({ c: isl.c, R: isl.R, depth: isl.depth, seed: isl.seed, isle, segs: 22, flat: false });
    const rnd = L.rnd;
    // main crystal cluster near the middle of the top
    const a = rnd() * E_TAU, f = rnd() * 0.4;
    const r = isl.R * f;
    const base = [isl.c[0] + Math.sin(a) * r, L.topY(f) - 0.12, isl.c[2] - Math.cos(a) * r];
    const hue = crystalCluster(rnd, base, isl.R * (0.45 + rnd() * 0.15), isle, isl.R * 0.35);
    glowSlots.push({ pos: [base[0], base[1] + 0.5, base[2]], radius: isl.R * 0.95, kind: 'crystal', hue, strength: 0.6 });
    // a couple of lone crystals toward the rim
    for (let k = 0; k < 2; k++) {
      const a2 = rnd() * E_TAU, f2 = 0.55 + rnd() * 0.3;
      const h = 0.35 + rnd() * 0.4;
      addCrystal([isl.c[0] + Math.sin(a2) * isl.R * f2, L.topY(f2) - 0.1, isl.c[2] - Math.cos(a2) * isl.R * f2],
        [(rnd() - 0.5) * 0.5, 1, (rnd() - 0.5) * 0.5], h, h * 0.15, rnd() * E_TAU, { aHue: rnd(), aPhase: rnd(), aIsle: isle });
    }
    // crystals hanging from the underside
    const ringU2 = L.under[2];
    for (let k = 0; k < 3; k++) {
      const p = ringU2[Math.floor(rnd() * ringU2.length)];
      const inX = (isl.c[0] - p[0]) * 0.12, inZ = (isl.c[2] - p[2]) * 0.12;
      const h = 0.6 + rnd() * 0.8;
      addCrystal([p[0] + inX, p[1] + 0.15, p[2] + inZ], [(p[0] - isl.c[0]) * 0.05, -1, (p[2] - isl.c[2]) * 0.05],
        h, h * 0.14, rnd() * E_TAU, { aHue: rnd(), aPhase: rnd(), aIsle: isle });
    }
    // rocks drifting near the island
    for (let k = 0; k < 3; k++) {
      const a3 = rnd() * E_TAU, d = isl.R * (1.1 + rnd() * 0.6);
      addRock(rnd, [isl.c[0] + Math.sin(a3) * d, isl.c[1] - isl.depth * (0.15 + rnd() * 0.45), isl.c[2] - Math.cos(a3) * d],
        0.25 + rnd() * 0.45, rockIsle++);
    }
    const topH = L.topY(0);
    islandInfo.push({ center: [isl.c[0], topH, isl.c[2]], radius: isl.R });
    // collider follows the domed top (a lathe of topY), so a teleport lands on the surface, not above it
    const prof = [];
    for (let s = 0; s <= 6; s++) { const f = (s / 6) * 0.8; prof.push(new THREE.Vector2(Math.max(isl.R * f, 1e-3), L.topY(f) - isl.c[1])); }
    const col = new THREE.Mesh(track(new THREE.LatheGeometry(prof, 20)), colliderMat);
    col.position.set(isl.c[0], isl.c[1], isl.c[2]);
    col.userData = { teleport: true, kind: 'island', index: i };
    addObj(root, col, `env-island-collider-${i}`);
    col.visible = false;
    teleportTargets.push(col);
  });

  while (glowSlots.length < NGLOW) glowSlots.push({ pos: [1e4, 1e4, 1e4], radius: 1, kind: 'none', strength: 0 });
  if (glowSlots.length > NGLOW) glowSlots.length = NGLOW;
  const glowPts = glowSlots.map((s) => new THREE.Vector4(s.pos[0], s.pos[1], s.pos[2], s.radius));
  const glowCols = glowSlots.map(() => new THREE.Color(0, 0, 0));

  addObj(root, new THREE.Mesh(track(terrainB.build(THREE)), shader({
    vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS,
    uniforms: {
      ...pick('uMoss', 'uRock', 'uVein', 'uAmbSky', 'uAmbGround', 'uKey', 'uSunDir', 'uFogColor', 'uFogNear', 'uFogFar', 'uGlowMul', 'uTime', 'uNoise'),
      uGlowPts: { value: glowPts }, uGlowCols: { value: glowCols },
    },
  })), 'env-terrain');
  addObj(root, new THREE.Mesh(track(crystalsB.build(THREE)), shader({
    vertexShader: CRYSTAL_VS, fragmentShader: CRYSTAL_FS,
    uniforms: pick('uCrysA', 'uCrysB', 'uGlowMul', 'uTime', 'uFogColor', 'uFogNear', 'uFogFar'),
  })), 'env-crystals');

  // ================= FIREFLIES (one Points) =================
  {
    const rnd = mulberry32(99);
    const N = 360;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N * 4), size = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 2.4 + Math.pow(rnd(), 0.8) * 12, a = rnd() * E_TAU;
      pos[i * 3] = Math.sin(a) * r; pos[i * 3 + 1] = 0.3 + rnd() * 5.5; pos[i * 3 + 2] = -Math.cos(a) * r;
      for (let k = 0; k < 4; k++) seed[i * 4 + k] = rnd();
      size[i] = 0.05 + rnd() * 0.06 + (rnd() < 0.08 ? 0.05 : 0);
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    addObj(root, new THREE.Points(g, shader({
      vertexShader: FLY_VS, fragmentShader: FLY_FS,
      uniforms: pick('uTime', 'uDrift', 'uViewH', 'uFlies', 'uGlowMul', 'uFlyA', 'uFlyB', 'uFogNear', 'uFogFar'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })), 'env-fireflies');
  }

  // ================= RUNE CIRCLE at the user's feet =================
  {
    const S = 4.6;
    const m = shader({
      vertexShader: RUNE_VS, fragmentShader: RUNE_FS, uniforms: { ...pick('uTime', 'uGlowMul', 'uRune'), uSize: { value: S } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const rune = addObj(root, new THREE.Mesh(track(new THREE.PlaneGeometry(S, S)), m), 'env-rune-circle');
    rune.rotation.x = -Math.PI / 2;
    rune.position.y = 0.012;
  }

  // ================= SEA OF CLOUDS far below =================
  let clouds = null;
  if (withClouds) {
    const g = track(new THREE.CircleGeometry(88, 64));
    g.rotateX(-Math.PI / 2);
    clouds = addObj(root, new THREE.Mesh(g, shader({
      vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS,
      uniforms: pick('uMid', 'uHorizon', 'uBelow', 'uSunGlow', 'uSunDir', 'uSunGlowAmt', 'uTime', 'uClouds', 'uNoise'),
      transparent: true, depthWrite: false,
    })), 'env-clouds', -25);
    clouds.position.y = CLOUD_Y;
  }

  // ---------- fog + background (owned while not in AR) ----------
  const fog = new THREE.Fog(cur.fogColor.clone(), 10, 75);
  const bg = new THREE.Color();
  let arFlag = false;
  let arApplied = null; // last applied AR state (null = never)

  function isAR() {
    if (arFlag) return true;
    if (room.visible === false) return true;
    const xr = renderer && renderer.xr;
    if (xr && xr.isPresenting) {
      const s = typeof xr.getSession === 'function' ? xr.getSession() : null;
      if (s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque') return true;
    }
    return false;
  }
  function applyAR(ar) {
    if (ar) {
      root.visible = false;
      if (arApplied !== true) { scene.fog = null; scene.background = null; } // on entry: clear whatever is there
      else { if (scene.fog === fog) scene.fog = null; if (scene.background === bg) scene.background = null; }
    } else {
      root.visible = true;
      if (scene.fog !== fog) scene.fog = fog;
      if (scene.background !== bg) scene.background = bg;
    }
    arApplied = ar;
  }

  // ---------- live palette for the integrator (e.g. to tint main.js lights to the mood) ----------
  const palette = {
    skyTop: cur.top, skyMid: cur.mid, horizon: cur.horizon, fog: cur.fogColor, ambientSky: cur.ambSky,
    ambientGround: cur.ambGround, key: cur.key, rune: cur.rune, crystalA: cur.crysA, crystalB: cur.crysB,
    fireflyA: cur.flyA, fireflyB: cur.flyB, auroraA: cur.auroraA, auroraB: cur.auroraB,
  };

  // ---------- per-frame ----------
  let time = 0, driftPhase = 0;
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector2();
  const tmpC = new THREE.Color();

  function pushUniforms() {
    keyScaled.copy(cur.key).multiplyScalar(cur.keyAmt);
    hazeColor.copy(cur.horizon).lerp(cur.mid, 0.6);
    U.uSunGlowAmt.value = cur.sunGlowAmt; U.uStars.value = cur.stars; U.uBand.value = cur.band;
    U.uAurora.value = cur.aurora; U.uMeteors.value = cur.meteors; U.uFlies.value = cur.flies;
    U.uHaze.value = cur.haze; U.uCaustics.value = cur.caustics; U.uClouds.value = cur.clouds;
    U.uFogNear.value = cur.fogNear; U.uFogFar.value = Math.max(cur.fogFar, cur.fogNear + 1);
    U.uFogAmt.value = cur.fogAmt; U.uGlowMul.value = cur.glowMul;
    for (let i = 0; i < glowSlots.length; i++) {
      const s = glowSlots[i];
      if (s.kind === 'rune') glowCols[i].copy(cur.rune).multiplyScalar(s.strength);
      else if (s.kind === 'crystal') glowCols[i].copy(cur.crysA).lerp(tmpC.copy(cur.crysB), s.hue).multiplyScalar(s.strength);
    }
    fog.color.copy(cur.fogColor); fog.near = U.uFogNear.value; fog.far = U.uFogFar.value;
    bg.copy(cur.fogColor);
  }
  pushUniforms();
  applyAR(isAR());

  function update(dt = 0, t) {
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    time = Number.isFinite(t) ? t : time + dt;
    U.uTime.value = time;

    const k = 1 - Math.exp(-dt / MOOD_TAU);
    if (k > 0) {
      for (const key of COLOR_KEYS) cur[key].lerp(tgt[key], k);
      for (const key of NUM_KEYS) cur[key] += (tgt[key] - cur[key]) * k;
    }
    driftPhase += dt * cur.drift * 0.35; // unbounded on purpose: highp is fine for days, and any wrap would pop particles
    U.uDrift.value = driftPhase;
    pushUniforms();

    // viewport height in framebuffer pixels (per eye in XR) for correctly sized points
    let vh = 0;
    const xr = renderer && renderer.xr;
    if (xr && xr.isPresenting && typeof xr.getCamera === 'function') {
      const vp = xr.getCamera()?.cameras?.[0]?.viewport;
      if (vp && vp.w > 0) vh = vp.w;
    }
    if (!vh && renderer && typeof renderer.getDrawingBufferSize === 'function') vh = renderer.getDrawingBufferSize(tmpV2).y;
    if (!(vh > 0)) vh = 1000;
    U.uViewH.value = vh; U.uPx.value = vh / 1000;

    // sky layers follow the viewer (one frame behind; invisible at 45-60 m)
    if (haveCam) {
      tmpV.copy(camWorld);
      root.updateWorldMatrix(true, false);
      root.worldToLocal(tmpV);
      skyGroup.position.copy(tmpV);
      if (clouds) clouds.position.set(tmpV.x, CLOUD_Y, tmpV.z);
    }
    applyAR(isAR());
  }

  function setMood(m, { instant = false } = {}) {
    if (typeof m === 'string') m = { preset: m };
    if (m && typeof m === 'object') {
      const preset = typeof m.preset === 'string' && Object.prototype.hasOwnProperty.call(MOODS, m.preset) ? m.preset : mood.preset;
      mood = { preset, fog: num01(m.fog, mood.fog), glow: num01(m.glow, mood.glow) };
      computeTargets();
      if (instant) { snapMood(); pushUniforms(); }
    }
    return { ...mood };
  }

  function setAR(on) { arFlag = !!on; applyAR(isAR()); }

  function stats() {
    let drawCalls = 0, triangles = 0, points = 0;
    root.traverseVisible((o) => {
      if (!(o.isMesh || o.isPoints) || !o.material || o.material.visible === false) return;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position.count;
      drawCalls += (o.material.transparent && o.material.side === THREE.DoubleSide && !o.material.forceSinglePass) ? 2 : 1;
      if (o.isMesh) triangles += count / 3; else points += count;
    });
    return { drawCalls, triangles: Math.round(triangles), points };
  }

  function dispose() {
    if (scene.fog === fog) scene.fog = null;
    if (scene.background === bg) scene.background = null;
    room.remove(root);
    for (const d of disposables) d.dispose?.();
    disposables.length = 0;
  }

  return {
    setMood, update, setAR,
    getMood: () => ({ ...mood }),
    moods: MOOD_NAMES,
    object3d: root,
    palette,               // live THREE.Color refs of the current (lerped) mood
    teleportTargets,       // invisible flat colliders: ground platform + island tops (userData.teleport = true)
    islands: islandInfo,   // [{ center:[x,y,z] (top surface), radius }]
    groundRadius: withGround ? GROUND_R * 0.88 : 0,
    stats,
    dispose,
  };
}

export default createEnvironment;
