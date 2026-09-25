// pico-theme.js : the picoxr.com palette from pico.css, for three.js scenes.
// Values re-themed 2026-09-24 from picoxr.com/global; see the header of pico.css for SOURCE / DERIVED tags.
// three.js is passed in by the caller so this module works with any import path or CDN.

export const PICO = {
  bg:      '#000000', // [SOURCE] site black (hero, footer): scene background / fog colour
  surface: '#232526', // [SOURCE .media-modal-container] opaque twin of --pico-surface
  ink:     '#ffffff', // [SOURCE] hero text
  accent:  '#4200ff', // [SOURCE .button-container] PICO violet. 3D fills use the raw brand hex; CSS text uses the lifted #7458ff
  accent2: '#3d8bff', // [SOURCE .switch-button:checked] PICO blue
  glow:    '#a393ff', // [DERIVED] light tint of #4200ff for emissive rims
  danger:  '#ff4d4f', // [SOURCE .field-error]
};

// Background + linear fog in PICO.bg. Pass THREE (or have it on globalThis).
// In immersive-ar (passthrough) a background or fog would paint over the real room,
// so pass { ar: true } there: it clears both instead.
//   applyPicoFog(scene, THREE)                 // VR
//   applyPicoFog(scene, THREE, { ar: true })   // AR / passthrough
export function applyPicoFog(scene, THREE = globalThis.THREE, { near = 4, far = 18, ar = false } = {}) {
  if (ar) {
    scene.fog = null;
    scene.background = null;
    return scene;
  }
  if (!THREE) throw new Error('applyPicoFog(scene, THREE): pass your three.js namespace');
  scene.background = new THREE.Color(PICO.bg);
  scene.fog = new THREE.Fog(PICO.bg, near, far);
  return scene;
}

// Materials. kind: 'glass' | 'glow' | 'matte'. Extra options are merged into the parameters.
export function picoMaterial(THREE, kind = 'matte', opts = {}) {
  switch (kind) {
    case 'glass':
      // Dark translucent panel, the web stand-in for PICO's glass window material.
      return new THREE.MeshPhysicalMaterial({
        color: PICO.surface,
        transparent: true,
        opacity: 0.72,
        roughness: 0.35,
        metalness: 0.0,
        clearcoat: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
        ...opts,
      });
    case 'glow':
      // Unlit, so it reads the same in any lighting, and emissive-looking under bloom.
      return new THREE.MeshBasicMaterial({
        color: PICO.glow,
        transparent: true,
        opacity: 0.95,
        toneMapped: false,
        ...opts,
      });
    case 'matte':
    default:
      return new THREE.MeshStandardMaterial({
        color: PICO.accent,
        roughness: 0.8,
        metalness: 0.05,
        ...opts,
      });
  }
}
