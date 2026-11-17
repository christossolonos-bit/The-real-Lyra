// Avatar studio: a cast of 3D companions that talk through the bot's brain (Ollama) and voices
// (Fish Audio). They share one scene and one conversation; whoever you name answers.
//
// The animation drivers are ports of GlbPlayer's C# ones (BlinkDriver, GazeDriver, HeadMotionDriver,
// the arm rest pose from GlbViewControl). Lip sync: Fish gives audio + text (no phoneme times), so
// we build vowel/word visemes from the text, stretch them to the clip duration, and scale by loudness.
// ?pip: just her, for the theater seat / corner embeds (hides dock, topbar, chat).
const PIP = new URLSearchParams(location.search).has('pip');
if (PIP) document.body.classList.add('pip');
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { expressClipNames, resolveBodyLanguage, pickMicroShapes, microWeight } from './avatar-express.js';
import { createBrainViz } from './avatar-brain.js';
import { hairCards, textureStats, cardGuides } from './avatar-hair.js';
import { strandLayer } from './avatar-strands.js';

const $ = (s) => document.querySelector(s);
let lastCueText = ''; // latest user ask / spoken line — drives semantic Rocketbox body language
let brainViz = null;

// ---- Music: the library songs she plays from the music tool ({ type: 'music' } stream messages).
// A plain <audio> element, kept out of the lip-sync analyser so songs don't move her mouth, and
// turned down while she's talking.
const jukebox = { el: new Audio(), queue: [], index: -1 };
jukebox.el.volume = 0.6;
jukebox.el.addEventListener('ended', () => playSong(jukebox.index + 1));
function playSong(index) {
  const track = jukebox.queue[index];
  if (!track) return musicCommand({ action: 'stop' });
  jukebox.index = index;
  jukebox.el.src = track.url;
  jukebox.el.play().catch(() => toast('Click anywhere on the page to let the music play.'));
  toast(`🎵 ${track.title}`);
}
function musicCommand({ action, tracks = [] }) {
  if (action === 'play') { jukebox.queue = tracks; playSong(0); }
  else if (action === 'queue') { jukebox.queue.push(...tracks); if (jukebox.index < 0 || jukebox.el.ended) playSong(jukebox.queue.length - tracks.length); }
  else if (action === 'pause') jukebox.el.pause();
  else if (action === 'resume') jukebox.el.play().catch(() => {});
  else if (action === 'skip') playSong(jukebox.index + 1);
  else if (action === 'stop') { jukebox.el.pause(); jukebox.el.removeAttribute('src'); jukebox.queue = []; jukebox.index = -1; }
}
function duckMusic(talking) {
  jukebox.el.volume = talking ? 0.15 : 0.6;
}
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
// Frame-rate independent easing: k is the fraction covered per 1/60 s.
const ease = (k, dt) => 1 - Math.pow(1 - k, dt * 60);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  name: '', voice: true, volume: 1, handsFree: false, subs: true,
  blink: true, gaze: true, head: true, intensity: 1, lips: 1, expr: 1, restSmile: 0.6,
  backdrop: 'studio', frame: PIP ? 'face' : 'bust', collapsed: false, quality: 'high', talkingTo: 'main',
};
let opts = { ...DEFAULTS };
try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('avatarOpts') || '{}') }; } catch {}
// The office backdrop was removed; anyone who had it goes back to the studio.
if (opts.backdrop === 'office') opts.backdrop = 'studio';
delete opts.officeIntroduced;
opts.volume = 1; // full playback level for her voice
const save = () => { try { localStorage.setItem('avatarOpts', JSON.stringify(opts)); } catch {} };

// ---------------------------------------------------------------- scene

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Khronos "Neutral" keeps skin and hair colours true to their textures; ACES washes skin out
// and AgX flattens everything toward grey.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap; // soft, blurred shadows (hair on the forehead, chin on the neck)

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.22; // low, so the key light's shading reads (too much ambient = flat)

// A portrait lighting rig: a soft warm key that casts shadows, a cool fill, and two rims that
// pick the hair and shoulders out from the background.
const key = new THREE.DirectionalLight(0xfff0e2, 3.2);
key.position.set(1.3, 2.4, 2.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.012;
key.shadow.radius = 5;
key.shadow.blurSamples = 16;
const fill = new THREE.DirectionalLight(0xdbe6ff, 0.4);
fill.position.set(-2.2, 1.3, 1.6);
const rimCool = new THREE.DirectionalLight(0xc4d4ff, 2.2);
rimCool.position.set(-1.6, 2.3, -2.2);
const rimWarm = new THREE.DirectionalLight(0xffd9b8, 1.2);
rimWarm.position.set(1.9, 1.7, -1.9);
const sky = new THREE.HemisphereLight(0xe4ebff, 0x3a2e34, 0.18);
scene.add(key, key.target, fill, rimCool, rimWarm, sky);

// A soft contact shadow under each character's feet in full-body view. A painted blob rather than
// a shadow-catching floor, which renders as a black slab with soft (VSM) shadows.
const shadowBlobTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
function makeShadowBlob() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.6),
    new THREE.MeshBasicMaterial({ map: shadowBlobTexture, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.userData.noAO = true;
  return mesh;
}

// The backdrop is drawn in the scene (not CSS) so post-processing treats it like the rest of the image.
const BACKDROPS = { studio: ['#2a2d40', '#0b0c12'], dusk: ['#45325c', '#110c1a'], day: ['#eef1f7', '#c3cbdb'] };
function setBackdrop(name) {
  const [inner, outer] = BACKDROPS[name] ?? BACKDROPS.studio;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(220, 190, 20, 256, 256, 420);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  scene.background?.dispose?.();
  scene.background = new THREE.CanvasTexture(c);
  scene.background.colorSpace = THREE.SRGBColorSpace;
}

// ---------------------------------------------------------------- post-processing

// Film grain and a soft vignette, applied last, in display space. A perfectly clean image is a
// big part of what reads as "CG"; a touch of grain makes skin look photographed.
const GrainShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, grain: { value: 0.035 }, vignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, grain, vignette; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += (hash(vUv * 1000.0) - 0.5) * grain * (1.0 - lum * 0.6);
      gl_FragColor = c;
    }`,
};

let composer = null, gtao = null, bloom = null, grain = null;
function buildComposer() {
  composer?.dispose();
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  // Ambient occlusion: the soft contact shading under the chin and nose, in the eye sockets and
  // where the collar meets the neck. The rigs ship no AO maps for the head or body, so this adds a lot.
  gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.updateGtaoMaterial({ radius: 0.09, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.9;
  // Hair cards and lashes are flat quads with see-through textures; in the AO pass they'd be solid
  // and cast dark rectangles, so they're left out (the shadow map handles hair shading).
  // The backdrop texture is dropped for the AO pass too: drawn there, it corrupts the AO depth
  // buffer and shows up as a black slab behind their legs.
  const hide = gtao.overrideVisibility.bind(gtao);
  const restore = gtao.restoreVisibility.bind(gtao);
  let backdrop = null;
  gtao.overrideVisibility = () => {
    hide();
    scene.traverse((o) => { if (o.userData.noAO) o.visible = false; });
    backdrop = scene.background;
    scene.background = null;
  };
  gtao.restoreVisibility = () => {
    restore();
    scene.background = backdrop;
  };
  composer.addPass(gtao);

  bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.14, 0.45, 0.9); // only bright glints
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grain = new ShaderPass(GrainShader);
  composer.addPass(grain);
  applyQuality();
}

// low: no shadows or post-processing. medium: shadows + AO. high: everything, at full resolution.
function applyQuality() {
  const q = opts.quality;
  renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
  renderer.shadowMap.enabled = q !== 'low';
  key.castShadow = q !== 'low';
  if (gtao) gtao.enabled = q !== 'low';
  if (bloom) bloom.enabled = q === 'high';
  if (grain) grain.uniforms.grain.value = q === 'high' ? 0.035 : 0;
  scene.traverse((o) => o.material && (o.material.needsUpdate = true)); // shadow on/off changes shaders
  // Card strands are the costliest draw; only keep them at high quality.
  let castNow = [];
  try { castNow = cast; } catch { /* cast not ready at first call */ }
  for (const c of castNow) { if (q === 'high') growCardStrands(c); else dropCardStrands(c); }
  resize();
}

// Guides along her own Avaturn hair cards → thin strand ribbons over the wig (wig stays visible).
const STRANDS = 4200, SEGS = 14, CHILDREN = 7; // simulated guides, points per guide, drawn strands per guide
const CARD_STRANDS = 1800;
function growCardStrands(c) {
  if (opts.quality !== 'high' || !c?.model || !c.bones?.Head || c.model.userData.hair) return;
  const meshes = [];
  c.model.traverse((o) => {
    if (o.isMesh && o.visible && o.material?.map && /hair/i.test(`${o.name} ${o.material.name}`) && !/brow|lash/i.test(`${o.name} ${o.material.name}`)) meshes.push(o);
  });
  if (!meshes.length) return;
  c.root.updateMatrixWorld(true);
  const g = cardGuides({ meshes, THREE, count: CARD_STRANDS, segs: SEGS });
  if (!g) return;
  const head = c.bones.Head;
  head.updateWorldMatrix(true, false);
  const layer = strandLayer({
    THREE, scene, SEGS, CHILDREN,
    head, restToHead: head.matrixWorld.clone().invert(), rest: g.rest, rootN: g.rootN, seg: g.seg, shade: g.shade, colors: g.color,
    count: g.count, size: g.size, hold: 0.25, material: { meanLum: textureStats(meshes[0].material.map)?.meanLum, width: 0.00024 },
  });
  layer.setTint(c.look?.hair ?? null);
  c.model.userData.hair = layer;
  c.model.userData.cardStrands = true;
}
function dropCardStrands(c) {
  const layer = c?.model?.userData.hair;
  if (!layer || !c.model.userData.cardStrands) return;
  scene.remove(layer.mesh);
  layer.mesh.geometry.dispose();
  layer.mesh.material.dispose();
  c.model.userData.hair = null;
  c.model.userData.cardStrands = false;
}

const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
camera.position.set(0, 1.5, 2);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.35;
controls.maxDistance = 7;

function resize() {
  // The panel covers the right of the screen, so the cast is framed in the space left of it.
  // Rendering a window of a larger virtual view shifts the centre without distorting anything.
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const collapsed = document.body.classList.contains('collapsed');
  const phone = innerWidth <= 760;
  const panel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')) || 0;
  // Recorder / theater pip have no panel: her face is centred in the seat.
  const side = collapsed || phone || RECORDER || PIP ? 0 : panel + 16;
  // Phone: the chat is a bottom sheet covering ~46% of the height, so centre higher up.
  const below = phone && !collapsed && !RECORDER && !PIP ? h * 0.32 : 0;
  camera.aspect = (w + side) / (h + below);
  camera.setViewOffset(w + side, h + below, side, below, w, h);
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
  }
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- the cast

const cast = []; // in screen order, left to right
const byId = new Map();
let current = null; // who you're talking to: gets the Expressions menu, the readout and the Face framing
let speaker = null; // who is talking right now: lip sync follows them and the others look at them
let thinker = null; // who is working out a reply

// Each character carries its own copy of every animation state, so they blink, glance, breathe
// and feel independently.
function createCharacter(info) {
  return {
    ...info, // id, name, persona, voiceId, main
    root: new THREE.Group(),
    model: null,
    morphs: new Map(), // morph target name -> [{ mesh, index }]
    bones: {},
    rest: new Map(), // bone -> rest quaternion (after the arm pose)
    height: 1.7,
    hasVisemes: false,
    weights: new Map(),
    managed: new Set(),
    blink: { until: 1500 + Math.random() * 3000, elapsed: -1, double: false },
    gaze: { tx: 0, ty: 0, x: 0, y: 0, idleAt: 0 },
    head: { t: Math.random() * 100, gYaw: 0, gPitch: 0, decay: 0, next: 5 + Math.random() * 8 },
    feel: { target: {}, now: {}, side: {}, pulse: null },
    fx: null,
    gestures: [],
    lips: { level: 0, cur: {}, fake: null, track: null, flashAt: 0 },
  };
}

// Compressed models (like three.js's facecap head) need the KTX2 texture and meshopt decoders.
const loader = new GLTFLoader()
  .setKTX2Loader(new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/').detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder);
const loading = new Map(); // character -> fraction loaded
function showLoading() {
  const parts = [...loading.values()];
  $('#loading').hidden = !parts.length;
  if (parts.length) $('#loadingBar').style.width = `${(100 * parts.reduce((a, b) => a + b, 0)) / parts.length}%`;
}

async function loadModel(c, url) {
  loading.set(c, 0);
  $('#loadingText').textContent = 'Loading the cast…';
  showLoading();
  let gltf;
  try {
    gltf = await loader.loadAsync(url, (e) => {
      if (e.total) loading.set(c, e.loaded / e.total);
      showLoading();
    });
  } catch (err) {
    loading.delete(c);
    showLoading();
    toast(`Couldn't load ${c.name}: ${err.message || err}`);
    return;
  }
  loading.delete(c);
  showLoading();

  if (c.model) c.root.remove(c.bones.Head?.isGroup ? c.bones.Head : c.model);
  removeStrandHair(c.model);
  const model = (c.model = gltf.scene);
  c.morphs.clear();
  c.rest.clear();
  c.managed.clear();
  c.bones = {};
  model.traverse((o) => {
    if (o.isBone) c.bones[o.name.replace(/^.*[:|]/, '')] ??= o;
    if (o.isMesh) o.frustumCulled = false; // skinned meshes are often culled by their bind-pose bounds
    if (o.isMesh && o.morphTargetDictionary) {
      for (const [raw, index] of Object.entries(o.morphTargetDictionary)) {
        const name = raw.replace(/_L$/, 'Left').replace(/_R$/, 'Right'); // facecap-style eyeBlink_L
        if (!c.morphs.has(name)) c.morphs.set(name, []);
        c.morphs.get(name).push({ mesh: o, index });
      }
    }
  });
  c.hasVisemes = c.morphs.has('viseme_aa');
  upgradeMaterials(model);
  c.look = { ...LOOK_DEFAULTS, ...(c.look || {}), strands: c.look?.strands === true };
  applyAppearance(model, c.look, c);

  // Normalise each model to stand on the floor, face the camera and be a believable size, so
  // characters from different tools line up next to each other.
  c.root.position.set(0, 0, 0);
  c.root.rotation.set(0, 0, 0);
  c.root.add(model);
  c.root.updateMatrixWorld(true);
  const la = new THREE.Vector3(), ra = new THREE.Vector3();
  if (c.bones.LeftArm && c.bones.RightArm) {
    c.bones.LeftArm.getWorldPosition(la);
    c.bones.RightArm.getWorldPosition(ra);
    if (la.x < ra.x) model.rotation.y += Math.PI; // its left arm should be on screen right
  }
  model.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(model);
  const h = box.max.y - box.min.y;
  if (!Object.keys(c.bones).length) {
    // A floating head with no skeleton: size it like a real head at standing height, and give it
    // a neck pivot so head motion and feeling poses turn it like they would a Head bone.
    model.scale.multiplyScalar(0.24 / (h || 1));
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const neck = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    const pivot = new THREE.Group();
    pivot.name = 'Head';
    pivot.position.set(neck.x, 1.48, neck.z);
    model.position.sub(neck);
    c.root.remove(model);
    pivot.add(model);
    c.root.add(pivot);
    c.bones.Head = pivot;
    c.root.updateMatrixWorld(true);
    c.height = 1.72;
  } else if (h < 1.2 || h > 2.3) model.scale.multiplyScalar(1.75 / (h || 1.75));
  if (c.bones.Head?.isGroup) {
    c.rest.set(c.bones.Head, c.bones.Head.quaternion.clone());
  } else {
  model.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(model);
  model.position.y -= box.min.y;
  c.height = box.max.y - box.min.y;

  poseArms(c);
  // Snapshot every bone we may touch later. rotateWorld / Rocketbox must restore from
  // this each frame — otherwise Hips/arms accumulate and the avatar tips or spins.
  for (const bone of Object.values(c.bones)) {
    if (bone?.isBone || bone?.isObject3D) c.rest.set(bone, bone.quaternion.clone());
  }
  }
  if (!c.root.userData.blob) c.root.add((c.root.userData.blob = makeShadowBlob()));
  if (!c.root.parent) scene.add(c.root);
  growCardStrands(c); // strand ribbons over her hair cards (high quality); wig stays visible

  layout();
  if (!c.morphs.has('eyeBlinkLeft') && !c.hasVisemes) toast(`${c.name}'s model has no ARKit or viseme face shapes, so they can't blink or lip sync.`);
  if (state === 'loading' && !loading.size) setState('idle');
}

// Side by side, each turned a little toward the other, like two people talking with you.
function layout() {
  const ready = cast.filter((c) => c.model);
  const gap = 0.36;
  ready.forEach((c, i) => {
    const x = (i - (ready.length - 1) / 2) * gap * 2;
    c.root.position.set(x, 0, 0);
    // Face each other slightly when there are two — never tip (x/z must stay 0).
    c.root.rotation.set(0, ready.length > 1 ? -Math.sign(x) * 0.2 : 0, 0);
    c.root.updateMatrixWorld(true);
  });
  // Fit the shadow camera tightly around everyone: the tighter it is, the sharper the shadow detail.
  const box = new THREE.Box3();
  for (const c of ready) box.expandByObject(c.model);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  key.target.position.copy(center);
  key.position.copy(center).add(new THREE.Vector3(1.3, 2.4, 2.1));
  const half = Math.max(box.max.y - box.min.y, box.max.x - box.min.x) * 0.6;
  Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 8 });
  key.shadow.camera.updateProjectionMatrix();
  frame(opts.frame, !layout.done);
  layout.done = true;
}

// ---------------------------------------------------------------- materials

// glTF gives every surface the same basic material. Real skin, eyes, hair and cloth each reflect
// light differently, so each gets a physically-based upgrade, matched by material name with
// fallbacks so Avaturn, Ready Player Me and Avatar SDK models all get the same treatment.
function toPhysical(m, extra = {}) {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, m);
  p.defines = { STANDARD: '', PHYSICAL: '' }; // Standard's copy() drops the PHYSICAL define
  return Object.assign(p, extra);
}

// Skin is translucent: light enters, scatters, and comes out redder, which softens the edge of
// shadows and stops skin looking like painted plastic. Approximated by letting diffuse light wrap
// past the shadow line with a red tint.
function addSkinScatter(mat) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const line = 'vec3 irradiance = dotNL * directLight.color;';
  if (!chunk.includes(line)) return; // a three.js update changed the chunk; skip rather than break
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk.replace(line, `${line}
      float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.5 ) / 1.5 );
      reflectedLight.directDiffuse += max( wrapNL - dotNL, 0.0 ) * directLight.color * vec3( 1.0, 0.35, 0.25 ) * 0.45 * BRDF_Lambert( material.diffuseColor );`));
  };
  mat.customProgramCacheKey = () => 'skin-scatter';
}

// Live Appearance / Customize: { skin, eyes, hair, clothes, strands, hairStyle, hairLength, … }.
// Facecap scans use shell+strand hair; Avaturn/RPM hide the plastic wig and grow real strands.
function applyAppearance(root, look, character = null) {
  if (!look) look = {};
  if (isFacecapLike(root)) applyLook(root, look);
  else tintTexturedLook(root, look);
  installStrandHair(root, look, character);
}

function findHeadMesh(root) {
  let best = null, bestScore = -1;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const n = `${o.name} ${o.parent?.name || ''}`.toLowerCase();
    if (/hair|wig|lash|eye|teeth|tongue|body|outfit|cloth|shoe|cornea/i.test(n) && !/head/.test(n)) return;
    let score = o.geometry.attributes.position.count;
    if (/head/i.test(n)) score *= 4;
    if (o.morphTargetDictionary) score *= 2;
    if (score > bestScore) { best = o; bestScore = score; }
  });
  return best;
}

function isWigMesh(o) {
  if (!o?.isMesh) return false;
  const n = `${o.name} ${o.material?.name || ''} ${o.parent?.name || ''}`.toLowerCase();
  return /hair|wig|avaturn_hair|haircut|hair_mesh/i.test(n) && !/eyelash|lash|eyeao/i.test(n);
}

function setWigVisible(root, visible) {
  root.traverse((o) => {
    if (isWigMesh(o)) {
      o.visible = visible;
      o.userData.wigHidden = !visible;
    }
  });
}

function removeStrandHair(root) {
  if (!root) return;
  const hair = root.userData?.hair;
  if (hair?.mesh) {
    scene.remove(hair.mesh);
    hair.mesh.geometry?.dispose?.();
    hair.mesh.material?.dispose?.();
  }
  root.traverse((o) => {
    if (o.name === 'hair' && o.isInstancedMesh) {
      o.parent?.remove(o);
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
  });
  if (root.userData) root.userData.hair = null;
}

function hairOptsFromLook(look = {}) {
  const style = look.hairStyle || 'long';
  const lengthMul = ({
    long: 1.85, medium: 1.15, bob: 0.85, short: 0.5, wavy: 1.95,
  }[style] || 1.85) * (Number(look.hairLength) || 1);
  const density = Math.max(0.55, Math.min(1.5, Number(look.hairDensity) || 1.05));
  const wave = style === 'wavy' ? 1.7 : style === 'bob' ? 0.75 : 1.1;
  return {
    color: look.hair || '#c9a66b',
    lengthMul,
    density,
    wave,
    style,
    // Off by default — hiding the Avaturn wig left a bald scalp when strands failed.
    strands: look.strands === true,
  };
}

function installStrandHair(root, look, character = null) {
  const opts = hairOptsFromLook(look);
  const head = findHeadMesh(root);
  if (!head) return;

  // Default: keep the Avaturn wig + card-strand overlay. Explicit Customize "strands" grows scalp hair instead.
  if (!opts.strands) {
    if (root.userData.cardStrands) {
      root.userData.hair?.setTint?.(opts.color || null);
    } else {
      removeStrandHair(root);
      root.userData.hairKey = null;
    }
    setWigVisible(root, true);
    return;
  }

  if (root.userData.cardStrands && character) dropCardStrands(character);

  const key = `${opts.style}|${opts.lengthMul.toFixed(2)}|${opts.density.toFixed(2)}|${opts.wave}`;
  const prev = root.userData.hairKey;
  if (root.userData.hair?.mesh?.isMesh && prev === key) {
    const col = new THREE.Color(opts.color);
    root.userData.hair.mesh.material.color.copy(col);
    head.traverse((o) => { if (o.name === 'hair' && o.material?.color) o.material.color.copy(col); });
    return;
  }
  removeStrandHair(root);
  const strands = addStrands(head, opts.color, opts);
  const ok = Boolean(strands?.mesh?.isMesh);
  if (!ok) {
    setWigVisible(root, true);
    root.userData.hair = null;
    root.userData.hairKey = null;
    if (character) growCardStrands(character);
    return;
  }
  // Keep wig as under-layer; strands draw on top (no bald scalp if sim hiccups).
  setWigVisible(root, true);
  addHair(head, opts.color);
  root.userData.hair = strands;
  root.userData.hairKey = key;
  root.userData.cardStrands = false;
  if (character) character.model = root;
}

function isFacecapLike(root) {
  let bones = 0;
  let meshes = 0;
  root.traverse((o) => {
    if (o.isBone) bones += 1;
    if (o.isMesh) meshes += 1;
  });
  return bones < 5 || meshes <= 3;
}

function ensureBaseColors(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && m.color && !m.userData.baseColor) m.userData.baseColor = m.color.clone();
    }
  });
}

