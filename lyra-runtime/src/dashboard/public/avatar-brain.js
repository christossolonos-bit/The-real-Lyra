/**
 * Luna's living cortex — anatomical brain silhouette of firing neurons + synapses.
 * Every real process (hearing, memory, think, feel, voice, tools…) cascades in its lobe.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Subsystems mapped onto cortex regions. */
const SYSTEMS = [
  // Saturated neon accents — resting tissue stays near-black; fire uses these hues.
  { id: 'hearing', label: 'Hearing', detail: 'mic · Whisper STT', color: 0x0ea5e9, kind: 'word' },
  { id: 'intake', label: 'Intake', detail: 'your message', color: 0x6366f1, kind: 'word' },
  { id: 'memory', label: 'Memory', detail: 'recall · contacts', color: 0x14b8a6, kind: 'think' },
  { id: 'brain', label: 'Thoughts', detail: 'LLM compose', color: 0x7c3aed, kind: 'think' },
  { id: 'plan', label: 'Planner', detail: 'which tools to use', color: 0xa78bfa, kind: 'think' },
  { id: 'voice', label: 'Voice', detail: 'Fish Audio TTS', color: 0xe11d48, kind: 'speak' },
  { id: 'lips', label: 'Lips', detail: 'viseme track', color: 0xdb2777, kind: 'speak' },
  { id: 'feelings', label: 'Feelings', detail: 'emotion blend', color: 0xd97706, kind: 'feel' },
  { id: 'pressure', label: 'Pressure', detail: 'mood buckets', color: 0xc026d3, kind: 'feel' },
  { id: 'body', label: 'Body', detail: 'Rocketbox motion', color: 0x2563eb, kind: 'tool' },
  { id: 'music', label: 'Music', detail: 'YT · Spotify · radio', color: 0x059669, kind: 'tool' },
  { id: 'images', label: 'Images', detail: 'generate_image', color: 0xea580c, kind: 'tool' },
  { id: 'files', label: 'Files', detail: 'files · send_file', color: 0x65a30d, kind: 'tool' },
  { id: 'presence', label: 'Presence', detail: 'Discord · studio', color: 0x4c1d95, kind: 'default' },
  { id: 'self', label: 'Self', detail: 'code · logs · map', color: 0xc2410c, kind: 'tool' },
  { id: 'faults', label: 'Faults', detail: 'errors · retries', color: 0xb91c1c, kind: 'default' },
];

const BY_ID = Object.fromEntries(SYSTEMS.map((s) => [s.id, s]));
const KIND_SYSTEM = {
  think: 'brain', word: 'hearing', feel: 'feelings', speak: 'voice', tool: 'files', default: 'presence',
};

function inferSystem(kind, label = '') {
  const L = String(label).toLowerCase();
  if (/heard|mic|stt|transcri|listen|hands-free/.test(L)) return 'hearing';
  if (/compos|llm|thinking|cortex|watching/.test(L)) return 'brain';
  if (/plan|tool pick|chat only|choosing/.test(L)) return 'plan';
  if (/memory|recall|remember/.test(L)) return 'memory';
  if (/affect|feel|emotion|curious|pensive|joy|sad|mood/.test(L)) return 'feelings';
  if (/pressure|bucket/.test(L)) return 'pressure';
  if (/music|spotify|youtube|radio|song/.test(L)) return 'music';
  if (/image|draw|picture/.test(L)) return 'images';
  if (/file|send_file|project/.test(L)) return 'files';
  if (/wave|dance|shrug|nod|body|rocket|gesture|tilt/.test(L)) return 'body';
  if (/self|architect|log|source/.test(L)) return 'self';
  if (/error|fail|fault/.test(L)) return 'faults';
  if (/speak|saying|tts|fish|voice|reply ready|viseme/.test(L) || kind === 'speak') return kind === 'speak' && /viseme|lip/.test(L) ? 'lips' : 'voice';
  return KIND_SYSTEM[kind] || 'brain';
}

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function fbm(x, y, z) {
  let v = 0, a = 0.5;
  for (let i = 0; i < 5; i++) {
    v += a * hash3(x, y, z);
    x = x * 2.03 + 17; y = y * 2.03 - 9; z = z * 2.03 + 3;
    a *= 0.5;
  }
  return v;
}

