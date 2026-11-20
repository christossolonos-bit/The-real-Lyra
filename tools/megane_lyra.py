# Dress Mégane as Lyra (series look) and save two GLBs:
#   lyra.glb           natural colours: teal long-sleeve top, dark teal trousers, dark shoes,
#                      chestnut hair (dark chocolate roots fading to caramel ends, like Lyra's reference)
#   lyra_hologram.glb  the same, with the cyan hologram glow built in (emissive), for any 3D viewer
# blender -b work/megane/megane.blend --python tools/megane_lyra.py -- <lyra.glb> <lyra_hologram.glb>
import bpy, sys, numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
OUT, OUT_HOLO = args[0], args[1]

# colours (Blender keeps colour-map pixels as sRGB values, so these are sRGB too)
TEAL = np.array([0.059, 0.357, 0.420])
PANTS = np.array([0.078, 0.208, 0.239])
SHOES = np.array([0.10, 0.11, 0.13])
ROOTS = np.array([0.13, 0.075, 0.045])  # dark chocolate at the roots
LENGTHS = np.array([0.30, 0.18, 0.10])  # warm chestnut brown
ENDS = np.array([0.50, 0.34, 0.20])     # soft caramel ends
ALPHA = ('Transparency', 'Eyelash', 'Occlusion', 'Tearline', 'Heels', 'Tongue')
CYAN = np.array([0.247, 0.878, 1.0])


def pix(img):
    return np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


import os
TEXDIR = os.path.join(os.path.dirname(OUT), '..', '..', 'work', 'megane', 'tex')
os.makedirs(TEXDIR, exist_ok=True)


def put(img, a):
    """Save edited pixels as a new image file and swap it in everywhere the old one is used.
    (Reallusion embeds its textures in the FBX: editing the packed original in place gets ignored on export.)"""
    h, w = a.shape[:2]
    alpha = any(k in img.name for k in ALPHA)
    new = bpy.data.images.new(img.name + '_lyra', w, h, alpha=True)
    new.colorspace_settings.name = img.colorspace_settings.name
    new.pixels.foreach_set(a.ravel())
    new.file_format = 'PNG' if alpha else 'JPEG'
    new.filepath_raw = os.path.join(TEXDIR, img.name.replace('.', '_') + ('.png' if alpha else '.jpg'))
    new.save()
    for m in bpy.data.materials:
        if m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image == img: n.image = new
    for k, v in img.items(): new[k] = v
    return new


def put_copy(img, a):
    """Like put(), but a separate new image (the original stays in use where it is)."""
    h, w = a.shape[:2]
    alpha = any(k in img.name for k in ALPHA)
    new = bpy.data.images.new(img.name + '_holo', w, h, alpha=True)
    new.colorspace_settings.name = img.colorspace_settings.name
    new.pixels.foreach_set(a.ravel())
    new.file_format = 'PNG' if alpha else 'JPEG'
    new.filepath_raw = os.path.join(TEXDIR, img.name.replace('.', '_') + ('_holo.png' if alpha else '_holo.jpg'))
    new.save()
    return new


def lum(a):
    return a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11


def raster(mask, tris_uv):
    """Mark the texture pixels covered by UV triangles."""
    h, w = mask.shape
    for t in tris_uv:
        p = np.array(t) * [w, h]
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
        x0, y0 = max(x0 - 1, 0), max(y0 - 1, 0)
        x1, y1 = min(x1 + 1, w - 1), min(y1 + 1, h - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        mask[y0:y1 + 1, x0:x1 + 1] |= (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)


def face_tris(obj, faces):
    uv = obj.data.uv_layers.active.data
    out = []
    for f in faces:
        L = [uv[i].uv[:] for i in f.loop_indices]
        for k in range(1, len(L) - 1):
            out.append((L[0], L[k], L[k + 1]))
    return out


def base_image(mat):
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links):
            return n
    return None


def fabric(l, mean, base, lo=0.55, hi=0.6):
    """A flat fabric colour that keeps the original's folds and shading."""
    k = np.clip(lo + hi * (l / max(mean, 1e-3)), 0.25, 1.6)[..., None]
    return np.clip(base[None, None, :] * k, 0, 1)


rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')


def bone_pos(n):
    return rig.matrix_world @ rig.data.bones[n].head_local


# ---------- top (teal) and trousers (dark teal): one shared texture, split by what each face shows ----------
cloth = bpy.data.objects['Pants_Shirt_Aesthetician']
img = base_image(cloth.material_slots[0].material).image
a = pix(img)
L = lum(a)
uvd = cloth.data.uv_layers.active.data
h, w = L.shape
shirt_f, pants_f = [], []
for f in cloth.data.polygons:
    u = np.mean([uvd[i].uv[:] for i in f.loop_indices], axis=0)
    bright = L[min(h - 1, int(u[1] * h)), min(w - 1, int(u[0] * w))] > 0.35  # the original top is white, the trousers black
    (shirt_f if bright else pants_f).append(f)
shirt_m = np.zeros(L.shape, bool)
pants_m = np.zeros(L.shape, bool)
raster(shirt_m, face_tris(cloth, shirt_f))
raster(pants_m, face_tris(cloth, pants_f))
out = a.copy()
if pants_m.any():
    out[..., :3] = np.where(pants_m[..., None], fabric(L, L[pants_m].mean(), PANTS, 0.6, 0.5), out[..., :3])
if shirt_m.any():
    out[..., :3] = np.where(shirt_m[..., None], fabric(L, L[shirt_m].mean(), TEAL), out[..., :3])
put(img, out)
mw = cloth.matrix_world
front = [mw @ cloth.data.vertices[i].co for f in shirt_f for i in f.vertices]
neck_z = max(p.z for p in front if abs(p.x) < 0.03 and p.y < 0.0)
print(f'top: {len(shirt_f)} faces, trousers: {len(pants_f)} faces, neckline z={neck_z:.3f}')

# ---------- long sleeves: her arm skin becomes teal fabric down to the wrists, with a cuff ----------
body = bpy.data.objects['CC_Base_Body']
bw = body.matrix_world


def arm_t(p):
    side = 'L' if p.x > 0 else 'R'
    s, e = bone_pos(f'bone_Arm{side}'), bone_pos(f'bone_Hand{side}')
    d = e - s
    return (p - s).dot(d) / d.length_squared


index = {m.name: i for i, m in enumerate(body.data.materials)}
for mname, rule in (('Std_Skin_Arm', 'arm'), ('Std_Skin_Body', 'torso')):
    img = base_image(body.data.materials[mname]).image
    a = pix(img)
    Lm = lum(a)
    sleeve = np.zeros(Lm.shape, bool)
    cuff = np.zeros(Lm.shape, bool)
    fs, cs = [], []
    for f in body.data.polygons:
        if f.material_index != index[mname]:
            continue
        p = bw @ f.center
        if rule == 'arm':
            t = arm_t(p)
            if t < 0.955:
                (cs if t > 0.92 else fs).append(f)
        elif 1.0 < p.z < neck_z - 0.005:
            fs.append(f)  # shoulders and upper chest the sleeveless top leaves bare, up to its neckline
    raster(sleeve, face_tris(body, fs))
    raster(cuff, face_tris(body, cs))
    mean = Lm[sleeve].mean() if sleeve.any() else 0.5
    out = a.copy()
    out[..., :3] = np.where(sleeve[..., None], fabric(Lm, mean, TEAL, 0.7, 0.35), out[..., :3])
    out[..., :3] = np.where(cuff[..., None], fabric(Lm, mean, TEAL * 0.8, 0.7, 0.35), out[..., :3])
    put(img, out)
    print(f'{mname}: {len(fs)} sleeve faces, {len(cs)} cuff faces')

# ---------- shoes ----------
img = base_image(bpy.data.objects['High_Heels'].material_slots[0].material).image
a = pix(img)
Ls = lum(a)
a[..., :3] = fabric(Ls, max(Ls.mean(), 0.05), SHOES, 0.5, 0.6)
put(img, a)

