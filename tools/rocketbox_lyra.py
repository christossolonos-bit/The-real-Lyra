# Lyra from Rocketbox: Sports_Female_01's body + Female_Adult_08's head, face shapes and hair, on one skeleton,
# dressed in Lyra's series look (teal long-sleeve top to the collarbone, dark teal trousers, dark flats). Saves:
#   <out.glb>       natural colours
#   <out_holo.glb>  the cyan hologram glow built in
# blender -b --python tools/rocketbox_lyra.py -- <out.glb> <out_holo.glb> <work folder>
import bpy, bmesh, os, sys, math, numpy as np
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
OUT, OUT_HOLO, WORK = args[0], args[1], args[2]
os.makedirs(WORK, exist_ok=True)
AV = r"D:/microsoft avatar and animations/Assets/Avatars"
BODY = (AV + "/Professions/Sports_Female_01", "Sports_Female_01")
HEAD = (AV + "/Adults/Female_Adult_08", "Female_Adult_08")

TEAL = np.array([0.059, 0.357, 0.420])
PANTS = np.array([0.078, 0.208, 0.239])
SHOES = np.array([0.09, 0.10, 0.11])
CYAN = np.array([0.247, 0.878, 1.0])
ALPHA = ('opacity',)

bpy.ops.wm.read_factory_settings(use_empty=True)


def imp(folder, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=f"{folder}/Export/{name}_facial.fbx")
    new = [o for o in bpy.data.objects if o not in before]
    tex = folder + "/Textures"
    for o in new:
        if o.type == "MESH":
            for m in o.data.materials:
                for n in m.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image:
                        p = os.path.join(tex, os.path.basename(n.image.filepath))
                        if os.path.exists(p):
                            n.image.filepath = p
                            n.image.reload()
    return next(o for o in new if o.type == "ARMATURE"), next(o for o in new if o.type == "MESH")


def keep_materials(obj, keep):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    names = [m.name for m in obj.data.materials]
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not any(k in names[f.material_index] for k in keep)], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


# ---------- her body (Sports_Female_01) with Adult_08's head and hair, one skeleton ----------
body_arm, body = imp(*BODY)
head_arm, head = imp(*HEAD)
keep_materials(body, ["_body"])
keep_materials(head, ["_head", "_opacity"])
head.parent = body_arm
for mod in head.modifiers:
    if mod.type == "ARMATURE":
        mod.object = body_arm
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
head.select_set(True)
bpy.context.view_layer.objects.active = head
bpy.ops.object.join()  # into the head, so its face shapes stay
lyra = head
lyra.name = "Lyra"
bpy.data.objects.remove(head_arm, do_unlink=True)
rig = body_arm
rig.name = "Lyra_Rig"
bm = bmesh.new()
bm.from_mesh(lyra.data)
bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v.is_boundary], dist=0.002)  # weld the neck seam
bm.to_mesh(lyra.data)
bm.free()

# (Rocketbox FBX is in centimetres under a scaled, turned armature: the glTF exporter handles that by itself;
# applying the transforms here broke the skinning)
bpy.context.view_layer.update()
W = lambda n: rig.matrix_world @ rig.data.bones[n].head_local
print('head at', [round(x, 3) for x in W('Bip01 Head')], 'feet at', [round(x, 3) for x in W('Bip01 L Foot')])

# ---------- the head: Rocketbox Adult_08, or the World of Warcraft human woman's face (Chris's pick) ----------
HEAD_MODE = os.environ.get('LYRA_HEAD', 'wow')
WOW_GLB = r"D:/Lyra Real AI/customizer/models/humanfemale_hd.glb"
WOW_PARTS = {'HeadSwap2', 'HeadSwap2.001', 'HeadSwap1', 'Ears2', 'Eyes1', 'Hair12'}  # her saved look: face 2, ears 2, hair 12
WOW_HAIR = np.array([0x7a, 0x45, 0x24]) / 255.0  # Lyra chestnut (sRGB), brightness 2, as in lyra_look.json
WOW_HAIR_BRIGHT = 1.45