function surfaceKind(o) {
  const bits = [o.name, o.material?.name];
  for (let p = o.parent; p; p = p.parent) bits.push(p.name);
  const n = bits.filter(Boolean).join(' ');
  if (/eyelash|eyeao|eye_ao|teeth|tongue|cornea|sclera/i.test(n)) return null;
  if (/\beye/i.test(n)) return 'eyes';
  if (/hair/i.test(n)) return 'hair';
  if (/look|cloth|outfit|shirt|suit|shoe|pant|dress|jacket|skirt/i.test(n)) return 'clothes';
  if (/body|head|skin|avatar|arm|leg|hand|torso/i.test(n)) return 'skin';
  return null;
}

function tintTexturedLook(root, look) {
  ensureBaseColors(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const kind = surfaceKind(o);
    if (!kind || !look[kind]) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const tint = new THREE.Color(look[kind]);
    for (const m of mats) {
      if (!m?.color) continue;
      const base = m.userData.baseColor || m.color;
      // Multiply keeps albedo texture; hex acts as a color filter.
      m.color.copy(base).multiply(tint);
      m.needsUpdate = true;
    }
  });
}

/** Soft resting face makeup / shape from Customize sliders (layered under feelings). */
function applyFaceLook(c) {
  const look = c.look || {};
  const smile = Number(look.smile ?? look.restSmile ?? 0.35);
  const brows = Number(look.brows ?? 0.1);
  const eyesOpen = Number(look.eyesOpen ?? 0.15);
  const blush = Number(look.blush ?? 0.15);
  const lips = Number(look.lips ?? 0.2);
  if (smile > 0.01) {
    add(c, 'mouthSmileLeft', smile * 0.35);
    add(c, 'mouthSmileRight', smile * 0.35);
  }
  if (brows > 0.01) {
    add(c, 'browInnerUp', brows * 0.35);
    add(c, 'browOuterUpLeft', brows * 0.2);
    add(c, 'browOuterUpRight', brows * 0.2);
  }
  if (eyesOpen > 0.01) {
    add(c, 'eyeWideLeft', eyesOpen * 0.25);
    add(c, 'eyeWideRight', eyesOpen * 0.25);
  }
  if (blush > 0.01) {
    add(c, 'cheekSquintLeft', blush * 0.22);
    add(c, 'cheekSquintRight', blush * 0.22);
  }
  if (lips > 0.01) {
    add(c, 'mouthPressLeft', lips * 0.12);
    add(c, 'mouthPressRight', lips * 0.12);
    add(c, 'mouthUpperUpLeft', lips * 0.08);
    add(c, 'mouthUpperUpRight', lips * 0.08);
  }
}

