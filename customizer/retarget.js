// Retarget Rocketbox (Bip01) animations onto the Lyra model's skeleton, baked once at load.
//
// - Hips, spine, neck, head, feet: copy the source bone's rotation relative to its rest pose (keeps nods and head turns).
// - Arms and legs: swing each target bone so it points the same way as the source bone (rest poses differ: A vs T).
// - Hands: match two directions (middle finger + thumb) so palms turn correctly.
// Both skeletons are compared in world space, each facing +Z.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const S = (side, n) => `Bip01 ${side} ${n}`;
// [source bone, target bone, mode, source aim joint, target aim joint, source 2nd joint, target 2nd joint]
function rig() {
  const m = [
    ['Bip01 Pelvis', 'bone_Root', 'delta'],
    ['Bip01 Spine', 'bone_SpineLow', 'delta'],
    ['Bip01 Spine1', 'bone_EXP_C1_Spine2', 'delta'],
    ['Bip01 Spine2', 'bone_Chest', 'delta'],
    ['Bip01 Neck', 'bone_EXP_C1_Neck1', 'delta'],
    ['Bip01 Head', 'bone_Head', 'delta'],
  ];
  for (const [s, t, foot] of [['L', 'L', 'bone_20'], ['R', 'R', 'bone_19']]) {
    m.push(
      [S(s, 'Clavicle'), `bone_Shoulder${t}`, 'aim', S(s, 'UpperArm'), `bone_Arm${t}`],
      [S(s, 'UpperArm'), `bone_Arm${t}`, 'aim', S(s, 'Forearm'), `bone_Elbow${t}`],
      [S(s, 'Forearm'), `bone_Elbow${t}`, 'aim', S(s, 'Hand'), `bone_Hand${t}`],
      [S(s, 'Hand'), `bone_Hand${t}`, 'aim2', S(s, 'Finger2'), `bone_MiddleFinger${t}`, S(s, 'Finger0'), `bone_Thumb${t}`],
      [S(s, 'Thigh'), `bone_EXP_${t}1_Leg1Twist1`, 'aim', S(s, 'Calf'), `bone_EXP_${t}1_Leg2Twist1`],
      [S(s, 'Calf'), `bone_EXP_${t}1_Leg2Twist1`, 'aim', S(s, 'Foot'), foot],
      [S(s, 'Foot'), foot, 'delta'],
    );
  }
  return m;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const wpos = (o, v) => o.getWorldPosition(v);
const wquat = (o, q) => o.getWorldQuaternion(q);
function basis(a, b, out) { // orthonormal frame from a primary and a secondary direction
  const x = a.clone().normalize(), z = new THREE.Vector3().crossVectors(x, b).normalize(), y = new THREE.Vector3().crossVectors(z, x);
  return out.makeBasis(x, y, z);
}

export async function loadRetargeted(url, targetRoot, loader, { fps = 20, prefix = 'RB ' } = {}) {
  const gltf = await loader.loadAsync(url);
  const src = gltf.scene;
  // the source must face +Z like the target: its left hand should be on +X
  src.updateMatrixWorld(true);
  const lh = src.getObjectByName('Bip01_L_Hand'), rh = src.getObjectByName('Bip01_R_Hand');
  if (wpos(lh, _v1).x < wpos(rh, _v2).x) src.rotation.y = Math.PI;
  src.updateMatrixWorld(true);

  // bake on a hidden copy so the visible Lyra keeps playing
  const tgt = SkeletonUtils.clone(targetRoot);
  tgt.position.set(0, 0, 0);
  // start from the true bind pose (the clone copies whatever frame the live model was in)
  tgt.traverse((o) => { if (o.isBone && /^bone_/.test(o.name) && !o.name.endsWith('_p')) { o.quaternion.identity(); o.position.set(0, 0, 0); o.scale.set(1, 1, 1); } });
  tgt.updateMatrixWorld(true);
  // three.js turns spaces in node names into underscores ("Bip01 L Hand" -> "Bip01_L_Hand")
  const byName = (root, n) => root.getObjectByName(n) || root.getObjectByName(n.replace(/ /g, '_'));
  const map = rig().map(([s, t, mode, sa, ta, s2, t2]) => ({
    s: byName(src, s), t: byName(tgt, t), mode, sa: sa && byName(src, sa), ta: ta && byName(tgt, ta), s2: s2 && byName(src, s2), t2: t2 && byName(tgt, t2), name: t,
  })).filter((e) => e.s && e.t && (e.mode === 'delta' || (e.sa && e.ta)) && (e.mode !== 'aim2' || (e.s2 && e.t2)));

  // rest poses
  const tgtRestLocal = new Map(map.map((e) => [e.t, e.t.quaternion.clone()]));
  const tgtRootRestPos = byName(tgt, 'bone_Root').position.clone();
  for (const e of map) { e.sRest = wquat(e.s, new THREE.Quaternion()); e.tRest = wquat(e.t, new THREE.Quaternion()); }
  const pelvisS = byName(src, 'Bip01 Pelvis'), rootT = byName(tgt, 'bone_Root');
  const sHip0 = wpos(pelvisS, new THREE.Vector3()), tHip0 = wpos(rootT, new THREE.Vector3());
  const scale = tHip0.y / Math.max(1e-3, sHip0.y); // both stand on y = 0

  const mixer = new THREE.AnimationMixer(src);
  const clips = [];
  for (const clip of gltf.animations) {
    const act = mixer.clipAction(clip); act.play();
    const n = Math.max(2, Math.floor(clip.duration * fps) + 1);
    const times = new Float32Array(n);
    const qv = new Map(map.map((e) => [e.name, new Float32Array(n * 4)]));
    const pv = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = Math.min(clip.duration, i / fps); times[i] = t;
      act.time = t; mixer.update(0); src.updateMatrixWorld(true);
      for (const e of map) e.t.quaternion.copy(tgtRestLocal.get(e.t));
      rootT.position.copy(tgtRootRestPos);
      tgt.updateMatrixWorld(true);
      for (const e of map) {
        const parentQ = wquat(e.t.parent, new THREE.Quaternion());
        let desired;
        if (e.mode === 'delta') {
          desired = wquat(e.s, _q).multiply(_q2.copy(e.sRest).invert()).multiply(e.tRest).clone();
        } else if (e.mode === 'aim') {
          const sd = wpos(e.sa, _v1).sub(wpos(e.s, _v2)).normalize();
          const td = wpos(e.ta, _v3).sub(wpos(e.t, _v4)).normalize();
          desired = new THREE.Quaternion().setFromUnitVectors(td, sd).multiply(wquat(e.t, _q));
        } else { // aim2: full orientation from two directions
          const sd = wpos(e.sa, new THREE.Vector3()).sub(wpos(e.s, _v2)), ss = wpos(e.s2, new THREE.Vector3()).sub(wpos(e.s, _v2));
          const td = wpos(e.ta, new THREE.Vector3()).sub(wpos(e.t, _v4)), ts = wpos(e.t2, new THREE.Vector3()).sub(wpos(e.t, _v4));
          basis(sd, ss, _m); basis(td, ts, _m2);
          const rot = new THREE.Quaternion().setFromRotationMatrix(_m.clone().multiply(_m2.clone().invert()));
          desired = rot.multiply(wquat(e.t, _q));
        }
        e.t.quaternion.copy(parentQ.invert().multiply(desired));
        e.t.updateMatrixWorld(true);
        qv.get(e.name).set(e.t.quaternion.toArray(), i * 4);
      }
      // hips: carry the source's sway and bob, scaled to Lyra's height, expressed in the root's parent space
      const dHip = wpos(pelvisS, _v1).sub(sHip0).multiplyScalar(scale);
      const pInv = _m.copy(rootT.parent.matrixWorld).invert();
      const restW = tHip0.clone().add(dHip).applyMatrix4(pInv);
      pv.set(restW.toArray(), i * 3);
    }
    act.stop();
    const tracks = map.map((e) => new THREE.QuaternionKeyframeTrack(`${e.name}.quaternion`, times, qv.get(e.name)));
    tracks.push(new THREE.VectorKeyframeTrack('bone_Root.position', times, pv));
    clips.push(new THREE.AnimationClip(prefix + clip.name, clip.duration, tracks));
  }
  return clips;
}
