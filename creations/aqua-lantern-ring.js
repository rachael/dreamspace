// aqua-lantern-ring.js: a slowly turning ring of small glowing lanterns
export default function create({ THREE, scene, room, world, addUpdate }) {
  const root = new THREE.Group();
  root.position.set(-3.5, 0, -5);

  const COUNT = 16;
  const RADIUS = 1.5;
  const BASE_Y = 1.2;

  const body = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.07, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    COUNT
  );
  body.frustumCulled = false;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);

  const haloPos = new Float32Array(COUNT * 3);
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
  const haloMat = new THREE.PointsMaterial({
    map: tex,
    color: 0x6ee7ff,
    size: 0.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const halos = new THREE.Points(haloGeo, haloMat);
  halos.frustumCulled = false;

  const aqua = new THREE.Color('#6ee7ff');
  const violet = new THREE.Color('#b9a6ff');
  const tmp = new THREE.Color();
  const dummy = new THREE.Object3D();
  const angle = new Float32Array(COUNT);
  const phase = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    angle[i] = (i / COUNT) * Math.PI * 2;
    phase[i] = i * 0.7;
    tmp.copy(aqua).lerp(violet, i % 2 === 0 ? 0.0 : 0.5);
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
      haloPos[i * 3] = x;
      haloPos[i * 3 + 1] = y;
      haloPos[i * 3 + 2] = z;
    }
    body.instanceMatrix.needsUpdate = true;
    haloGeo.attributes.position.needsUpdate = true;
  }
  place(0);

  root.add(body, halos);

  addUpdate((dt, t) => {
    root.rotation.y += dt * 0.1;
    haloMat.opacity = 0.5 + Math.sin(t * 0.7) * 0.08;
    place(t);
  });

  return root;
}
