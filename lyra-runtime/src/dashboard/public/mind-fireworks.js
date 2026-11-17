// Fireworks for her mind (owner, 2026-11-15: "whenever new knowledge is found or made, there's like fireworks or
// something exploding or points showing, to indicate learning and the relationship, really interactive, fun stuff").
// Only real events set them off: something she learned, points someone earned or lost, a level gained. Each burst is
// a shell of glowing sparks that fly out from where it happened in her brain, fall a little, twinkle and fade. Drawn
// additively with the same soft-point look as her neurons, so it belongs to the brain rather than sitting on top.
//
//   const fw = createFireworks(THREE); scene.add(fw.group);
//   fw.burst([x,y,z], '#ffcc00', { size: 1 });   each frame: fw.update(dt); on resize: fw.setScale(k)

export function createFireworks(THREE, { cap = 4000 } = {}) {
  const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 3), alpha = new Float32Array(cap), sz = new Float32Array(cap);
  const vel = new Float32Array(cap * 3), life = new Float32Array(cap), age = new Float32Array(cap), tint = new Float32Array(cap * 3), tw = new Float32Array(cap);
  let next = 0;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 } },
    vertexShader: `attribute float aAlpha;attribute float aSize;varying float vA;varying vec3 vC;uniform float uScale;void main(){vA=aAlpha;vC=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=aSize*uScale/-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying float vA;varying vec3 vC;void main(){if(vA<0.01)discard;float r=length(gl_PointCoord-0.5);if(r>0.5)discard;float core=smoothstep(0.5,0.0,r);float a=core*core*vA;gl_FragColor=vec4(mix(vC,vec3(1.0),core*0.6)*a*1.8,a);}`,
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false;
  const group = new THREE.Group(); group.add(points);
  const c = new THREE.Color();

  function spark(p, v, color, t, size) {
    const i = next; next = (next + 1) % cap;
    pos.set(p, i * 3); vel.set(v, i * 3); life[i] = t; age[i] = 0; sz[i] = size; tw[i] = Math.random() * 6.28;
    tint[i * 3] = color.r; tint[i * 3 + 1] = color.g; tint[i * 3 + 2] = color.b;
  }
  // One shell: sparks out in every direction (a sphere, a little uneven), a white flash at the centre, and a few
  // slower trailing embers. size 1 is a fact or a few points; 2 and up is a level gained.
  function burst(p, color = '#ffffff', { size = 1, count = null } = {}) {
    c.set(color);
    const n = count ?? Math.round(70 + size * 90);
    const speed = 0.35 + size * 0.22;
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = speed * (0.75 + Math.random() * 0.5);
      // a few sparks in a second colour, mixed toward white, so a shell isn't flat
      const cc = Math.random() < 0.2 ? c.clone().lerp(new THREE.Color(1, 1, 1), 0.6) : c;
      spark(p, [s * Math.cos(th) * sp, u * sp, s * Math.sin(th) * sp], cc, 1.1 + Math.random() * 0.7 + size * 0.25, 3.2 + Math.random() * 2.2);
    }
    for (let k = 0; k < 6 + size * 4; k++) spark(p, [(Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04], new THREE.Color(1, 1, 1), 0.35, 9 + size * 4);
    for (let k = 0; k < 14 * size; k++) spark(p, [(Math.random() - 0.5) * 0.15, Math.random() * 0.12, (Math.random() - 0.5) * 0.15], c, 2.2 + Math.random(), 2.2);
  }
  // Several shells in a ring around a point, a beat apart: for a level gained.
  function finale(p, colors) {
    colors.forEach((col, k) => setTimeout(() => {
      const a = (k / colors.length) * Math.PI * 2;
      burst([p[0] + Math.cos(a) * 0.35, p[1] + 0.15 + Math.sin(a * 2) * 0.1, p[2] + Math.sin(a) * 0.35], col, { size: 2 });
    }, k * 220));
  }

  function update(dt) {
    const g = 0.16; // they fall a little, like real sparks
    for (let i = 0; i < cap; i++) {
      if (life[i] <= 0) { if (alpha[i]) alpha[i] = 0; continue; }
      age[i] += dt;
      const t = age[i] / life[i];
      if (t >= 1) { life[i] = 0; alpha[i] = 0; continue; }
      const drag = Math.exp(-dt * 1.6);
      vel[i * 3] *= drag; vel[i * 3 + 1] = vel[i * 3 + 1] * drag - g * dt; vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const twinkle = t > 0.55 ? 0.6 + 0.4 * Math.sin(age[i] * 28 + tw[i]) : 1;
      alpha[i] = (1 - t) * (1 - t) * twinkle;
      // hot white first, then their own colour
      const w = Math.max(0, 1 - t * 4);
      col[i * 3] = tint[i * 3] + (1 - tint[i * 3]) * w; col[i * 3 + 1] = tint[i * 3 + 1] + (1 - tint[i * 3 + 1]) * w; col[i * 3 + 2] = tint[i * 3 + 2] + (1 - tint[i * 3 + 2]) * w;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.attributes.aAlpha.needsUpdate = true; geo.attributes.aSize.needsUpdate = true;
  }

  return { group, burst, finale, update, setScale: (k) => { mat.uniforms.uScale.value = k; } };
}
