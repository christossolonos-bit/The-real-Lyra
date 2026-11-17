// Lyra's eyes: the webcam, read on this PC only.
//  - MediaPipe Face Landmarker: 478 points, 52 expression blendshapes and head pose, ~15 times a second.
//  - face-api: a 128-number face fingerprint, matched against the people she knows (Chris, Dad...).
// No video or photos are stored. Only fingerprints of people you add are saved (data/faces.json).
// While the camera is on, a small snapshot is kept in the server's memory only (never on disk), so she
// can actually look when someone asks her to.
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import * as faceapi from 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.esm.js';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const FA_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
const MATCH = 0.5;          // face fingerprint distance under this = the same person
const GONE_MS = 8000;       // unseen this long = they left
const AWAY_MS = 30 * 60e3;  // gone this long and back = a new arrival worth greeting

export function createEyes({ api, onChange, onArrive, onGaze, onStatus }) {
  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  const canvas = document.createElement('canvas');
  let landmarker, stream, running = false, matcher = null, people = [];
  const seen = new Map();   // name -> { last, since, gone }
  let unknownLast = 0, unknownGreeted = 0;
  let face = null;          // primary face: { name, expression, details, attention, x, y, size }
  let lastReport = '', lastReportAt = 0;

  async function loadPeople() {
    const r = await api('/api/faces/list');
    people = r.people || [];
    matcher = people.length
      ? new faceapi.FaceMatcher(people.map((p) => new faceapi.LabeledFaceDescriptors(p.name, p.descriptors.map((d) => new Float32Array(d)))), MATCH)
      : null;
    return people;
  }

  async function start() {
    if (running) return;
    onStatus?.('waking her eyes…');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    video.srcObject = stream; await video.play();
    if (!landmarker) {
      const files = await FilesetResolver.forVisionTasks(MP_WASM);
      landmarker = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numFaces: 4, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(FA_MODELS), faceapi.nets.faceLandmark68Net.loadFromUri(FA_MODELS), faceapi.nets.faceRecognitionNet.loadFromUri(FA_MODELS)]);
    }
    await loadPeople();
    running = true; onStatus?.('on');
    trackLoop(); recogniseLoop(); snapshotLoop();
  }

  function stop() {
    running = false; stream?.getTracks().forEach((t) => t.stop()); stream = null;
    seen.clear(); face = null; onStatus?.('off');
    api('/api/seen', { cameraOn: false });
  }

  // ---- detailed face reading: expressions, head pose, where they are ----
  let lastT = -1;
  function trackLoop() {
    if (!running) return;
    requestAnimationFrame(trackLoop);
    const now = performance.now();
    if (now - lastT < 66 || video.readyState < 2) return; // ~15 fps
    lastT = now;
    const res = landmarker.detectForVideo(video, now);
    if (!res.faceLandmarks?.length) { face = face && { ...face, present: false }; onGaze?.(null); return; }
    // the biggest face is the one she's talking to
    let best = 0, bestSize = 0;
    res.faceLandmarks.forEach((pts, i) => {
      const xs = pts.map((p) => p.x); const size = Math.max(...xs) - Math.min(...xs);
      if (size > bestSize) { bestSize = size; best = i; }
    });
    const pts = res.faceLandmarks[best];
    const bs = Object.fromEntries((res.faceBlendshapes?.[best]?.categories || []).map((c) => [c.categoryName, c.score]));
    const m = res.facialTransformationMatrixes?.[best]?.data;
    const yaw = m ? Math.atan2(m[8], m[10]) * 57.3 : 0, pitch = m ? Math.asin(-m[9]) * 57.3 : 0;
    const nose = pts[1];
    const read = readFace(bs, yaw, pitch, bestSize);
    face = { ...(face || {}), present: true, faces: res.faceLandmarks.length, ...read, x: nose.x, y: nose.y, size: bestSize };
    onGaze?.({ x: nose.x, y: nose.y, size: bestSize });
  }

  // blendshapes -> plain words she can use
  const hold = new Map(); // label -> since (so a blink isn't "tired")
  function readFace(b, yaw, pitch, size) {
    const g = (k) => b[k] || 0, two = (k) => (g(k + 'Left') + g(k + 'Right')) / 2;
    const smile = two('mouthSmile'), frown = two('mouthFrown'), jaw = g('jawOpen'), browUp = g('browInnerUp'),
      browOut = two('browOuterUp'), browDown = two('browDown'), blink = two('eyeBlink'), squint = two('eyeSquint'),
      sneer = two('noseSneer'), pucker = g('mouthPucker'), press = two('mouthPress');
    const raw = [];
    if (smile > 0.55 && jaw > 0.25) raw.push('laughing');
    else if (smile > 0.35) raw.push(smile > 0.6 ? 'grinning' : 'smiling');
    if (frown > 0.35 || (press > 0.4 && browDown > 0.3)) raw.push('frowning');
    if (browUp > 0.45 && jaw > 0.2 && smile < 0.3) raw.push('surprised');
    else if (browUp > 0.5 || browOut > 0.5) raw.push('eyebrows raised');
    if (browDown > 0.45 && smile < 0.2) raw.push('concentrating or annoyed');
    if (squint > 0.5 && smile < 0.3) raw.push('squinting');
    if (sneer > 0.4) raw.push('wrinkling their nose');
    if (pucker > 0.5) raw.push('pursing their lips');
    if (jaw > 0.45 && smile < 0.3) raw.push('mouth open');
    if (blink > 0.55) raw.push('eyes closing');
    const now = performance.now(), words = [];
    for (const w of raw) { if (!hold.has(w)) hold.set(w, now); words.push(w); }
    for (const w of [...hold.keys()]) if (!raw.includes(w)) hold.delete(w);
    // sustained states only
    const sustained = words.filter((w) => w !== 'eyes closing' || now - hold.get(w) > 2500).map((w) => (w === 'eyes closing' ? 'eyes drooping, looks tired' : w));
    let attention = 'looking at you';
    if (Math.abs(yaw) > 28) attention = `looking away to the ${yaw > 0 ? 'side' : 'other side'}`;
    else if (pitch > 22) attention = 'looking down';
    else if (pitch < -20) attention = 'looking up';
    if (size > 0.42) attention += ', leaning in close';
    else if (size < 0.14) attention += ', sitting back from the screen';
    return { expression: sustained.length ? sustained.join(', ') : 'neutral, relaxed face', attention, details: { smile, jaw, browUp, blink, yaw: Math.round(yaw), pitch: Math.round(pitch) } };
  }

  // ---- who: face fingerprints every ~1.2 s ----
  async function recogniseLoop() {
    while (running) {
      try {
        const found = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptors();
        const now = Date.now();
        let biggest = null, bigArea = 0;
        for (const f of found) {
          const name = matcher ? matcher.findBestMatch(f.descriptor).label : 'unknown';
          const area = f.detection.box.width * f.detection.box.height;
          if (area > bigArea) { bigArea = area; biggest = name; }
          if (name === 'unknown') {
            if (now - unknownLast > GONE_MS && now - unknownGreeted > 10 * 60e3) { unknownGreeted = now; onArrive?.(null); }
            unknownLast = now; continue;
          }
          const s = seen.get(name);
          if (!s || now - s.last > GONE_MS) {
            const away = s ? now - s.last : Infinity;
            seen.set(name, { last: now, since: now });
            if (away > AWAY_MS) onArrive?.(name);
          } else s.last = now;
        }
        if (face) face.name = biggest && biggest !== 'unknown' ? biggest : null;
        report();
      } catch (e) { console.warn('eyes:', e.message); }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  function present() {
    const now = Date.now();
    return [...seen.entries()].filter(([, s]) => now - s.last < GONE_MS).map(([n]) => n);
  }

  function report() {
    const now = Date.now();
    const body = {
      cameraOn: true, present: present(), unknown: now - unknownLast < GONE_MS,
      main: face?.present ? { name: face.name, expression: face.expression, attention: face.attention, faces: face.faces } : null,
    };
    const key = JSON.stringify(body);
    if (key === lastReport && now - lastReportAt < 5000) return;
    lastReport = key; lastReportAt = now;
    api('/api/seen', body);
    onChange?.(body);
  }

  // ---- a small snapshot for the server's memory, so she can look when asked ----
  async function snapshotLoop() {
    while (running) {
      const w = 512, h = Math.round((video.videoHeight / video.videoWidth) * w) || 384;
      canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      api('/api/seen/snapshot', { image: canvas.toDataURL('image/jpeg', 0.7) });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ---- learning a face: ~8 fingerprints over a few seconds ----
  async function learn(name, onProgress) {
    if (!running) throw new Error('turn her eyes on first');
    const prints = [];
    for (let i = 0; i < 20 && prints.length < 8; i++) {
      const f = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 })).withFaceLandmarks().withFaceDescriptor();
      if (f) { prints.push(Array.from(f.descriptor)); onProgress?.(prints.length / 8); }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (prints.length < 4) throw new Error("couldn't see a face clearly. Look at the camera in good light and try again");
    const r = await api('/api/faces/add', { person: name, descriptors: prints });
    if (r.error) throw new Error(r.error);
    await loadPeople();
    seen.set(name, { last: Date.now(), since: Date.now() }); // already here: don't greet as a fresh arrival
    return r;
  }
  async function forget(name) { await api('/api/faces/remove', { person: name }); await loadPeople(); seen.delete(name); }

  return { start, stop, learn, forget, loadPeople, get running() { return running; }, get people() { return people; } };
}
