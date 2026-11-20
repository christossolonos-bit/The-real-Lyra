# A Reallusion Character Creator (CC3/CC4) character -> Lyra's body, exactly as she looks (no recolouring).
# Saves two GLBs:
#   <out.glb>        her natural look
#   <out_holo.glb>   the same with the cyan hologram glow built in (emissive), for any 3D viewer
# blender -b --python tools/cc_to_lyra.py -- <character.fbx> <textures folder> <out.glb> <out_holo.glb> [<work folder>]
#
# What it does: stands her up (some CC exports are Y-up), links the loose textures by name, renames her main bones to
# the names Lyra's animation code uses, keeps only the face shapes for talking/blinking/smiling, removes underwear
# hidden under clothes, shrinks the textures for the web, and exports.
import bpy, sys, os, math, numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
FBX, TEXDIR, OUT, OUT_HOLO = args[:4]
WORK = args[4] if len(args) > 4 else os.path.join(os.path.dirname(OUT), 'cc_work')
os.makedirs(WORK, exist_ok=True)
ALPHA = ('Transparency', 'Eyelash', 'Occlusion', 'Tearline', 'Heels', 'Tongue', 'Cornea')
CYAN = np.array([0.247, 0.878, 1.0])
HAIR_BROWN = np.array([0.34, 0.19, 0.11])  # warm brown, as in the reference picture (sRGB)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=FBX, use_image_search=False)
# some CC exports are Y-up but don't say so: if she comes in lying down, import again telling Blender the file is Y-up
def lying():
    bpy.context.view_layer.update()
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    head = next((b for b in rig.data.bones if b.name.endswith('_Head')), None) if rig else None
    return head and abs((rig.matrix_world @ head.head_local).z) < 0.8
if lying():
    # this export turns the skeleton 90 degrees one way and every mesh 90 degrees back, so at rest she looks fine but her
    # bones lie flat (animations would bend her sideways). Clearing both turns leaves skeleton and mesh upright, matching.
    for o in bpy.data.objects:
        if o.type in ('ARMATURE', 'MESH'):
            o.rotation_euler = (0, 0, 0)
    print('skeleton and mesh straightened; standing now:', not lying())

# ---------- textures: link the loose files by name (Name_Diffuse.png, Name_Normal.png ...) ----------
files = {os.path.splitext(f)[0].lower(): os.path.join(TEXDIR, f) for f in os.listdir(TEXDIR)} if os.path.isdir(TEXDIR) else {}
for img in bpy.data.images:
    key = img.name.split('.')[0].lower()
    if key in files and (img.size[0] == 0 or not img.has_data):
        img.filepath = files[key]
        img.reload()

bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# ---------- bone names Lyra's code knows (retarget, gaze, head-follow, jaw) ----------
RENAME = {
    'CC_Base_Hip': 'bone_Root', 'CC_Base_Waist': 'bone_SpineLow', 'CC_Base_Spine01': 'bone_EXP_C1_Spine2', 'CC_Base_Spine02': 'bone_Chest',
    'CC_Base_NeckTwist01': 'bone_EXP_C1_Neck1', 'CC_Base_Head': 'bone_Head', 'CC_Base_JawRoot': 'bone_Jaw',
    'CC_Base_L_Foot': 'bone_20', 'CC_Base_R_Foot': 'bone_19',
}
for s in 'LR':
    RENAME.update({f'CC_Base_{s}_Clavicle': f'bone_Shoulder{s}', f'CC_Base_{s}_Upperarm': f'bone_Arm{s}', f'CC_Base_{s}_Forearm': f'bone_Elbow{s}',
                   f'CC_Base_{s}_Hand': f'bone_Hand{s}', f'CC_Base_{s}_Mid1': f'bone_MiddleFinger{s}', f'CC_Base_{s}_Thumb1': f'bone_Thumb{s}',
                   f'CC_Base_{s}_Thigh': f'bone_EXP_{s}1_Leg1Twist1', f'CC_Base_{s}_Calf': f'bone_EXP_{s}1_Leg2Twist1'})
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for old, new in RENAME.items():
    b = rig.data.bones.get(old)
    if b:
        b.name = new
    else:
        print('missing bone', old)

for o in list(bpy.data.objects):
    if o.type == 'MESH' and o.name.startswith('Underwear'):
        bpy.data.objects.remove(o)

