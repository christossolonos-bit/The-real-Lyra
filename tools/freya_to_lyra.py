# Freya (Blender, Rigify "Unity_Rig") -> Lyra. Dresses her in Lyra's series look, keeps her own face and hair,
# and saves two GLBs:
#   <out.glb>       teal long-sleeve top (to the collarbone), dark teal trousers, dark flats
#   <out_holo.glb>  the same with the cyan hologram glow built in (emissive)
# blender -b D:/Blend/Blend/Freya.blend --python tools/freya_to_lyra.py -- <out.glb> <out_holo.glb> <work folder>
import bpy, sys, os, numpy as np, mathutils

args = sys.argv[sys.argv.index('--') + 1:]
OUT, OUT_HOLO, WORK = args[0], args[1], args[2]
os.makedirs(WORK, exist_ok=True)

TEAL = np.array([0.059, 0.357, 0.420])   # Lyra's top (sRGB)
PANTS = np.array([0.078, 0.208, 0.239])  # her trousers
SHOES = np.array([0.09, 0.10, 0.11])     # dark flats
CYAN = np.array([0.247, 0.878, 1.0])
NECKLINE = 1.435                          # just below the collarbones: high neckline, no skin below
WAIST = 0.95                              # top meets trousers
ANKLE = 0.115                             # trousers meet shoes
ALPHA = ('Hair', 'Cap', 'Eyebrows', 'Eyelashes', 'Alpha')

# ---------- keep only her: the deform skeleton and the visible meshes ----------
for o in list(bpy.data.objects):
    # her corset and mini skirt go: Lyra wears a plain fitted top and trousers (painted on below)
    if o.name.startswith('WGT') or o.name in ('rig', 'metarig', 'Under', 'Top', 'Skirt') or o.type not in ('MESH', 'ARMATURE'):
        bpy.data.objects.remove(o)
rig = bpy.data.objects['Unity_Rig']
for o in bpy.data.objects:
    if o.type == 'MESH':
        for m in list(o.modifiers):
            if m.type == 'SUBSURF':
                o.modifiers.remove(m)

# ---------- the bone names Lyra's code knows (animation retarget, gaze, head-follow, jaw) ----------
RENAME = {'DEF-spine': 'bone_Root', 'DEF-spine.001': 'bone_SpineLow', 'DEF-spine.002': 'bone_EXP_C1_Spine2', 'DEF-spine.003': 'bone_Chest',
          'DEF-spine.004': 'bone_EXP_C1_Neck1', 'DEF-spine.006': 'bone_Head', 'DEF-jaw_master': 'bone_Jaw',
          'DEF-foot.L': 'bone_20', 'DEF-foot.R': 'bone_19'}
for s in 'LR':
    RENAME.update({f'DEF-shoulder.{s}': f'bone_Shoulder{s}', f'DEF-upper_arm.{s}': f'bone_Arm{s}', f'DEF-forearm.{s}': f'bone_Elbow{s}',
                   f'DEF-hand.{s}': f'bone_Hand{s}', f'DEF-f_middle.01.{s}': f'bone_MiddleFinger{s}', f'DEF-thumb.01.{s}': f'bone_Thumb{s}',
                   f'DEF-thigh.{s}': f'bone_EXP_{s}1_Leg1Twist1', f'DEF-shin.{s}': f'bone_EXP_{s}1_Leg2Twist1'})
for old, new in RENAME.items():
    b = rig.data.bones.get(old)
    if b:
        b.name = new
    else:
        print('missing bone', old)
W = lambda n: rig.matrix_world @ rig.data.bones[n].head_local


# ---------- texture helpers: edited textures become new images, swapped in ----------
def pix(img):
    return np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


def lum(a):
    return a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11


def save_new(img, a, suffix):
    h, w = a.shape[:2]
    alpha = any(k in img.name for k in ALPHA)
    new = bpy.data.images.new(img.name + suffix, w, h, alpha=True)
    new.colorspace_settings.name = img.colorspace_settings.name
    new.pixels.foreach_set(a.ravel())
    new.file_format = 'PNG' if alpha else 'JPEG'
    new.filepath_raw = os.path.join(WORK, (img.name + suffix).replace('.', '_').replace(' ', '_') + ('.png' if alpha else '.jpg'))
    new.save()
    return new


def swap(old, new):
    for m in bpy.data.materials:
        if m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image == old:
                    n.image = new


def base_node(mat):
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if not bsdf:
        return None
    def walk(sock, depth=0):
        for l in sock.links:
            n = l.from_node
            if n.type == 'TEX_IMAGE':
                return n
            if depth < 4:
                for inp in n.inputs:
                    r = walk(inp, depth + 1)
                    if r:
                        return r
        return None
    return walk(bsdf.inputs['Base Color'])


def raster(mask, tris_uv):
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
        mask[y0:y1 + 1, x0:x1 + 1] |= (l1 >= -0.03) & (l2 >= -0.03) & (1 - l1 - l2 >= -0.03)


