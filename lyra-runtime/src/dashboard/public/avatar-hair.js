// Her hair, drawn as hair (owner, 2026-11-16: "the hair... it's looking like a claymation thing, and they need to be
// individual strands. Is there any way for us to do some high definition on that?").
//
// Avaturn hair is "hair cards": a few thousand triangles carrying a 1024x1024 texture of individual strands with
// see-through gaps between them. Until this, the page drew those cards solid down to an alpha of 0.06 with no
// alpha-to-coverage, so every half-covered strand edge became solid; and a little way off the GPU's smaller copies of
// the texture (mipmaps) average strands and gaps into one half-covered sheet, which that cut then drew solid too. That
// is the clay. Three things here:
//
//  - hairCards: the cards drawn with alpha-to-coverage (each strand's edge antialiased across the MSAA samples, its
//    alpha sharpened to one pixel around the cut by three.js), the cut at 0.5, and the alpha of the smaller copies
//    scaled back up by how much smaller they are, so strands and gaps survive at every distance (Ben Golus, "Anti-aliased
//    Alpha Test"). Light comes off them the way it does off hair: two highlights along the strand direction
//    (Kajiya-Kay, with Marschner's shifted lobes), not a fabric sheen.
//  - textureStats: the hair texture's own pixels, read once: where its strands are (alpha) and how bright it is on
//    average, so a recolour keeps each strand's contrast (avatar-appearance.js) and strands grow where hair is.
//  - cardGuides: guide strands grown along her own hair cards, from where the texture has hair, down the cards' strand
//    direction, for the strand layer (avatar.js strandLayer) that draws real individual strands over them.

// The hair texture's pixels, once per texture: alpha(u, v) 0..1 and its average brightness where there's hair.
export function textureStats(texture) {
  if (!texture?.image) return null;
  if (texture.userData.hairStats) return texture.userData.hairStats;
  const img = texture.image, w = img.width, h = img.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) { // every 4th pixel is plenty for an average
    const a = px[i + 3] / 255;
    if (a < 0.5) continue;
    sum += (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255; n++;
  }
  // glTF textures aren't flipped: uv (0,0) is the image's top left.
  const at = (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * h)));
    return (y * w + x) * 4;
  };
  const stats = {
    size: w,
    meanLum: n ? sum / n : 0.25,
    alpha: (u, v) => px[at(u, v) + 3] / 255,
    color: (u, v) => { const i = at(u, v); return [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]; },
  };
  texture.userData.hairStats = stats;
  return stats;
}

