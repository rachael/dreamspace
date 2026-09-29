// lantern-ring.js: a slow ring of glowing paper lanterns
export default function create({ THREE, scene, room, world, addUpdate }) {
  const root = new THREE.Group();
  root.position.set(2.5, 0, -5);

  const COUNT = 12;
  const RADIUS = 2;
  const BASE_Y = 1.3;

  const body = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.13, 0.11, 0.3, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    COUNT
  );
  const cap = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09, 0.15, 0.04, 12),
    new THREE.MeshStandardMaterial({ color: 0x0a0f24, roughness: 0.7 }),
    COUNT
  );
  body.frustumCulled = false;
  cap.frustumCulled = false;

  // soft halo texture
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const halo = new THREE.CanvasTexture(canvas);

  const haloPos = new Float32Array(COUNT * 3);
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
  const haloMat = new THREE.PointsMaterial({
    map: halo,
    color: 0xff9a45,
    size: 1.0,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const halos = new THREE.Points(haloGeo, haloMat);
  halos.frustumCulled = false;

  const amber = new THREE.Color('#ffa54f');
  const rose = new THREE.Color('#ff9a7a');
  const tmp = new THREE.Color();
  const dummy = new THREE.Object3D();
  const phase = new Float32Array(COUNT);
  const angle = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    angle[i] = (i / COUNT) * Math.PI * 2;
    phase[i] = i * 0.9;
    tmp.copy(amber).lerp(rose, i % 3 === 0 ? 0.45 : 0.0);
    body.setColorAt(i, tmp);
  }
  body.instanceColor.needsUpdate = true;

  function place(t) {
    for (let i = 0; i < COUNT; i++) {
      const x = Math.cos(angle[i]) * RADIUS;
      const z = Math.sin(angle[i]) * RADIUS;
      const y = BASE_Y + Math.sin(t * 0.6 + phase[i]) * 0.05;
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, y + 0.17, z);
      dummy.updateMatrix();
      cap.setMatrixAt(i, dummy.matrix);
      haloPos[i * 3] = x;
      haloPos[i * 3 + 1] = y;
      haloPos[i * 3 + 2] = z;
    }
    body.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    haloGeo.attributes.position.needsUpdate = true;
  }
  place(0);

  root.add(body, cap, halos);

  addUpdate((dt, t) => {
    root.rotation.y += dt * 0.12;
    haloMat.opacity = 0.5 + Math.sin(t * 0.7) * 0.08;
    place(t);
  });

  return root;
}
