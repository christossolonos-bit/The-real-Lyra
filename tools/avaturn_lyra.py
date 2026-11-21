# Lyra from an Avaturn / Ready Player Me style avatar (Chris's pick: baked character #5, the teal dress).
# Keeps her exactly as she looks, renames her main bones to the names Lyra's code uses (so the Rocketbox motion
# library drives her), drops the 421 baked animations (20 MB), keeps her face shapes (talking, blinking), and saves:
#   <out.glb>       her natural look
#   <out_holo.glb>  the cyan hologram glow built in
# blender -b --python tools/avaturn_lyra.py -- <avatar.glb> <out.glb> <out_holo.glb> <work folder>
import bpy, sys, os, numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, OUT_HOLO, WORK = args[:4]
os.makedirs(WORK, exist_ok=True)
CYAN = np.array([0.247, 0.878, 1.0])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
if rig.animation_data:
    rig.animation_data.action = None
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
for pb in rig.pose.bones:
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.location = (0, 0, 0)
    pb.scale = (1, 1, 1)

RENAME = {'Hips': 'bone_Root', 'Spine': 'bone_SpineLow', 'Spine1': 'bone_EXP_C1_Spine2', 'Spine2': 'bone_Chest',
          'Neck': 'bone_EXP_C1_Neck1', 'Head': 'bone_Head', 'LeftFoot': 'bone_20', 'RightFoot': 'bone_19'}
for side, s in (('Left', 'L'), ('Right', 'R')):
    RENAME.update({f'{side}Shoulder': f'bone_Shoulder{s}', f'{side}Arm': f'bone_Arm{s}', f'{side}ForeArm': f'bone_Elbow{s}',
                   f'{side}Hand': f'bone_Hand{s}', f'{side}HandMiddle1': f'bone_MiddleFinger{s}', f'{side}HandThumb1': f'bone_Thumb{s}',
                   f'{side}UpLeg': f'bone_EXP_{s}1_Leg1Twist1', f'{side}Leg': f'bone_EXP_{s}1_Leg2Twist1'})
for old, new in RENAME.items():
    b = rig.data.bones.get(old)
    if b:
        b.name = new
    else:
        print('missing bone', old)
bpy.context.view_layer.update()
H = rig.matrix_world @ rig.data.bones['bone_Head'].head_local
print('head at', [round(x, 3) for x in H])
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        print('SHAPES', o.name, [k.name for k in o.data.shape_keys.key_blocks][1:])


def pix(img):
    return np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


# ---------- Lyra's series outfit (Chris, 2026-11-20): teal long-sleeve top, dark teal trousers, dark shoes ----------
# The avatar carries a hidden default outfit (jacket over a top, trousers) made for her body. It replaces the dress
# and is recoloured: the jacket and the top under it teal (the top a touch lighter), the trousers dark teal.
# LYRA_OUTFIT=plain (default) her plain series top; =jacket the recoloured jacket; =original the avatar's own clothes.
import bmesh
TEAL, PANTS, SHOES = np.array([0.059, 0.357, 0.420]), np.array([0.078, 0.208, 0.239]), np.array([0.09, 0.10, 0.11])


def raster(mask, tris_uv):
    h, w = mask.shape
    for t in tris_uv:
        p = np.array(t) * [w, h]
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
        x0, y0, x1, y1 = max(x0 - 1, 0), max(y0 - 1, 0), min(x1 + 1, w - 1), min(y1 + 1, h - 1)
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