def graft_wow_head():
    """Replace the Rocketbox head with the WoW human woman's face, ears, eyes and hair, sized and turned to fit,
    with her jaw and eyelid bones added under the Rocketbox head bone (so she can talk and blink)."""
    from mathutils import Matrix
    if lyra.data.shape_keys:
        lyra.shape_key_clear()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=WOW_GLB)
    new = [o for o in bpy.data.objects if o not in before]
    warm = next(o for o in new if o.type == 'ARMATURE')
    bpy.context.view_layer.update()
    WW = lambda n: warm.matrix_world @ warm.data.bones[n].head_local
    WT = lambda n: warm.matrix_world @ warm.data.bones[n].tail_local
    parts = [o for o in new if o.type == 'MESH' and o.name.replace('humanfemale_hd_', '') in WOW_PARTS]
    for o in [o for o in new if o.type == 'MESH' and o not in parts]:
        bpy.data.objects.remove(o)
    # WoW faces rest with the eyelids shut (her animations open them): pose the lids as in her Stand clip, bake it in
    LIDS = ['bone_EXP_L1_EyeLid1', 'bone_EXP_L1_EyeLid2', 'bone_EXP_R1_EyeLid1', 'bone_EXP_R1_EyeLid2']
    stand = next((a for a in bpy.data.actions if a.name.startswith('Stand')), None)
    if stand:
        warm.animation_data_create()
        warm.animation_data.action = None
        for pb in warm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0); pb.scale = (1, 1, 1)
        f0 = stand.frame_range[0]
        for fc in getattr(stand, 'fcurves', []) or []:
            bn = fc.data_path.split('"')[1] if '"' in fc.data_path else ''
            if bn in LIDS:
                pb = warm.pose.bones[bn]
                prop = fc.data_path.split('.')[-1]
                getattr(pb, prop)[fc.array_index] = fc.evaluate(f0)
        bpy.context.view_layer.update()
        for o in parts:
            bpy.context.view_layer.objects.active = o
            for x in bpy.context.view_layer.objects:
                x.select_set(x == o)
            for m in list(o.modifiers):
                if m.type == 'ARMATURE':
                    bpy.ops.object.modifier_apply(modifier=m.name)
        for pb in warm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
        bpy.context.view_layer.update()
        print('eyelids opened from', stand.name)
    else:
        print('no Stand clip found: eyelids stay as they are')
    # alignment: her eyes onto the Rocketbox eyes, same size (head-to-eyes distance), same facing
    eyes_w = (WW('bone_EXP_L1_Eye1') + WW('bone_EXP_R1_Eye1')) / 2
    eyes_r = (W('Bip01 LEye') + W('Bip01 REye')) / 2
    head_w, head_r = WW('bone_Head'), W('Bip01 Head')
    s = (eyes_r - head_r).length / (eyes_w - head_w).length
    fw, fr = (eyes_w - head_w), (eyes_r - head_r)
    fw.z = fr.z = 0
    yaw = math.atan2(fr.y, fr.x) - math.atan2(fw.y, fw.x)
    M = Matrix.Translation(eyes_r) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(s, 4) @ Matrix.Translation(-eyes_w)
    print(f'WoW head: scale {s:.3f}, turn {math.degrees(yaw):.0f} deg')
    face = next(o for o in parts if o.name.endswith('HeadSwap2.001'))
    chin = min((M @ (face.matrix_world @ v.co)).z for v in face.data.vertices)
    cut = chin + 0.015  # a little overlap under her jaw
    lmw = lyra.matrix_world
    names = [m.name for m in lyra.data.materials]
    bm = bmesh.new(); bm.from_mesh(lyra.data)
    gone = [f for f in bm.faces if '_opacity' in names[f.material_index] or
            ('_head' in names[f.material_index] and (lmw @ f.calc_center_median()).z > cut)]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(lyra.data); bm.free()
    print(f'Rocketbox head removed above z={cut:.3f} (her neck stays)')
    # new bones under the Rocketbox head: her jaw and eyelids (WoW names -> Lyra names)
    NEWB = {'bone_Jaw': 'wow_Jaw', 'bone_EXP_L1_EyeLid1': 'wow_LidL1', 'bone_EXP_L1_EyeLid2': 'wow_LidL2',
            'bone_EXP_R1_EyeLid1': 'wow_LidR1', 'bone_EXP_R1_EyeLid2': 'wow_LidR2'}
    inv = rig.matrix_world.inverted()
    bpy.context.view_layer.objects.active = rig
    for o in bpy.context.view_layer.objects:
        o.select_set(o == rig)
    bpy.ops.object.mode_set(mode='EDIT')
    for src, dst in NEWB.items():
        h, t = M @ WW(src), M @ WT(src)
        if (t - h).length < 0.005:
            t = h + (M.to_3x3() @ Vector((0, 0, 0.02))).normalized() * 0.02
        e = rig.data.edit_bones.new(dst)
        e.head, e.tail = inv @ h, inv @ t
        e.parent = rig.data.edit_bones['Bip01 Head']
    bpy.ops.object.mode_set(mode='OBJECT')
    # vertex weights: WoW bones -> Rocketbox bones (jaw and lids to the new bones, the rest to head/neck/chest)
    jaw_kids = {f'bone_{i}' for i in range(105, 113)}

    def target(n):
        if n == 'bone_Jaw' or n in jaw_kids: return 'wow_Jaw'
        if n in NEWB: return NEWB[n]
        if n.startswith('bone_EXP_C1_Neck'): return 'Bip01 Neck'
        if n == 'bone_Chest': return 'Bip01 Spine2'
        if n == 'bone_ShoulderL': return 'Bip01 L Clavicle'
        if n == 'bone_ShoulderR': return 'Bip01 R Clavicle'
        return 'Bip01 Head'
    for o in parts:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(M)
        idx = {g.index: g.name for g in o.vertex_groups}
        acc = []
        for v in o.data.vertices:
            d = {}
            for g in v.groups:
                t = target(idx[g.group])
                d[t] = d.get(t, 0) + g.weight
            acc.append(d)
        o.vertex_groups.clear()
        for t in {t for d in acc for t in d}:
            g = o.vertex_groups.new(name=t)
            for i, d in enumerate(acc):
                if t in d:
                    g.add([i], min(1.0, d[t]), 'REPLACE')
        # into the Rocketbox rig's space, skinned to it
        o.parent = rig
        o.matrix_parent_inverse = rig.matrix_world.inverted()
        o.modifiers.new('rig', 'ARMATURE').object = rig
    # materials: clear names, and her chestnut hair baked in (the WoW colour lives in the creator's shader otherwise)
    hair_done = set()
    for o in parts:
        for slot in o.material_slots:
            m = slot.material
            if not m:
                continue
            if m.name == 'texture-type-6':
                m.name = 'WoWHair'
            elif m.name == 'skin':
                m.name = 'WoWSkin'
            elif m.name == 'texture-type-19':
                m.name = 'WoWEyes'
            if m.name == 'WoWHair' and m.name not in hair_done:
                hair_done.add(m.name)
                nd = base_node(m)
                if nd:
                    a = pix(nd.image)
                    l = lum(a)
                    k = np.clip(l / 0.42, 0, 1.4)[..., None]
                    lin = np.where(WOW_HAIR <= 0.04045, WOW_HAIR / 12.92, ((WOW_HAIR + 0.055) / 1.055) ** 2.4)
                    c = lin * WOW_HAIR_BRIGHT * (0.28 + 0.95 * k)
                    a[..., :3] = np.clip(np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 1e-6, None), 1 / 2.4) - 0.055), 0, 1)
                    swap(nd.image, save_new(nd.image, a, '_chestnut'))
    bpy.data.objects.remove(warm)
    print('WoW head grafted:', [o.name for o in parts])