/** Anatomical brain SDF — hemispheres, fissure, temporal lobes, cerebellum, stem. */
function brainField(x, y, z) {
  const ax = Math.abs(x);
  // Longitudinal fissure: pull hemispheres apart at midline.
  const hx = ax - 0.18;
  const cx = hx / 1.02;
  const cy = (y - 0.05) / 0.78;
  const cz = (z + 0.02) / 0.95;
  let d = cx * cx * 1.05 + cy * cy + cz * cz * 0.92;
  // Frontal pole
  d -= 0.16 * Math.max(0, cy + 0.45) * Math.max(0, 0.55 - cz);
  // Occipital bulge
  d -= 0.14 * Math.max(0, -cz - 0.1) * (1 - Math.abs(cy) * 0.55);
  // Parietal loft
  d -= 0.08 * Math.max(0, cy - 0.15) * (1 - Math.abs(cz));
  // Temporal lobe drop
  const tcx = (ax - 0.62) / 0.5;
  const tcy = (y + 0.38) / 0.45;
  const tcz = (z - 0.08) / 0.5;
  d = Math.min(d, (tcx * tcx + tcy * tcy + tcz * tcz) * 0.88 + 0.1);
  const hemi = 1.12 - d;

  const cere = 0.9 - ((ax / 0.62) ** 2 + ((y + 0.62) / 0.32) ** 2 + ((z + 0.62) / 0.45) ** 2);
  const stem = 0.75 - ((x / 0.14) ** 2 + ((y + 0.78) / 0.4) ** 2 + ((z + 0.1) / 0.14) ** 2);
  return Math.max(hemi, cere * 0.95, stem * 0.6);
}

function systemAt(x, y, z) {
  const ax = Math.abs(x);
  if (y < -0.58) return 'faults';
  if (y < -0.45 && z < -0.1) return 'self';
  if (z < -0.5) return 'memory';
  if (ax > 0.6 && y < 0.05) return 'hearing';
  if (ax > 0.52 && y > 0.12 && z > -0.05) return 'music';
  if (z > 0.45 && y > 0.12) return 'plan';
  if (z > 0.3 && y > 0.02) return 'brain';
  if (z > 0.22 && y < 0.02) return 'voice';
  if (z > 0.05 && y < -0.12 && ax < 0.48) return 'lips';
  if (ax < 0.3 && Math.abs(y) < 0.32 && Math.abs(z) < 0.38) return 'feelings';
  if (ax < 0.42 && y > 0 && z < 0.12) return 'pressure';
  if (y > 0.45) return 'body';
  if (ax > 0.38 && z > 0.12 && y > 0.12) return 'files';
  if (ax > 0.32 && y > 0.22 && z < 0.05) return 'images';
  if (ax < 0.38 && z > 0.12) return 'intake';
  if (hash3(x * 2, y, z) > 0.78) return 'presence';
  return y > 0.08 ? 'brain' : 'memory';
}