// Colors a plain grey scan like three.js's facecap head, from the character's "look" in
// characters.json: { skin, eyes, hair }. Its parts share one atlas material, so each gets
// its own copy, and the part is found from the names of the nodes above the mesh.
function applyLook(root, look) {
  const partOf = (o) => {
    for (let p = o; p; p = p.parent) {
      if (/eye/i.test(p.name)) return 'eye';
      if (/teeth/i.test(p.name)) return 'teeth';
      if (/head/i.test(p.name)) return 'head';
    }
    return 'head';
  };
  let head = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const part = partOf(o);
    if (!o.material.userData?.lookClone) {
      o.material = o.material.clone();
      o.material.userData.lookClone = true;
    }
    const m = o.material;
    if (part === 'head') {
      head = o;
      if (look.skin) m.color.set(look.skin).multiplyScalar(1.3); // the texture is a mid grey, so lift it back up
      m.roughness = 0.55;
    }
    if (part === 'eye' && look.eyes) {
      // Tint only the dark iris and pupil, so the whites stay white.
      if (!m.userData.irisColor) m.userData.irisColor = { value: new THREE.Color(look.eyes) };
      else m.userData.irisColor.value.set(look.eyes);
      if (!m.userData.irisHooked) {
        m.userData.irisHooked = true;
        m.onBeforeCompile = (sh) => {
          sh.uniforms.irisColor = m.userData.irisColor;
          sh.fragmentShader = `uniform vec3 irisColor;
${sh.fragmentShader}`.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(irisColor * (0.35 + 1.4 * lum), diffuseColor.rgb, smoothstep(0.3, 0.55, lum));`,
          );
        };
      }
      m.customProgramCacheKey = () => `iris${look.eyes}`;
      m.needsUpdate = true;
    }
  });
  // Strand hair is installed by installStrandHair() after applyLook / tint.
}

/** World position of a mesh vertex — uses skinning on Avaturn/RPM SkinnedMeshes. */
function vertexWorldPos(mesh, i, target, normalOut = null) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  if (mesh.isSkinnedMesh && mesh.skeleton && typeof mesh.boneTransform === 'function') {
    mesh.boneTransform(i, target);
    target.applyMatrix4(mesh.matrixWorld);
  } else {
    target.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
  }
  if (normalOut && nor) {
    normalOut.fromBufferAttribute(nor, i).transformDirection(mesh.matrixWorld).normalize();
  }
  return target;
}

// Where hair grows: 0 below the hairline, 1 on the scalp. Skinned heads use boneTransform
// so roots land on the live skull — not the bind-pose mesh (that left her bald).
function scalpOf(head) {
  head.updateWorldMatrix(true, true);
  if (head.isSkinnedMesh) head.skeleton?.update();
  const src = head.geometry, pos = src.attributes.position, idx = src.index;
  if (!src.attributes.normal) src.computeVertexNormals();
  const P = new Float32Array(pos.count * 3), N = new Float32Array(pos.count * 3), mask = new Float32Array(pos.count);
  const w = new THREE.Vector3(), n = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    vertexWorldPos(head, i, w, n);
    box.expandByPoint(w);
    w.toArray(P, i * 3);
    n.toArray(N, i * 3);
  }
  const size = box.getSize(new THREE.Vector3());
  const midX = (box.min.x + box.max.x) / 2;
  for (let i = 0; i < pos.count; i++) {
    w.fromArray(P, i * 3);
    n.fromArray(N, i * 3);
    const y = (w.y - box.min.y) / Math.max(1e-6, size.y);
    const back = THREE.MathUtils.clamp((box.max.z - w.z) / Math.max(1e-6, size.z), 0, 1);
    const side = Math.abs(w.x - midX) / Math.max(1e-6, size.x * 0.5);
    // Slightly lower hairline so Avaturn painted scalps get full coverage.
    const line = 0.72 - 0.38 * back ** 1.2 - 0.05 * side;
    const up = Math.max(0, n.y + 0.15);
    mask[i] = THREE.MathUtils.smoothstep(y, line - 0.04, line + 0.1) * THREE.MathUtils.smoothstep(up, 0.05, 0.45);
  }
  const tris = [], count = idx ? idx.count : pos.count;
  for (let t = 0; t < count; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    if (mask[a] + mask[b] + mask[c] > 0.08) tris.push(a, b, c);
  }
  return { box, size, P, N, mask, tris };
}

// The scalp's undercoat: stacked shells (copies of the scalp pushed out along its normals) showing
// a dense short fuzz, so skin doesn't show through between the simulated strands on top.
const HAIR_LAYERS = 40;
function addHair(head, color) {
  const { size, P, N, mask, tris } = scalpOf(head);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('hairMask', new THREE.Float32BufferAttribute(mask, 1));
  geo.setIndex(tris);

  const len = size.y * 0.055; // short undercoat so scalp never reads as a bald cap
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.hairLen = { value: len };
    sh.uniforms.hairDensity = { value: 3200 / size.y }; // strand spacing, relative to head height
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float hairMask;
        uniform float hairLen;
        varying vec3 vRoot;
        varying float vLayer;
        varying float vMask;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLayer = float(gl_InstanceID) / ${HAIR_LAYERS - 1}.0;
        vRoot = position;
        vMask = hairMask;
        float h = vLayer * hairLen * hairMask;
        // Out along the scalp, then bending down and back under its own weight.
        transformed += objectNormal * h + vec3(0.0, -1.0, -0.4) * h * vLayer * 0.9;`)
;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float hairDensity;
        varying vec3 vRoot;
        varying float vLayer;
        varying float vMask;
        vec3 hash3(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.xxy + p.yxx) * p.zyx); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // The nearest strand root in a jittered 3D grid over the scalp.
        vec3 cell = vRoot * hairDensity, id = floor(cell);
        float best = 9.0; vec3 rnd = vec3(0.0);
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 o = id + vec3(x, y, z), r = hash3(o);
          float d = length(cell - o - r);
          if (d < best) { best = d; rnd = r; }
        }
        // Near the hairline strands get sparser and shorter, instead of stopping at an edge.
        if (rnd.z > vMask * 1.3 - 0.15) discard;
        float strandLen = mix(0.55, 1.0, rnd.x) * mix(0.4, 1.0, vMask);
        if (vLayer > 0.0 && (vLayer > strandLen || best > 0.75 * (1.0 - vLayer / max(strandLen, 0.001)))) discard;
        // Darker at the roots (self-shadowing), a little variation strand to strand.
        diffuseColor.rgb *= mix(0.35, 1.0, vLayer) * mix(0.8, 1.15, rnd.y);`);
  };
  mat.customProgramCacheKey = () => 'shellHair';
  const hair = new THREE.InstancedMesh(geo, mat, HAIR_LAYERS);
  for (let i = 0; i < HAIR_LAYERS; i++) hair.setMatrixAt(i, new THREE.Matrix4());
  hair.name = 'hair';
  hair.frustumCulled = false;
  hair.castShadow = true;
  hair.userData.noAO = true;
  head.attach(hair);
}

// Real strands: thousands of tapered ribbons rooted on the scalp, each a chain of points simulated
// with Verlet integration. Roots ride the head; the rest swings under gravity and inertia, keeps
// its combed shape with a stiffness that fades toward the tips, and is pushed out of the skull.
// The simulation runs in world space. "Rest" space is the head's world frame at load, where the
// strands were combed, and K maps rest space to wherever the head is now.
/** Matrix strands should follow — Head bone on skinned Avaturn rigs, else the mesh node. */
function hairFollowMatrix(head) {
  if (head.isSkinnedMesh && head.skeleton?.bones?.length) {
    const bone = head.skeleton.bones.find((b) => /^head$/i.test(String(b.name).replace(/^.*[:|]/, '')));
    if (bone) {
      bone.updateWorldMatrix(true, false);
      return bone.matrixWorld;
    }
  }
  head.updateWorldMatrix(true, false);
  return head.matrixWorld;
}

function addStrands(head, color, hairOpts = {}) {
  const lengthMul = hairOpts.lengthMul ?? 1;
  const densityMul = hairOpts.density ?? 1;
  const waveMul = hairOpts.wave ?? 1;
  const guideCount = Math.max(1800, Math.round(STRANDS * densityMul));
  const { box, size, P, N, mask, tris } = scalpOf(head);
  const follow0 = hairFollowMatrix(head).clone();
  const restToHead = follow0.clone().invert();
  const centre = box.getCenter(new THREE.Vector3()), radii = size.clone().multiplyScalar(0.5);
  const q = new THREE.Vector3();
  // Push a rest-space point out of the skull (an ellipsoid slightly larger than the head).
  const outside = (v, pad) => {
    q.subVectors(v, centre).divide(radii);
    const d = q.length();
    if (d < pad) v.copy(q.multiplyScalar(pad / d).multiply(radii).add(centre));
  };

  // Roots: area-weighted random points on the scalp, thinning out toward the hairline.
  const area = [], A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris.length; t += 3) {
    A.fromArray(P, tris[t] * 3); B.fromArray(P, tris[t + 1] * 3); C.fromArray(P, tris[t + 2] * 3);
    const m = Math.min(mask[tris[t]], mask[tris[t + 1]], mask[tris[t + 2]]);
    total += new THREE.Triangle(A, B, C).getArea() * m * m;
    area.push(total);
  }
  if (total <= 1e-8 || !area.length) {
    console.warn('strand hair: empty scalp mask — falling back to upper-hemisphere tris');
    area.length = 0;
    total = 0;
    // Fallback: use top third of head verts so Avaturn still gets strands.
    for (let t = 0; t < tris.length; t += 3) {
      A.fromArray(P, tris[t] * 3);
      if (A.y < centre.y) continue;
      B.fromArray(P, tris[t + 1] * 3); C.fromArray(P, tris[t + 2] * 3);
      total += new THREE.Triangle(A, B, C).getArea();
      area.push(total);
    }
  }
  if (total <= 1e-8) {
    console.warn('strand hair: no usable scalp — skipping');
    return { mesh: new THREE.Object3D(), update() {} };
  }
  const pts = SEGS + 1;
  const rest = new Float32Array(guideCount * pts * 3), rootN = new Float32Array(guideCount * 3), seg = new Float32Array(guideCount), shade = new Float32Array(guideCount), pad = new Float32Array(guideCount);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), dir = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const crown = centre.clone().add(new THREE.Vector3(0, radii.y * 0.9, -radii.z * 0.35)); // the whorl hair grows out from
  const style = hairOpts.style || 'medium';
  const gravity = style === 'short' ? 0.28 : style === 'bob' ? 0.22 : 0.18;
  const flare = style === 'bob' ? 0.55 : style === 'wavy' ? 0.4 : 0.3;
  for (let s = 0; s < guideCount; s++) {
    const r = Math.random() * total;
    let lo = 0, hi = area.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < r) lo = mid + 1; else hi = mid; }
    const t = Math.min(lo, Math.floor(tris.length / 3) - 1) * 3;
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    p.set(0, 0, 0); n.set(0, 0, 0);
    for (const [k, wgt] of [[tris[t], 1 - u - v], [tris[t + 1], u], [tris[t + 2], v]]) {
      p.addScaledVector(A.fromArray(P, k * 3), wgt);
      n.addScaledVector(B.fromArray(N, k * 3), wgt);
    }
    n.normalize();
    n.toArray(rootN, s * 3);
    const edge = mask[tris[t]] * (1 - u - v) + mask[tris[t + 1]] * u + mask[tris[t + 2]] * v; // 1 well inside the hairline
    // Combed shape: lying along the scalp, flowing away from the crown, then falling under
    // gravity. Longer at the back. Style + length slider scale the overall fall.
    const back = 1 + 0.65 * THREE.MathUtils.clamp((centre.z - p.z) / radii.z, 0, 1);
    // Shoulder-to-chest length at lengthMul≈1.85 (style "long").
    const len = size.y * (0.38 + 0.18 * Math.random()) * back * lengthMul;
    seg[s] = (len * (0.28 + 0.72 * Math.max(0.2, edge || 0.55))) / SEGS;
    // The ellipsoid bulges past the forehead, so a strand only collides from its root's depth out.
    pad[s] = Math.min(1.02, q.subVectors(p, centre).divide(radii).length() + 0.01);
    shade[s] = 0.75 + 0.5 * Math.random();
    dir.subVectors(p, crown);
    dir.addScaledVector(n, -dir.dot(n)).normalize().addScaledVector(n, flare * Math.max(0.2, edge || 0.5)).normalize();
    for (let i = 0; i < pts; i++) {
      if (i) {
        p.addScaledVector(dir, seg[s]);
        outside(p, pad[s]);
        dir.addScaledVector(down, gravity).normalize();
        if (waveMul > 1.05) {
          dir.x += Math.sin(i * 0.9 + s * 0.17) * 0.04 * waveMul;
          dir.normalize();
        }
      }
      p.toArray(rest, (s * pts + i) * 3);
    }
  }

  // Drawing happens on the GPU. Each frame the simulated guides go into a float texture (one row
  // per guide: its points, then its root normal), and the vertex shader builds CHILDREN tapered,
  // camera-facing ribbons around each guide. Children spread out at the root and gather toward
  // the tip, which is what makes hair clump into locks instead of reading as separate threads.
  const texW = pts + 1, guideData = new Float32Array(texW * guideCount * 4);
  const guideTex = new THREE.DataTexture(guideData, texW, guideCount, THREE.RGBAFormat, THREE.FloatType);
  guideTex.minFilter = guideTex.magFilter = THREE.NearestFilter;
  const strands = guideCount * CHILDREN, verts = strands * pts * 2;
  const ref = new Float32Array(verts * 3), child = new Float32Array(verts * 4), index = new Uint32Array(strands * SEGS * 6);
  for (let s = 0, k = 0; s < strands; s++) {
    const g = Math.floor(s / CHILDREN), first = s % CHILDREN === 0;
    // Spot in the clump (in a disc; the first child is the guide itself), its own shade and length.
    const a = Math.random() * Math.PI * 2, r = first ? 0 : Math.sqrt(Math.random());
    const ox = Math.cos(a) * r, oy = Math.sin(a) * r, rnd = Math.random();
    const tone = shade[g] * (0.85 + 0.3 * Math.random());
    for (let i = 0; i < pts; i++) {
      for (let side = 0; side < 2; side++) {
        const v = (s * pts + i) * 2 + side;
        ref.set([g, i, side ? 1 : -1], v * 3);
        child.set([ox, oy, rnd, tone], v * 4);
      }
      if (i < SEGS) {
        const b = (s * pts + i) * 2;
        index.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], k);
        k += 6;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3)); // placed in the shader
  geo.setAttribute('hairRef', new THREE.BufferAttribute(ref, 3));
  geo.setAttribute('hairChild', new THREE.BufferAttribute(child, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide, alphaToCoverage: true });
  const clump = { value: 0 }; // how far children sit from their guide at the root (set per frame, in world units)
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.guides = { value: guideTex };
    sh.uniforms.clump = clump;
    sh.uniforms.hairWidth = { value: 0.00055 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 hairRef;
        attribute vec4 hairChild;
        uniform sampler2D guides;
        uniform float clump, hairWidth;
        varying vec3 vHairT;
        varying float vHairU, vHairSide, vHairShade, vHairRnd;
        vec3 guidePoint(float g, float i) { return texelFetch(guides, ivec2(int(i), int(g)), 0).xyz; }`)
      .replace('#include <beginnormal_vertex>', `
        float g = hairRef.x, i = hairRef.y, u = i / ${SEGS}.0;
        vec3 C = guidePoint(g, i);
        vec3 T = normalize(guidePoint(g, min(i + 1.0, ${SEGS}.0)) - guidePoint(g, max(i - 1.0, 0.0)));
        vec3 rootN = guidePoint(g, ${pts}.0);
        vec3 B = normalize(cross(T, rootN) + vec3(1e-5, 0.0, 0.0)), N2 = cross(B, T);
        // Clumping: wide at the root, gathered near the tip, with a little waviness of its own.
        float spread = clump * mix(1.0, 0.22, smoothstep(0.15, 0.95, u));
        float wave = clump * ${0.18 * (hairOpts.wave ?? 1).toFixed(2)} * u * sin(u * ${waveMul > 1.05 ? 14.0 : 11.0} + hairChild.z * 40.0);
        C += B * (hairChild.x * spread + wave) + N2 * (hairChild.y * spread * 0.6);
        // Children trail off at different lengths, so the ends of a lock are thin and wispy.
        float keep = mix(0.7, 1.0, hairChild.z);
        float live = step(u, keep + 0.001);
        vec3 toCam = normalize(cameraPosition - C);
        vec3 S = normalize(cross(T, toCam));
        float w = hairWidth * (1.0 - 0.75 * u / keep) * live;
        vec3 hairPos = C + S * w * hairRef.z;
        // A thin cylinder's normal: toward the camera, rolling toward each edge.
        vec3 objectNormal = normalize(normalize(cross(S, T)) * sign(dot(cross(S, T), toCam)) + S * 0.55 * hairRef.z);
        vHairT = normalize((viewMatrix * vec4(T, 0.0)).xyz);
        vHairU = u / keep;
        vHairSide = hairRef.z;
        vHairShade = hairChild.w;
        vHairRnd = hairChild.z;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = hairPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHairT;
        varying float vHairU, vHairSide, vHairShade, vHairRnd;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vHairU > 1.0) discard;
        diffuseColor.rgb *= vHairShade * mix(0.4, 1.0, smoothstep(0.0, 0.35, vHairU)); // darker at the roots
        // Soft, antialiased edges and wispy tips (via alpha to coverage).
        diffuseColor.a = (1.0 - smoothstep(0.55, 1.0, abs(vHairSide))) * (1.0 - smoothstep(0.75, 1.0, vHairU));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Hair sheen (Kajiya-Kay with Marschner's two lobes): light reflects off the cuticle as a
        // bright white band shifted toward the tips, plus a broader one tinted by the hair colour.
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 Vd = normalize(vViewPosition);
          float jitter = (vHairRnd - 0.5) * 0.3;
          vec3 T1 = normalize(vHairT + normal * (0.12 + jitter));
          vec3 T2 = normalize(vHairT - normal * (0.1 - jitter));
          for (int l = 0; l < NUM_DIR_LIGHTS; l++) {
            vec3 L = directionalLights[l].direction, H = normalize(L + Vd);
            float t1 = dot(T1, H), t2 = dot(T2, H);
            float s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 180.0);
            float s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 40.0);
            float wrap = clamp(dot(normal, L) * 0.5 + 0.5, 0.0, 1.0);
            reflectedLight.directSpecular += directionalLights[l].color * wrap * (0.1 * s1 + 0.18 * s2 * diffuseColor.rgb);
          }
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'strandHair';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hairStrands';
  mesh.frustumCulled = false;
  mesh.userData.noAO = true;
  mesh.matrixWorldAutoUpdate = false; // the shader places everything in world space
  scene.add(mesh);

  const cur = new Float32Array(rest.length), prev = new Float32Array(rest.length);
  const K = new THREE.Matrix4(), Kinv = new THREE.Matrix4(), rot = new THREE.Matrix3();
  const x = new THREE.Vector3(), y = new THREE.Vector3(), comb = new THREE.Vector3();
  let started = false;

  return {
    mesh,
    update(dt) {
      if (head.isSkinnedMesh) head.skeleton?.update();
      K.multiplyMatrices(hairFollowMatrix(head), restToHead);
      Kinv.copy(K).invert();
      const scale = Math.cbrt(Math.abs(K.determinant()));
      clump.value = size.y * scale * 0.045;
      if (!started) {
        // Start combed, wherever the head is.
        for (let j = 0; j < rest.length; j += 3) comb.fromArray(rest, j).applyMatrix4(K).toArray(cur, j);
        prev.set(cur);
        started = true;
      }
      const h = Math.min(dt, 1 / 30), g = -9.8 * h * h, damp = 0.94;
      for (let s = 0; s < guideCount; s++) {
        const len = seg[s] * scale;
        for (let i = 0; i < pts; i++) {
          const j = (s * pts + i) * 3;
          comb.fromArray(rest, j).applyMatrix4(K); // where the comb puts this point now
          if (i === 0) {
            comb.toArray(cur, j);
            comb.toArray(prev, j);
            continue;
          }
          // Verlet: keep (damped) velocity and add gravity.
          for (let a = 0; a < 3; a++) {
            const now = cur[j + a];
            cur[j + a] = now + (now - prev[j + a]) * damp + (a === 1 ? g : 0);
            prev[j + a] = now;
          }
          // Hold the combed shape: firm at the root, loose at the tip.
          const f = 1 - i / pts;
          x.fromArray(cur, j).lerp(comb, 0.02 + 0.3 * f * f * f);
          // Keep the segment's length, following the point before it.
          y.fromArray(cur, j - 3);
          x.sub(y).setLength(len).add(y);
          // Stay out of the skull, tested in rest space where the ellipsoid is defined.
          x.applyMatrix4(Kinv);
          outside(x, pad[s]);
          x.applyMatrix4(K).toArray(cur, j);
        }
      }

      // Hand the guides to the shader: their points, then their root normal (turned with the head).
      rot.setFromMatrix4(K);
      for (let s = 0; s < guideCount; s++) {
        const row = s * texW * 4;
        for (let i = 0; i < pts; i++) {
          const j = (s * pts + i) * 3;
          guideData[row + i * 4] = cur[j];
          guideData[row + i * 4 + 1] = cur[j + 1];
          guideData[row + i * 4 + 2] = cur[j + 2];
        }
        x.fromArray(rootN, s * 3).applyMatrix3(rot).normalize();
        guideData[row + pts * 4] = x.x;
        guideData[row + pts * 4 + 1] = x.y;
        guideData[row + pts * 4 + 2] = x.z;
      }
      guideTex.needsUpdate = true;
    },
  };
}

function upgradeMaterials(root) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const name = `${m.name} ${o.name}`.toLowerCase();
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[key]) m[key].anisotropy = aniso;
    o.castShadow = true;
    o.receiveShadow = true;

    if (/eyeao|eyelash|lash|tearline/.test(name)) {
      if (m.transparent) m.depthWrite = false;
      o.castShadow = false;
      o.userData.noAO = true;
    } else if (/cornea/.test(name)) {
      // A separate clear shell over the eye: make it a wet, glassy coat that only shows highlights.
      o.material = toPhysical(m, { roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, depthWrite: false, envMapIntensity: 2 });
      o.castShadow = false;
      o.userData.noAO = true;
    } else if (/eye/.test(name)) {
      // A wet cornea: a sharp clear coat over the iris catches the lights as tiny highlights.
      o.material = toPhysical(m, { roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6 });
      o.castShadow = false;
    } else if (/teeth|tongue/.test(name)) {
      o.material = toPhysical(m, { roughness: 0.45, clearcoat: name.includes('tongue') ? 0.6 : 0.3, clearcoatRoughness: 0.2 });
      o.material.color.multiplyScalar(0.88); // CG teeth are always too white
      o.castShadow = false;
    } else if (/hair|brow|beard/.test(name)) {
      // Head hair cards: alpha-to-coverage + mip alpha lift + strand lighting (avatar-hair.js).
      // Brows/beards keep a softer cut. Wig mesh stays visible under the card-strand overlay.
      const headHair = /hair/.test(name) && Boolean(m.map);
      o.material = toPhysical(m, {
        metalness: 0, roughness: 0.5, transparent: false, depthWrite: true, alphaToCoverage: true,
        alphaTest: m.transparent ? 0.12 : 0.3, sheen: 0.35, sheenRoughness: 0.3,
        sheenColor: new THREE.Color(0.7, 0.42, 0.3), specularIntensity: 0.5, envMapIntensity: 0.9,
      });
      if (headHair) hairCards(o.material);
      o.userData.noAO = true;
    } else if (/head|body|skin/.test(name)) {
      o.material = toPhysical(m, {
        roughness: 1, specularIntensity: 0.55, sheen: 0.35, sheenRoughness: 0.55,
        sheenColor: new THREE.Color(1, 0.62, 0.52), envMapIntensity: 0.75,
      });
      addSkinScatter(o.material);
    } else {
      // Clothes and shoes: a little fabric sheen at grazing angles.
      o.material = toPhysical(m, { sheen: 0.5, sheenRoughness: 0.8, sheenColor: new THREE.Color(0.3, 0.3, 0.32), envMapIntensity: 0.7 });
    }
    if (o.material !== m) m.dispose();
  });
}

// Rotates a bone by a world-space rotation, keeping the rest of its local transform.
const _p = new THREE.Quaternion();
const _m = new THREE.Quaternion();
function rotateWorld(bone, worldRot) {
  bone.parent.getWorldQuaternion(_p);
  _m.copy(_p).invert().multiply(worldRot).multiply(_p);
  bone.quaternion.premultiply(_m);
}

// Ported from GlbViewControl.BuildArmPose: measure where each arm points and rotate it to hang
// down, rather than trusting per-rig Euler angles. Then a slight elbow bend so it looks relaxed.
function poseArms(c) {
  const chains = [
    ['LeftArm', 'LeftForeArm', 'LeftHand'],
    ['RightArm', 'RightForeArm', 'RightHand'],
  ];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const aim = (bone, child, wanted) => {
    c.root.updateMatrixWorld(true);
    bone.getWorldPosition(a);
    child.getWorldPosition(b);
    const dir = b.sub(a).normalize();
    if (dir.dot(wanted) > 0.9999) return;
    rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(dir, wanted));
  };
  for (const [arm, fore, hand] of chains) {
    const B = c.bones;
    if (!B[arm] || !B[fore]) continue;
    c.root.updateMatrixWorld(true);
    B[arm].getWorldPosition(a);
    B[fore].getWorldPosition(b);
    const out = Math.sign(b.x - a.x) || 1; // which side this arm is on
    aim(B[arm], B[fore], new THREE.Vector3(0.16 * out, -1, 0.05).normalize());
    if (B[hand]) aim(B[fore], B[hand], new THREE.Vector3(0.1 * out, -1, 0.22).normalize());
  }
  c.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- camera framing

// Face: a close-up of whoever you're talking to. Upper and full body: everyone, as a group shot.
let camTween = null;
function frame(kind, instant = false) {
  opts.frame = kind;
  save();
  document.querySelectorAll('#framing button').forEach((b) => b.classList.toggle('on', b.dataset.frame === kind));
  const ready = cast.filter((c) => c.model);
  if (!ready.length) return;
  const heads = ready.map((c) => (c.bones.Head ?? c.model).getWorldPosition(new THREE.Vector3()));
  // Distance that fits a span of `tall` x `wide` metres in the visible area (left of the panel).
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const visibleAspect = camera.view ? camera.view.width / camera.view.height : camera.aspect;
  const fit = (tall, wide) => Math.max(tall / 2 / tan, wide / 2 / (tan * visibleAspect));
  const xs = heads.map((p) => p.x);
  const spread = Math.max(...xs) - Math.min(...xs);
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const topY = Math.max(...heads.map((p) => p.y));
  const tallest = Math.max(...ready.map((c) => c.height));
  let target, dist;
  if (kind === 'face') {
    const head = (current?.model ? current.bones.Head ?? current.model : ready[0].bones.Head ?? ready[0].model).getWorldPosition(new THREE.Vector3());
    target = head.add(new THREE.Vector3(0, 0.06, 0));
    dist = fit(0.36, 0.3);
  } else if (kind === 'bust') {
    target = new THREE.Vector3(midX, topY - 0.16, 0);
    dist = fit(0.85, (ready.length > 1 ? 1.05 : 0.65) + spread); // a group needs room for shoulders and hair
  } else {
    target = new THREE.Vector3(midX, tallest / 2, 0);
    dist = fit(tallest * 1.12, 0.8 + spread);
  }
  const pos = target.clone().add(new THREE.Vector3(0, 0.03, dist));
  if (instant) {
    controls.target.copy(target);
    camera.position.copy(pos);
    controls.update();
    return;
  }
  camTween = { t: 0, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target, toP: pos };
}

// ---------------------------------------------------------------- face: one weight per target per frame

const add = (c, name, w) => { if (w > 0.0005) c.weights.set(name, (c.weights.get(name) || 0) + w); };
function applyWeights(c) {
  for (const name of c.weights.keys()) c.managed.add(name);
  for (const name of c.managed) {
    const w = clamp(c.weights.get(name) || 0);
    for (const { mesh, index } of c.morphs.get(name) ?? []) mesh.morphTargetInfluences[index] = w;
  }
  c.weights.clear();
}

// Blink (BlinkDriver): fast close, slower open, random interval, sometimes a double blink.
const CLOSE_MS = 90, OPEN_MS = 170;
function updateBlink(c, ms) {
  if (!opts.blink) return;
  const blink = c.blink;
  const idle = speaker !== c && thinker !== c;
  if (blink.elapsed >= 0) {
    blink.elapsed += ms;
    if (blink.elapsed >= CLOSE_MS + OPEN_MS) {
      blink.elapsed = -1;
      // Idle: longer gaps between blinks (calm resting). Listening: slightly quicker.
      const gap = blink.double ? 120
        : idle ? 2800 + Math.random() * 4500
        : c.watching ? 1600 + Math.random() * 2800
        : 2000 + Math.random() * 4000;
      blink.until = gap;
      blink.double = false;
      return;
    }
    const w = blink.elapsed <= CLOSE_MS ? smoothstep(blink.elapsed / CLOSE_MS) : smoothstep(1 - (blink.elapsed - CLOSE_MS) / OPEN_MS);
    add(c, 'eyeBlinkLeft', w);
    add(c, 'eyeBlinkRight', w);
    return;
  }
  blink.until -= ms;
  if (blink.until <= 0) {
    blink.elapsed = 0;
    blink.double = Math.random() < (idle ? 0.1 : 0.18);
  }
}

// Gaze (GazeDriver): eyes ease toward a point on screen, measured from the face. That point is
// the pointer, or, while someone else is talking or thinking, that person's face.
// "In"/"out" are relative to the nose, so the two eyes take opposite targets horizontally.
const pointer = { x: null, y: null, lastMove: 0 };
addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.lastMove = performance.now(); });
document.addEventListener('pointerleave', () => { pointer.x = null; });
const _v = new THREE.Vector3();
function onScreen(c, out = new THREE.Vector2()) {
  (c.bones.Head ?? c.model).getWorldPosition(_v).add(new THREE.Vector3(0, 0.07, 0)).project(camera);
  return out.set(((_v.x + 1) / 2) * innerWidth, ((1 - _v.y) / 2) * innerHeight);
}
const _me = new THREE.Vector2(), _them = new THREE.Vector2();
function updateGaze(c, dt, now) {
  const gaze = c.gaze;
  const other = speaker && speaker !== c ? speaker : thinker && thinker !== c ? thinker : null;
  c.watching = Boolean(other && opts.gaze);
  if (!opts.gaze || !c.bones.Head) { gaze.tx = gaze.ty = 0; }
  else if (other?.model) {
    // Look at whoever is talking. Screen distance understates a turn toward someone beside you,
    // so the head adds most of the turn (see updateHead).
    onScreen(c, _me);
    onScreen(other, _them);
    gaze.tx = clamp((_them.x - _me.x) / 300, -1, 1);
    gaze.ty = clamp((_them.y - _me.y) / 520, -1, 1);
  } else if (pointer.x !== null && now - pointer.lastMove < 4000) {
    onScreen(c, _me);
    gaze.tx = clamp((pointer.x - _me.x) / 520, -1, 1);
    gaze.ty = clamp((pointer.y - _me.y) / 520, -1, 1);
  } else if (now > gaze.idleAt) {
    // Nobody's pointing: small random glances, mostly back toward the camera.
    const away = Math.random() < 0.35;
    gaze.tx = away ? (Math.random() - 0.5) * 0.8 : 0;
    gaze.ty = away ? (Math.random() - 0.5) * 0.4 : 0;
    gaze.idleAt = now + 1200 + Math.random() * 2600;
  }
  // Feelings pull the eyes too: shy looks down and away, thinking looks up.
  const fx = c.fx;
  const k = ease(0.25, dt);
  gaze.x += (clamp(gaze.tx + fx.gx, -1, 1) - gaze.x) * k;
  gaze.y += (clamp(gaze.ty + fx.gy, -1, 1) - gaze.y) * k;
  if (fx.gaze) { gaze.x = fx.gaze.x; gaze.y = fx.gaze.y; } // eye roll

  const MAX = 0.55;
  const h = Math.abs(gaze.x) * MAX, v = Math.abs(gaze.y) * MAX;
  if (gaze.x > 0) { add(c, 'eyeLookOutLeft', h); add(c, 'eyeLookInRight', h); }
  else { add(c, 'eyeLookInLeft', h); add(c, 'eyeLookOutRight', h); }
  if (gaze.y > 0) { add(c, 'eyeLookDownLeft', v); add(c, 'eyeLookDownRight', v); }
  else { add(c, 'eyeLookUpLeft', v); add(c, 'eyeLookUpRight', v); }
}

// ---------------------------------------------------------------- Microsoft Rocketbox body mocap
// Clips under data/anims (converted from Rocketbox FBX). Bone names are VRM humanoid; we remap to
 // the Avaturn/Mixamo skeleton. fullBody plays legs/hips planted (yaw kept, tip damped).

const RB_BONE = {
  hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot',
  leftThumbMetacarpal: 'LeftHandThumb1', leftThumbProximal: 'LeftHandThumb2',
  leftIndexProximal: 'LeftHandIndex1', leftIndexIntermediate: 'LeftHandIndex2',
  leftMiddleProximal: 'LeftHandMiddle1', leftMiddleIntermediate: 'LeftHandMiddle2',
  leftRingProximal: 'LeftHandRing1', leftRingIntermediate: 'LeftHandRing2',
  leftLittleProximal: 'LeftHandPinky1', leftLittleIntermediate: 'LeftHandPinky2',
  rightThumbMetacarpal: 'RightHandThumb1', rightThumbProximal: 'RightHandThumb2',
  rightIndexProximal: 'RightHandIndex1', rightIndexIntermediate: 'RightHandIndex2',
  rightMiddleProximal: 'RightHandMiddle1', rightMiddleIntermediate: 'RightHandMiddle2',
  rightRingProximal: 'RightHandRing1', rightRingIntermediate: 'RightHandRing2',
  rightLittleProximal: 'RightHandPinky1', rightLittleIntermediate: 'RightHandPinky2',
};
const RB_UPPER = /Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little|spine|chest|upperChest|neck|^head$/i;
const RB_ARMS = /Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/i;
const RB_SETS = {
  listen: ['f_gestic_listen_neutral_01', 'f_gestic_listen_relaxed_01', 'f_gestic_listen_accept_01', 'f_gestic_listen_neutral_02', 'f_gestic_listen_neutral_03'],
  talk: ['f_gestic_talk_neutral_01', 'f_gestic_talk_relaxed_01', 'f_gestic_talk_neutral_02', 'f_gestic_talk_excited_01', 'f_gestic_talk_relaxed_02', 'f_gestic_talk_self-assured_01'],
  idle: ['f_idle_neutral_01', 'f_idle_neutral_02', 'f_idle_neutral_03', 'f_idle_breathe_01', 'f_idle_move_01', 'f_idle_look_around_01', 'f_idle_waiting_01', 'f_idle_shake_leg_01'],
  // Soft studio idle: full-body neutrals/breathe/move (not arms-only).
  softIdle: ['f_idle_neutral_01', 'f_idle_neutral_02', 'f_idle_neutral_03', 'f_idle_breathe_01', 'f_idle_move_01', 'f_idle_waiting_01'],
};
// mode comes from the server (Luna's avatar_motion tool). Default rest = natural arms (fixes zombie pose).
const rb = {
  catalog: [],
  clips: new Map(),
  ready: false,
  motion: { mode: 'rest', clip: null, intensity: 0.85, fullBody: false },
};
const _rbQ1 = new THREE.Quaternion();
const _rbQ2 = new THREE.Quaternion();
const _rbBind = new THREE.Quaternion();
const _rbDelta = new THREE.Quaternion();
const _rbTarget = new THREE.Quaternion();
const _rbAcc = new THREE.Quaternion(); // blend accumulator (must not share scratch with sampleRbBone)
const _rbHipApplied = new THREE.Euler();
const _rbHipRest = new THREE.Euler();
const _rbHipOut = new THREE.Euler();

async function loadRocketbox() {
  try {
    const [{ files }, motion] = await Promise.all([
      fetch('/api/avatar/anims').then((r) => r.json()),
      fetch('/api/avatar/motion').then((r) => r.json()).catch(() => null),
    ]);
    rb.catalog = files || [];
    if (motion) applyMotionState(motion);
    // Prefetch talk/listen/idle plus every semantic expression clip we might need.
    const want = [...new Set([...RB_SETS.listen, ...RB_SETS.talk, ...RB_SETS.idle, ...expressClipNames()])];
    await Promise.all(want.map((n) => ensureRbClip(n)));
    rb.ready = true;
    startAvatarLive(); // Discord voice → lip sync + motion updates
  } catch (err) {
    console.warn('Rocketbox anims:', err);
  }
}

function applyMotionState(s) {
  if (!s) return;
  rb.motion = {
    mode: s.mode || 'rest',
    clip: s.clip || null,
    intensity: typeof s.intensity === 'number' ? s.intensity : 0.85,
    fullBody: Boolean(s.fullBody),
  };
}

async function ensureRbClip(name) {
  if (!name || rb.clips.has(name)) return rb.clips.get(name);
  try {
    const clip = await fetch(`/api/avatar/anims/${encodeURIComponent(name)}`).then((r) => {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    });
    // Frame 0 = clip bind pose; we apply deltas from that onto the character's rest pose
    // so Mixamo arms don't get overwritten by absolute VRM quaternions (zombie T-pose).
    clip.bind = {};
    for (const [vrmName, arr] of Object.entries(clip.bones || {})) {
      clip.bind[vrmName] = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]);
    }
    rb.clips.set(name, clip);
    return clip;
  } catch {
    rb.clips.set(name, null);
    return null;
  }
}

function pickRbClip(list, seed) {
  const available = list.filter((n) => rb.clips.get(n));
  if (!available.length) return null;
  return available[Math.abs(seed) % available.length];
}

/** Ease 0→1 with a smoothstep so clip swaps don't pop. */
function rbEase(t) {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
}

/**
 * Sample one bone's retargeted pose into outQ (rest * bind^-1 * frame).
 * Returns false if this bone isn't in the clip / shouldn't be used.
 */
function sampleRbBone(c, clip, vrmName, time, upperOnly, outQ, armsOnly = false) {
  if (armsOnly) {
    if (!RB_ARMS.test(vrmName)) return false;
  } else if (upperOnly) {
    if (/UpperLeg|LowerLeg|Foot|^hips$/i.test(vrmName)) return false;
    if (!RB_UPPER.test(vrmName) && !/^(spine|chest|upperChest|neck|head)$/i.test(vrmName)) return false;
  }
  const arr = clip.bones[vrmName];
  const bindQ = clip.bind[vrmName];
  const boneName = RB_BONE[vrmName];
  const bone = boneName && c.bones[boneName];
  const restQ = bone && c.rest.get(bone);
  if (!arr || !bindQ || !bone || !restQ) return false;
  const last = clip.frames - 1;
  if (last < 1) return false;
  let f = ((time * clip.fps) % last + last) % last;
  const i = Math.floor(f);
  const j = Math.min(last, i + 1);
  const u = f - i;
  _rbQ1.set(arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]);
  _rbQ2.set(arr[j * 4], arr[j * 4 + 1], arr[j * 4 + 2], arr[j * 4 + 3]);
  _rbQ1.slerp(_rbQ2, u);
  _rbDelta.copy(bindQ).invert().multiply(_rbQ1);
  outQ.copy(restQ).multiply(_rbDelta);
  // Planted full-body: keep hip yaw from mocap, damp pitch/roll so she doesn't tip/spin.
  if (!upperOnly && !armsOnly && /^hips$/i.test(vrmName)) {
    _rbHipApplied.setFromQuaternion(outQ, 'YXZ');
    _rbHipRest.setFromQuaternion(restQ, 'YXZ');
    _rbHipOut.set(
      _rbHipRest.x * 0.82 + _rbHipApplied.x * 0.18,
      _rbHipApplied.y,
      _rbHipRest.z * 0.82 + _rbHipApplied.z * 0.18,
      'YXZ',
    );
    outQ.setFromEuler(_rbHipOut);
  }
  return true;
}

/**
 * Apply one or more Rocketbox layers with proper quaternion blending.
 * layers: [{ name, time, weight, upperOnly? }] — weights should roughly sum ≤ 1.
 * masterWeight scales the whole result toward rest (0 = rest pose).
 */
function applyRbLayers(c, layers, masterWeight = 1) {
  const mw = clamp(masterWeight);
  if (mw <= 0.01 || !layers?.length) return;
  const active = [];
  for (const L of layers) {
    if (!L?.name || (L.weight ?? 0) <= 0.01) continue;
    const clip = rb.clips.get(L.name);
    if (!clip?.bind) continue;
    active.push({
      clip,
      time: L.time || 0,
      weight: L.weight,
      upperOnly: L.upperOnly !== false,
      armsOnly: Boolean(L.armsOnly),
    });
  }
  if (!active.length) return;

  // Collect every bone name any layer touches.
  const names = new Set();
  for (const L of active) {
    for (const vrmName of Object.keys(L.clip.bones)) names.add(vrmName);
  }

  for (const vrmName of names) {
    const boneName = RB_BONE[vrmName];
    const bone = boneName && c.bones[boneName];
    if (!bone) continue;

    let accW = 0;
    let first = true;
    for (const L of active) {
      if (!sampleRbBone(c, L.clip, vrmName, L.time, L.upperOnly, _rbTarget, L.armsOnly)) continue;
      if (first) {
        _rbAcc.copy(_rbTarget);
        accW = L.weight;
        first = false;
      } else {
        const t = L.weight / (accW + L.weight);
        _rbAcc.slerp(_rbTarget, t);
        accW += L.weight;
      }
    }
    if (first || accW <= 0.01) continue;
    // Soften when layers don't cover a full weight — leave more of the rest pose.
    const applyW = mw * clamp(accW);
    bone.quaternion.slerp(_rbAcc, applyW);
  }
}

function applyRbClip(c, name, time, weight, upperOnly = true, armsOnly = false) {
  applyRbLayers(c, [{ name, time, weight: 1, upperOnly, armsOnly }], weight);
}

/** Crossfade helper: keep prev→next with a timed mix. */
function rbCrossfade(state, nextName, now, blendMs = 650) {
  if (!nextName) return;
  if (state.clip === nextName) return;
  if (!state.clip) {
    state.clip = nextName;
    state.prev = null;
    state.mix = 1;
    state.blendFrom = now;
    state.blendMs = blendMs;
    return;
  }
  state.prev = state.clip;
  state.clip = nextName;
  state.mix = 0;
  state.blendFrom = now;
  state.blendMs = blendMs;
}

function rbMixAt(state, now) {
  if (!state.prev || !state.clip) return 1;
  const u = rbEase((now - (state.blendFrom || now)) / Math.max(1, state.blendMs || 650));
  state.mix = u;
  if (u >= 0.999) {
    state.prev = null;
    state.mix = 1;
  }
  return state.mix;
}

function updateRocketbox(c, dt, now) {
  if (!rb.ready || !c.model) return;
  // While studio body-language owns the arms, keep Rocketbox base out of the way —
  // stacking two mocap clips is what caused the poppy "glitch" transitions.
  if ((thinker === c || speaker === c) && c.express?.clip) return;
  const mode = rb.motion.mode || 'rest';
  if (mode === 'rest') return; // natural posed arms from poseArms / rest quats
  const intensity = rb.motion.intensity ?? 0.85;
  c.rb = c.rb || {
    t: Math.random() * 30, talkW: 0,
    listenName: null, talkName: null, idleName: null, idleUntil: 0,
    talk: { clip: null, prev: null, mix: 1, blendFrom: 0, blendMs: 700 },
    idle: { clip: null, prev: null, mix: 1, blendFrom: 0, blendMs: 900 },
    listen: { clip: null, prev: null, mix: 1, blendFrom: 0, blendMs: 700 },
    modeW: { listen: 0, talk: 0, idle: 0.35 },
  };
  const s = c.rb;
  s.t += dt;
  const talking = speaker === c ? 1 : 0;
  // Slower talk/listen weight ramp so shoulders don't snap when she starts speaking.
  s.talkW += ((talking ? 1 : 0) - s.talkW) * Math.min(1, dt * 2.2);
  const seed = c.id.length + Math.floor(s.t / 14);

  const upperOnly = !rb.motion.fullBody;
  if (mode === 'clip' && rb.motion.clip) {
    ensureRbClip(rb.motion.clip);
    applyRbClip(c, rb.motion.clip, s.t, intensity, upperOnly);
    return;
  }

  if (!s.listenName) {
    s.listenName = pickRbClip(RB_SETS.listen, seed);
    rbCrossfade(s.listen, s.listenName, now, 500);
  }
  // Swap talk clips less often, and always crossfade.
  if (!s.talkName || (talking && Math.floor(s.t / 14) !== Math.floor((s.t - dt) / 14))) {
    const next = pickRbClip(RB_SETS.talk, seed + 3);
    if (next && next !== s.talkName) {
      s.talkName = next;
      rbCrossfade(s.talk, next, now, 750);
    } else if (!s.talk.clip && next) {
      s.talkName = next;
      rbCrossfade(s.talk, next, now, 500);
    }
  }
  if (!s.idleName || now > s.idleUntil) {
    const next = pickRbClip(RB_SETS.idle, seed + 7);
    s.idleName = next;
    s.idleUntil = now + 10000 + Math.random() * 12000;
    if (next) rbCrossfade(s.idle, next, now, 1000);
  }

  rbMixAt(s.listen, now);
  rbMixAt(s.talk, now);
  rbMixAt(s.idle, now);

  const layersFor = (slot, time, w) => {
    if (w <= 0.02) return [];
    const out = [];
    // Talk/listen gestic stays upper; idle can plant full-body when pressure asks for it.
    const uOnly = slot === s.idle ? upperOnly : true;
    if (slot.prev) out.push({ name: slot.prev, time, weight: (1 - slot.mix) * w, upperOnly: uOnly });
    if (slot.clip) out.push({ name: slot.clip, time, weight: (slot.mix ?? 1) * w, upperOnly: uOnly });
    return out;
  };

  if (mode === 'listen') {
    applyRbLayers(c, layersFor(s.listen, s.t + 2.1, 1), intensity);
    return;
  }
  if (mode === 'talk') {
    applyRbLayers(c, layersFor(s.talk, s.t + 1.3, 1), intensity);
    return;
  }
  if (mode === 'idle') {
    applyRbLayers(c, layersFor(s.idle, s.t * 0.7, 1), intensity);
    return;
  }
  // auto — blend listen / talk / idle with soft weights (no hard cut between modes)
  const listenW = 0.7 * (1 - s.talkW);
  const talkW = 0.88 * s.talkW;
  const idleW = 0.32 * (1 - s.talkW) * (1 - talkW * 0.5);
  applyRbLayers(c, [
    ...layersFor(s.listen, s.t + 2.1, listenW),
    ...layersFor(s.talk, s.t + 1.3, talkW),
    ...layersFor(s.idle, s.t * 0.7, idleW),
  ], intensity);
}

function topFeeling(c) {
  const entries = Object.entries(c.feel?.now || {}).filter(([, v]) => v >= 0.08).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || null;
}

// Cortex event buffer — survives while the Brain panel is closed, flushed on open.
const brainBuf = [];
function brainSpark(ev) {
  if (!ev || ev.silent && !ev.system) return;
  brainBuf.push({ ...ev, _t: Date.now() });
  if (brainBuf.length > 48) brainBuf.shift();
  noteTurn(ev);
  if (!brainViz?.isActive?.()) return;
  try {
    if (ev.pathway || ev.type === 'pathway') brainViz.pathway(ev.systems || ev.pathway, { label: ev.label });
    else brainViz.spark(ev);
  } catch { /* panel may be closed */ }
}
function brainPathway(systems, label) {
  brainSpark({ type: 'pathway', systems, pathway: systems, label });
}

// Turn transparency chip — compact log of what this reply actually did.
const turn = { steps: [], clearAt: 0 };
function noteTurn(ev) {
  if (!ev?.system || ev.silent) return;
  // Chip shows cognition + tools, not body/lips/presence flicker.
  if (/^(presence|body|lips)$/.test(ev.system)) return;
  const label = (ev.label || ev.system || '').replace(/\s+/g, ' ').trim().slice(0, 36);
  const key = `${ev.system}:${label}`;
  if (turn.steps[turn.steps.length - 1]?.key === key) return;
  turn.steps.push({ key, system: ev.system, label });
  if (turn.steps.length > 6) turn.steps.shift();
  turn.clearAt = Date.now() + 14000;
  renderTurnChip();
}
function beginTurnChip() {
  turn.steps = [];
  turn.clearAt = Date.now() + 20000;
  renderTurnChip();
}
function renderTurnChip() {
  const chip = $('#turnChip');
  const el = $('#turnSteps');
  if (!chip || !el) return;
  if (!turn.steps.length || Date.now() > turn.clearAt) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  el.innerHTML = turn.steps.map((s) => `<b>${escapeHtml(s.system)}</b>${escapeHtml(s.label)}`).join(' · ');
}
setInterval(() => {
  if (turn.steps.length && Date.now() > turn.clearAt) {
    turn.steps = [];
    renderTurnChip();
  }
}, 2000);

function cueTextFor(c) {
  // Prefer the line she's saying, else what you just asked — words pick the Rocketbox motion.
  if (speaker === c && c.lips?.track?.words != null) {
    // track may not keep raw text; fall through to lastCueText / caption
  }
  if (speaker === c) {
    const cap = $('#captionText')?.textContent || '';
    if (cap) return cap.replace(new RegExp(`^${c.name}\\s*`, 'i'), '');
  }
  return lastCueText || '';
}

/**
 * Body language while thinking or talking: word-associated Rocketbox clips + gestures.
 * Clip changes crossfade (~0.7s) so arms don't pop between motions.
 */
function updateBodyLanguage(c, dt, now) {
  const active = thinker === c || speaker === c;
  // Pressure can drive idle express when Rocketbox is on rest (no forced clip/idle set).
  const pressureIdle = !active && rb.ready
    && (rb.motion.mode || 'rest') === 'rest'
    && rb.pressureFeel
    && now < (rb.pressureUntil || 0);
  if ((!active && !pressureIdle) || !rb.ready) {
    if (c.express) {
      // Fade express intensity out instead of cutting to rest in one frame.
      c.express.outW = Math.max(0, (c.express.outW ?? 1) - dt / 0.55);
      if (c.express.outW <= 0.02) c.express = null;
      else if (c.express.clip) {
        const upperOnly = opts.frame === 'face' || !(c.express.fullBody || rb.motion.fullBody);
        const t = (now / 1000) * 0.8;
        const layers = [];
        if (c.express.prev) layers.push({ name: c.express.prev, time: t, weight: 1 - (c.express.mix ?? 1), upperOnly });
        layers.push({ name: c.express.clip, time: t, weight: c.express.mix ?? 1, upperOnly });
        applyRbLayers(c, layers, (c.express.outW ?? 1) * 0.45 * (rb.motion.intensity ?? 0.85));
      }
    }
    return;
  }
  const feel = active ? topFeeling(c) : (rb.pressureFeel || topFeeling(c));
  const text = cueTextFor(c);
  const motion = resolveBodyLanguage(text, feel);
  const fresh = !c.express;
  c.express = c.express || {
    clip: null, prev: null, mix: 1, blendFrom: 0, blendMs: 700,
    until: 0, gestureAt: 0, label: '', key: '', fullBody: false, outW: 1, intensity: 0,
  };
  const e = c.express;
  e.outW = 1;
  const key = `${motion.label}|${motion.source}|${(motion.hits || []).join(',')}`;
  const keyChanged = fresh || e.key !== key;
  if (keyChanged || now > e.until || !e.clip) {
    e.key = key;
    e.label = motion.label;
    e.fullBody = Boolean(motion.fullBody) || Boolean(rb.motion.fullBody) || /move|leg|dance|cheer|stretch|shake_leg|nervous|yawn/i.test(motion.clips.join(' '));
    for (const n of motion.clips) ensureRbClip(n);
    // Prefer a different clip than the one currently playing so the blend is visible.
    const seed = c.id.length + Math.floor(now / 1800);
    let next = pickRbClip(motion.clips, seed) || pickRbClip(motion.clips.filter((n) => rb.clips.has(n)), seed);
    if (next && next === e.clip && motion.clips.length > 1) {
      next = pickRbClip(motion.clips.filter((n) => n !== e.clip), seed + 5) || next;
    }
    if (next) rbCrossfade(e, next, now, fresh ? 450 : 750);
    // Hold each motion longer so she settles into it instead of thrashing.
    e.until = now + (speaker === c ? 3200 : 4200) + Math.random() * 3500;
    if (fresh) e.gestureAt = now + 600;
    if (state === 'thinking' && thinker === c) {
      $('#stateText').textContent = `${c.name} is ${motion.label}`;
      $('#stateDot').className = 'dot busy';
    }
    if (keyChanged) {
      brainSpark({
        kind: motion.source === 'word' ? 'word' : speaker === c ? 'speak' : 'think',
        system: 'body',
        label: motion.label,
        intensity: motion.source === 'word' ? 1.0 : 0.7,
      });
    }
  }
  // Keep a readable act line on the feelings dock.
  c.think = speaker === c ? null : { label: e.label };
  const mix = rbMixAt(e, now);
  const targetI = speaker === c ? 0.72 : 0.58;
  // Soft intensity — no pulsing sin on the bone weight (that read as jitter).
  e.intensity += (targetI - (e.intensity || targetI)) * Math.min(1, dt * 3);
  const breath = 1 + 0.04 * Math.sin((now / 1000) * 1.1); // tiny, smooth
  if (e.clip && rb.clips.get(e.clip)) {
    const upperOnly = opts.frame === 'face' || !e.fullBody;
    const speed = speaker === c ? 0.95 : 0.78;
    const t = (now / 1000) * speed;
    const layers = [];
    if (e.prev && rb.clips.get(e.prev)) {
      layers.push({ name: e.prev, time: t, weight: 1 - mix, upperOnly });
    }
    layers.push({ name: e.clip, time: t, weight: mix, upperOnly });
    applyRbLayers(c, layers, e.intensity * breath * (rb.motion.intensity ?? 0.85));
  }
  if (now >= e.gestureAt) {
    const g = motion.gestures[Math.floor(Math.random() * motion.gestures.length)];
    if (g) playGesture(c, g);
    // Gestures less often — overlapping shrugs/nods stacked on mocap looked twitchy.
    e.gestureAt = now + (speaker === c ? 2800 : 3600) + Math.random() * 3200;
    // No brain spark per gesture — that was the random-light noise.
  }
}

function updateMicroExpressions(c, now) {
  if (!c.model) return;
  const busy = thinker === c || speaker === c;
  c.micro = c.micro || { until: 0, born: 0, shapes: {} };
  const m = c.micro;
  if (!busy) {
    m.shapes = {};
    return;
  }
  if (now >= m.until) {
    const resolved = resolveBodyLanguage(cueTextFor(c), topFeeling(c));
    const mood = resolved.micro || topFeeling(c);
    m.shapes = pickMicroShapes(mood, speaker === c);
    m.born = now;
    // Longer hold so Blender-amplified brows/smiles register on camera.
    m.until = now + (speaker === c ? 420 + Math.random() * 680 : 650 + Math.random() * 900);
    // Micro flickers stay on the face only — not the cortex map.
  }
  const w = microWeight(now, m.born, m.until) * opts.expr * 0.55 * (speaker === c ? 0.9 : 0.75);
  if (w <= 0.01) return;
  for (const [shape, amt] of Object.entries(m.shapes)) add(c, shape, amt * w);
}

// Back-compat name used from updateHead.
function updateThinking(c, dt, now) {
  updateBodyLanguage(c, dt, now);
}

// Discord voice (and motion tool) → this page.
function startAvatarLive() {
  if (rb.live) return;
  rb.live = true;
  const events = new EventSource('/api/avatar/live');
  events.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'motion') {
      applyMotionState(msg);
      return;
    }
    if (msg.type === 'feelings') {
      const who = byId.get(msg.character || 'main') || cast.find((c) => c.main) || cast[0];
      if (who && msg.feelings) setFeelings(who, msg.feelings, Boolean(msg.pressure?.beat));
      if (msg.pressure?.label) {
        brainSpark({
          kind: 'feel',
          system: 'pressure',
          label: msg.pressure.label,
          intensity: msg.pressure.value ?? 0.5,
          from: 'pressure',
        });
        brainPathway(['pressure', 'feelings', 'body'], msg.pressure.label);
      }
      // Idle body language can follow pressure when she's not mid-chat express.
      if (msg.pressure?.feel) {
        rb.pressureFeel = msg.pressure.feel;
        rb.pressureLabel = msg.pressure.label || '';
        rb.pressureUntil = performance.now() + (msg.pressure.beat ? 12_000 : 55_000);
      }
      return;
    }
    if (msg.type === 'sleep') {
      const asleep = Boolean(msg.sleep?.asleep || msg.sleep?.lay);
      document.body.classList.toggle('avatar-asleep', asleep);
      if (asleep) toast(`${msg.sleep?.stage || 'sleeping'}…`);
      return;
    }
    if (msg.type !== 'speech' || !msg.text) return;
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const who = byId.get(msg.character || 'main') || cast.find((c) => c.main) || cast[0];
    if (!who) return;
    let buffer = null;
    if (msg.audio) {
      try { buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(msg.audio)); } catch {}
    }
    // Discord mirrors stay silent locally (call already has audio). Theater/studio reactions play.
    const silent = Boolean(msg.audio) && !msg.playLocal;
    if (msg.playLocal && msg.text) {
      try {
        const row = document.createElement('div');
        row.className = 'bubble them';
        row.innerHTML = `<b>${escapeHtml(who.name || 'Lyra')}</b><div class="text"></div>`;
        row.querySelector('.text').textContent = msg.text;
        log?.append?.(row);
        log && (log.scrollTop = log.scrollHeight);
      } catch {}
    }
    enqueueSpeech({ char: who.id, text: msg.text, buffer, feelings: null, gestures: null, silent });
  };
  events.onerror = () => { /* browser reconnects EventSource automatically */ };
}

// Head motion (HeadMotionDriver): layered sines at unrelated periods plus occasional glances.
// The head also turns toward where the eyes are looking, and nods with speech.
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function updateHead(c, dt) {
  const B = c.bones, fx = c.fx, s = c.head;
  // Always re-assert upright root (guards against any accidental x/z tip).
  if (c.root) {
    c.root.rotation.x = 0;
    c.root.rotation.z = 0;
  }
  for (const [bone, q] of c.rest) bone.quaternion.copy(q);
  // Body mocap from Rocketbox (after rest restore, before procedural head overlay).
  const now = performance.now();
  updateRocketbox(c, dt, now);
  updateThinking(c, dt, now);
  s.t += dt;
  const t = s.t;
  // Idle presence: breath only. Never touch Hips — world-space hip rotates tip/spin the whole body.
  const idle = speaker !== c && thinker !== c;
  c.presence = c.presence || { sway: 0, side: 1, nextShift: 0 };
  const pr = c.presence;
  pr.sway = 0;

  // Breathing: slow chest lift (stronger at rest so she doesn't look frozen).
  const breathAmp = idle ? 1.25 : 0.85;
  const breath = Math.sin(t * (idle ? 1.25 : 1.6)) * THREE.MathUtils.degToRad(0.75 * breathAmp) * fx.breath;
  if (B.Spine2) rotateWorld(B.Spine2, _q.setFromEuler(_e.set(-breath, 0, 0, 'YXZ')));
  if (B.Spine1 && idle) rotateWorld(B.Spine1, _q.setFromEuler(_e.set(-breath * 0.35, 0, 0, 'YXZ')));

  // Soft idle Rocketbox: planted full-body neutrals (legs included, hips tip-damped).
  if (idle && rb.ready && (rb.motion.mode || 'rest') === 'rest' && !c.express?.clip) {
    c.rbIdle = c.rbIdle || { name: null, t: Math.random() * 20, until: 0 };
    const id = c.rbIdle;
    id.t += dt;
    if (!id.name || now > id.until) {
      id.name = pickRbClip(RB_SETS.softIdle, c.id.length + Math.floor(now / 12000));
      id.until = now + 9000 + Math.random() * 10000;
      if (id.name) ensureRbClip(id.name);
    }
    if (id.name) applyRbClip(c, id.name, id.t * 0.55, 0.38, false, false);
  }

  // Shrugs and laughs lift the shoulders (kept gentle so they don't fight Rocketbox blends).
  if (fx.shoulders > 0.001) {
    const lift = THREE.MathUtils.degToRad(5.5) * fx.shoulders;
    if (B.LeftShoulder) rotateWorld(B.LeftShoulder, _q.setFromEuler(_e.set(0, 0, lift)));
    if (B.RightShoulder) rotateWorld(B.RightShoulder, _q.setFromEuler(_e.set(0, 0, -lift)));
  }

  const deg = THREE.MathUtils.degToRad;
  // Turning to face whoever's talking takes the head, not just the eyes.
  const turn = c.watching ? deg(26) : deg(7);
  // Feeling and gesture poses apply even with idle motion off.
  const poseP = deg(fx.pitch), poseY = deg(fx.yaw), poseR = deg(fx.roll);
  if (!opts.head) {
    const y = poseY + (c.watching ? c.gaze.x * turn : 0);
    if (B.Neck) rotateWorld(B.Neck, _q.setFromEuler(_e.set(poseP * 0.4, y * 0.4, poseR * 0.4, 'YXZ')));
    if (B.Head) rotateWorld(B.Head, _q.setFromEuler(_e.set(poseP * 0.6, y * 0.6, poseR * 0.6, 'YXZ')));
    return;
  }
  // Quieter head wander while idle; a bit more life while listening to someone else.
  const live = idle ? 0.7 : c.watching ? 1.05 : 1;
  let yaw = (0.55 * Math.sin(t * 0.23) + 0.3 * Math.sin(t * 0.61 + 1.7) + 0.15 * Math.sin(t * 1.3 + 0.4)) * live;
  let pitch = (0.5 * Math.sin(t * 0.19 + 2.1) + 0.32 * Math.sin(t * 0.53 + 0.9) + 0.18 * Math.sin(t * 1.1 + 2.7)) * live;
  const roll = (0.6 * Math.sin(t * 0.17 + 0.6) + 0.4 * Math.sin(t * 0.44 + 1.2)) * live + pr.sway * 0.35;

  s.next -= dt;
  if (s.next <= 0) {
    s.gYaw = (Math.random() - 0.5) * (idle ? 1.4 : 2);
    s.gPitch = (Math.random() - 0.5) * (idle ? 0.8 : 1.2);
    s.decay = 1;
    s.next = (idle ? 7 : 6) + Math.random() * (idle ? 12 : 10);
  }
  if (s.decay > 0) s.decay = Math.max(0, s.decay - dt / 2.5);
  const g = smoothstep(s.decay);
  yaw += s.gYaw * g;
  pitch += s.gPitch * g;

  const speak = speaker === c ? 1.45 : 1;
  const i = opts.intensity * speak * fx.motion;
  const y = deg(yaw * 3.2 * i) + c.gaze.x * turn + poseY;
  const p = deg(pitch * 2 * i) + c.gaze.y * deg(4) + c.lips.level * deg(2.2) * opts.intensity + poseP;
  const r = deg(roll * 1.4 * i) + poseR;

  // Shared between neck and head so the bend isn't all at one joint.
  if (B.Neck) rotateWorld(B.Neck, _q.setFromEuler(_e.set(p * 0.4, y * 0.4, r * 0.4, 'YXZ')));
  if (B.Head) rotateWorld(B.Head, _q.setFromEuler(_e.set(p * 0.6, y * 0.6, r * 0.6, 'YXZ')));
}

function degSafe(d) {
  return THREE.MathUtils.degToRad(d);
}

// ---------------------------------------------------------------- feelings

// There are no presets. The server keeps each character's emotional state as a blend of feelings
// (0..1 each), updated from the conversation, and the face is the weighted sum of every feeling's
// expression. Each expression also biases head pose (degrees; +pitch is chin down), gaze, how much
// they move, and how often they blink, so "sad" droops and looks down while "excited" is wide-eyed.
const LR = (base, v) => ({ [base + 'Left']: v, [base + 'Right']: v });
const X = (face, more = {}) => ({ face, pitch: 0, yaw: 0, roll: 0, gx: 0, gy: 0, motion: 1, blink: 1, ...more });
const EXPRESSIONS = {
  calm: X({ ...LR('mouthSmile', 0.08) }, { motion: 0.85 }),
  joy: X({ ...LR('mouthSmile', 0.62), ...LR('cheekSquint', 0.38), ...LR('eyeSquint', 0.15), browInnerUp: 0.1 }, { pitch: -1.5, motion: 1.2 }),
  amused: X({ mouthSmileLeft: 0.55, mouthSmileRight: 0.42, ...LR('cheekSquint', 0.45), ...LR('eyeSquint', 0.35), ...LR('mouthDimple', 0.2) }, { roll: 3, pitch: -1, motion: 1.25 }),
  fond: X({ ...LR('mouthSmile', 0.3), ...LR('eyeSquint', 0.12), ...LR('eyeBlink', 0.12), browInnerUp: 0.18 }, { roll: 4, pitch: 1.5, motion: 0.9 }),
  playful: X({ mouthSmileLeft: 0.48, mouthSmileRight: 0.18, browOuterUpLeft: 0.42, eyeSquintRight: 0.22, mouthLeft: 0.1 }, { roll: -5, yaw: 3, motion: 1.2 }),
  smug: X({ mouthSmileLeft: 0.5, mouthPressRight: 0.22, ...LR('eyeSquint', 0.3), browDownRight: 0.15, ...LR('eyeBlink', 0.1) }, { pitch: -4, roll: 2 }),
  excited: X({ ...LR('mouthSmile', 0.38), browInnerUp: 0.18, ...LR('browOuterUp', 0.2), ...LR('eyeWide', 0.12), jawOpen: 0.02 }, { pitch: -1, motion: 1.25, blink: 1.1 }),
  flirty: X({ mouthSmileLeft: 0.36, mouthSmileRight: 0.24, ...LR('eyeBlink', 0.22), browOuterUpLeft: 0.15, ...LR('cheekSquint', 0.12) }, { roll: 6, pitch: 2.5, gx: -0.22, gy: 0.05, motion: 0.9 }),
  confident: X({ ...LR('mouthSmile', 0.2), ...LR('eyeSquint', 0.1), ...LR('browDown', 0.06) }, { pitch: -3, motion: 0.9 }),
  curious: X({ browInnerUp: 0.14, browOuterUpLeft: 0.2, ...LR('eyeWide', 0.06), mouthPucker: 0.04 }, { roll: 4, yaw: 1, pitch: 0.5 }),
  pensive: X({ browInnerUp: 0.2, browDownLeft: 0.25, mouthPressLeft: 0.25, mouthRollLower: 0.2, mouthLeft: 0.15 }, { pitch: -2, gx: -0.4, gy: -0.45, motion: 0.7 }),
  confused: X({ browDownLeft: 0.45, browOuterUpRight: 0.4, browInnerUp: 0.15, mouthLeft: 0.2, mouthPressRight: 0.2, eyeSquintLeft: 0.2 }, { roll: -6 }),
  skeptical: X({ browDownLeft: 0.65, browOuterUpRight: 0.6, eyeSquintLeft: 0.45, mouthPressLeft: 0.35, mouthRight: 0.2, mouthSmileRight: 0.12 }, { pitch: -3, roll: 4 }),
  surprised: X({ browInnerUp: 0.7, ...LR('browOuterUp', 0.6), ...LR('eyeWide', 0.55), mouthFunnel: 0.04 }, { pitch: -3, motion: 1.2 }),
  worried: X({ browInnerUp: 0.65, ...LR('browDown', 0.1), ...LR('eyeWide', 0.2), ...LR('mouthPress', 0.25), ...LR('mouthStretch', 0.15), ...LR('mouthFrown', 0.1) }, { pitch: 2, gy: 0.1, blink: 1.6 }),
  sad: X({ browInnerUp: 0.6, ...LR('mouthFrown', 0.45), ...LR('mouthPress', 0.15), mouthShrugLower: 0.2, ...LR('eyeBlink', 0.18) }, { pitch: 6, gy: 0.3, motion: 0.6 }),
  embarrassed: X({ ...LR('mouthSmile', 0.25), ...LR('mouthPress', 0.2), ...LR('eyeBlink', 0.2), browInnerUp: 0.25, ...LR('cheekSquint', 0.15) }, { pitch: 6, yaw: -6, gx: -0.35, gy: 0.35, blink: 1.5 }),
  annoyed: X({ ...LR('browDown', 0.45), ...LR('eyeSquint', 0.25), ...LR('mouthPress', 0.35), ...LR('mouthFrown', 0.15), ...LR('noseSneer', 0.1) }, { pitch: -1, motion: 0.9 }),
  angry: X({ ...LR('browDown', 1), ...LR('eyeSquint', 0.3), ...LR('noseSneer', 0.55), ...LR('mouthPress', 0.5), ...LR('mouthFrown', 0.4), ...LR('mouthUpperUp', 0.2), jawForward: 0.12 }, { pitch: 4, motion: 1.1, blink: 0.6 }),
  disgusted: X({ ...LR('noseSneer', 0.6), ...LR('mouthUpperUp', 0.45), ...LR('browDown', 0.35), ...LR('eyeSquint', 0.3), ...LR('mouthFrown', 0.25) }, { pitch: -3, yaw: 6 }),
  bored: X({ ...LR('eyeBlink', 0.3), ...LR('mouthPress', 0.1), mouthLeft: 0.2, mouthRollLower: 0.1 }, { roll: -4, gx: 0.3, gy: -0.1, motion: 0.5, blink: 0.7 }),
  tired: X({ ...LR('eyeBlink', 0.45), browInnerUp: 0.2, ...LR('mouthFrown', 0.1), jawOpen: 0.03 }, { pitch: 5, motion: 0.5, blink: 0.6 }),
  determined: X({ ...LR('browDown', 0.35), ...LR('mouthPress', 0.3), ...LR('eyeSquint', 0.15), jawForward: 0.1 }, { pitch: 1 }),
  scared: X({ browInnerUp: 0.7, ...LR('eyeWide', 0.7), ...LR('mouthStretch', 0.2) }, { pitch: 3, motion: 1.3, blink: 1.5 }),
};
const NEGATIVE = ['sad', 'annoyed', 'angry', 'disgusted', 'worried', 'scared', 'tired', 'bored', 'skeptical'];
const SPEECH_SAFE = /Smile|cheek|eye|brow|nose/; // brows/eyes stay; mouth belongs to lip sync while talking
const SPEECH_MOUTH = /jaw|mouthOpen|mouthFunnel|mouthPucker|mouthStretch|mouthPress|mouthLower|mouthUpper|mouthRoll|mouthShrug|tongue/i;
const HALF_LIFE = 90; // seconds, matching the server

// beat: a new sentence started, so give its strongest feeling a visible push even if the mix is similar.
function setFeelings(c, f, beat = false) {
  if (!c) return;
  c.feel.target = { ...(f || {}) };
  if (beat) {
    const top = Object.entries(c.feel.target).sort((a, b) => b[1] - a[1])[0];
    if (top) c.feel.pulse = { name: top[0], start: performance.now() };
  }
  if (c === current) renderFeelings();
}

// Lopsided expressions (a smirk, one raised brow) are written for one side. Each time a feeling
// starts, it picks a side at random, so the face doesn't lean the same way all the time.
const mirror = (shape) => shape.replace(/Left|Right/, (m) => (m === 'Left' ? 'Right' : 'Left'));

// Per-frame effects of feelings and gestures (c.fx), read by gaze, blink and head motion.
function updateFeelings(c, dt) {
  const feel = c.feel;
  const decay = Math.pow(0.5, dt / HALF_LIFE);
  for (const k of Object.keys(feel.target)) if ((feel.target[k] *= decay) < 0.03) delete feel.target[k];
  const goal = { ...feel.target };
  // While thinking: only lean pensive if nothing else is already driving her face —
  // otherwise excited/annoyed/flirty reactions stay visible (and can look like dancing, etc.).
  if (thinker === c) {
    const lead = Object.entries(feel.target).sort((a, b) => b[1] - a[1])[0];
    if (!lead || lead[1] < 0.18) goal.pensive = Math.max(goal.pensive || 0, 0.4);
  }

  const fx = (c.fx = { pitch: 0, yaw: 0, roll: 0, gx: 0, gy: 0, motion: 1, blink: 1, shoulders: 0, breath: 1, gaze: null });
  const k = ease(0.06, dt);
  for (const name of new Set([...Object.keys(feel.now), ...Object.keys(goal)])) {
    const was = feel.now[name] || 0;
    const v = (feel.now[name] = was + ((goal[name] || 0) - was) * k);
    if (was < 0.1 && (goal[name] || 0) >= 0.1) feel.side[name] = Math.random() < 0.5 ? 1 : -1;
    if (v < 0.005) delete feel.now[name];
  }

  // The strongest feeling leads and the others only colour it. Simply adding every lingering feeling
  // saturates the smile shapes after a few messages, and then nothing visibly changes.
  const names = Object.keys(feel.now).filter((n) => EXPRESSIONS[n]);
  const vmax = Math.max(0.001, ...names.map((n) => feel.now[n]));
  const share = {};
  let total = 0;
  for (const n of names) total += share[n] = feel.now[n] * Math.pow(feel.now[n] / vmax, 1.5);
  const norm = total > 1 ? 1 / total : 1;

  const pulse = feel.pulse && (performance.now() - feel.pulse.start) / 1500;
  if (pulse >= 1) feel.pulse = null;
  const strength = opts.expr * 0.85; // soft face — avoid cartoon brows/eyes when feelings stack
  const talking = clamp(c.lips.level * 3);
  let negative = 0;
  for (const name of names) {
    const e = EXPRESSIONS[name];
    if (NEGATIVE.includes(name)) negative += feel.now[name];
    const beat = feel.pulse?.name === name ? 1 + 0.22 * Math.sin(Math.PI * Math.min(1, pulse * 1.6)) : 1;
    const w = share[name] * norm * strength * beat;
    const flip = feel.side[name] === -1;
    for (const [shape, amount] of Object.entries(e.face)) {
      // While she talks, kill expression jaw/wide-mouth so vowels can shape the lips instead.
      const mouthMul = SPEECH_MOUTH.test(shape) ? 1 - 0.96 * talking : SPEECH_SAFE.test(shape) ? 1 : 1 - 0.7 * talking;
      add(c, flip ? mirror(shape) : shape, amount * w * mouthMul);
    }
    fx.pitch += e.pitch * w; fx.yaw += e.yaw * w * (flip ? -1 : 1); fx.roll += e.roll * w * (flip ? -1 : 1);
    fx.gx += e.gx * w * (flip ? -1 : 1); fx.gy += e.gy * w;
    fx.motion += (e.motion - 1) * share[name] * norm; fx.blink += (e.blink - 1) * share[name] * norm;
  }
  // A resting smile that fades when they're upset or another expression takes over.
  const rest = opts.restSmile * 0.25 * clamp(1 - negative) * (1 - 0.7 * Math.min(1, total));
  add(c, 'mouthSmileLeft', rest);
  add(c, 'mouthSmileRight', rest);
  fx.motion = Math.max(0.3, fx.motion);
  fx.blink = Math.max(0.4, fx.blink);
}

// Gestures: short one-off motions, from the model's tags or the Expressions menu.
const bell = (t) => (t < 0.25 ? smoothstep(t / 0.25) : t > 0.7 ? smoothstep((1 - t) / 0.3) : 1);
const GESTURE_DEFS = {
  wink: [650, (c, t, o) => { const b = bell(t); add(c, 'eyeBlinkLeft', b); add(c, 'mouthSmileLeft', 0.35 * b); add(c, 'cheekSquintLeft', 0.3 * b); o.roll += 3 * b; }],
  nod: [900, (c, t, o) => { o.pitch += Math.sin(t * Math.PI * 4) * 7 * (1 - t); }],
  shake: [1100, (c, t, o) => { o.yaw += Math.sin(t * Math.PI * 4) * 9 * (1 - t); }],
  tilt: [1600, (c, t, o) => { o.roll += bell(t) * 9; }],
  laugh: [1400, (c, t, o) => {
    const b = bell(t), bounce = Math.abs(Math.sin(t * Math.PI * 7));
    for (const [s, v] of Object.entries({ ...LR('mouthSmile', 0.6), ...LR('cheekSquint', 0.45), ...LR('eyeSquint', 0.4) })) add(c, s, v * b);
    add(c, 'jawOpen', 0.2 * b * bounce);
    o.pitch += (-3 + bounce * 2.5) * b;
    o.shoulders += 0.3 * b * bounce;
  }],
  sigh: [1800, (c, t, o) => { const b = bell(t); add(c, 'eyeBlinkLeft', 0.35 * b); add(c, 'eyeBlinkRight', 0.35 * b); add(c, 'browInnerUp', 0.25 * b); o.pitch += 4 * b; o.breath += 4 * b; o.shoulders += 0.5 * Math.sin(Math.PI * t); }],
  eyeroll: [1200, (c, t, o) => { const b = bell(t); o.gaze = { x: Math.cos(Math.PI * (1 - t)) * 0.8, y: -0.95 * b }; add(c, 'browOuterUpLeft', 0.25 * b); add(c, 'browOuterUpRight', 0.25 * b); o.pitch -= 3 * b; o.roll += 3 * b; }],
  shrug: [1300, (c, t, o) => { const b = bell(t); o.shoulders += b; add(c, 'mouthShrugLower', 0.4 * b); add(c, 'browInnerUp', 0.3 * b); add(c, 'browOuterUpLeft', 0.3 * b); add(c, 'browOuterUpRight', 0.3 * b); o.roll += 5 * b; }],
  gasp: [800, (c, t, o) => { const b = bell(t); add(c, 'eyeWideLeft', 0.6 * b); add(c, 'eyeWideRight', 0.6 * b); add(c, 'browInnerUp', 0.5 * b); add(c, 'jawOpen', 0.25 * b); o.pitch -= 3 * b; }],
};
function playGesture(c, name, delay = 0) {
  if (c && GESTURE_DEFS[name]) c.gestures.push({ name, start: performance.now() + delay });
}
function updateGestures(c, now) {
  for (let i = c.gestures.length - 1; i >= 0; i--) {
    const g = c.gestures[i];
    const [ms, run] = GESTURE_DEFS[g.name];
    const t = (now - g.start) / ms;
    if (t < 0) continue;
    if (t >= 1) { c.gestures.splice(i, 1); continue; }
    run(c, t, c.fx);
  }
}

// ---------------------------------------------------------------- lip sync (text vowels + audio energy)

// Fish gives audio + the spoken text, not phoneme timestamps. We build a viseme timeline from the
// words (vowels / consonant shapes), stretch it to the clip's real duration (speech speed), and
// scale mouth openness from loudness so quiet parts close.
let audioCtx = null, analyser = null, gainNode = null;
let timeBuf, freqBuf;
// Full Oculus/Avaturn viseme set (Head/Teeth/Tongue morphs on the HD model).
const VISEMES = [
  'viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_kk',
  'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR', 'viseme_aa', 'viseme_E',
  'viseme_I', 'viseme_O', 'viseme_U', 'jawOpen', 'mouthOpen',
];
// Models without viseme shapes (only ARKit) build each mouth shape from jaw and lip controls.
const VISEME_ARKIT = {
  // Shape the lips; keep jaw small — no wide-open talking face.
  viseme_aa: { jawOpen: 0.22, mouthOpen: 0.2, ...LR('mouthLowerDown', 0.45) },
  viseme_O: { jawOpen: 0.12, mouthOpen: 0.1, mouthFunnel: 0.85 },
  viseme_U: { jawOpen: 0.06, mouthOpen: 0.05, mouthPucker: 0.9 },
  viseme_E: { jawOpen: 0.12, mouthOpen: 0.1, ...LR('mouthStretch', 0.55) },
  viseme_I: { jawOpen: 0.08, mouthOpen: 0.06, ...LR('mouthStretch', 0.48), ...LR('mouthSmile', 0.14) },
  viseme_SS: { jawOpen: 0.04, ...LR('mouthStretch', 0.38) },
  viseme_CH: { jawOpen: 0.08, mouthFunnel: 0.48, mouthPucker: 0.32 },
  viseme_PP: { ...LR('mouthPress', 0.65), jawOpen: 0.01 },
  viseme_FF: { ...LR('mouthPress', 0.4), ...LR('mouthUpperUp', 0.28), jawOpen: 0.03 },
  viseme_TH: { jawOpen: 0.06, tongueOut: 0.35, ...LR('mouthStretch', 0.18) },
  viseme_DD: { jawOpen: 0.08, ...LR('mouthLowerDown', 0.22) },
  viseme_kk: { jawOpen: 0.1, mouthOpen: 0.06 },
  viseme_nn: { jawOpen: 0.05, ...LR('mouthLowerDown', 0.14) },
  viseme_RR: { jawOpen: 0.07, mouthPucker: 0.3, mouthFunnel: 0.18 },
  viseme_sil: {},
};
function addViseme(c, name, w) {
  if (name === 'jawOpen' || name === 'mouthOpen') {
    // Tiny residual openness only — vowel morphs do the real work.
    add(c, 'jawOpen', w * 0.35);
    add(c, 'mouthOpen', w * 0.35);
    return;
  }
  if (c.hasVisemes) {
    // Baked Oculus visemes already encode lip shape — only a light jaw assist.
    add(c, name, w);
    if (name === 'viseme_aa') { add(c, 'jawOpen', w * 0.08); }
    else if (name === 'viseme_O') { add(c, 'jawOpen', w * 0.05); }
    else if (name === 'viseme_E') { add(c, 'jawOpen', w * 0.04); }
    return;
  }
  for (const [shape, k] of Object.entries(VISEME_ARKIT[name] ?? {})) add(c, shape, w * k);
}

// Relative mouth-hold units (vowels dominate; consonants are brief accents).
const VISEME_HOLD = {
  viseme_aa: 2.2, viseme_O: 1.9, viseme_U: 1.7, viseme_E: 1.8, viseme_I: 1.6,
  viseme_SS: 0.55, viseme_CH: 0.5, viseme_PP: 0.4, viseme_FF: 0.45, viseme_TH: 0.45,
  viseme_DD: 0.4, viseme_kk: 0.35, viseme_nn: 0.45, viseme_RR: 0.85, viseme_sil: 0.4, rest: 0.9,
};
const VOWEL = /^viseme_(aa|E|I|O|U)$/;
// Floor durations so letter-speed flicker can't happen even on short words.
const MIN_VOWEL_SEC = 0.09;
const MIN_CONS_SEC = 0.05;
const MIN_REST_SEC = 0.07;

function countSyllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  let n = (w.match(/[aeiouy]+/g) || []).length;
  if (w.endsWith('e') && n > 1) n -= 1;
  if (w.endsWith('le') && w.length > 2 && !/[aeiouy]/.test(w.at(-3))) n += 1;
  return Math.max(1, n);
}

/** Map a consonant cluster to one viseme (onset/coda only — not every letter). */
function consonantViseme(cluster) {
  const c = String(cluster || '').toLowerCase();
  if (!c) return null;
  if (/^(ch|sh|zh|tch|dg|j)/.test(c) || c.includes('ch') || c.includes('sh')) return 'viseme_CH';
  if (/^th/.test(c)) return 'viseme_TH';
  if (/^(ph|f|v)/.test(c)) return 'viseme_FF';
  if (/^[bpm]/.test(c)) return 'viseme_PP';
  if (/^[szc]/.test(c)) return 'viseme_SS';
  if (/^[wy]/.test(c)) return c[0] === 'w' ? 'viseme_U' : 'viseme_I';
  if (/^[td]/.test(c)) return 'viseme_DD';
  if (/^(ng|nk|n|l|m)/.test(c)) return 'viseme_nn';
  if (/^r/.test(c)) return 'viseme_RR';
  if (/^[kqgxh]/.test(c)) return 'viseme_kk';
  return 'viseme_DD';
}

function vowelViseme(vowelRun, nextLetter) {
  const v = String(vowelRun || '').toLowerCase();
  if (!v) return 'viseme_aa';
  if (/^(oo|u|ew|ue|ou$)/.test(v) || v === 'u') return 'viseme_U';
  if (/^(ee|ea|ie|ei|ey|i)$/.test(v) || (v === 'e' && !nextLetter)) return 'viseme_I';
  if (/^(ai|ay|e)/.test(v)) return 'viseme_E';
  if (/^(o|oa|oe|au|aw|ow|ou)/.test(v)) return 'viseme_O';
  if (/ar|er|ir|ur|or/.test(v) || (v === 'a' && nextLetter === 'r')) return 'viseme_RR';
  if (v[0] === 'a') return 'viseme_aa';
  if (v[0] === 'e') return 'viseme_E';
  if (v[0] === 'i') return 'viseme_I';
  if (v[0] === 'o') return 'viseme_O';
  return 'viseme_U';
}

/**
 * Syllable-centric tokens: one mouth shape per syllable (onset + vowel + brief coda),
 * not a flicker for every letter. That was why lips looked random and too fast.
 */
function tokenizeWord(word) {
  const s = String(word || '').toLowerCase().replace(/[^a-z']/g, '');
  if (!s) return [{ v: 'viseme_aa', w: 1 }];
  const out = [];
  const push = (v, w = 1) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.v === v) last.w += w;
    else out.push({ v, w });
  };
  // Split into C* V+ C* chunks (syllable-ish).
  const re = /([^aeiouy]*)([aeiouy]+)([^aeiouy]*)/g;
  let m;
  let matched = false;
  while ((m = re.exec(s))) {
    matched = true;
    const [, onset, nucleus, coda] = m;
    const next = s[m.index + m[0].length] || '';
    if (onset) push(consonantViseme(onset), 0.45);
    push(vowelViseme(nucleus, coda[0] || next), 1.6);
    // Only a short closing consonant — don't animate every coda letter.
    if (coda) push(consonantViseme(coda), 0.35);
  }
  if (!matched) {
    // All consonants (rare) — one closed shape.
    push(consonantViseme(s) || 'viseme_PP', 0.8);
  }
  return out.length ? out : [{ v: 'viseme_aa', w: 1 }];
}

// RMS envelope of an AudioBuffer — used to drop text cues only onto voiced time (real speech rate).
function speechEnvelope(buffer, hopMs = 16) {
  if (!buffer?.getChannelData) return null;
  const data = buffer.getChannelData(0);
  const hop = Math.max(1, Math.floor(buffer.sampleRate * hopMs / 1000));
  const env = new Float32Array(Math.ceil(data.length / hop));
  for (let i = 0, e = 0; i < data.length; i += hop, e++) {
    let sum = 0;
    const end = Math.min(data.length, i + hop);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    env[e] = Math.sqrt(sum / (end - i));
  }
  // Adaptive threshold from median-ish energy.
  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.35)] || 0.01;
  const thresh = Math.max(0.012, floor * 1.8);
  const voiced = [];
  let run = null;
  for (let i = 0; i < env.length; i++) {
    const on = env[i] >= thresh;
    const t = (i * hop) / buffer.sampleRate;
    if (on && !run) run = { t0: t, t1: t };
    if (run) {
      run.t1 = t + hopMs / 1000;
      if (!on) { if (run.t1 - run.t0 > 0.04) voiced.push(run); run = null; }
    }
  }
  if (run && run.t1 - run.t0 > 0.04) voiced.push(run);
  // Merge tiny gaps (<80ms) so one word isn't split into fragments.
  const merged = [];
  for (const span of voiced) {
    const prev = merged[merged.length - 1];
    if (prev && span.t0 - prev.t1 < 0.08) prev.t1 = span.t1;
    else merged.push({ ...span });
  }
  return { env, hopMs, thresh, voiced: merged, duration: buffer.duration };
}

function placeOnVoiced(cues, voiced, duration) {
  if (!voiced?.length) return cues;
  const voiceDur = voiced.reduce((s, v) => s + (v.t1 - v.t0), 0);
  if (voiceDur < 0.08) return cues;
  let units = 0;
  for (const c of cues) if (c.v !== 'rest') units += c.t1 - c.t0;
  if (units < 1e-6) return cues;
  // Map each non-rest cue into voiced time only — never bridge a silence gap (mouth closes there).
  const out = [];
  let spanIdx = 0;
  let spanPos = 0;
  for (const cue of cues) {
    if (cue.v === 'rest') continue;
    let left = (cue.t1 - cue.t0) / units * voiceDur;
    while (left > 1e-4 && spanIdx < voiced.length) {
      const span = voiced[spanIdx];
      const avail = (span.t1 - span.t0) - spanPos;
      if (avail <= 1e-4) { spanIdx++; spanPos = 0; continue; }
      const take = Math.min(left, avail);
      const t0 = span.t0 + spanPos;
      const t1 = Math.min(duration, t0 + take);
      out.push({ t0, t1, v: cue.v, peak: cue.peak ?? 1 });
      spanPos += take;
      left -= take;
      if (spanPos >= span.t1 - span.t0 - 1e-4) { spanIdx++; spanPos = 0; }
    }
  }
  return out.length ? out : cues;
}

// Build a timed viseme track: syllable slots stretched to clip duration; audio envelope
// warps those slots onto voiced regions so the mouth follows real speech rate.
function buildLipTrack(text, durationSec, buffer = null) {
  const raw = String(text || '').toLowerCase().replace(/[^a-z'\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = raw ? raw.split(' ') : [];
  const dur = Math.max(0.45, durationSec || estimateSpeechSec(text));
  const env = buffer ? speechEnvelope(buffer) : null;

  const wordMeta = words.map((w) => ({ word: w, syl: countSyllables(w), tokens: tokenizeWord(w) }));
  const sylTotal = wordMeta.reduce((s, w) => s + w.syl, 0) || 1;
  // More closed time between words — reads as speech, not continuous mouth thrash.
  const gapShare = Math.min(0.28, 0.08 + words.length * 0.014);
  const speakShare = 1 - gapShare;
  const cues = [];
  let t = 0;
  wordMeta.forEach((w, wi) => {
    const wordDur = dur * speakShare * (w.syl / sylTotal);
    let units = 0;
    for (const tok of w.tokens) units += (VISEME_HOLD[tok.v] || 1) * tok.w;
    for (const tok of w.tokens) {
      const isVowel = VOWEL.test(tok.v);
      const span = wordDur * ((VISEME_HOLD[tok.v] || 1) * tok.w) / (units || 1);
      const floor = isVowel ? MIN_VOWEL_SEC : MIN_CONS_SEC;
      const held = Math.max(floor, span);
      cues.push({ t0: t, t1: t + held, v: tok.v, peak: isVowel ? 1 : 0.75 });
      t += held;
    }
    if (wi < wordMeta.length - 1) {
      const gap = Math.max(MIN_REST_SEC, dur * gapShare / Math.max(1, words.length - 1));
      cues.push({ t0: t, t1: t + gap, v: 'rest', peak: 0 });
      t += gap;
    }
  });
  // Stretch / compress to match clip length after min-duration floors.
  if (cues.length && t > 1e-4) {
    const k = dur / t;
    for (const c of cues) { c.t0 *= k; c.t1 *= k; }
  }
  // Always lock non-rest cues onto the audio's voiced spans when we have a buffer —
  // that's the closest we get to phoneme alignment without Fish timestamps.
  let placed = cues;
  if (env?.voiced?.length) {
    placed = mergeLipCues(placeOnVoiced(cues, env.voiced, dur));
  }
  return {
    duration: dur,
    cues: placed,
    words: wordMeta.length,
    voiced: env?.voiced?.length || 0,
    env, // live amplitude gate while speaking
  };
}

/** Merge adjacent same-viseme fragments so placeOnVoiced doesn't create letter-speed chatter. */
function mergeLipCues(cues) {
  if (!cues?.length) return cues;
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.v === c.v && c.t0 - prev.t1 < 0.04) {
      prev.t1 = c.t1;
      prev.peak = Math.max(prev.peak || 1, c.peak || 1);
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

/** Sample speech envelope 0..1 at time t (for mouth amplitude lock). */
function sampleEnv(track, t) {
  const env = track?.env;
  if (!env?.env?.length) return 1;
  const i = Math.min(env.env.length - 1, Math.max(0, Math.floor((t * 1000) / env.hopMs)));
  const v = env.env[i] / Math.max(env.thresh * 2.2, 1e-4);
  return clamp(v);
}

function sampleLipTrack(track, elapsed) {
  const target = {};
  if (!track?.cues?.length) return target;
  const t = Math.min(Math.max(0, elapsed), track.duration - 1e-4);
  let best = null;
  let bestW = 0;
  for (let i = 0; i < track.cues.length; i++) {
    const cue = track.cues[i];
    if (cue.v === 'rest') continue;
    const dur = Math.max(0.04, cue.t1 - cue.t0);
    const consonant = !VOWEL.test(cue.v);
    // Vowels: wide plateau. Consonants: brief early peak, then yield to the next vowel.
    const attack = consonant ? 0.18 : 0.28;
    const peakAt = cue.t0 + dur * attack;
    const rise = Math.max(consonant ? 0.02 : 0.04, peakAt - cue.t0);
    const fall = Math.max(consonant ? 0.03 : 0.05, cue.t1 - peakAt);
    let w = 0;
    const pad = consonant ? 0.01 : 0.025;
    if (t >= cue.t0 - pad && t <= cue.t1 + pad) {
      if (t <= peakAt) w = clamp((t - (peakAt - rise)) / rise);
      else w = clamp(1 - (t - peakAt) / fall);
      // Hold vowels near full open through the middle of the cue.
      if (!consonant && t > peakAt && t < cue.t1 - fall * 0.35) w = Math.max(w, 0.85);
    }
    w *= cue.peak ?? 1;
    if (w > 0.001) {
      target[cue.v] = Math.max(target[cue.v] || 0, w);
      if (w > bestW) { bestW = w; best = cue.v; }
    }
  }
  // One dominant shape — suppress rivals harder so lips don't look like noise.
  if (best) {
    for (const k of Object.keys(target)) {
      if (k !== best) target[k] *= VOWEL.test(best) ? 0.18 : 0.28;
    }
  }
  return target;
}

function estimateSpeechSec(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z'\s]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const syl = words.reduce((s, w) => s + countSyllables(w), 0);
  // ~3.6 syllables/sec — closer to Fish TTS pacing than the old 4.5 (which ran the mouth ahead).
  return Math.max(0.85, syl / 3.6 + Math.max(0, words.length - 1) * 0.06);
}

function lipElapsed(track, now) {
  if (!track) return 0;
  // Prefer AudioContext clock when we started a BufferSource (stays locked to playback).
  if (track.audioStart != null && audioCtx) return Math.max(0, audioCtx.currentTime - track.audioStart);
  return Math.max(0, (now - track.start) / 1000);
}

let recordDest = null; // speech audio as a stream, for recording video replies
function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.28;
  gainNode = audioCtx.createGain();
  // ?silent: lips move but nothing plays (theater / Discord already carries the audio).
  gainNode.gain.value = new URLSearchParams(location.search).has('silent') ? 0 : opts.volume;
  analyser.connect(gainNode).connect(audioCtx.destination);
  recordDest = audioCtx.createMediaStreamDestination();
  analyser.connect(recordDest); // before the volume control, so clips don't depend on it
  timeBuf = new Float32Array(analyser.fftSize);
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  return audioCtx;
}

function audioEnergy() {
  if (!analyser) return { vol: 0, hiss: 0, bright: 0.5 };
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0;
  for (const v of timeBuf) sum += v * v;
  const rms = Math.sqrt(sum / timeBuf.length);
  const vol = clamp((rms - 0.01) * 8 * opts.lips);
  analyser.getByteFrequencyData(freqBuf);
  const hz = audioCtx.sampleRate / analyser.fftSize;
  const band = (lo, hi) => {
    let s = 0, n = 0;
    for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz) && i < freqBuf.length; i++) { s += freqBuf[i]; n++; }
    return n ? s / n / 255 : 0;
  };
  const low = band(150, 900), mid = band(900, 2400), high = band(3200, 8000);
  const hiss = clamp((high / (low + mid + high + 1e-6) - 0.26) * 3.8);
  const bright = mid / (low + mid + 1e-6);
  return { vol, hiss, bright };
}

function updateLips(c, dt, now) {
  const lips = c.lips;
  const target = {};
  let vol = 0;
  const track = lips.track;
  const onTrack = track && speaker === c && (track.audioStart != null || now >= track.start);
  const elapsed = lipElapsed(track, now);

  if (analyser && playing && speaker === c) {
    const e = audioEnergy();
    vol = e.vol;
    // Loudness gates amplitude only — never invents shapes (that looked random).
    const voiced = clamp(vol * 1.15) * (1 - e.hiss * 0.25);

    if (onTrack) {
      const shapes = sampleLipTrack(track, elapsed);
      // Envelope from the clip + live analyser: mouth opens with real energy, shape from text.
      const envGate = Math.max(sampleEnv(track, elapsed), voiced * 0.85);
      let shapeSum = 0;
      for (const [name, w] of Object.entries(shapes)) {
        const boost = VOWEL.test(name)
          ? Math.max(0.55, 0.4 + envGate * 0.6)
          : Math.max(0.45, 0.35 + envGate * 0.5);
        target[name] = w * boost * opts.lips;
        shapeSum += target[name];
      }
      target.jawOpen = (shapes.viseme_aa || 0) * 0.08 * envGate + voiced * 0.015;
      target.mouthOpen = ((shapes.viseme_aa || 0) * 0.1 + (shapes.viseme_O || 0) * 0.05) * envGate + voiced * 0.02;
      // Close in real silence (between words / unvoiced gaps).
      if (envGate < 0.12 || shapeSum < 0.04) {
        for (const k of Object.keys(target)) target[k] *= 0.12;
      }
    } else {
      // Track missing: gentle amplitude only, no bright-band vowel roulette.
      target.jawOpen = voiced * 0.08;
      target.mouthOpen = voiced * 0.1;
      target.viseme_aa = voiced * 0.35 * opts.lips;
    }
  } else if (lips.fake && now < lips.fake.until) {
    const fakeTrack = lips.fake.track || track;
    const t = elapsed || (now - lips.fake.start) / 1000;
    const shapes = sampleLipTrack(fakeTrack, t);
    const envGate = sampleEnv(fakeTrack, t);
    const shapePeak = Math.max(0, ...Object.values(shapes), 0);
    vol = clamp((0.35 + 0.55 * shapePeak * Math.max(0.4, envGate)) * opts.lips);
    for (const [name, w] of Object.entries(shapes)) {
      target[name] = w * Math.max(0.55, 0.4 + shapePeak * 0.45) * Math.max(0.35, envGate) * opts.lips;
    }
    target.jawOpen = (shapes.viseme_aa || 0) * 0.08 * envGate;
    target.mouthOpen = ((shapes.viseme_aa || 0) * 0.1 + (shapes.viseme_O || 0) * 0.05) * envGate;
    if (envGate < 0.12) for (const k of Object.keys(target)) target[k] *= 0.1;
  }

  // Occasional brow flash on real loudness jumps (rare — not every syllable).
  if (vol - lips.level > 0.28 && now - lips.flashAt > 900 && Math.random() < 0.35) lips.flashAt = now;
  const flash = lips.flashAt ? Math.max(0, 1 - (now - lips.flashAt) / 420) : 0;
  if (flash > 0) {
    const f = smoothstep(flash) * 0.28 * opts.expr;
    add(c, 'browInnerUp', f);
    add(c, 'browOuterUpLeft', f * 0.75);
    add(c, 'browOuterUpRight', f * 0.75);
  }
  lips.level += (vol - lips.level) * ease(0.35, dt);
  // Slow blend — lips follow syllables, not 60fps letter chatter.
  for (const name of VISEMES) {
    const cur = lips.cur[name] || 0;
    const tgt = target[name] || 0;
    const attack = VOWEL.test(name) ? 0.38 : 0.55;
    const release = 0.28;
    lips.cur[name] = cur + (tgt - cur) * ease(tgt > cur ? attack : release, dt);
    addViseme(c, name, lips.cur[name]);
  }
}

// ---------------------------------------------------------------- speech queue

const speech = []; // { char, text, buffer, feelings, gestures }
let playing = null; // the BufferSource now playing
let speakToken = 0;

function enqueueSpeech(item) {
  speech.push(item);
  if (!playing && !cast.some((c) => c.lips.fake)) playNext();
}

function playNext() {
  const item = speech.shift();
  if (!item) {
    caption(null);
    speaker = null;
    if (state === 'speaking') setState(streaming ? 'thinking' : 'idle');
    if (!streaming) turnFinished();
    return;
  }
  const c = byId.get(item.char);
  // Feelings and gestures land as the sentence starts, not when it arrives.
  if (item.feelings) setFeelings(c, item.feelings, Boolean(item.text));
  item.gestures?.forEach((g, i) => playGesture(c, g, i * 700));
  if (!item.text || !c) return playNext(); // a tag on its own: nothing to say
  speaker = c;
  lastCueText = item.text;
  if (c) c.express = null; // re-pick Rocketbox motion for this sentence's words
  setState('speaking');
  caption(item.text, c);
  brainSpark({ kind: 'speak', system: 'voice', label: item.text.slice(0, 56), intensity: 1, from: 'brain' });
  brainSpark({ kind: 'speak', system: 'lips', label: 'viseme track', intensity: 0.7, from: 'voice' });
  const token = speakToken;
  // silent: Discord already plays the voice — drive lips from text+duration, don't double-play audio.
  if (item.silent && item.buffer) {
    const sec = item.buffer.duration || estimateSpeechSec(item.text);
    const ms = sec * 1000;
    // Warp word/syllable cues onto the clip's voiced regions so speed matches the Discord audio.
    const track = buildLipTrack(item.text, sec, item.buffer);
    const start = performance.now();
    c.lips.track = { ...track, start };
    c.lips.fake = { start, until: start + ms, track };
    setTimeout(() => {
      if (token !== speakToken) return;
      c.lips.fake = null;
      if (c.lips.track) c.lips.track = null;
      playNext();
    }, ms + 80);
  } else if (item.buffer) {
    const src = audioCtx.createBufferSource();
    src.buffer = item.buffer;
    src.connect(analyser);
    const track = buildLipTrack(item.text, item.buffer.duration, item.buffer);
    const start = performance.now();
    const audioStart = audioCtx.currentTime;
    // audioStart locks mouth timing to the Web Audio clock (not rAF/performance drift).
    c.lips.track = { ...track, start, audioStart };
    src.onended = () => {
      if (token !== speakToken) return;
      playing = null;
      if (c.lips.track) c.lips.track = null;
      playNext();
    };
    playing = src;
    src.start();
  } else {
    const sec = estimateSpeechSec(item.text);
    const ms = sec * 1000;
    const track = buildLipTrack(item.text, sec);
    const start = performance.now();
    c.lips.track = { ...track, start };
    c.lips.fake = { start, until: start + ms, track };
    setTimeout(() => {
      if (token !== speakToken) return;
      c.lips.fake = null;
      if (c.lips.track) c.lips.track = null;
      playNext();
    }, ms + 150);
  }
}

function stopSpeaking() {
  speakToken++;
  speech.length = 0;
  for (const c of cast) {
    c.lips.fake = null;
    c.lips.track = null;
  }
  if (playing) { try { playing.stop(); } catch {} playing = null; }
  speaker = null;
  caption(null);
}

function caption(text, c) {
  if (text && opts.subs) {
    $('#captionText').innerHTML = (cast.length > 1 && c ? `<b>${escapeHtml(c.name)}</b> ` : '') + escapeHtml(text);
  }
  $('#caption').classList.toggle('show', Boolean(text && opts.subs));
}

// ---------------------------------------------------------------- chat

let streaming = null; // AbortController for the reply in flight
let state = 'loading';

function setState(next, label) {
  state = next;
  duckMusic(next === 'speaking');
  const labels = { idle: 'Ready', thinking: 'Thinking…', speaking: 'Speaking', listening: 'Listening…', transcribing: 'Transcribing…', error: 'Error', loading: 'Loading' };
  const thinkLabel = next === 'thinking' && thinker ? `${thinker.name} is ${thinker.think?.label || 'thinking…'}` : null;
  const who = thinkLabel || (next === 'speaking' && speaker ? `${speaker.name} is speaking` : null);
  $('#stateText').textContent = label ?? who ?? labels[next] ?? next;
  $('#stateDot').className = 'dot ' + ({ idle: 'good', error: 'bad' }[next] ?? 'busy');
}

const log = $('#log');
function bubble(role, text = '', who = null) {
  $('#empty')?.remove();
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (who) el.dataset.who = who;
  const body = document.createElement('span');
  body.className = 'text';
  body.textContent = text;
  if (role === 'assistant' && who && cast.length > 1) {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = who;
    el.append(name);
  }
  el.append(body);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  ensureAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  interrupt();
  lastCueText = text;
  beginTurnChip();
  // Pathway + memory/plan sparks come from the chat stream (server activity bus).
  brainSpark({ kind: 'word', system: 'hearing', label: `heard: ${text.slice(0, 48)}`, intensity: 0.95 });
  bubble('user', text);
  await requestReply({ text, character: current?.id });
}

// Streams one character's reply: to your message, or (auto) their own turn in banter.
async function requestReply(request) {
  let out = null;
  setState('thinking');
  if (request.text) lastCueText = request.text;
  if (!turn.steps.length) beginTurnChip();

  const ctrl = new AbortController();
  streaming = ctrl;
  let gotText = false;
  let who = null;
  try {
    const res = await fetch('/api/avatar/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, name: opts.name || undefined, speak: opts.voice }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'pathway') {
          brainPathway(msg.systems || [], msg.label);
        } else if (msg.type === 'cortex') {
          // Live plan / memory / tool / error from the activity bus.
          brainSpark({
            kind: msg.kind || 'think',
            system: msg.system,
            label: msg.label,
            intensity: msg.intensity ?? 0.85,
            from: msg.from,
          });
        } else if (msg.type === 'speaker') {
          // The server decided who answers (whoever was named, or who you were talking to).
          who = byId.get(msg.character) ?? current;
          if (!request.auto) setCurrent(who); // banter shouldn't change who you're talking to
          lastTurn = who;
          thinker = who;
          if (who) who.express = null; // re-resolve body language for this thought
          setState('thinking');
          out = bubble('assistant', '', who?.name);
          out.querySelector('.text').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        } else if (msg.type === 'state') {
          setFeelings(who, msg.feelings); // their first reaction while they think
          brainSpark({ kind: 'feel', system: 'feelings', label: 'affect update', intensity: 0.75, from: 'brain' });
          brainSpark({ kind: 'feel', system: 'pressure', label: 'mood buckets', intensity: 0.45, from: 'feelings' });
        } else if (msg.type === 'notice') {
          toast(msg.message);
        } else if (msg.type === 'image') {
          brainSpark({ kind: 'tool', system: 'images', label: 'generate_image', intensity: 1, from: 'plan' });
          // A picture they made with generate_image: shown in their bubble; click to open full size.
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)], { type: msg.mime }));
          link.target = '_blank';
          link.download = msg.name;
          const img = document.createElement('img');
          img.src = link.href;
          img.alt = 'Generated image';
          img.className = 'gen';
          img.onload = () => (log.scrollTop = log.scrollHeight);
          link.append(img);
          out.append(link);
        } else if (msg.type === 'music') {
          musicCommand(msg);
          brainSpark({ kind: 'tool', system: 'music', label: 'music tool', intensity: 1, from: 'plan' });
        } else if (msg.type === 'audio') {
          brainSpark({ kind: 'tool', system: 'music', label: 'generate_music', intensity: 1, from: 'plan' });
          // A song they made with generate_music: a player in their bubble, plus a download link.
          const url = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)], { type: msg.mime }));
          const player = document.createElement('audio');
          player.controls = true;
          player.src = url;
          player.className = 'song';
          const link = document.createElement('a');
          link.href = url;
          link.download = msg.name;
          link.className = 'file';
          link.textContent = `🎵 ${msg.name}`;
          out.append(player, link);
          log.scrollTop = log.scrollHeight;
        } else if (msg.type === 'file') {
          brainSpark({ kind: 'tool', system: 'files', label: msg.name || 'send_file', intensity: 1, from: 'plan' });
          // A file they wrote with send_file: a download link in their bubble.
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([base64ToArrayBuffer(msg.base64)]));
          link.download = msg.name;
          link.className = 'file';
          link.textContent = `📄 ${msg.name}`;
          out.append(link);
          log.scrollTop = log.scrollHeight;
        } else if (msg.type === 'sentence') {
          if (msg.text) {
            const t = out.querySelector('.text');
            if (!gotText) t.textContent = '';
            t.textContent += (gotText ? ' ' : '') + msg.text;
            gotText = true;
            log.scrollTop = log.scrollHeight;
          }
          let buffer = null;
          if (msg.audio) {
            try { buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(msg.audio)); } catch {}
          }
          if (streaming !== ctrl) return;
          enqueueSpeech({ char: who?.id, text: msg.text, buffer: opts.voice ? buffer : null, feelings: msg.feelings, gestures: msg.gestures });
        } else if (msg.type === 'error') {
          brainSpark({ kind: 'default', system: 'faults', label: msg.message, intensity: 1.15 });
          toast(msg.message);
        }
      }
    }
    if (out && !gotText) out.querySelector('.text').textContent = '…';
  } catch (err) {
    if (err.name === 'AbortError') return;
    out?.remove();
    bubble('err', err.message);
    thinker = null;
    if (banter.on) setBanter(false, 'Banter stopped after an error.');
    setState('error', 'Error');
    setTimeout(() => state === 'error' && setState('idle'), 3000);
    return;
  } finally {
    if (streaming === ctrl) {
      streaming = null;
      thinker = null;
    }
  }
  if (!playing && !cast.some((c) => c.lips.fake) && !speech.length) {
    setState('idle');
    turnFinished();
  }
}

function interrupt() {
  clearTimeout(banter.timer);
  if (streaming) { streaming.abort(); streaming = null; }
  thinker = null;
  stopSpeaking();
}

// ---------------------------------------------------------------- banter

// Banter: the cast keep talking among themselves, taking turns, until it's switched off. You can
// jump in at any time (type or hold Space); they answer you, then carry on. It pauses while the
// page is hidden, and it isn't remembered between visits, so a forgotten tab can't run up
// Fish Audio credits.
const banter = { on: false, timer: null };
let lastTurn = null; // the character who spoke last

function setBanter(on, message) {
  banter.on = on && cast.length > 1;
  clearTimeout(banter.timer);
  $('#banterBtn').classList.toggle('on', banter.on);
  $('#banterBtn').setAttribute('aria-pressed', String(banter.on));
  if (message) toast(message);
  if (banter.on && state === 'idle' && !streaming) nextBanterTurn(400);
}

// Called whenever a reply has been fully spoken.
function turnFinished() {
  if (banter.on) nextBanterTurn(900 + Math.random() * 1400); // a natural beat between lines
}

function nextBanterTurn(delay) {
  clearTimeout(banter.timer);
  banter.timer = setTimeout(() => {
    if (!banter.on || document.hidden) return; // hidden: resumes when the page is visible again
    // Someone's still talking, or you're about to: try again shortly instead of talking over it.
    if (streaming || speech.length || playing || state !== 'idle' || mic.recording || mic.busy) return nextBanterTurn(1000);
    const others = cast.filter((c) => c !== lastTurn && c.model);
    const next = others[Math.floor(Math.random() * others.length)] ?? cast[0];
    ensureAudio();
    requestReply({ auto: true, character: next.id });
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && banter.on && state === 'idle' && !streaming) nextBanterTurn(800);
});

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadHistory() {
  try {
    const rows = await fetch('/api/conversations/avatar').then((r) => r.json());
    const mainName = byId.get('main')?.name;
    for (const m of rows.slice(-40)) {
      if (m.role === 'assistant') {
        bubble('assistant', m.content, m.name ?? mainName);
        lastTurn = cast.find((c) => c.name === (m.name ?? mainName)) ?? lastTurn;
      } else bubble('user', m.content);
    }
  } catch {}
}

// ---------------------------------------------------------------- who you're talking to

function setCurrent(c) {
  if (!c || c === current) return;
  current = c;
  opts.talkingTo = c.id;
  syncLookUi(c);
  save();
  document.querySelectorAll('#castPicker button').forEach((b) => b.classList.toggle('on', b.dataset.id === c.id));
  $('#input').placeholder = cast.length > 1 ? `Message ${c.name}… (or name someone)` : 'Message…';
  renderFeelings();
  if (opts.frame === 'face') frame('face');
}

function renderCastPicker() {
  const picker = $('#castPicker');
  picker.hidden = cast.length < 2;
  $('#banterBtn').hidden = cast.length < 2;
  picker.innerHTML = cast.map((c) => `<button data-id="${c.id}" class="${c === current ? 'on' : ''}">${escapeHtml(c.name)}</button>`).join('');
}
$('#banterBtn').addEventListener('click', () => {
  ensureAudio(); // a click, so audio can start
  if (audioCtx.state === 'suspended') audioCtx.resume();
  setBanter(!banter.on, banter.on ? 'Banter off. They’ll finish their thought.' : 'Banter on. Jump in any time, or press Esc to stop.');
});
$('#castPicker').addEventListener('click', (e) => {
  const c = byId.get(e.target.closest('button')?.dataset.id);
  if (c) setCurrent(c);
});

// Clicking a character (without dragging the camera) talks to them.
const raycaster = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // Skinned meshes raycast against their bind pose, so use each character's rough box instead.
  let best = null;
  for (const c of cast) {
    if (!c.model) continue;
    const box = new THREE.Box3().setFromObject(c.model);
    const hit = raycaster.ray.intersectBox(box, new THREE.Vector3());
    if (hit) {
      const d = hit.distanceTo(raycaster.ray.origin);
      if (!best || d < best.d) best = { c, d };
    }
  }
  if (best) setCurrent(best.c);
});

// ---------------------------------------------------------------- microphone (PC mic via the Node server)

// Browser getUserMedia is often blocked; we capture on the PC with ffmpeg and run Whisper locally.
const mic = {
  mode: 'pc', // 'pc' | 'browser'
  stream: null, ctx: null, node: null, sink: null, rate: 48000,
  recording: false, chunks: [], preroll: [],
  voiced: 0, silent: 0, level: 0, busy: false, levelPoll: null, device: null,
  listen: false, // hands-free PC VAD session
};

async function startPcMic() {
  const res = await fetch('/api/avatar/mic/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  mic.mode = 'pc';
  mic.device = data.device || 'PC mic';
  mic.rate = data.rate || 48000;
  startMicLevelPoll();
  return true;
}

async function startPcListen() {
  const res = await fetch('/api/avatar/mic/listen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  mic.mode = 'pc';
  mic.listen = true;
  mic.device = data.device || 'PC mic';
  mic.rate = data.rate || 48000;
  startMicLevelPoll();
  return true;
}

function startMicLevelPoll() {
  stopMicLevelPoll();
  mic.levelPoll = setInterval(async () => {
    if (mic.mode !== 'pc') return;
    if (!mic.recording && !mic.listen) return;
    try {
      const s = await fetch('/api/avatar/mic/status').then((r) => r.json());
      mic.level = s.level || 0;
      $('#micBtn')?.style.setProperty('--lvl', String(1 + clamp(mic.level * 8, 0, 0.35)));
      if (mic.listen) {
        if (s.speaking && state === 'idle') setState('listening');
        if (s.utteranceReady && !mic.busy) await takePcUtterance();
      }
    } catch { /* ignore */ }
  }, 140);
}

function stopMicLevelPoll() {
  if (mic.levelPoll) { clearInterval(mic.levelPoll); mic.levelPoll = null; }
}

async function takePcUtterance() {
  if (mic.busy || state === 'speaking' || state === 'thinking' || streaming) return;
  mic.busy = true;
  setState('transcribing');
  updateMicButton();
  brainSpark({ kind: 'word', system: 'hearing', label: 'Whisper STT', intensity: 0.85 });
  try {
    const res = await fetch('/api/avatar/mic/utterance', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.text) send(data.text);
    else setState('idle');
  } catch (err) {
    setState('idle');
    toast('Transcription failed: ' + err.message);
  } finally {
    mic.busy = false;
    updateMicButton();
  }
}

async function startBrowserMic() {
  ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (mic.stream) {
    if (mic.ctx?.state === 'suspended') await mic.ctx.resume();
    return true;
  }
  mic.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  try { mic.ctx = new AudioContext({ sampleRate: 48000 }); } catch { mic.ctx = new AudioContext(); }
  if (mic.ctx.state === 'suspended') await mic.ctx.resume();
  mic.rate = mic.ctx.sampleRate;
  mic.mode = 'browser';
  const src = mic.ctx.createMediaStreamSource(mic.stream);
  mic.node = mic.ctx.createScriptProcessor(4096, 1, 1);
  mic.node.onaudioprocess = (e) => onMicAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(mic.node);
  mic.sink = mic.ctx.createMediaStreamDestination();
  mic.node.connect(mic.sink);
  return true;
}

async function startMic() {
  ensureAudio();
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  // Prefer the PC mic so a blocked browser permission doesn't matter.
  try {
    return await startPcMic();
  } catch (pcErr) {
    console.warn('PC mic failed, trying browser:', pcErr);
    try {
      await startBrowserMic();
      toast('Using browser mic (PC mic unavailable)');
      return true;
    } catch (err) {
      toast('Microphone failed: ' + (pcErr.message || err.message));
      return false;
    }
  }
}

function stopMicStream() {
  stopMicLevelPoll();
  if (mic.mode === 'pc' && (mic.recording || mic.listen)) {
    fetch('/api/avatar/mic/stop', { method: 'POST' }).catch(() => {});
  }
  mic.node?.disconnect();
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  Object.assign(mic, {
    stream: null, ctx: null, node: null, sink: null, recording: false, chunks: [], device: null, listen: false,
  });
  updateMicButton();
}

function onMicAudio(data) {
  let sum = 0;
  for (const v of data) sum += v * v;
  const rms = Math.sqrt(sum / data.length);
  mic.level = rms;
  $('#micBtn').style.setProperty('--lvl', String(1 + clamp(rms * 8, 0, 0.35)));

  if (mic.recording && mic.mode === 'browser') mic.chunks.push(data);
  if (!opts.handsFree || mic.busy || pushToTalk) return;
  if (state === 'speaking' || state === 'thinking') { mic.voiced = 0; return; }

  const blockMs = (data.length / mic.rate) * 1000;
  if (!mic.recording) {
    mic.preroll.push(data);
    if (mic.preroll.length > 8) mic.preroll.shift();
    mic.voiced = rms > 0.02 ? mic.voiced + blockMs : 0;
    if (mic.voiced > 120) {
      mic.recording = true;
      mic.chunks = [...mic.preroll];
      mic.silent = 0;
      setState('listening');
      updateMicButton();
    }
  } else {
    mic.silent = rms < 0.012 ? mic.silent + blockMs : 0;
    if (mic.silent > 900) finishRecording();
  }
}

let pushToTalk = false;
async function beginTalk() {
  if (mic.busy) return;
  if (mic.listen) {
    toast('Hands-free is on — just speak and pause');
    return;
  }
  interrupt();
  pushToTalk = true;
  mic.recording = true;
  mic.chunks = [];
  setState('listening');
  updateMicButton();
  if (!(await startMic())) {
    mic.recording = false;
    pushToTalk = false;
    setState('idle');
    updateMicButton();
  }
}

async function finishRecording() {
  if (!mic.recording) return;
  mic.recording = false;
  pushToTalk = false;
  updateMicButton();

  mic.busy = true;
  setState('transcribing');
  updateMicButton();
  brainSpark({ kind: 'word', system: 'hearing', label: 'Whisper STT', intensity: 0.85 });
  try {
    let text = '';
    if (mic.mode === 'pc') {
      stopMicLevelPoll();
      const res = await fetch('/api/avatar/mic/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      text = data.text || '';
      if (data.device) mic.device = data.device;
    } else {
      const chunks = mic.chunks;
      mic.chunks = [];
      mic.preroll = [];
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total / mic.rate < 0.35) { setState('idle'); return; }
      const flat = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { flat.set(c, o); o += c.length; }
      const ratio = mic.rate / 48000;
      const n = Math.floor(total / ratio);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = clamp(flat[Math.floor(i * ratio)], -1, 1) * 0x7fff;
      const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      const res = await fetch('/api/avatar/listen', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      text = data.text || '';
    }
    if (text) send(text);
    else { setState('idle'); toast("Didn't catch that — hold the mic a bit longer."); }
  } catch (err) {
    setState('idle');
    toast('Transcription failed: ' + err.message);
  } finally {
    mic.busy = false;
    updateMicButton();
  }
}

function updateMicButton() {
  const b = $('#micBtn');
  if (!b) return;
  b.classList.toggle('rec', mic.recording || (mic.listen && state === 'listening'));
  b.classList.toggle('working', mic.busy);
  b.classList.toggle('armed', opts.handsFree && (mic.listen || Boolean(mic.stream)) && !mic.recording && !mic.busy);
  b.title = mic.listen
    ? `Hands-free PC mic${mic.device ? ` (${mic.device})` : ''} — speak, pause to send`
    : mic.mode === 'pc'
      ? `PC mic${mic.device ? ` (${mic.device})` : ''} — hold to talk (Space)`
      : 'Hold to talk (or hold Space). Click to start and stop.';
}

// Hold to talk; a quick click starts, click again to stop. Audio is transcribed on this PC (Whisper).
let pressAt = 0;
$('#micBtn').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  if (mic.busy) return;
  // Second press while armed: stop and send to the bot's local STT.
  if (mic.recording && pushToTalk) {
    await finishRecording();
    return;
  }
  pressAt = performance.now();
  await beginTalk();
});
$('#micBtn').addEventListener('pointerup', () => {
  if (!mic.recording || !pushToTalk) return;
  const held = performance.now() - pressAt;
  // Hold ≥280ms: release-to-send. Short click: stay recording until the next press.
  if (held >= 280) finishRecording();
});
$('#micBtn').addEventListener('pointercancel', () => {
  if (mic.recording && pushToTalk) finishRecording();
});
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.target.closest('textarea, input, select')) return;
  e.preventDefault();
  if (mic.recording && pushToTalk) return;
  pressAt = performance.now();
  beginTalk();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pushToTalk && !e.target.closest('textarea, input, select')) finishRecording();
  if (e.code === 'Escape') { setBanter(false); interrupt(); setState('idle'); }
});

// ---------------------------------------------------------------- UI wiring

const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  $('#sendBtn').disabled = !input.value.trim();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
$('#sendBtn').addEventListener('click', submit);
function submit() {
  const text = input.value;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  send(text);
}

$('#framing').addEventListener('click', (e) => e.target.dataset.frame && frame(e.target.dataset.frame));
// Live readout of the strongest feelings of whoever you're talking to, in the dock.
let lastReadout = '';
function renderFeelings() {
  if (!current) return;
  const top = Object.entries(current.feel.target).filter(([, v]) => v >= 0.08).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const who = cast.length > 1 ? `<span class="feel who">${escapeHtml(current.name)}</span>` : '';
  const actLabel = current.express?.label || current.think?.label;
  const act = actLabel
    ? `<span class="feel act" title="Body language right now">${escapeHtml(actLabel)}</span>`
    : '';
  const html = who + act + (top.length
    ? top.map(([n, v]) => `<span class="feel" title="${n} ${v.toFixed(2)}">${n}<i style="--v:${v.toFixed(2)}"></i></span>`).join('')
    : (act ? '' : '<span class="feel calm">calm</span>'));
  if (html !== lastReadout) $('#feelings').innerHTML = lastReadout = html;
}
setInterval(renderFeelings, 1000); // feelings fade between replies

// Expressions menu: nudge how they feel (the conversation sees it too) or play a gesture.
async function nudgeFeeling(c, body) {
  try {
    const res = await fetch('/api/avatar/emotion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, character: c.id }) });
    setFeelings(c, (await res.json()).feelings);
  } catch (err) {
    toast(err.message);
  }
}
function ensureBrain() {
  if (brainViz) return brainViz;
  brainViz = createBrainViz($('#brainPanel'));
  return brainViz;
}
$('#brainBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openCustomPanel(false);
  const viz = ensureBrain();
  const on = viz.toggle();
  $('#brainBtn').classList.toggle('on', on);
  if (on) {
    // Replay what happened while the panel was closed, then mark presence.
    const recent = brainBuf.filter((ev) => Date.now() - (ev._t || 0) < 90000).slice(-14);
    try { viz.flush(recent); } catch { /* ignore */ }
    brainSpark({ kind: 'think', system: 'presence', label: 'watching cortex', intensity: 0.55, silent: true });
  }
});
$('#brainClose')?.addEventListener('click', () => {
  brainViz?.stop();
  $('#brainBtn')?.classList.remove('on');
});

$('#exprBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openCustomPanel(false);
  $('#exprPanel').hidden = !$('#exprPanel').hidden;
  $('#exprBtn').classList.toggle('on', !$('#exprPanel').hidden);
  $('#exprWho').textContent = current?.name ?? 'them';
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#exprPanel')) { $('#exprPanel').hidden = true; $('#exprBtn').classList.remove('on'); }
});
$('#exprPanel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !current) return;
  if (b.dataset.feel) nudgeFeeling(current, { feelings: { [b.dataset.feel]: 0.85 } });
  if (b.dataset.gesture) playGesture(current, b.dataset.gesture);
  if (b.id === 'calmBtn') nudgeFeeling(current, { reset: true });
});
$('#exprFeelings').innerHTML = Object.keys(EXPRESSIONS).map((n) => `<button data-feel="${n}">${n}</button>`).join('');
$('#exprGestures').innerHTML = Object.keys(GESTURE_DEFS).map((n) => `<button data-gesture="${n}">${n}</button>`).join('');

function setCollapsed(c) {
  opts.collapsed = c;
  save();
  document.body.classList.toggle('collapsed', c);
  $('#reopen').hidden = !c;
  setTimeout(resize, 260);
  resize();
}
$('#collapseBtn').addEventListener('click', () => setCollapsed(true));
$('#reopen').addEventListener('click', () => setCollapsed(false));
$('#settingsBtn').addEventListener('click', () => {
  const s = $('#settings');
  s.hidden = !s.hidden;
  $('#panelTitle').textContent = s.hidden ? 'Conversation' : 'Settings';
});
$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('Clear this conversation? Long-term memories are kept.')) return;
  await fetch('/api/conversations/avatar', { method: 'DELETE' });
  log.innerHTML = '';
  toast('Conversation cleared');
});

// Settings controls, bound to opts.
const bind = (id, key, apply) => {
  const el = $(id);
  const isBox = el.type === 'checkbox';
  if (isBox) el.checked = opts[key]; else el.value = opts[key];
  el.addEventListener(isBox || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    opts[key] = isBox ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    save();
    apply?.(opts[key]);
  });
  apply?.(opts[key], true);
};
bind('#optName', 'name');
bind('#optVoice', 'voice', (on) => !on && playing && stopSpeaking());
bind('#optVolume', 'volume', (v) => gainNode && (gainNode.gain.value = v));
bind('#optHandsFree', 'handsFree', async (on, init) => {
  if (init) return; // needs a click before capture can start
  // Prefer PC mic + server VAD (works even when the browser mic is blocked).
  if (on) {
    try {
      ensureAudio();
      if (audioCtx?.state === 'suspended') await audioCtx.resume();
      await startPcListen();
      toast(`Hands-free on · ${mic.device || 'PC mic'}`);
      brainSpark({ kind: 'word', system: 'hearing', label: 'hands-free listen', intensity: 0.6 });
    } catch (pcErr) {
      try {
        await startBrowserMic();
        toast('Hands-free on · browser mic');
      } catch (err) {
        opts.handsFree = false;
        $('#optHandsFree').checked = false;
        save();
        toast('Hands-free failed: ' + (pcErr.message || err.message));
      }
    }
  } else if (!pushToTalk) {
    stopMicStream();
  }
  updateMicButton();
});
bind('#optSubs', 'subs', (on) => !on && caption(null));
bind('#optBlink', 'blink');
bind('#optGaze', 'gaze');
bind('#optHead', 'head');
bind('#optIntensity', 'intensity');
bind('#optLips', 'lips');
bind('#optExpr', 'expr');
bind('#optRest', 'restSmile');
bind('#optBackdrop', 'backdrop', (v) => { document.body.dataset.backdrop = v; setBackdrop(v); });
bind('#optQuality', 'quality', (v, init) => { if (!init) { fps.steppedDown = true; applyQuality(); } });

// Each character's name, persona and Fish voice. The main one is also the Discord bot.
function renderCharacterEditors() {
  $('#castEditors').innerHTML = cast.map((c) => `
    <div class="char-edit" data-id="${c.id}">
      <div class="set"><label>Name${c.main ? '<span class="hint">Also the Discord bot’s name, persona and voice</span>' : ''}</label><input type="text" data-field="name" value="${escapeHtml(c.name)}"></div>
      <div class="set"><label>Fish voice ID<span class="hint">From a voice’s page on fish.audio${c.main ? '' : '. Without one they stay silent'}</span></label><input type="text" data-field="voiceId" value="${escapeHtml(c.voiceId || '')}" placeholder="voice ID"></div>
      <label class="persona-label">Persona</label>
      <textarea data-field="persona" rows="4" placeholder="Who ${escapeHtml(c.name)} is: personality, how they talk, what they like…">${escapeHtml(c.persona || '')}</textarea>
      <button class="save-char">Save ${escapeHtml(c.name)}</button>
    </div>`).join('');
}
$('#castEditors').addEventListener('click', async (e) => {
  if (!e.target.matches('.save-char')) return;
  const box = e.target.closest('.char-edit');
  const c = byId.get(box.dataset.id);
  const patch = Object.fromEntries([...box.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value]));
  try {
    const res = await fetch(`/api/avatar/characters/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.error || res.statusText);
    Object.assign(c, { name: updated.name, persona: updated.persona, voiceId: updated.voiceId });
    renderCastPicker();
    renderCharacterEditors();
    renderFeelings();
    toast(`Saved ${c.name}`);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
});