def face_tris(obj, faces):
    uv = obj.data.uv_layers.active.data
    out = []
    for f in faces:
        L = [uv[i].uv[:] for i in f.loop_indices]
        for k in range(1, len(L) - 1):
            out.append((L[0], L[k], L[k + 1]))
    return out


def fabric(l, mean, base, lo=0.6, hi=0.5):
    k = np.clip(lo + hi * (l / max(mean, 1e-3)), 0.25, 1.5)[..., None]
    return np.clip(base[None, None, :] * k, 0, 1)


def recolour_mesh(name, colour, lo=0.6, hi=0.5):
    o = bpy.data.objects.get(name)
    if not o:
        return
    for slot in o.material_slots:
        node = slot.material and base_node(slot.material)
        if not node:
            # a plain colour, no image: set the colour itself (Blender colours are linear)
            bsdf = slot.material and slot.material.use_nodes and slot.material.node_tree.nodes.get('Principled BSDF')
            if bsdf:
                lin = np.where(colour <= 0.04045, colour / 12.92, ((colour + 0.055) / 1.055) ** 2.4)
                for l in list(bsdf.inputs['Base Color'].links):
                    slot.material.node_tree.links.remove(l)
                bsdf.inputs['Base Color'].default_value = (*lin, 1)
                print('recoloured (plain colour)', name)
            continue
        a = pix(node.image)
        l = lum(a)
        a[..., :3] = fabric(l, l[a[..., 3] > 0.1].mean() if (a[..., 3] > 0.1).any() else l.mean(), colour, lo, hi)
        swap(node.image, save_new(node.image, a, '_lyra'))
        print('recoloured', name)


# ---------- her skin becomes Lyra's clothes where the series outfit covers it ----------
body = bpy.data.objects['Body']
bw = body.matrix_world
node = base_node(body.material_slots[0].material)
a = pix(node.image)
L = lum(a)


def arm_t(p):
    s = 'L' if p.x > 0 else 'R'
    st, en = W(f'bone_Arm{s}'), W(f'bone_Hand{s}')
    d = en - st
    return (p - st).dot(d) / d.length_squared, (p - (st + d * max(0, min(1, (p - st).dot(d) / d.length_squared)))).length


top_f, cuff_f, pants_f, shoe_f = [], [], [], []
for f in body.data.polygons:
    p = bw @ f.center
    t, dist = arm_t(p)
    on_arm = dist < 0.07 and abs(p.x) > 0.16
    if on_arm:
        if t < 0.90:
            top_f.append(f)        # sleeve
        elif t < 0.95:
            cuff_f.append(f)       # cuff, then her hand stays skin
        continue
    if WAIST <= p.z < NECKLINE:
        top_f.append(f)
    elif ANKLE <= p.z < WAIST:
        pants_f.append(f)
    elif p.z < ANKLE:
        shoe_f.append(f)
masks = {}
for key, faces in (('top', top_f), ('cuff', cuff_f), ('pants', pants_f), ('shoe', shoe_f)):
    m = np.zeros(L.shape, bool)
    raster(m, face_tris(body, faces))
    masks[key] = m
skin_mean = L.mean()
out = a.copy()
out[..., :3] = np.where(masks['pants'][..., None], fabric(L, skin_mean, PANTS), out[..., :3])
out[..., :3] = np.where(masks['shoe'][..., None], fabric(L, skin_mean, SHOES, 0.7, 0.4), out[..., :3])
out[..., :3] = np.where(masks['top'][..., None], fabric(L, skin_mean, TEAL), out[..., :3])
out[..., :3] = np.where(masks['cuff'][..., None], fabric(L, skin_mean, TEAL * 0.8), out[..., :3])
swap(node.image, save_new(node.image, out, '_lyra'))
print(f'skin -> clothes: top {len(top_f)}, cuffs {len(cuff_f)}, trousers {len(pants_f)}, shoes {len(shoe_f)} faces')

# ---------- real clothes over the paint: a fitted top and trousers ----------
# Paint alone shows her sculpted anatomy through it. These garments are copies of her skin where the clothes go,
# smoothed (so they read as fabric, not anatomy) and lifted a few millimetres off the skin. They keep her skin
# weights, so they move exactly with her.
import bmesh