def recolour(obj, groups):
    """groups: [(faces, colour, lo, hi)]: paint each group's part of the texture in that colour, keeping its shading."""
    mat = obj.material_slots[0].material
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    node = next(l.from_node for l in bsdf.inputs['Base Color'].links if l.from_node.type == 'TEX_IMAGE')
    a = pix(node.image)
    lum = a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11
    uv = obj.data.uv_layers.active.data
    out = a.copy()
    for faces, colour, lo, hi in groups:
        m = np.zeros(lum.shape, bool)
        raster(m, [(L[0], L[k], L[k + 1]) for f in faces for L in [[uv[i].uv[:] for i in f.loop_indices]] for k in range(1, len(L) - 1)])
        if not m.any():
            continue
        k = np.clip(lo + hi * (lum / max(lum[m].mean(), 1e-3)), 0.3, 1.6)[..., None]
        out[..., :3] = np.where(m[..., None], np.clip(colour[None, None, :] * k, 0, 1), out[..., :3])
    h, w = out.shape[:2]
    img = bpy.data.images.new(node.image.name + '_lyra', w, h, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.file_format = 'JPEG'
    img.filepath_raw = os.path.join(WORK, f'{obj.name}_lyra.jpg')
    img.save()
    node.image = img


OUTFIT = os.environ.get('LYRA_OUTFIT', 'plain')  # plain (her series look) | jacket | original
# the outfit's pieces (connected parts of avaturn_look_0, in mesh order); the plain top drops the tailoring
COLLARS = {7, 8, 9, 11, 12, 15, 16, 31, 39, 51}
LAPELS = {32, 33, 40, 41, 49, 50}
BELT = {0, 1, 2, 3, 4, 5, 6, 20, 21, 22, 23}
TAILS = {24, 25, 28, 42, 43, 44, 46, 47}
TROUSERS = {18, 19}


def islands(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, stack = [], [f]
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g.index)
            for e in g.edges:
                for n in e.link_faces:
                    if n.index not in seen:
                        seen.add(n.index)
                        stack.append(n)
        out.append(isl)
    bm.free()
    return out


if OUTFIT != 'original':
    look = bpy.data.objects.get('avaturn_look_0')
    if look:
        if look.name not in bpy.context.view_layer.objects:
            bpy.context.scene.collection.objects.link(look)
        look.hide_viewport = False
        look.hide_set(False)
        look.hide_render = False
        for o in [o for o in bpy.data.objects if o.name.startswith('Wardrobe_')]:
            bpy.data.objects.remove(o)  # the dress goes
        isl = islands(look)
        assert len(isl) == 52 and len(look.data.polygons) == 8909, 'not the avatar this was made for'
        hips = (rig.matrix_world @ rig.data.bones['bone_Root'].head_local).z
        if OUTFIT == 'plain':
            # Lyra's plain top (Chris, 2026-11-20: "strip these clothes off her and put the Lyra hologram clothes on her"):
            # no collar, lapels, belt or jacket tails; the rest of the jacket and shirt becomes one fitted long-sleeve top,
            # ending just below the waist, over the trousers (which start at 1.18 m)
            drop = {i for k in COLLARS | LAPELS | BELT | TAILS for i in isl[k]}
            waist = hips + 0.11
            for k, faces in enumerate(isl):
                if k not in TROUSERS:
                    drop |= {i for i in faces if (look.matrix_world @ look.data.polygons[i].center).z < waist}
            bm = bmesh.new()
            bm.from_mesh(look.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[i] for i in sorted(drop)], context='FACES')
            bm.to_mesh(look.data)
            bm.free()
            look.data.update()
            # after the delete, sort again by piece: whatever is left of the trousers vs the top
            isl2 = islands(look)
            low = [k for k, f in enumerate(isl2) if min((look.matrix_world @ look.data.polygons[i].center).z for i in f) < 0.5]
            P = look.data.polygons
            tro = [P[i] for k in low for i in isl2[k]]
            top = [P[i] for k, f in enumerate(isl2) if k not in low for i in f]
            # flat colours, the cloth's own creases kept faintly (buttons and seams fade out); each piece is evened out
            # on its own (the shirt fabric is much lighter than the jacket's), so the whole top is one teal
            recolour(look, [(tro, PANTS, 0.7, 0.35)] + [([P[i] for i in f], TEAL, 0.85, 0.18) for k, f in enumerate(isl2) if k not in low])
            print(f'Lyra plain outfit: top {len(top)} faces, trousers {len(tro)} faces, dropped {len(drop)}')
        else:
            top = [i for k, f in enumerate(isl) if k not in TROUSERS for i in f]
            tro = [i for k in TROUSERS for i in isl[k]]
            polys = look.data.polygons
            recolour(look, [([polys[i] for i in tro], PANTS, 0.6, 0.5), ([polys[i] for i in top], TEAL, 0.55, 0.6)])
            print(f'Lyra jacket outfit: jacket and top {len(top)} faces, trousers {len(tro)} faces')
    shoes = bpy.data.objects.get('avaturn_shoes_0')
    if shoes and shoes.name in bpy.context.view_layer.objects:
        recolour(shoes, [(list(shoes.data.polygons), SHOES, 0.5, 0.6)])