function buildCloud(count = 3200) {
  const positions = [];
  const colors = [];
  const systems = [];
  const bySystem = Object.fromEntries(SYSTEMS.map((s) => [s.id, []]));
  let n = 0;
  for (let t = 0; t < count * 55 && n < count; t++) {
    const x = (Math.random() * 2 - 1) * 1.35;
    const y = (Math.random() * 2 - 1) * 1.15;
    const z = (Math.random() * 2 - 1) * 1.25;
    const field = brainField(x, y, z);
    if (field <= 0.015) continue;
    // Bias to cortical shell for gyri silhouette.
    const shellBias = field < 0.38 || Math.random() < 0.28;
    if (!shellBias && Math.random() > 0.22) continue;

    // Stronger gyri / sulci displacement.
    const fold = (fbm(x * 4.2, y * 4.2, z * 4.2) - 0.5);
    const ridge = (fbm(x * 7.1 + 3, y * 7.1, z * 7.1) - 0.5) * 0.08;
    const px = x * (1 + fold * 0.08) + ridge * Math.sign(x || 1) * 0.3;
    const py = y + fold * 0.55 + ridge * 0.4;
    const pz = z + fold * 0.28 + ridge * 0.2;
    if (brainField(px, py, pz) <= 0) continue;

    const sid = systemAt(px, py, pz);
    const col = new THREE.Color(BY_ID[sid]?.color ?? 0x4c1d95);
    // Dark tissue: mostly charcoal with a faint region tint (never bright/white at rest).
    const depth = Math.min(1, field * 2.2);
    const tint = 0.045 + 0.11 * depth;
    const base = 0.035 + 0.04 * depth;
    positions.push(px, py, pz);
    colors.push(base + col.r * tint, base + col.g * tint, base + col.b * tint * 1.05);
    systems.push(sid);
    bySystem[sid]?.push(n);
    n++;
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    systems,
    bySystem,
    count: n,
  };
}

/** Spatial-hash kNN — fast enough for thousands of neurons. */
function buildEdges(positions, count, k = 5, maxDist = 0.32) {
  const cell = maxDist;
  const grid = new Map();
  const key = (ix, iy, iz) => `${ix}|${iy}|${iz}`;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const p = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    pts.push(p);
    const ix = Math.floor(p.x / cell);
    const iy = Math.floor(p.y / cell);
    const iz = Math.floor(p.z / cell);
    const kk = key(ix, iy, iz);
    if (!grid.has(kk)) grid.set(kk, []);
    grid.get(kk).push(i);
  }
  const pairs = new Set();
  const edges = [];
  const maxD2 = maxDist * maxDist;
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    const ix = Math.floor(p.x / cell);
    const iy = Math.floor(p.y / cell);
    const iz = Math.floor(p.z / cell);
    const cand = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(key(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const d2 = p.distanceToSquared(pts[j]);
            if (d2 <= maxD2) cand.push({ j, d2 });
          }
        }
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    for (let n = 0; n < Math.min(k, cand.length); n++) {
      const j = cand[n].j;
      const pk = `${i}:${j}`;
      if (pairs.has(pk)) continue;
      pairs.add(pk);
      edges.push(i, j);
    }
  }
  return { edges, pts };
}

