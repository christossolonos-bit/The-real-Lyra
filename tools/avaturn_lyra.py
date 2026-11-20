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