# ---------- a body inside her clothes (Chris, 2026-11-21: "add the athlete girl inside as a body") ----------
# Avaturn removes the skin the outfit covers, so she's hollow from the chest to the knees. Rocketbox's Sports_Female_01
# fills it: only her torso and thighs (Lyra's own head, arms and lower legs stay), lined up to Lyra's hips, knees and
# neck, pushed in wherever it would poke through the clothes, moving with the clothes' bone weights, a plain dark teal.
ATHLETE = os.environ.get('LYRA_FILL', r'D:/microsoft avatar and animations/Assets/Avatars/Professions/Sports_Female_01/Export/Sports_Female_01.fbx')
look = bpy.data.objects.get('avaturn_look_0')
if OUTFIT != 'original' and look and os.path.exists(ATHLETE):
    from mathutils import Vector, kdtree
    from mathutils.bvhtree import BVHTree
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=ATHLETE)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    src = next(o for o in new if o.type == 'MESH')
    bpy.context.view_layer.update()
    bz = lambda n: (arm.matrix_world @ arm.data.bones[n].head_local).z
    lz = lambda n: (rig.matrix_world @ rig.data.bones[n].head_local).z
    # athlete heights -> Lyra heights, in pieces: ground, knee, hips, neck
    A = [0.0, bz('Bip01 L Calf'), bz('Bip01 Pelvis'), bz('Bip01 Neck')]
    L = [0.0, lz('bone_EXP_L1_Leg2Twist1'), lz('bone_Root'), lz('bone_EXP_C1_Neck1')]
    mz = lambda z: float(np.interp(z, A, L, left=0.0, right=L[-1] + (z - A[-1]) * (L[-1] - L[-2]) / (A[-1] - A[-2])))
    me = src.data.copy()
    me.transform(src.matrix_world)
    toes = [v.co.y for v in me.vertices if v.co.z < 0.04]
    flip = sum(toes) / len(toes) > 0  # Lyra faces -y
    for v in me.vertices:
        x, y, z = v.co
        if flip:
            x, y = -x, -y
        v.co = Vector((x, y, mz(z)))
    for o in new:
        bpy.data.objects.remove(o)
    # only the torso and thighs
    knee, neck = L[1], L[3]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    gone = [v for v in bm.verts if v.co.z < knee - 0.04 or v.co.z > neck - 0.07 or abs(v.co.x) > 0.205]  # her own skin covers the shoulders and upper chest  # wider than her hips: the athlete's arms and hands
    bmesh.ops.delete(bm, geom=gone, context='VERTS')
    bm.to_mesh(me)
    bm.free()
    # inside the clothes: wherever it reaches the fabric, it moves 8 mm under it
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    cl = look.evaluated_get(dg)
    cm = cl.to_mesh()
    cm.transform(look.matrix_world)
    bvh = BVHTree.FromPolygons([v.co.copy() for v in cm.vertices], [tuple(p.vertices) for p in cm.polygons])
    pushed = 0
    for v in me.vertices:
        hit, nrm, _, dist = bvh.find_nearest(v.co)
        if hit is None:
            continue
        if nrm.dot(v.co - hit) > -0.012 and dist < 0.08:
            v.co = hit - nrm * 0.012
            pushed += 1
    cl.to_mesh_clear()
    # a copy of the clothes object (same rig binding, which the exporter keeps), with the body's shape swapped in;
    # the shape is in world space, so it goes into the clothes' own space first
    me.transform(look.matrix_world.inverted())
    fill = look.copy()
    fill.name = 'LyraFill'
    fill.data = me
    for c in look.users_collection:
        c.objects.link(fill)
    # the athlete's own bone groups (Bip01 ...) go; Lyra's clothes' groups take their places, in the same order
    fill.vertex_groups.clear()
    for vg in look.vertex_groups:
        fill.vertex_groups.new(name=vg.name)
    # each vertex moves like the nearest point of the clothes, leaving out the sleeves (the body has no arms; a sleeve's
    # weights would drag the armpits down with her hands)
    import re
    armish = {vg.index for vg in look.vertex_groups if re.search(r'Arm|Elbow|Hand|Finger|Thumb|Index|Ring|Pinky|Middle', vg.name)}
    # and the legs only from the trousers (the top's hem follows the hips, not the thighs)
    def tree(vs):
        t = kdtree.KDTree(len(vs))
        for v in vs:
            t.insert(look.matrix_world @ v.co, v.index)
        t.balance()
        return t
    torso = [v for v in look.data.vertices if sum(g.weight for g in v.groups if g.group in armish) < 0.05]
    legs = tree([v for v in torso if (look.matrix_world @ v.co).z < L[2] + 0.09])  # the top is cut above this
    body = tree(torso)
    for v in me.vertices:
        w = look.matrix_world @ v.co
        _, i, _ = (legs if w.z < L[2] else body).find(w)
        for g in look.data.vertices[i].groups:
            fill.vertex_groups[g.group].add([v.index], g.weight, 'REPLACE')
    me.materials.clear()
    m = bpy.data.materials.new('LyraFill')
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*PANTS, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    me.materials.append(m)
    for p in me.polygons:
        p.material_index = 0
    print(f'Lyra body inside: {len(me.vertices)} vertices, {pushed} pushed under the clothes')