export function createBrainViz(root) {
  const canvas = root.querySelector('canvas') || Object.assign(document.createElement('canvas'), { className: 'brain-canvas' });
  if (!canvas.parentNode) root.insertBefore(canvas, root.querySelector('.brain-log'));

  let hud = root.querySelector('.brain-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.className = 'brain-hud';
    hud.innerHTML = `
      <div class="brain-status">
        <div class="brain-quiet" id="brainQuiet">quiet</div>
        <div class="brain-sub" id="brainSub">resting potential — waiting for a turn</div>
      </div>
      <ul class="brain-legend">${SYSTEMS.map((s) => `
        <li data-sys="${s.id}" title="${s.detail}"><i style="background:#${s.color.toString(16).padStart(6, '0')}"></i>${s.label}</li>
      `).join('')}</ul>
      <div class="brain-foot">drag to turn · wheel to zoom</div>
    `;
    root.insertBefore(hud, root.querySelector('.brain-log'));
  }
  const quietEl = hud.querySelector('#brainQuiet');
  const subEl = hud.querySelector('#brainSub');
  const logEl = root.querySelector('.brain-log');
  const legendItems = [...hud.querySelectorAll('.brain-legend li')];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0.35, 0.55, 3.8);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxDistance = 7.5;
  controls.target.set(0, 0.02, 0);
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  scene.add(new THREE.AmbientLight(0x1e1b4b, 0.22));
  const key = new THREE.PointLight(0x4c1d95, 0.55, 14);
  key.position.set(2.2, 2.6, 3.2);
  scene.add(key);
  const fill = new THREE.PointLight(0x0e7490, 0.2, 12);
  fill.position.set(-2.5, -0.5, 1.5);
  scene.add(fill);

  const brain = new THREE.Group();
  scene.add(brain);

  // Build dense cortex
  const cloud = buildCloud(3400);
  const { edges, pts } = buildEdges(cloud.positions, cloud.count, 5, 0.3);
  const baseColors = cloud.colors.slice();
  const fire = new Float32Array(cloud.count); // per-neuron excitation 0..1

  // --- Base neurons (region-colored)
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(cloud.colors.slice(), 3));
  const colorAttr = nodeGeo.getAttribute('color');
  const nodeMat = new THREE.PointsMaterial({
    size: 0.024,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    sizeAttenuation: true,
  });
  brain.add(new THREE.Points(nodeGeo, nodeMat));

  // Compact hot buffer — colored fire only (no white wash).
  const sparkPosArr = new Float32Array(cloud.count * 3);
  const sparkColArr = new Float32Array(cloud.count * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPosArr, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkColArr, 3));
  sparkGeo.setDrawRange(0, 0);
  const sparkMat = new THREE.PointsMaterial({
    size: 0.07,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
  });
  brain.add(new THREE.Points(sparkGeo, sparkMat));

  // --- Synapses
  const numEdges = edges.length / 2;
  const seg = new Float32Array(numEdges * 6);
  const edgePairs = [];
  for (let e = 0; e < numEdges; e++) {
    const i = edges[e * 2];
    const j = edges[e * 2 + 1];
    edgePairs.push([i, j]);
    const o = e * 6;
    seg[o] = cloud.positions[i * 3];
    seg[o + 1] = cloud.positions[i * 3 + 1];
    seg[o + 2] = cloud.positions[i * 3 + 2];
    seg[o + 3] = cloud.positions[j * 3];
    seg[o + 4] = cloud.positions[j * 3 + 1];
    seg[o + 5] = cloud.positions[j * 3 + 2];
  }
  const synapseGeo = new THREE.BufferGeometry();
  synapseGeo.setAttribute('position', new THREE.BufferAttribute(seg, 3));
  // Per-vertex colors so firing edges can glow
  const SYN_REST = [0.08, 0.1, 0.16];
  const synColors = new Float32Array(numEdges * 6);
  for (let i = 0; i < synColors.length; i += 3) {
    synColors[i] = SYN_REST[0]; synColors[i + 1] = SYN_REST[1]; synColors[i + 2] = SYN_REST[2];
  }
  synapseGeo.setAttribute('color', new THREE.BufferAttribute(synColors, 3));
  const synColorAttr = synapseGeo.getAttribute('color');
  const synapseMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  brain.add(new THREE.LineSegments(synapseGeo, synapseMat));

  // Adjacency for cascade
  const adj = Array.from({ length: cloud.count }, () => []);
  for (const [i, j] of edgePairs) {
    adj[i].push(j);
    adj[j].push(i);
  }

  // System hubs (subtle organs)
  const hubMeshes = {};
  const hubs = new THREE.Group();
  brain.add(hubs);
  for (const s of SYSTEMS) {
    const idxs = cloud.bySystem[s.id] || [];
    if (idxs.length < 8) continue;
    const c = new THREE.Vector3();
    for (const i of idxs) c.add(pts[i]);
    c.multiplyScalar(1 / idxs.length);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 10),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    mesh.position.copy(c);
    hubs.add(mesh);
    hubMeshes[s.id] = { mesh, base: 0.12, idxs, color: new THREE.Color(s.color), pos: c.clone() };
  }

  // Structural pathways
  const PATH_LINKS = [
    ['hearing', 'intake'], ['intake', 'memory'], ['memory', 'brain'],
    ['brain', 'plan'], ['brain', 'feelings'], ['feelings', 'pressure'],
    ['plan', 'voice'], ['brain', 'voice'], ['voice', 'lips'],
    ['plan', 'music'], ['plan', 'images'], ['plan', 'files'],
    ['brain', 'body'], ['self', 'brain'], ['faults', 'brain'],
  ];
  const pathEdges = [];
  const pathGroup = new THREE.Group();
  brain.add(pathGroup);
  for (const [a, b] of PATH_LINKS) {
    const ha = hubMeshes[a];
    const hb = hubMeshes[b];
    if (!ha || !hb) continue;
    const geo = new THREE.BufferGeometry().setFromPoints([ha.pos, hb.pos]);
    const mat = new THREE.LineBasicMaterial({ color: 0x312e81, transparent: true, opacity: 0.1, depthWrite: false });
    pathGroup.add(new THREE.Line(geo, mat));
    pathEdges.push({ a, b, mat, glow: 0 });
  }

  const sysGlow = new Map();
  const travelers = [];
  const sparkPool = [];
  let pathAnim = null;
  let resting = true;

  function setStatus(sys, label) {
    const s = BY_ID[sys];
    if (quietEl) {
      quietEl.textContent = s?.label || (sys ? sys : 'quiet');
      quietEl.classList.toggle('hot', Boolean(sys));
    }
    if (subEl) {
      subEl.textContent = sys
        ? `${s?.detail || ''}${label ? ` · ${label}` : ''}`
        : 'resting potential — waiting for a turn';
    }
    for (const li of legendItems) li.classList.toggle('on', li.dataset.sys === sys);
  }

  function resize() {
    const w = root.clientWidth || 480;
    const h = Math.max(200, (root.clientHeight || 360) - 120);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function allocMesh(color) {
    const hex = typeof color === 'number' ? color : (color?.getHex?.() ?? 0xa855f7);
    let m = sparkPool.pop();
    if (!m) {
      m = new THREE.Mesh(
        new THREE.SphereGeometry(0.028, 8, 8),
        new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
    } else {
      m.material.color.setHex(hex);
      m.material.opacity = 1;
    }
    return m;
  }

  function excite(idx, amount, color) {
    fire[idx] = Math.min(1.4, fire[idx] + amount);
    if (color) {
      // Pull base color toward fire color while excited
      const t = Math.min(1, amount);
      colorAttr.setX(idx, colorAttr.getX(idx) * (1 - t * 0.3) + color.r * t);
      colorAttr.setY(idx, colorAttr.getY(idx) * (1 - t * 0.3) + color.g * t);
      colorAttr.setZ(idx, colorAttr.getZ(idx) * (1 - t * 0.3) + color.b * t);
    }
  }

  function pulseEdge(a, b, amount = 1) {
    for (const e of pathEdges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) e.glow = Math.max(e.glow, amount);
    }
  }

  function pathway(systems = [], opts = {}) {
    const seq = systems.filter((id) => BY_ID[id] && hubMeshes[id]);
    if (!seq.length) return;
    pathAnim = { systems: seq, i: 0, at: performance.now(), label: opts.label };
    if (logEl && opts.label) {
      const row = document.createElement('div');
      row.className = 'spark-row think';
      row.innerHTML = `<span class="spark-dot" style="background:#a855f7"></span><b>Path</b> ${opts.label}: ${seq.join(' → ')}`;
      logEl.prepend(row);
      while (logEl.children.length > 18) logEl.lastChild.remove();
    }
    spark({ system: seq[0], kind: 'think', label: opts.label || seq[0], intensity: 1, silent: true });
  }

  /**
   * Fire a real process into its cortical region — neurons cascade along synapses.
   * @param {{ kind?: string, system?: string, label?: string, intensity?: number, silent?: boolean, from?: string }} ev
   */
  function spark(ev = {}) {
    const kind = ev.kind || 'default';
    const sys = ev.system || inferSystem(kind, ev.label);
    const meta = BY_ID[sys] || BY_ID.brain;
    const intensity = Math.min(1.6, Math.max(0.35, ev.intensity ?? 0.9));
    const idxs = cloud.bySystem[sys] || [];
    if (!idxs.length) return;

    resting = false;
    sysGlow.set(sys, Math.max(sysGlow.get(sys) || 0, 0.85 + intensity * 0.5));
    setStatus(sys, ev.label || meta.detail);

    const col = new THREE.Color(meta.color);
    // Seed burst: excite a cluster of neurons in this lobe
    const seeds = Math.max(6, Math.round(14 * intensity));
    const seedIdx = [];
    for (let s = 0; s < seeds; s++) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      excite(i, 0.7 + intensity * 0.5, col);
      seedIdx.push(i);
    }
    colorAttr.needsUpdate = true;

    // Synaptic cascades from seeds
    const waves = Math.max(2, Math.round(3 + intensity * 4));
    for (let w = 0; w < waves; w++) {
      const start = seedIdx[w % seedIdx.length];
      const path = [start];
      let cur = start;
      for (let step = 0; step < 6 + Math.floor(intensity * 5); step++) {
        const nbrs = adj[cur];
        if (!nbrs.length) break;
        // Prefer same-system neighbors, else any
        const same = nbrs.filter((j) => cloud.systems[j] === sys && !path.includes(j));
        const pool = same.length ? same : nbrs.filter((j) => !path.includes(j));
        const next = (pool.length ? pool : nbrs)[Math.floor(Math.random() * (pool.length || nbrs.length))];
        path.push(next);
        cur = next;
      }
      travelers.push({
        path,
        life: 0,
        max: 0.55 + Math.random() * 0.55,
        color: meta.color,
        intensity,
        system: sys,
        mesh: null,
        delay: w * 0.05,
      });
    }

    // Hub-to-hub packet
    if (ev.from && hubMeshes[ev.from] && hubMeshes[sys]) {
      travelers.push({
        pathHubs: [ev.from, sys],
        life: 0,
        max: 0.5,
        color: meta.color,
        intensity,
        system: sys,
        mesh: null,
        delay: 0,
      });
      pulseEdge(ev.from, sys, 1.3);
    }

    for (const e of pathEdges) {
      if (e.a === sys && sysGlow.has(e.b)) pulseEdge(e.a, e.b, 0.95);
      if (e.b === sys && sysGlow.has(e.a)) pulseEdge(e.a, e.b, 0.95);
    }

    if (logEl && ev.label && !ev.silent) {
      const row = document.createElement('div');
      row.className = `spark-row ${kind}`;
      row.innerHTML = `<span class="spark-dot" style="background:#${meta.color.toString(16).padStart(6, '0')}"></span><b>${meta.label}</b> ${ev.label}`;
      logEl.prepend(row);
      while (logEl.children.length > 18) logEl.lastChild.remove();
    }
    synapseMat.opacity = Math.min(0.55, 0.22 + intensity * 0.2);
  }

  let raf = 0;
  let last = performance.now();
  let active = false;
  let quietAt = 0;

  function frame(now) {
    if (!active) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    // --- Resting potential: tiny spontaneous spikes across cortex
    if (resting || sysGlow.size === 0) {
      const nRest = 3 + Math.floor(Math.random() * 4);
      for (let r = 0; r < nRest; r++) {
        const i = Math.floor(Math.random() * cloud.count);
        if (fire[i] < 0.15) fire[i] = 0.25 + Math.random() * 0.25;
      }
    }
    // Active lobes keep a higher spontaneous rate
    for (const [sys, g] of sysGlow) {
      if (g < 0.05) continue;
      const idxs = cloud.bySystem[sys] || [];
      const n = Math.max(1, Math.floor(idxs.length * 0.004 * g));
      for (let r = 0; r < n; r++) {
        const i = idxs[Math.floor(Math.random() * idxs.length)];
        fire[i] = Math.min(1.2, fire[i] + 0.35 + Math.random() * 0.4);
      }
    }

    // Decay fire + rebuild spark draw list + synapse colors
    let sparkN = 0;
    let anyFire = false;
    for (let i = 0; i < cloud.count; i++) {
      if (fire[i] > 0.001) {
        anyFire = true;
        fire[i] *= Math.exp(-dt * 2.8);
        const f = fire[i];
        const sid = cloud.systems[i];
        const accent = BY_ID[sid]?.color ?? 0x7c3aed;
        const ar = ((accent >> 16) & 255) / 255;
        const ag = ((accent >> 8) & 255) / 255;
        const ab = (accent & 255) / 255;
        // Lift toward region neon — never add white.
        const br = baseColors[i * 3];
        const bg = baseColors[i * 3 + 1];
        const bb = baseColors[i * 3 + 2];
        const t = Math.min(1, f * 1.15);
        colorAttr.setXYZ(
          i,
          br + (ar * 0.75 - br) * t,
          bg + (ag * 0.75 - bg) * t,
          bb + (ab * 0.75 - bb) * t,
        );
        if (f > 0.18) {
          const o = sparkN * 3;
          sparkPosArr[o] = cloud.positions[i * 3];
          sparkPosArr[o + 1] = cloud.positions[i * 3 + 1];
          sparkPosArr[o + 2] = cloud.positions[i * 3 + 2];
          const glow = 0.35 + f * 0.45;
          sparkColArr[o] = Math.min(0.92, ar * glow);
          sparkColArr[o + 1] = Math.min(0.92, ag * glow);
          sparkColArr[o + 2] = Math.min(0.92, ab * glow);
          sparkN++;
        }
      } else if (fire[i] !== 0) {
        fire[i] = 0;
        colorAttr.setXYZ(i, baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
      }
    }
    if (anyFire) colorAttr.needsUpdate = true;
    sparkGeo.setDrawRange(0, sparkN);
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.attributes.color.needsUpdate = true;
    sparkMat.size = 0.055 + Math.min(0.04, sparkN * 0.00003);

    // Synapse glow when either end is firing — tinted, never white.
    let synDirty = false;
    for (let e = 0; e < edgePairs.length; e++) {
      const [i, j] = edgePairs[e];
      const f = Math.max(fire[i], fire[j]);
      const o = e * 6;
      if (f > 0.12) {
        const hot = fire[i] >= fire[j] ? i : j;
        const accent = BY_ID[cloud.systems[hot]]?.color ?? 0x7c3aed;
        const ar = ((accent >> 16) & 255) / 255;
        const ag = ((accent >> 8) & 255) / 255;
        const ab = (accent & 255) / 255;
        const g = 0.2 + f * 0.55;
        synColorAttr.setXYZ(o / 3, ar * g, ag * g, ab * g);
        synColorAttr.setXYZ(o / 3 + 1, ar * g, ag * g, ab * g);
        synDirty = true;
      } else if (synColorAttr.getX(o / 3) > SYN_REST[0] + 0.02) {
        synColorAttr.setXYZ(o / 3, SYN_REST[0], SYN_REST[1], SYN_REST[2]);
        synColorAttr.setXYZ(o / 3 + 1, SYN_REST[0], SYN_REST[1], SYN_REST[2]);
        synDirty = true;
      }
    }
    if (synDirty) synColorAttr.needsUpdate = true;
    synapseMat.opacity += ((anyFire ? 0.38 : 0.22) - synapseMat.opacity) * Math.min(1, dt * 3);

    // System glow decay
    for (const [sys, g] of [...sysGlow.entries()]) {
      const next = g - dt * 0.65;
      const hub = hubMeshes[sys];
      if (next <= 0.02) {
        sysGlow.delete(sys);
        if (hub) {
          hub.mesh.material.opacity = hub.base;
          hub.mesh.scale.setScalar(1);
        }
      } else {
        sysGlow.set(sys, next);
        if (hub) {
          hub.mesh.material.opacity = hub.base + next * 0.55;
          hub.mesh.scale.setScalar(1 + next * 1.1);
        }
      }
    }

    // Pathway animation
    if (pathAnim) {
      const stepMs = 340;
      const nextI = Math.floor((now - pathAnim.at) / stepMs);
      while (pathAnim.i < nextI && pathAnim.i + 1 < pathAnim.systems.length) {
        const from = pathAnim.systems[pathAnim.i];
        const to = pathAnim.systems[pathAnim.i + 1];
        pathAnim.i += 1;
        spark({ system: to, from, kind: 'think', label: pathAnim.label ? `${pathAnim.label} · ${to}` : to, intensity: 0.95, silent: true });
        pulseEdge(from, to, 1.3);
      }
      if (pathAnim.i >= pathAnim.systems.length - 1 && now - pathAnim.at > stepMs * pathAnim.systems.length) {
        pathAnim = null;
      }
    }
    for (const e of pathEdges) {
      e.glow = Math.max(0, e.glow - dt * 0.65);
      e.mat.opacity = 0.08 + e.glow * 0.45;
      e.mat.color.setHex(e.glow > 0.15 ? 0x7c3aed : 0x312e81);
    }

    // Traveling neurotransmitter packets
    for (let i = travelers.length - 1; i >= 0; i--) {
      const s = travelers[i];
      if (s.delay > 0) { s.delay -= dt; continue; }
      s.life += dt;
      const u = s.life / s.max;
      if (!s.mesh) {
        s.mesh = allocMesh(s.color);
        brain.add(s.mesh);
      }
      if (s.pathHubs) {
        const ha = hubMeshes[s.pathHubs[0]]?.pos;
        const hb = hubMeshes[s.pathHubs[1]]?.pos;
        if (ha && hb) s.mesh.position.lerpVectors(ha, hb, u);
      } else if (s.path?.length) {
        const pathT = u * (s.path.length - 1);
        const a = Math.floor(pathT);
        const b = Math.min(s.path.length - 1, a + 1);
        const f = pathT - a;
        s.mesh.position.lerpVectors(pts[s.path[a]], pts[s.path[b]], f);
        // Excite neurons along the axon
        excite(s.path[b], 0.55 * (1 - u), new THREE.Color(s.color));
      }
      s.mesh.scale.setScalar((0.9 + s.intensity * 0.6) * (1 - u * 0.35));
      s.mesh.material.opacity = Math.max(0, 1 - u * u);
      if (u >= 1) {
        brain.remove(s.mesh);
        sparkPool.push(s.mesh);
        s.mesh = null;
        travelers.splice(i, 1);
      }
    }

    if (!travelers.length && !sysGlow.size && !pathAnim) {
      resting = true;
      if (quietAt && now > quietAt) {
        setStatus(null);
        quietAt = 0;
      }
    } else {
      quietAt = now + 1600;
      resting = false;
    }

    // Subtle brain pulse
    brain.scale.setScalar(1 + Math.sin(t * 1.1) * 0.006);

    controls.update();
    renderer.render(scene, camera);
  }

  function start() {
    if (active) return;
    active = true;
    root.hidden = false;
    resize();
    last = performance.now();
    setStatus(null);
    raf = requestAnimationFrame(frame);
    spark({ kind: 'think', system: 'presence', label: 'cortex online', intensity: 0.55, silent: true });
  }

  function stop() {
    active = false;
    cancelAnimationFrame(raf);
    pathAnim = null;
    root.hidden = true;
  }

  function toggle() {
    if (active) stop();
    else start();
    return active;
  }

  function flush(events = []) {
    for (const ev of events.slice(-14)) {
      if (ev.type === 'pathway' || ev.pathway) pathway(ev.systems || ev.pathway, { label: ev.label });
      else spark({ ...ev, intensity: (ev.intensity || 0.8) * 0.8 });
    }
  }

  window.addEventListener('resize', () => active && resize());
  const foot = hud.querySelector('.brain-foot');
  if (foot) foot.textContent = `drag to turn · wheel to zoom · ${cloud.count.toLocaleString()} neurons · ${numEdges.toLocaleString()} synapses`;

  return { spark, pathway, flush, start, stop, toggle, isActive: () => active, resize };
}