// Customize panel: strand hair, colors, face, clothes — live preview + save to character.
const LOOK_DEFAULTS = {
  skin: '#d9a587', eyes: '#3f7fb8', hair: '#c9a66b', clothes: '#4a5568',
  strands: false, hairStyle: 'long', hairLength: 1.15, hairDensity: 1.1,
  blush: 0.15, lips: 0.2, smile: 0.35, brows: 0.1, eyesOpen: 0.15,
};
const LOOK_PRESETS = [
  { id: 'natural', label: 'Natural', look: { skin: '#d9a587', eyes: '#3f7fb8', hair: '#2a1a10', clothes: '#4a5568', hairStyle: 'medium', hairLength: 1, blush: 0.12, lips: 0.15, smile: 0.3 } },
  { id: 'blonde', label: 'Blonde', look: { skin: '#e8b89a', eyes: '#5b8fc7', hair: '#c9a66b', clothes: '#6b5b95', hairStyle: 'long', hairLength: 1.15, blush: 0.2, lips: 0.28, smile: 0.4 } },
  { id: 'raven', label: 'Raven', look: { skin: '#c99578', eyes: '#2f5d8a', hair: '#0d0a0a', clothes: '#1f2937', hairStyle: 'wavy', hairLength: 1.2, blush: 0.18, lips: 0.35, smile: 0.22 } },
  { id: 'copper', label: 'Copper', look: { skin: '#d4a07a', eyes: '#3d7a5a', hair: '#8b3a1a', clothes: '#3f4a5a', hairStyle: 'bob', hairLength: 0.95, blush: 0.25, lips: 0.3, smile: 0.38 } },
  { id: 'silver', label: 'Silver', look: { skin: '#d8b09a', eyes: '#6a8aaa', hair: '#b8c0c8', clothes: '#374151', hairStyle: 'short', hairLength: 0.85, blush: 0.1, lips: 0.18, smile: 0.25 } },
  // Outfit / wardrobe colour looks (same body; clothes tint like the student wardrobe palettes).
  { id: 'navy-suit', label: 'Navy', look: { clothes: '#1e3a5f', hairStyle: 'medium' } },
  { id: 'wine', label: 'Wine', look: { clothes: '#6b1e3a', hairStyle: 'long' } },
  { id: 'forest', label: 'Forest', look: { clothes: '#1f4d3a', hairStyle: 'bob' } },
  { id: 'cream', label: 'Cream', look: { clothes: '#c4b59a', hairStyle: 'medium' } },
  { id: 'charcoal', label: 'Charcoal', look: { clothes: '#2a2e35', hairStyle: 'short' } },
];