# ---------- face shapes: speech visemes, jaw, blinks, smiles ----------
KEEP_PREFIX = ('AA_VI_',)
KEEP = {'Basis', 'AK_09_EyeBlinkLeft', 'AK_10_EyeBlinkRight', 'AK_25_JawOpen', 'AK_32_MouthFunnel', 'AK_38_MouthPucker',
        'AK_44_MouthSmileLeft', 'AK_45_MouthSmileRight', 'AK_03_BrowInnerUp'}
for k in list(lyra.data.shape_keys.key_blocks):
    if k.name not in KEEP and not k.name.startswith(KEEP_PREFIX):
        lyra.shape_key_remove(k)
print('face shapes:', [k.name for k in lyra.data.shape_keys.key_blocks][1:])


# ---------- texture helpers ----------
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
    new.filepath_raw = os.path.join(WORK, (img.name + suffix).replace('.', '_') + ('.png' if alpha else '.jpg'))
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
    for l in bsdf.inputs['Base Color'].links:
        if l.from_node.type == 'TEX_IMAGE':
            return l.from_node
    return None


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


if HEAD_MODE == 'wow':
    graft_wow_head()

# ---------- where Lyra's clothes go, from her own skeleton ----------
NECKLINE = W('Bip01 Neck').z + 0.012   # up to the base of the neck: covers the collarbones (and the swimsuit straps)
WAIST = W('Bip01 Pelvis').z + 0.04     # the top meets the trousers
ANKLE = W('Bip01 L Foot').z + 0.03     # trousers meet the shoes
print(f'neckline {NECKLINE:.3f}  waist {WAIST:.3f}  ankle {ANKLE:.3f}')