// Hair cards drawn as hair. material: the card's physical material (upgraded in avatar.js); it's changed in place.
export function hairCards(material) {
  const size = { value: material.map?.image?.width || 1024 };
  Object.assign(material, {
    metalness: 0, roughness: 0.42, transparent: false, depthWrite: true,
    alphaToCoverage: true, alphaTest: 0.5, sheen: 0, specularIntensity: 0.35, envMapIntensity: 0.7,
  });
  if (material.map) textureStats(material.map); // read now, so a recolour has the average to hand
  material.userData.hairCards = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (sh, ...args) => {
    previous?.call(material, sh, ...args);
    sh.uniforms.hairTexSize = size;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float hairTexSize;')
      // The smaller copies of the texture average strands and gaps: scale their alpha back up by how much smaller they
      // are, so the strands don't melt into a sheet with distance.
      .replace('#include <alphatest_fragment>', `
        #ifdef USE_MAP
        {
          vec2 texel = vMapUv * hairTexSize;
          vec2 ddx = dFdx(texel), ddy = dFdy(texel);
          float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
          diffuseColor.a *= 1.0 + mip * 0.25;
        }
        #endif
        #include <alphatest_fragment>`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Hair highlights along the strand. On these cards the strands run down the texture (+v), so the strand
        // direction is how the surface moves as v grows.
        #if NUM_DIR_LIGHTS > 0 && defined( USE_MAP )
        {
          vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
          vec2 dux = dFdx(vMapUv), duy = dFdy(vMapUv);
          vec3 T = dpy * dux.x - dpx * duy.x; // perpendicular to how u changes, so along v
          T = normalize(T - normal * dot(T, normal) + vec3(1e-6));
          vec3 Vd = normalize(vViewPosition);
          float jitter = fract(sin(dot(floor(vMapUv * vec2(160.0, 8.0)), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
          vec3 T1 = normalize(T + normal * (0.12 + jitter * 0.08));
          vec3 T2 = normalize(T - normal * (0.10 - jitter * 0.08));
          for (int l = 0; l < NUM_DIR_LIGHTS; l++) {
            vec3 L = directionalLights[l].direction, H = normalize(L + Vd);
            float t1 = dot(T1, H), t2 = dot(T2, H);
            float s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 160.0);
            float s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 36.0);
            float wrap = clamp(dot(normal, L) * 0.5 + 0.5, 0.0, 1.0);
            reflectedLight.directSpecular += directionalLights[l].color * wrap * (0.12 * s1 + 0.22 * s2 * diffuseColor.rgb);
          }
        }
        #endif`);
  };
  material.customProgramCacheKey = () => 'hairCards';
  material.needsUpdate = true;
  return material;
}

// Guide strands grown along her own hair cards. meshes: the hair card meshes (skinned or not), posed. Each guide starts
// where the card's texture has hair and walks down the texture's strand (+v), and every point of it is looked up on the
// card surface itself, so the strand lies on the card and follows its curve around her head, and ends where the
// texture's strand ends. (Grown as straight lines first, 2026-11-16, they left the curved cards and stood out from her
// head like a halo.) Returns rest points (world space at this moment), root normals, segment lengths, shade and colour
// for the strand layer; null when there's no hair texture to grow from.
export function cardGuides({ meshes, THREE, count, segs }) {
  const cards = [];
  const box = new THREE.Box3(), v = new THREE.Vector3();
  let total = 0;
  for (const mesh of meshes) {
    const stats = textureStats(mesh.material?.map);
    const g = mesh.geometry, pos = g.attributes.position, uvAttr = g.attributes.uv;
    if (!stats || !pos || !uvAttr) continue;
    mesh.updateWorldMatrix(true, false);
    const P = new Float32Array(pos.count * 3), UV = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      (mesh.isSkinnedMesh ? mesh.getVertexPosition(i, v) : v.fromBufferAttribute(pos, i)).applyMatrix4(mesh.matrixWorld).toArray(P, i * 3);
      box.expandByPoint(v);
      UV[i * 2] = uvAttr.getX(i); UV[i * 2 + 1] = uvAttr.getY(i);
    }
    const index = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
    // Triangles found by where they sit in the texture: a grid over uv, each cell listing the triangles that touch it.
    const GRID = 96, cells = Array.from({ length: GRID * GRID }, () => []);
    const tris = [];
    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      const area = triArea(P, a, b, c);
      if (!(area > 0)) continue;
      const ti = tris.length;
      total += area;
      tris.push({ a, b, c, cum: total });
      const us = [UV[a * 2], UV[b * 2], UV[c * 2]], vs = [UV[a * 2 + 1], UV[b * 2 + 1], UV[c * 2 + 1]];
      const x0 = cell(Math.min(...us), GRID), x1 = cell(Math.max(...us), GRID), y0 = cell(Math.min(...vs), GRID), y1 = cell(Math.max(...vs), GRID);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * GRID + x].push(ti);
    }
    if (tris.length) cards.push({ P, UV, tris, cells, GRID, stats, to: total }); // to: where its triangles end in the running area
  }
  if (!cards.length) return null;
  // The card surface at a texture point: where it is and which way it faces, or null when no triangle has that point.
  // Avaturn lays the same strand strips of the texture on many cards around the head, so one texture point is on
  // several of them: near is where the strand is now, and the point taken is the one on the card it's walking (the
  // nearest to it), never one across her head (taken first, 2026-11-16, the strands jumped across in long lines).
  // within: how far from near it may be, or it's off the end of this card.
  const at = (card, u, w, near = null, within = Infinity, startTri = -1) => {
    const list = startTri >= 0 ? [startTri] : card.cells[cell(w, card.GRID) * card.GRID + cell(u, card.GRID)];
    let best = null, bestD = within;
    for (const ti of list) {
      const { a, b, c } = card.tris[ti];
      const bc = barycentric(card.UV, a, b, c, u, w);
      if (!bc) continue;
      const p = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = card.P[a * 3 + k] * bc[0] + card.P[b * 3 + k] * bc[1] + card.P[c * 3 + k] * bc[2];
      const d = near ? Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]) : 0;
      if (d <= bestD) { best = { p, n: normal(card.P, a, b, c) }; bestD = d; if (!near) break; }
    }
    return best;
  };
  const size = box.getSize(new THREE.Vector3());
  const pts = segs + 1, MAX_WALK = 48;
  const rest = new Float32Array(count * pts * 3), rootN = new Float32Array(count * 3), seg = new Float32Array(count);
  const shade = new Float32Array(count), color = new Float32Array(count * 3);
  const step = size.y * 0.006; // how far apart (in the world) the walk looks the card up
  const walk = [];
  let made = 0;
  for (let tries = 0; made < count && tries < count * 40; tries++) {
    // A root: an area-weighted random point on a card, where its texture has hair.
    const r = Math.random() * total;
    const card = cards.find((k) => r <= k.to) ?? cards.at(-1);
    let lo = 0, hi = card.tris.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (card.tris[mid].cum < r) lo = mid + 1; else hi = mid; }
    const { a, b, c } = card.tris[lo];
    let p1 = Math.random(), p2 = Math.random();
    if (p1 + p2 > 1) { p1 = 1 - p1; p2 = 1 - p2; }
    const p0 = 1 - p1 - p2;
    const u = card.UV[a * 2] * p0 + card.UV[b * 2] * p1 + card.UV[c * 2] * p2;
    let w = card.UV[a * 2 + 1] * p0 + card.UV[b * 2 + 1] * p1 + card.UV[c * 2 + 1] * p2;
    if (card.stats.alpha(u, w) < 0.6) continue;
    // How much v moves per world unit here, so each step of the walk is about `step` long on the card.
    const dvPerUnit = 1 / Math.max(1e-6, dPdv(card.P, card.UV, a, b, c));
    const dv = step * dvPerUnit;
    walk.length = 0;
    const here = at(card, u, w, null, Infinity, lo); // the root is on the triangle it was picked from
    if (!here) continue;
    const rootNormal = here.n;
    walk.push(here.p);
    for (let i = 0; i < MAX_WALK; i++) {
      w += dv;
      if (card.stats.alpha(u, w) < 0.35) break; // the texture's strand ends here
      const next = at(card, u, w, walk.at(-1), step * 3);
      if (!next) break; // off the end of this card
      walk.push(next.p);
    }
    if (walk.length < 4) continue; // too short to be a strand
    // Lifted a hair's breadth off the card, so it lies on it rather than in it; resampled to evenly spaced points.
    const lift = size.y * (0.0015 + 0.004 * Math.random());
    const poly = walk.map((q) => [q[0] + rootNormal[0] * lift, q[1] + rootNormal[1] * lift, q[2] + rootNormal[2] * lift]);
    const lengths = [0];
    for (let i = 1; i < poly.length; i++) lengths.push(lengths[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1], poly[i][2] - poly[i - 1][2]));
    const len = lengths.at(-1);
    if (!(len > 0)) continue;
    let j = 0;
    for (let i = 0; i < pts; i++) {
      const d = (len * i) / segs;
      while (j < poly.length - 2 && lengths[j + 1] < d) j++;
      const f = Math.min(1, Math.max(0, (d - lengths[j]) / Math.max(1e-9, lengths[j + 1] - lengths[j])));
      for (let k = 0; k < 3; k++) rest[(made * pts + i) * 3 + k] = poly[j][k] + (poly[j + 1][k] - poly[j][k]) * f;
    }
    rootN.set(rootNormal, made * 3);
    seg[made] = len / segs;
    shade[made] = 0.8 + 0.4 * Math.random();
    color.set(card.stats.color(u, card.UV[a * 2 + 1] * p0 + card.UV[b * 2 + 1] * p1 + card.UV[c * 2 + 1] * p2), made * 3);
    made++;
  }
  if (!made) return null;
  return { count: made, rest: rest.subarray(0, made * pts * 3), rootN: rootN.subarray(0, made * 3), seg: seg.subarray(0, made), shade: shade.subarray(0, made), color: color.subarray(0, made * 3), size };
}