function readLookFromUi() {
  const num = (id, d) => {
    const el = $(id);
    const v = el ? Number(el.value) : d;
    return Number.isFinite(v) ? v : d;
  };
  return {
    skin: $('#lookSkin')?.value || LOOK_DEFAULTS.skin,
    eyes: $('#lookEyes')?.value || LOOK_DEFAULTS.eyes,
    hair: $('#lookHair')?.value || LOOK_DEFAULTS.hair,
    clothes: $('#lookClothes')?.value || LOOK_DEFAULTS.clothes,
    strands: $('#lookStrands')?.checked === true,
    hairStyle: $('#lookHairStyle')?.value || 'medium',
    hairLength: num('#lookHairLength', 1),
    hairDensity: num('#lookHairDensity', 1),
    blush: num('#lookBlush', 0.15),
    lips: num('#lookLips', 0.2),
    smile: num('#lookSmile', 0.35),
    brows: num('#lookBrows', 0.1),
    eyesOpen: num('#lookEyesOpen', 0.15),
  };
}

function setRangeLabel(id, val) {
  const el = $(id);
  if (el) el.textContent = Number(val).toFixed(2);
}

function syncLookUi(c = current) {
  const look = { ...LOOK_DEFAULTS, ...(c?.look || {}) };
  if ($('#lookSkin')) $('#lookSkin').value = look.skin;
  if ($('#lookEyes')) $('#lookEyes').value = look.eyes;
  if ($('#lookHair')) $('#lookHair').value = look.hair;
  if ($('#lookClothes')) $('#lookClothes').value = look.clothes;
  if ($('#lookStrands')) $('#lookStrands').checked = look.strands === true;
  if ($('#lookHairStyle')) $('#lookHairStyle').value = look.hairStyle || 'medium';
  if ($('#lookHairLength')) $('#lookHairLength').value = look.hairLength ?? 1;
  if ($('#lookHairDensity')) $('#lookHairDensity').value = look.hairDensity ?? 1;
  if ($('#lookBlush')) $('#lookBlush').value = look.blush ?? 0.15;
  if ($('#lookLips')) $('#lookLips').value = look.lips ?? 0.2;
  if ($('#lookSmile')) $('#lookSmile').value = look.smile ?? 0.35;
  if ($('#lookBrows')) $('#lookBrows').value = look.brows ?? 0.1;
  if ($('#lookEyesOpen')) $('#lookEyesOpen').value = look.eyesOpen ?? 0.15;
  setRangeLabel('#lookHairLengthVal', look.hairLength ?? 1);
  setRangeLabel('#lookHairDensityVal', look.hairDensity ?? 1);
  setRangeLabel('#lookBlushVal', look.blush ?? 0.15);
  setRangeLabel('#lookLipsVal', look.lips ?? 0.2);
  setRangeLabel('#lookSmileVal', look.smile ?? 0.35);
  setRangeLabel('#lookBrowsVal', look.brows ?? 0.1);
  setRangeLabel('#lookEyesOpenVal', look.eyesOpen ?? 0.15);
  if ($('#customWho')) $('#customWho').textContent = c?.name || 'character';
}