# ---------- hair: dark chocolate roots, warm chestnut lengths, caramel ends ----------
# Her hair cards run down the texture: roots at the top rows, tips at the bottom.
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for slot in o.material_slots:
        m = slot.material
        if not m or not any(k in m.name for k in ('Hair_Transparency', 'BabyHair')):
            continue
        node = base_image(m)
        if not node or node.image.get('lyra_done'):
            continue
        img = node.image
        a = pix(img)
        Lh = lum(a)
        # Blender's first pixel row is the bottom of the image (the tips); the last row is the top (the roots)
        t = np.linspace(1.0, 0.0, a.shape[0])[:, None, None]  # 0 at the roots, 1 at the tips
        col = np.where(t < 0.5, ROOTS + (LENGTHS - ROOTS) * np.clip(t / 0.5, 0, 1),
                       LENGTHS + (ENDS - LENGTHS) * np.clip((t - 0.5) / 0.5, 0, 1))
        k = np.clip(0.55 + 0.6 * (Lh / max(Lh.mean(), 1e-3)) ** 0.7, 0.35, 1.25)[..., None]  # strand detail kept
        a[..., :3] = np.clip(col * k, 0, 1)
        img = put(img, a)
        img['lyra_done'] = True
print('hair: chocolate roots to caramel ends')

# ---------- web weight: no specular maps (the page doesn't use them), smaller normal maps, JPEG where no alpha ----------
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for slot in o.material_slots:
        m = slot.material
        if not m:
            continue
        for n in list(m.node_tree.nodes):
            if n.type == 'TEX_IMAGE' and n.image and 'Specular' in n.image.name:
                m.node_tree.nodes.remove(n)
# texture sizes: big where you look (face, clothes, hair), small where you can't see much
SIZE = {'Std_Skin_Head_Diffuse': 2048, 'pants_shirt': 2048, 'Hair_Transparency': 2048, 'Std_Skin_Arm_Diffuse': 1024,
        'Std_Skin_Body_Diffuse': 1024, 'Std_Skin_Leg_Diffuse': 512, 'Std_Nails': 256, 'Std_Eyelash': 512, 'Std_Tongue': 256,
        'Teeth': 512, 'BabyHair': 1024, 'Scalp': 512, 'High_Heels': 512, 'Normal': 1024}
for img in list(bpy.data.images):
    try: _ = img.pixels[0]  # load embedded textures before reading their size
    except Exception: continue
    if img.size[0] == 0: continue
    lim = min([v for k, v in SIZE.items() if k in img.name] or [2048])
    w, h = img.size
    if max(w, h) > lim and img.users:
        tmp = img.copy(); tmp.scale(max(1, int(w * lim / max(w, h))), max(1, int(h * lim / max(w, h))))
        put(img, pix(tmp)); bpy.data.images.remove(tmp)


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=False, export_skins=True,
                              export_morph=True, export_morph_normal=False, export_image_format='AUTO',
                              export_jpeg_quality=86, export_yup=True)
    print('exported', path)


export(OUT)

# ---------- the hologram version: her own shading becomes cyan light (emissive) on a near-black base ----------
done = set()
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for slot in o.material_slots:
        m = slot.material
        if not m or m.name in done:
            continue
        done.add(m.name)
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        if not bsdf:
            continue
        node = base_image(m)
        if node:
            src = node.image
            a = pix(src)
            l = lum(a)
            c = CYAN[None, None, :] * np.clip(0.06 + 1.35 * l ** 1.2, 0, 1.4)[..., None]
            c = c + (np.array([0.85, 1, 1]) - c) * np.clip((l - 0.75) / 0.35, 0, 1)[..., None] * 0.35  # bright -> white
            a[..., :3] = np.clip(c, 0, 1)
            holo = put_copy(src, a)
            em = m.node_tree.nodes.new('ShaderNodeTexImage')
            em.image = holo
            m.node_tree.links.new(em.outputs[0], bsdf.inputs['Emission Color'])
            m.node_tree.links.new(em.outputs[0], bsdf.inputs['Base Color'])
            bsdf.inputs['Emission Strength'].default_value = 1.0
        else:
            bsdf.inputs['Emission Color'].default_value = (*(CYAN * 0.4), 1)
            bsdf.inputs['Emission Strength'].default_value = 1.0
export(OUT_HOLO)