const cell = (x, n) => Math.min(n - 1, Math.max(0, Math.floor(x * n)));
function triArea(P, a, b, c) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
function normal(P, a, b, c) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}
// Barycentric weights of uv point (u, w) in triangle a b c (in the texture), or null when it's outside.
function barycentric(UV, a, b, c, u, w) {
  const x0 = UV[a * 2], y0 = UV[a * 2 + 1], x1 = UV[b * 2], y1 = UV[b * 2 + 1], x2 = UV[c * 2], y2 = UV[c * 2 + 1];
  const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(d) < 1e-12) return null;
  const l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (w - y2)) / d, l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (w - y2)) / d, l2 = 1 - l0 - l1;
  const e = -1e-5;
  return l0 >= e && l1 >= e && l2 >= e ? [l0, l1, l2] : null;
}
// How far the surface moves in the world as v grows by one, in triangle a b c.
function dPdv(P, UV, a, b, c) {
  const du1 = UV[b * 2] - UV[a * 2], dv1 = UV[b * 2 + 1] - UV[a * 2 + 1], du2 = UV[c * 2] - UV[a * 2], dv2 = UV[c * 2 + 1] - UV[a * 2 + 1];
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-12) return 1;
  const e1 = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), e2 = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
  const d = [0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) / det);
  return Math.hypot(...d);
}