let hairRebuildTimer = 0;
function applyCurrentLookLive(rebuildHair = false) {
  if (!current?.model) return;
  current.look = readLookFromUi();
  if (!rebuildHair && current.model.userData.hair) {
    // Force rebuild key miss only when style/length/density/strands change.
    const key = `${current.look.hairStyle}|${Number(current.look.hairLength).toFixed(2)}|${Number(current.look.hairDensity).toFixed(2)}|${hairOptsFromLook(current.look).wave}`;
    if (current.model.userData.hairKey !== key || current.look.strands === false) rebuildHair = true;
  }
  if (rebuildHair) current.model.userData.hairKey = null;
  applyAppearance(current.model, current.look, current);
  if (current.model.userData.cardStrands) {
    current.model.userData.hair?.setTint?.(current.look.hair || null);
  } else if (opts.quality === 'high' && current.look.strands !== true) {
    growCardStrands(current);
  }
  setRangeLabel('#lookHairLengthVal', current.look.hairLength);
  setRangeLabel('#lookHairDensityVal', current.look.hairDensity);
  setRangeLabel('#lookBlushVal', current.look.blush);
  setRangeLabel('#lookLipsVal', current.look.lips);
  setRangeLabel('#lookSmileVal', current.look.smile);
  setRangeLabel('#lookBrowsVal', current.look.brows);
  setRangeLabel('#lookEyesOpenVal', current.look.eyesOpen);
}

