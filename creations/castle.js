// castle.js: a walkable moonlit castle: open gate, lantern-lit courtyard, and a hall with columns, banners and a floating crystal
export default function create({ THREE, scene, room, world, addUpdate }) {
  const root = new THREE.Group();
  root.position.set(0, 0, 0.5);

  // procedural canvas textures (256 px), seeded so they never change between loads
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  function makeTex(draw) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d');
    draw(x);
    for (let i = 0; i < 900; i++) {
      x.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
      x.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    const tx = new THREE.CanvasTexture(c);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }
  function tint(tx, rx, ry) {
    const c = tx.clone();
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    return c;
  }

  // staggered stone blocks: 8 rows of 4 blocks
  const stoneTex = makeTex((x) => {
    x.fillStyle = '#56666c';
    x.fillRect(0, 0, 256, 256);
    const shade = [];
    for (let i = 0; i < 32; i++) shade.push(165 + rnd() * 55);
    for (let row = 0; row < 8; row++) {
      for (let k = -1; k < 5; k++) {
        const l = shade[row * 4 + ((k + 4) % 4)];
        x.fillStyle = 'rgb(' + ((l * 0.9) | 0) + ',' + (l | 0) + ',' + ((l + 6) | 0) + ')';
        x.fillRect(k * 64 + (row % 2) * 32 + 2, row * 32 + 2, 60, 28);
      }
    }
  });

  // flagstones: 4 x 4 slabs
  const flagTex = makeTex((x) => {
    x.fillStyle = '#4b5a66';
    x.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) {
        const l = 150 + rnd() * 60;
        x.fillStyle = 'rgb(' + ((l * 0.88) | 0) + ',' + ((l * 0.95) | 0) + ',' + (l | 0) + ')';
        x.fillRect(k * 64 + 2, r * 64 + 2, 60, 60);
      }
    }
  });

  // overlapping roof scales
  const roofTex = makeTex((x) => {
    x.fillStyle = '#5a4fa0';
    x.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 16; row++) {
      for (let k = -1; k < 9; k++) {
        const l = 170 + rnd() * 70;
        x.fillStyle = 'rgb(' + ((l * 0.85) | 0) + ',' + ((l * 0.8) | 0) + ',' + (l | 0) + ')';
        x.beginPath();
        x.arc(k * 32 + (row % 2) * 16 + 16, row * 16, 16, 0, Math.PI);
        x.fill();
        x.strokeStyle = 'rgba(30,20,80,0.55)';
        x.lineWidth = 2;
        x.stroke();
      }
    }
  });

  // walls are boxes of every size, so their uvs come from world-scale position (a block is always ~1 m)
  const stone = new THREE.MeshStandardMaterial({ color: 0x8fb8c4, map: stoneTex, roughness: 0.9, emissive: 0x0f4a5a, emissiveIntensity: 0.6, fog: false });
  stone.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' +
        'vec3 wp = position;\n' +
        '#ifdef USE_INSTANCING\n' +
        'wp = wp * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)) + instanceMatrix[3].xyz;\n' +
        '#endif\n' +
        'vec3 an = abs(normal);\n' +
        'vWUv = (an.x > an.y && an.x > an.z) ? wp.zy : ((an.y > an.z) ? wp.xz : wp.xy);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;')
      .replace('#include <map_fragment>', 'vec4 wtex = texture2D(map, vWUv * 0.25);\ndiffuseColor *= wtex;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= wtex.rgb;');
  };
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x8fb8c4, map: tint(stoneTex, 3, 2), roughness: 0.9, emissive: 0x0f4a5a, emissiveIntensity: 0.3, fog: false });
  const colMat = new THREE.MeshStandardMaterial({ color: 0xa5c4d0, map: tint(stoneTex, 1, 5), roughness: 0.8, emissive: 0x0f4a5a, emissiveIntensity: 0.3, fog: false });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9a86ee, map: tint(roofTex, 1.5, 1), roughness: 0.7, emissive: 0x3a2a8a, emissiveIntensity: 0.4, fog: false });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x7fa0b0, map: tint(flagTex, 4, 4), roughness: 1, emissive: 0x0a2530, emissiveIntensity: 0.35, fog: false });
  const hallFloorMat = new THREE.MeshStandardMaterial({ color: 0x7f8fe0, map: tint(flagTex, 2, 1.5), roughness: 0.8, emissive: 0x1a2656, emissiveIntensity: 0.35, fog: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb86b, fog: false });
  const bannerMat = new THREE.MeshStandardMaterial({ color: 0x6b4fd8, emissive: 0x4a34a8, emissiveIntensity: 0.6, side: THREE.DoubleSide, fog: false });
  const aquaMat = new THREE.MeshBasicMaterial({ color: 0x6ee7ff, fog: false });
  const lanternMat = new THREE.MeshBasicMaterial({ color: 0xffb86b, fog: false });

  const dummy = new THREE.Object3D();
  const box = new THREE.BoxGeometry(1, 1, 1);

  function setBox(mesh, i, x, y, z, sx, sy, sz) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  // courtyard walls (16 m square, gate gap 3 m at the front) and the hall walls
  const wallDefs = [
    [-4.75, 2.5, 8, 6.5, 5, 0.6],
    [4.75, 2.5, 8, 6.5, 5, 0.6],
    [0, 4.5, 8, 3, 1, 0.6],
    [0, 2.5, -8, 16, 5, 0.6],
    [-8, 2.5, 0, 0.6, 5, 16],
    [8, 2.5, 0, 0.6, 5, 16],
    // hall: back, sides, front with a 2 m door, lintel, ceiling
    [0, 2.5, -5, 8, 5, 0.4],
    [-4, 2.5, -2, 0.4, 5, 6.4],
    [4, 2.5, -2, 0.4, 5, 6.4],
    [-2.5, 2.5, 1, 3, 5, 0.4],
    [2.5, 2.5, 1, 3, 5, 0.4],
    [0, 4.0, 1, 2, 2, 0.4],
    [0, 5.2, -2, 8.6, 0.4, 6.6],
  ];
  const walls = new THREE.InstancedMesh(box, stone, wallDefs.length);
  wallDefs.forEach((d, i) => setBox(walls, i, d[0], d[1], d[2], d[3], d[4], d[5]));

  // corner towers with violet roofs
  const towers = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.3, 1.5, 8, 12), towerMat, 4);
  const roofs = new THREE.InstancedMesh(new THREE.ConeGeometry(1.9, 3, 12), roofMat, 4);
  [[8, 8], [-8, 8], [8, -8], [-8, -8]].forEach((c, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.position.set(c[0], 4, c[1]);
    dummy.updateMatrix();
    towers.setMatrixAt(i, dummy.matrix);
    dummy.position.set(c[0], 9.5, c[1]);
    dummy.updateMatrix();
    roofs.setMatrixAt(i, dummy.matrix);
  });

  const keepRoof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 3.4, 4), roofMat);
  keepRoof.position.set(0, 7.1, -2);
  keepRoof.rotation.y = Math.PI / 4;

  // floors
  const courtyard = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), floorMat);
  courtyard.rotation.x = -Math.PI / 2;
  const hallFloor = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 6), hallFloorMat);
  hallFloor.rotation.x = -Math.PI / 2;
  hallFloor.position.set(0, 0.02, -2);

  // hall columns
  const cols = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.34, 5, 10), colMat, 4);
  [[-2, -0.5], [2, -0.5], [-2, -3.5], [2, -3.5]].forEach((c, i) => {
    dummy.position.set(c[0], 2.5, c[1]);
    dummy.updateMatrix();
    cols.setMatrixAt(i, dummy.matrix);
  });

  // tall amber windows on the hall's back wall
  const wins = new THREE.InstancedMesh(box, glowMat, 3);
  setBox(wins, 0, -2.5, 2.6, -4.77, 0.7, 2, 0.06);
  setBox(wins, 1, 0, 3.0, -4.77, 0.7, 2.4, 0.06);
  setBox(wins, 2, 2.5, 2.6, -4.77, 0.7, 2, 0.06);

  // violet banners on the hall's side walls
  const banners = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.9, 2.4), bannerMat, 4);
  [[-3.78, -1.2, 1], [-3.78, -3.6, 1], [3.78, -1.2, -1], [3.78, -3.6, -1]].forEach((b, i) => {
    dummy.position.set(b[0], 2.8, b[1]);
    dummy.rotation.set(0, b[2] * Math.PI / 2, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    banners.setMatrixAt(i, dummy.matrix);
  });

  // dais and floating crystal
  const dais = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.3, 16), towerMat);
  dais.position.set(0, 0.17, -3.9);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), aquaMat);
  crystal.scale.y = 1.6;

  // lanterns with soft halos
  const lanternPos = [
    [-7.2, 2.2, 5], [-7.2, 2.2, 0], [-7.2, 2.2, -5],
    [7.2, 2.2, 5], [7.2, 2.2, 0], [7.2, 2.2, -5],
    [-1.9, 3.4, 7.4], [1.9, 3.4, 7.4],
    [-2, 3.6, -0.5], [2, 3.6, -0.5], [-2, 3.6, -3.5], [2, 3.6, -3.5],
  ];
  const LC = lanternPos.length;
  const lanterns = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 12, 10), lanternMat, LC);
  const haloPos = new Float32Array((LC + 1) * 3);
  lanternPos.forEach((p, i) => {
    dummy.position.set(p[0], p[1], p[2]);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    lanterns.setMatrixAt(i, dummy.matrix);
    haloPos[i * 3] = p[0];
    haloPos[i * 3 + 1] = p[1];
    haloPos[i * 3 + 2] = p[2];
  });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
  const haloMat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(canvas),
    color: 0xffa54f,
    size: 1.1,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const halos = new THREE.Points(haloGeo, haloMat);

  [walls, towers, roofs, cols, wins, banners, lanterns, keepRoof, courtyard, hallFloor, dais, crystal, halos]
    .forEach((m) => { m.frustumCulled = false; });
  root.add(walls, towers, roofs, keepRoof, courtyard, hallFloor, cols, wins, banners, dais, crystal, lanterns, halos);

  const CRYSTAL_Y = 1.5;
  addUpdate((dt, t) => {
    const y = CRYSTAL_Y + Math.sin(t * 0.7) * 0.06;
    crystal.position.set(0, y, -3.9);
    crystal.rotation.y += dt * 0.25;
    haloPos[LC * 3] = 0;
    haloPos[LC * 3 + 1] = y;
    haloPos[LC * 3 + 2] = -3.9;
    haloGeo.attributes.position.needsUpdate = true;
    haloMat.opacity = 0.48 + Math.sin(t * 0.6) * 0.08;
    glowMat.color.setRGB(1, 0.72 + Math.sin(t * 0.5) * 0.04, 0.42);
    roofMat.emissiveIntensity = 0.5 + Math.sin(t * 0.4) * 0.1;
  });

  return root;
}