def export(path):
    # only what she actually wears: the avatar also carries hidden default clothes (outside the view layer)
    vl = bpy.context.view_layer
    bpy.ops.object.select_all(action='DESELECT')
    for o in vl.objects:
        o.select_set(o.type in ('MESH', 'ARMATURE') and o.visible_get())
    print('exporting', [o.name for o in vl.objects if o.select_get() and o.type == 'MESH'])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=False,
                              export_skins=True, export_morph=True, export_morph_normal=False, export_image_format='AUTO',
                              export_jpeg_quality=88, export_yup=True)
    print('exported', path, round(os.path.getsize(path) / 1e6, 1), 'MB')


export(OUT)

# ---------- hologram version: her shading becomes cyan light (emissive) ----------
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
        link = next(iter(bsdf.inputs['Base Color'].links), None)
        nd = link.from_node if link and link.from_node.type == 'TEX_IMAGE' else None
        if nd and nd.image:
            a = pix(nd.image)
            l = a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11
            c = CYAN[None, None, :] * np.clip(0.06 + 1.35 * l ** 1.2, 0, 1.4)[..., None]
            c = c + (np.array([0.85, 1, 1]) - c) * np.clip((l - 0.75) / 0.35, 0, 1)[..., None] * 0.35
            a[..., :3] = np.clip(c, 0, 1)
            h, w = a.shape[:2]
            holo = bpy.data.images.new(nd.image.name + '_holo', w, h, alpha=True)
            holo.pixels.foreach_set(a.ravel())
            holo.file_format = 'PNG'
            holo.filepath_raw = os.path.join(WORK, (nd.image.name + '_holo').replace('.', '_') + '.png')
            holo.save()
            nd.image = holo
            m.node_tree.links.new(nd.outputs[0], bsdf.inputs['Emission Color'])
        else:
            bsdf.inputs['Emission Color'].default_value = (*(CYAN * 0.4), 1)
        bsdf.inputs['Emission Strength'].default_value = 1.0
export(OUT_HOLO)