function scheduleHairRebuild() {
  clearTimeout(hairRebuildTimer);
  hairRebuildTimer = setTimeout(() => applyCurrentLookLive(true), 280);
}

function openCustomPanel(on = true) {
  const panel = $('#customPanel');
  if (!panel) return;
  panel.hidden = !on;
  $('#customBtn')?.classList.toggle('on', on);
  if (on) {
    $('#brainPanel') && ($('#brainPanel').hidden = true);
    $('#exprPanel') && ($('#exprPanel').hidden = true);
    syncLookUi(current);
    frame('bust');
  }
}

async function uploadModelFile(file) {
  if (!current || !file) return;
  toast(`Saving ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/avatar/characters/${current.id}/model?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
      body: buf,
    });
    const updated = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(updated.error || res.statusText);
    if (updated.look) current.look = { ...LOOK_DEFAULTS, ...updated.look, strands: updated.look.strands !== false };
    await loadModel(current, `/api/avatar/model/${current.id}?t=${Date.now()}`);
    await refreshLibrary();
    syncLookUi(current);
    toast(`Saved model for ${current.name}`);
  } catch (err) {
    toast(`Couldn't save model: ${err.message}`);
  }
}

async function refreshLibrary() {
  const sels = [$('#optLibrary'), $('#customLibrary')].filter(Boolean);
  if (!sels.length) return;
  try {
    const { files } = await fetch('/api/avatar/library').then((r) => r.json());
    const html = `<option value="">— choose saved —</option>` +
      (files || []).map((f) => `<option value="${escapeHtml(f.file)}">${escapeHtml(f.file)} (${(f.bytes / 1048576).toFixed(1)} MB)</option>`).join('');
    for (const sel of sels) {
      const prev = sel.value;
      sel.innerHTML = html;
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    }
  } catch {
    /* ignore */
  }
}