def garment(name, faces, colour, lift=0.005, smooth=25, drape=6):
    keep = {f.index for f in faces}
    me = body.data.copy()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = body.parent
    obj.matrix_parent_inverse = body.matrix_parent_inverse.copy()
    obj.matrix_world = body.matrix_world.copy()
    for g in body.vertex_groups:
        obj.vertex_groups.new(name=g.name)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    bm.to_mesh(me)
    bm.free()
    # smooth the shape (fabric, not anatomy), then lift it so every point sits at least `lift` OUTSIDE her
    # original skin (smoothing pulls curves inward, which would let the skin poke through)
    orig = [v.co.copy() for v in me.vertices]
    onorm = [v.normal.copy() for v in me.vertices]
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    sm = obj.modifiers.new('fabric', 'SMOOTH')
    sm.factor = 1.0
    sm.iterations = smooth
    bpy.ops.object.modifier_apply(modifier='fabric')
    me.update()
    for v, o0, n0 in zip(me.vertices, orig, onorm):
        inward = (o0 - v.co).dot(n0)  # how far smoothing pulled this point below the skin
        v.co += n0 * (max(0.0, inward) + lift)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    lin = np.where(colour <= 0.04045, colour / 12.92, ((colour + 0.055) / 1.055) ** 2.4)
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = 0.85
    me.materials.clear()
    me.materials.append(mat)
    arm = obj.modifiers.new('rig', 'ARMATURE')
    arm.object = rig
    print(f'garment {name}: {len(me.polygons)} faces')
    return obj


garment('LyraTop', top_f + cuff_f, TEAL, lift=0.008, smooth=140, drape=8)  # hangs like a sweater: no body contours
garment('LyraTrousers', pants_f, PANTS, lift=0.010, smooth=180, drape=8)  # trousers hang straight like fabric
if 'Stockings' in bpy.data.objects:
    bpy.data.objects.remove(bpy.data.objects['Stockings'])  # under the trousers now

# her own clothes take Lyra's colours (the corset becomes part of the teal top; skirt and stockings the trousers)
recolour_mesh('Top', TEAL)
recolour_mesh('Skirt', PANTS)
recolour_mesh('Stockings', PANTS)

# the corset is very dense: lighter for the web
top = bpy.data.objects.get('Top')
if top and len(top.data.polygons) > 12000:
    d = top.modifiers.new('lighter', 'DECIMATE')
    d.ratio = 12000 / len(top.data.polygons)
    bpy.context.view_layer.objects.active = top
    top.modifiers.move(top.modifiers.find('lighter'), 0)
    bpy.ops.object.modifier_apply(modifier='lighter')

# ---------- web weight: texture sizes, no maps the page doesn't use ----------
SIZE = {'Body': 2048, 'Hair': 2048, 'Cap': 1024, 'Eyes': 512, 'Mouth': 512, 'Eyebrows': 512, 'Eyelashes': 512, 'Normal': 1024,
        'Top': 1024, 'skirt': 1024, 'Skirt': 1024, 'Stockings': 1024, 'Roughness': 512}
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for n in list(m.node_tree.nodes):
        if n.type == 'TEX_IMAGE' and n.image and n.image.name != 'Render Result':
            try:
                _ = n.image.pixels[0]
            except Exception:
                continue
            w, h = n.image.size
            lim = min([v for k, v in SIZE.items() if k.lower() in n.image.name.lower()] or [1024])
            if w and max(w, h) > lim:
                tmp = n.image.copy()
                tmp.scale(max(1, int(w * lim / max(w, h))), max(1, int(h * lim / max(w, h))))
                swap(n.image, save_new(n.image, pix(tmp), '_web'))
                bpy.data.images.remove(tmp)


def export(path):
    # some of her objects live in hidden/excluded collections: bring them into the scene so they can be exported
    vl = bpy.context.view_layer
    for o in bpy.data.objects:
        if o.type in ('MESH', 'ARMATURE') and o.name not in vl.objects:
            bpy.context.scene.collection.objects.link(o)
        o.hide_viewport = False
        try:
            o.hide_set(False)
        except RuntimeError:
            pass
    vl.update()
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        o.select_set(o.type in ('MESH', 'ARMATURE'))
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=False,
                              export_skins=True, export_morph=True, export_image_format='AUTO', export_jpeg_quality=86,
                              export_yup=True, export_def_bones=False)
    print('exported', path)


export(OUT)

# ---------- hologram version: her shading becomes cyan light ----------
done = set()
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for slot in o.material_slots:
        m = slot.material
        if not m or m.name in done or not m.use_nodes:
            continue
        done.add(m.name)
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        if not bsdf:
            continue
        node = base_node(m)
        if node and node.image:
            a = pix(node.image)
            l = lum(a)
            c = CYAN[None, None, :] * np.clip(0.06 + 1.35 * l ** 1.2, 0, 1.4)[..., None]
            c = c + (np.array([0.85, 1, 1]) - c) * np.clip((l - 0.75) / 0.35, 0, 1)[..., None] * 0.35
            a[..., :3] = np.clip(c, 0, 1)
            holo = save_new(node.image, a, '_holo')
            node.image = holo
            m.node_tree.links.new(node.outputs[0], bsdf.inputs['Emission Color'])
        else:
            bsdf.inputs['Emission Color'].default_value = (*(CYAN * 0.4), 1)
        bsdf.inputs['Emission Strength'].default_value = 1.0
export(OUT_HOLO)