def arm_t(p):
    s = 'L' if p.x > 0 else 'R'
    st, en = W(f'Bip01 {s} UpperArm'), W(f'Bip01 {s} Hand')
    d = en - st
    t = (p - st).dot(d) / d.length_squared
    return t, (p - (st + d * max(0, min(1, t)))).length


mw = lyra.matrix_world
mats = [m.name for m in lyra.data.materials]
_bimg = None


def bikini(f):
    """Is this face showing the pink swimsuit (by its texture colour at the face's centre)?"""
    global _bimg
    if _bimg is None:
        nd = base_node(lyra.data.materials[f.material_index])
        _bimg = pix(nd.image) if nd else np.zeros((1, 1, 4))
    uv = lyra.data.uv_layers.active.data
    u = np.mean([uv[i].uv[:] for i in f.loop_indices], axis=0)
    h, w = _bimg.shape[:2]
    r, g, b = _bimg[min(h - 1, int(u[1] * h)), min(w - 1, int(u[0] * w)), :3]
    return r > 0.45 and r - g > 0.22 and b > 0.25
from collections import Counter
used = Counter(f.material_index for f in lyra.data.polygons)
body_idx = max((i for i, n in enumerate(mats) if '_body' in n), key=lambda i: used.get(i, 0))  # the body that has faces (the sports body)
print('body material', mats[body_idx])
top_f, cuff_f, pants_f, shoe_f = [], [], [], []
for f in lyra.data.polygons:
    if f.material_index != body_idx:
        continue
    p = mw @ f.center
    t, dist = arm_t(p)
    if dist < 0.08 and abs(p.x) > 0.15:
        if t < 0.90:
            top_f.append(f)
        elif t < 0.95:
            cuff_f.append(f)
        continue
    if WAIST <= p.z < NECKLINE or (p.z >= WAIST and bikini(f)):  # bikini straps above the neckline become part of the top
        top_f.append(f)
    elif ANKLE <= p.z < WAIST:
        pants_f.append(f)
    elif p.z < ANKLE:
        shoe_f.append(f)

node = base_node(lyra.data.materials[body_idx])
a = pix(node.image)
L = lum(a)
masks = {}
for key, faces in (('top', top_f), ('cuff', cuff_f), ('pants', pants_f), ('shoe', shoe_f)):
    m = np.zeros(L.shape, bool)
    raster(m, face_tris(lyra, faces))
    masks[key] = m
mean = L.mean()
out = a.copy()
out[..., :3] = np.where(masks['pants'][..., None], fabric(L, mean, PANTS), out[..., :3])
out[..., :3] = np.where(masks['shoe'][..., None], fabric(L, mean, SHOES, 0.7, 0.4), out[..., :3])
out[..., :3] = np.where(masks['top'][..., None], fabric(L, mean, TEAL), out[..., :3])
out[..., :3] = np.where(masks['cuff'][..., None], fabric(L, mean, TEAL * 0.8), out[..., :3])
swap(node.image, save_new(node.image, out, '_lyra'))
print(f'painted: top {len(top_f)}, cuffs {len(cuff_f)}, trousers {len(pants_f)}, shoes {len(shoe_f)} faces')


# ---------- real garments over the paint: a fitted top and trousers that move with her ----------
def garment(name, faces, colour, lift=0.006, smooth=8, drape=3):
    keep = {f.index for f in faces}
    me = lyra.data.copy()
    if me.shape_keys:
        tmp = bpy.data.objects.new('tmp', me)
        bpy.context.scene.collection.objects.link(tmp)
        tmp.shape_key_clear()
        bpy.data.objects.remove(tmp)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = lyra.parent
    obj.matrix_world = lyra.matrix_world.copy()
    for g in lyra.vertex_groups:
        obj.vertex_groups.new(name=g.name)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
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
    inward = [max(0.0, (o0 - v.co).dot(n0)) for v, o0, n0 in zip(me.vertices, orig, onorm)]
    nbr = [[] for _ in me.vertices]
    for e in me.edges:
        a_, b_ = e.vertices
        nbr[a_].append(b_)
        nbr[b_].append(a_)
    d = inward[:]
    for _ in range(drape):
        d = [max([d[i]] + [d[j] for j in nbr[i]]) for i in range(len(d))]
    for _ in range(drape * 2):
        d = [0.5 * d[i] + 0.5 * (sum(d[j] for j in nbr[i]) / len(nbr[i]) if nbr[i] else d[i]) for i in range(len(d))]
    for v, n0, di, ii in zip(me.vertices, onorm, d, inward):
        v.co += n0 * (max(di, ii) + lift)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    lin = np.where(colour <= 0.04045, colour / 12.92, ((colour + 0.055) / 1.055) ** 2.4)
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = 0.85
    me.materials.clear()
    me.materials.append(mat)
    obj.modifiers.new('rig', 'ARMATURE').object = rig
    print(f'garment {name}: {len(me.polygons)} faces')