# ---------- face shapes: talking (both CC3 "Open" and CC4 "V_Open" names), blinking, smiling, brows ----------
KEEP = {'Basis', 'Open', 'Explosive', 'Dental_Lip', 'Tight-O', 'Tight', 'Wide', 'Affricate', 'Lip_Open',
        'V_Open', 'V_Explosive', 'V_Dental_Lip', 'V_Tight_O', 'V_Tight', 'V_Wide', 'V_Affricate', 'V_Lip_Open',
        'Eye_Blink', 'Eye_Blink_L', 'Eye_Blink_R', 'Mouth_Smile', 'Mouth_Smile_L', 'Mouth_Smile_R', 'Jaw_Open',
        'Brow_Raise_Inner_L', 'Brow_Raise_Inner_R', 'Brow_Raise_L', 'Brow_Raise_R'}
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        for k in list(o.data.shape_keys.key_blocks):
            if k.name not in KEEP:
                o.shape_key_remove(k)
        print(o.name, 'face shapes:', [k.name for k in o.data.shape_keys.key_blocks][1:])


# ---------- textures: new web-sized copies, swapped in (embedded originals are ignored on export otherwise) ----------
def pix(img):
    return np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


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


SIZE = {'Std_Skin_Head': 2048, 'Hair': 2048, 'Transparency': 2048, 'Dress': 1024, 'suit': 1024, 'Std_Skin_Arm': 1024,
        'Std_Skin_Body': 1024, 'Std_Skin_Leg': 1024, 'Std_Nails': 256, 'Std_Eyelash': 512, 'Std_Tongue': 256, 'Teeth': 512,
        'Scalp': 512, 'Heels': 512, 'Eye': 512, 'Cornea': 256, 'm0': 256, 'm1': 256, 'Normal': 1024}
used = set()
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for n in list(m.node_tree.nodes):
        if n.type != 'TEX_IMAGE' or not n.image:
            continue
        nm = n.image.name
        # maps the page doesn't use: drop them (and their weight)
        if any(k in nm for k in ('Specular', 'MetallicAlpha', 'HDRP', 'Glow', 'Displacement', 'ao', 'WeightMap', 'SSS', 'Trans', 'Micro')) \
                and not any(l.to_socket.name in ('Base Color', 'Alpha', 'Color') for l in n.outputs[0].links):
            m.node_tree.nodes.remove(n)
            continue
        used.add(n.image)
for img in list(used):
    try:
        _ = img.pixels[0]
    except Exception:
        print('could not read', img.name)
        continue
    w, h = img.size
    if w == 0:
        print('empty texture', img.name)
        continue
    lim = min([v for k, v in SIZE.items() if k.lower() in img.name.lower()] or [1024])
    a = pix(img)
    if max(w, h) > lim:
        tmp = img.copy()
        tmp.scale(max(1, int(w * lim / max(w, h))), max(1, int(h * lim / max(w, h))))
        a = pix(tmp)
        bpy.data.images.remove(tmp)
    # hair: Reallusion's hair shader works with soft ~50% alpha and tints the base colour; a web page needs strong
    # alpha to cut the strands out, and the tint baked in (warm brown, darker at the roots)
    if 'Transparency' in img.name and 'Diffuse' in img.name and not any(k in img.name for k in ('Eyelash', 'Occlusion', 'Tearline')):
        scalp = 'Scalp' in img.name
        a[..., 3] = np.clip(a[..., 3] * (1.6 if scalp else 2.3), 0, 1)
        lm = a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11
        mean = lm[a[..., 3] > 0.3].mean() if (a[..., 3] > 0.3).any() else 0.4
        k = np.clip(0.5 + 0.7 * (lm / max(mean, 1e-3)) ** 0.8, 0.3, 1.35)[..., None]
        a[..., :3] = np.clip(HAIR_BROWN[None, None, :] * k, 0, 1)
        print('hair tinted and alpha strengthened:', img.name)
    swap(img, save_new(img, a, '_web'))


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=False, export_skins=True,
                              export_morph=True, export_morph_normal=False, export_image_format='AUTO',
                              export_jpeg_quality=86, export_yup=True)
    print('exported', path)


export(OUT)


# ---------- hologram version: her own shading becomes cyan light (emissive) ----------
def lum(a):
    return a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11


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
        link = next((l for l in bsdf.inputs['Base Color'].links), None)
        node = link.from_node if link and link.from_node.type == 'TEX_IMAGE' else None
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