async function saveCurrentLook() {
  if (!current) return;
  const look = readLookFromUi();
  try {
    const res = await fetch(`/api/avatar/characters/${current.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ look }),
    });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.error || res.statusText);
    current.look = updated.look || look;
    applyAppearance(current.model, current.look, current);
    toast(`Saved look for ${current.name}`);
  } catch (err) {
    toast(`Couldn't save look: ${err.message}`);
  }
}

async function useLibraryFile(file) {
  if (!file || !current) return;
  try {
    const res = await fetch(`/api/avatar/characters/${current.id}/model/use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const updated = await res.json();
    if (!res.ok) throw new Error(updated.error || res.statusText);
    await loadModel(current, `/api/avatar/model/${current.id}?t=${Date.now()}`);
    syncLookUi(current);
    toast(`Loaded ${file} for ${current.name}`);
  } catch (err) {
    toast(`Couldn't load library model: ${err.message}`);
  }
}

const presetHost = $('#customPresets');
if (presetHost) {
  presetHost.innerHTML = LOOK_PRESETS.map((p) => `<button type="button" data-preset="${p.id}">${p.label}</button>`).join('');
  presetHost.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn || !current) return;
    const preset = LOOK_PRESETS.find((p) => p.id === btn.dataset.preset);
    if (!preset) return;
    current.look = { ...LOOK_DEFAULTS, ...current.look, ...preset.look, strands: false };
    syncLookUi(current);
    applyCurrentLookLive(true);
    presetHost.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  });
}

$('#customBtn')?.addEventListener('click', () => openCustomPanel($('#customPanel')?.hidden !== false));
$('#customClose')?.addEventListener('click', () => openCustomPanel(false));
$('#pickGlb')?.addEventListener('click', () => $('#glbFile').click());
$('#customPickGlb')?.addEventListener('click', () => $('#glbFile').click());
$('#glbFile')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) uploadModelFile(file);
});
$('#customSave')?.addEventListener('click', saveCurrentLook);
$('#customReset')?.addEventListener('click', () => {
  if (!current) return;
  current.look = { ...LOOK_DEFAULTS };
  syncLookUi(current);
  applyCurrentLookLive(true);
});
for (const id of ['#lookSkin', '#lookEyes', '#lookHair', '#lookClothes', '#lookBlush', '#lookLips', '#lookSmile', '#lookBrows', '#lookEyesOpen']) {
  $(id)?.addEventListener('input', () => applyCurrentLookLive(false));
}
$('#lookStrands')?.addEventListener('change', () => applyCurrentLookLive(true));
$('#lookHairStyle')?.addEventListener('change', () => applyCurrentLookLive(true));
$('#lookHairLength')?.addEventListener('input', scheduleHairRebuild);
$('#lookHairDensity')?.addEventListener('input', scheduleHairRebuild);
$('#optLibrary')?.addEventListener('change', (e) => useLibraryFile(e.target.value));
$('#customLibrary')?.addEventListener('change', (e) => useLibraryFile(e.target.value));

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const file = [...e.dataTransfer.files].find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (file) uploadModelFile(file);
  else toast('Drop a .glb file');
});

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function loadStatus() {
  try {
    const s = await fetch('/api/avatar/status').then((r) => r.json());
    $('#modelName').textContent = s.model;
    $('#voiceName').textContent = s.fishReady ? 'Fish Audio' : 'not set up';
    $('#fishDot').className = 'dot ' + (s.fishReady ? 'good' : 'bad');
    if (!s.fishReady) toast('FISH_API_KEY is missing in .env, so replies will be silent.');
  } catch {
    toast("Can't reach the bot. Is it running?");
  }
}

// ---------------------------------------------------------------- loop

// If High can't hold ~25fps for a few seconds, step down a level once rather than stutter.
const fps = { time: 0, frames: 0, steppedDown: false };
function watchFrameRate(dt) {
  if (fps.steppedDown || opts.quality === 'low' || document.hidden || loading.size || !cast.some((c) => c.model) || dt >= 0.1) return;
  fps.time += dt;
  fps.frames++;
  if (fps.time < 4) return;
  const rate = fps.frames / fps.time;
  fps.time = fps.frames = 0;
  if (rate < 25) {
    fps.steppedDown = true;
    opts.quality = opts.quality === 'high' ? 'medium' : 'low';
    $('#optQuality').value = opts.quality;
    save();
    applyQuality();
    toast(`Graphics lowered to ${opts.quality} to keep things smooth (${Math.round(rate)} fps).`);
  }
}

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt / 0.7);
    const k = smoothstep(camTween.t);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, k);
    camera.position.lerpVectors(camTween.fromP, camTween.toP, k);
    if (camTween.t >= 1) camTween = null;
  }
  controls.update();
  for (const c of cast) {
    if (!c.model) continue;
    updateFeelings(c, dt);
    updateGestures(c, now);
    updateMicroExpressions(c, now);
    applyFaceLook(c);
    updateBlink(c, dt * 1000 * c.fx.blink);
    updateGaze(c, dt, now);
    updateLips(c, dt, now);
    updateHead(c, dt);
    applyWeights(c);
    c.model.userData.hair?.update(dt);
  }
  if (RECORDER || PIP) frameFace();
  if (composer && opts.quality !== 'low') {
    grain.uniforms.time.value = (now / 1000) % 100;
    composer.render(dt);
  } else {
    renderer.render(scene, camera);
  }
  if (clipRec) copyClipFrame(); // straight after rendering, while the frame is still in the buffer
  watchFrameRate(dt);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- video replies (recorder mode)
// /avatar.html?recorder=1, left open, records Discord replies as clips of her face saying them
// (Amy's spec). The server sends each reply's lines with their voice; this page plays them through
// the normal speech path (so the mouth follows the audio), records a fixed 720x720 crop of her face
// plus the speech audio as WebM, and uploads it. One clip at a time, in order.

const RECORDER = new URLSearchParams(location.search).has('recorder');
const CLIP_SIZE = 720;
const clipCanvas = Object.assign(document.createElement('canvas'), { width: CLIP_SIZE, height: CLIP_SIZE });
const clipCtx = clipCanvas.getContext('2d');
let clipRec = null; // the MediaRecorder while a clip is being recorded
const clipJobs = [];
let clipBusy = false;

// A still camera square on to her face: placed from the head, so the seat / clips show eyes and
// forehead (theater pip was cutting at the nose when aimed too low / too close).
const _fv = new THREE.Vector3(), _fq = new THREE.Quaternion();
function frameFace() {
  const c = cast.find((x) => x.main) || cast[0];
  if (!c?.model) return;
  (c.bones.Head ?? c.model).getWorldPosition(_fv);
  // Pip seat is a tall portrait: aim a bit above the head center and stand farther back so the
  // crop includes forehead and eyes, not just mouth/chin.
  const lift = PIP ? 0.1 : 0.03;
  const dist = PIP ? 1.25 : 0.95;
  const head = _fv.clone().add(new THREE.Vector3(0, lift, 0));
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(c.model.getWorldQuaternion(_fq)).setY(0).normalize();
  if (forward.lengthSq() < 0.01) forward.set(0, 0, 1);
  camera.position.copy(head).addScaledVector(forward, dist);
  controls.target.copy(head);
  camera.lookAt(head);
}

// Copies the middle square of the rendered frame into the clip canvas.
function copyClipFrame() {
  const src = renderer.domElement;
  const s = Math.min(src.width, src.height);
  clipCtx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, CLIP_SIZE, CLIP_SIZE);
}

function recorderBar(text, recording = false) {
  const bar = $('#recorderBar');
  bar.textContent = text;
  bar.classList.toggle('rec', recording);
}

const speechDone = () =>
  new Promise((ok) => {
    const check = () => (!playing && !speech.length && !cast.some((c) => c.lips.fake) ? ok() : setTimeout(check, 100));
    check();
  });

async function recordClip(job) {
  const fail = (reason) => fetch(`/api/avatar/recorder/${job.id}/failed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  if (!audioCtx || audioCtx.state !== 'running') return fail('audio is blocked; click the recorder page once to allow it');
  if (!cast[0]?.model) return fail('the avatar is still loading');
  const buffers = [];
  for (const line of job.lines) buffers.push(await audioCtx.decodeAudioData(base64ToArrayBuffer(line.audio)));
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const stream = new MediaStream([...clipCanvas.captureStream(30).getVideoTracks(), ...recordDest.stream.getAudioTracks()]);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((ok) => (rec.onstop = ok));
  copyClipFrame();
  clipRec = rec;
  rec.start(); // before the audio, so the first syllable is in
  recorderBar(`Recording reply #${job.id}`, true);
  fetch(`/api/avatar/recorder/${job.id}/ack`, { method: 'POST' });
  job.lines.forEach((line, i) => enqueueSpeech({ char: cast[0].id, text: line.text, buffer: buffers[i] }));
  await speechDone();
  await new Promise((ok) => setTimeout(ok, 250)); // tail, so the last syllable isn't clipped (frame holds)
  rec.stop();
  await stopped;
  clipRec = null;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  await fetch(`/api/avatar/recorder/${job.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  recorderBar(`Sent reply #${job.id} (${(blob.size / 1048576).toFixed(1)} MB). Waiting for the next one.`);
}

async function nextClip() {
  if (clipBusy || !clipJobs.length) return;
  clipBusy = true;
  const job = clipJobs.shift();
  try {
    await recordClip(job);
  } catch (err) {
    clipRec = null;
    fetch(`/api/avatar/recorder/${job.id}/failed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: err.message }) });
    recorderBar(`Reply #${job.id} failed: ${err.message}`);
  }
  clipBusy = false;
  nextClip();
}

function startRecorder() {
  document.body.classList.add('recorder');
  const bar = Object.assign(document.createElement('div'), { id: 'recorderBar' });
  document.body.append(bar);
  recorderBar('Video recorder: click here once to allow audio.');
  // Browsers only let audio start after a click on the page.
  addEventListener('pointerdown', () => {
    ensureAudio().resume().then(() => recorderBar('Video recorder ready. Keep this window open (not minimised).'));
  });
  const events = new EventSource('/api/avatar/recorder');
  events.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'job') {
      clipJobs.push(msg);
      nextClip();
    }
  };
  events.onerror = () => recorderBar('Lost the connection to the bot; reconnecting…');
  events.onopen = () => audioCtx?.state === 'running' && recorderBar('Video recorder ready. Keep this window open (not minimised).');
}

// ---------------------------------------------------------------- start

async function loadCast() {
  let list;
  try {
    list = await fetch('/api/avatar/characters').then((r) => r.json());
  } catch {
    list = [{ id: 'main', main: true, name: 'Companion', persona: '', voiceId: '', feelings: {} }];
  }
  // A character marked "solo" gets its own page (avatar.html?character=<id>) instead of joining the cast.
  const only = RECORDER ? 'main' : new URLSearchParams(location.search).get('character');
  list = only ? list.filter((c) => c.id === only) : list.filter((c) => !c.solo);
  if (!list.length) list = [{ id: 'main', main: true, name: 'Companion', persona: '', voiceId: '', feelings: {} }];
  for (const info of list) {
    const c = createCharacter(info);
    c.look = { ...LOOK_DEFAULTS, ...(info.look || {}), strands: info.look?.strands === true };
    c.feel.target = { ...(info.feelings || {}) };
    cast.push(c);
    byId.set(c.id, c);
  }
  setCurrent(byId.get(opts.talkingTo) ?? cast[0]);
  // setCurrent no-ops when already selected; force look UI once cast is ready.
  syncLookUi(current);
  renderCastPicker();
  renderCharacterEditors();
  $('#botName').textContent = cast.length > 1 ? 'Studio' : cast[0].name;
  document.title = `${cast.map((c) => c.name).join(' & ')} · Avatar Studio`;
  await loadHistory();
  await Promise.all(cast.map((c) => loadModel(c, `/api/avatar/model/${c.id}`)));
  await refreshLibrary();
  loadRocketbox(); // Microsoft Rocketbox body motions (async; applies when ready)
}

document.body.dataset.backdrop = opts.backdrop;
document.body.classList.toggle('collapsed', opts.collapsed);
$('#reopen').hidden = !opts.collapsed;
resize();
buildComposer();
setState('loading');
if (RECORDER) startRecorder();
tick();
loadStatus();
loadCast();
