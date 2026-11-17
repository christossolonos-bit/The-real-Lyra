// Strand hair layer over simulated guides (from the-student).
// Card-grown guides (avatar-hair.js) and optional scalp strands both draw here.
export function strandLayer({ THREE, scene, SEGS, CHILDREN, head, restToHead, rest, rootN, seg, pad = null, shade, colors = null, count, size, outside = null, hold = 0.02, material = {} }) {
  const STRANDS = count, pts = SEGS + 1;
  // Drawing happens on the GPU. Each frame the simulated guides go into a float texture (one row
  // per guide: its points, then its root normal), and the vertex shader builds CHILDREN tapered,
  // camera-facing ribbons around each guide. Children spread out at the root and gather toward
  // the tip, which is what makes hair clump into locks instead of reading as separate threads.
  const texW = pts + 1, guideData = new Float32Array(texW * STRANDS * 4);
  const guideTex = new THREE.DataTexture(guideData, texW, STRANDS, THREE.RGBAFormat, THREE.FloatType);
  guideTex.minFilter = guideTex.magFilter = THREE.NearestFilter;
  const strands = STRANDS * CHILDREN, verts = strands * pts * 2;
  const ref = new Float32Array(verts * 3), child = new Float32Array(verts * 4), tone3 = new Float32Array(verts * 3), index = new Uint32Array(strands * SEGS * 6);
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
        if (colors) tone3.set(colors.subarray(g * 3, g * 3 + 3), v * 3); else tone3.set([1, 1, 1], v * 3);
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
  geo.setAttribute('hairColor', new THREE.BufferAttribute(tone3, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // Solid strands (no alpha-to-coverage): soft half-covered edges let whatever is behind her show
  // through her hair.
  const mat = new THREE.MeshStandardMaterial({ color: colors ? 0xffffff : material.color, roughness: colors ? 0.5 : 0.9, side: THREE.DoubleSide, alphaToCoverage: Boolean(colors) });
  // Her hair colour, the way avatar-appearance.js tints her cards: each strand keeps its brightness relative to the
  // texture's average (base 0: the texture's own colour).
  const tint = { value: new THREE.Color(1, 1, 1) }, tintBase = { value: 0 }, tintMean = { value: material.meanLum ?? 0.25 };
  const clump = { value: 0 }; // how far children sit from their guide at the root (set per frame, in world units)
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.guides = { value: guideTex };
    sh.uniforms.clump = clump;
    sh.uniforms.hairWidth = { value: material.width ?? 0.00028 };
    sh.uniforms.hairTint = tint; sh.uniforms.hairTintBase = tintBase; sh.uniforms.hairTintMean = tintMean;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 hairRef;
        attribute vec4 hairChild;
        attribute vec3 hairColor;
        varying vec3 vHairColor;
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
        float wave = clump * 0.18 * u * sin(u * 11.0 + hairChild.z * 40.0);
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
        vHairColor = hairColor;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = hairPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHairT, vHairColor;
        uniform vec3 hairTint; uniform float hairTintBase, hairTintMean;
        varying float vHairU, vHairSide, vHairShade, vHairRnd;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vHairU > 1.0) discard;
        {
          float lum = dot(vHairColor, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb *= mix(vHairColor, hairTint * clamp(lum / max(hairTintMean, 0.02), 0.1, 1.8) * 0.82, hairTintBase);
        }
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
  mesh.name = 'strandLayer'; // not "hair": avatar-appearance.js must not swap this shader for its card tint
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
    // Her hair colour (avatar-appearance's hair setting): null puts the texture's own colours back.
    setTint(color) { tintBase.value = color ? 1 : 0; if (color) tint.value.set(color); },
    update(dt) {
      head.updateWorldMatrix(true, false);
      K.multiplyMatrices(head.matrixWorld, restToHead);
      Kinv.copy(K).invert();
      const scale = Math.cbrt(Math.abs(K.determinant()));
      clump.value = size.y * scale * 0.035;
      if (!started) {
        // Start combed, wherever the head is.
        for (let j = 0; j < rest.length; j += 3) comb.fromArray(rest, j).applyMatrix4(K).toArray(cur, j);
        prev.set(cur);
        started = true;
      }
      const h = Math.min(dt, 1 / 30), g = -9.8 * h * h, damp = 0.94;
      for (let s = 0; s < STRANDS; s++) {
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
          x.fromArray(cur, j).lerp(comb, hold + 0.3 * f * f * f);
          // Keep the segment's length, following the point before it.
          y.fromArray(cur, j - 3);
          x.sub(y).setLength(len).add(y);
          // Stay out of the skull, tested in rest space where the ellipsoid is defined.
          if (outside) { x.applyMatrix4(Kinv); outside(x, pad[s]); x.applyMatrix4(K); }
          x.toArray(cur, j);
        }
      }

      // Hand the guides to the shader: their points, then their root normal (turned with the head).
      rot.setFromMatrix4(K);
      for (let s = 0; s < STRANDS; s++) {
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