garment('LyraTop', top_f + cuff_f + [f for f in pants_f if (mw @ f.center).z > WAIST - 0.05], TEAL)  # overlaps the trousers at the waist
garment('LyraTrousers', pants_f, PANTS, lift=0.015, smooth=6, drape=3)  # loose enough that the skin never pokes through

# ---------- the bone names Lyra's code knows ----------
RENAME = {'Bip01 Pelvis': 'bone_Root', 'Bip01 Spine': 'bone_SpineLow', 'Bip01 Spine1': 'bone_EXP_C1_Spine2', 'Bip01 Spine2': 'bone_Chest',
          'Bip01 Neck': 'bone_EXP_C1_Neck1', 'Bip01 Head': 'bone_Head',
          ('wow_Jaw' if HEAD_MODE == 'wow' else 'Bip01 MJaw'): 'bone_Jaw', 'Bip01 L Foot': 'bone_20', 'Bip01 R Foot': 'bone_19'}
for s in 'LR':
    RENAME.update({f'Bip01 {s} Clavicle': f'bone_Shoulder{s}', f'Bip01 {s} UpperArm': f'bone_Arm{s}', f'Bip01 {s} Forearm': f'bone_Elbow{s}',
                   f'Bip01 {s} Hand': f'bone_Hand{s}', f'Bip01 {s} Finger2': f'bone_MiddleFinger{s}', f'Bip01 {s} Finger0': f'bone_Thumb{s}',
                   f'Bip01 {s} Thigh': f'bone_EXP_{s}1_Leg1Twist1', f'Bip01 {s} Calf': f'bone_EXP_{s}1_Leg2Twist1'})
for old, new in RENAME.items():
    b = rig.data.bones.get(old)
    if b:
        b.name = new
    else:
        print('missing bone', old)

# ---------- textures: web-sized new images (Rocketbox ships .tga) ----------
SIZE = {'_head_color': 2048, '_body_color': 2048, '_opacity': 2048, 'normal': 1024}
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for n in list(m.node_tree.nodes):
        if n.type != 'TEX_IMAGE' or not n.image:
            continue
        if 'specular' in n.image.name.lower():
            m.node_tree.nodes.remove(n)
            continue
        try:
            _ = n.image.pixels[0]
        except Exception:
            continue
        w, h = n.image.size
        lim = min([v for k, v in SIZE.items() if k in n.image.name.lower()] or [1024])
        img = n.image
        if w and max(w, h) > lim:
            tmp = img.copy()
            tmp.scale(int(w * lim / max(w, h)), int(h * lim / max(w, h)))
            swap(img, save_new(img, pix(tmp), '_web'))
            bpy.data.images.remove(tmp)
        elif img.filepath.lower().endswith('.tga'):
            swap(img, save_new(img, pix(img), '_web'))
for m in lyra.data.materials:
    if '_opacity' in m.name:
        m.blend_method = 'HASHED'


def export(path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        o.select_set(o.type in ('MESH', 'ARMATURE'))
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=False,
                              export_skins=True, export_morph=True, export_morph_normal=False, export_image_format='AUTO',
                              export_jpeg_quality=86, export_yup=True)
    print('exported', path)


export(OUT)

# ---------- hologram version ----------
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
        nd = base_node(m)
        if nd and nd.image:
            a = pix(nd.image)
            l = lum(a)
            c = CYAN[None, None, :] * np.clip(0.06 + 1.35 * l ** 1.2, 0, 1.4)[..., None]
            c = c + (np.array([0.85, 1, 1]) - c) * np.clip((l - 0.75) / 0.35, 0, 1)[..., None] * 0.35
            a[..., :3] = np.clip(c, 0, 1)
            nd.image = save_new(nd.image, a, '_holo')
            m.node_tree.links.new(nd.outputs[0], bsdf.inputs['Emission Color'])
        else:
            bsdf.inputs['Emission Color'].default_value = (*(CYAN * 0.4), 1)
        bsdf.inputs['Emission Strength'].default_value = 1.0
export(OUT_HOLO)
