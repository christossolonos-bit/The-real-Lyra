# Mégane (Reallusion CC3+) -> Lyra's body. Renames her main bones to the names Lyra's animation code uses,
# keeps only the face shapes needed for talking and blinking, shrinks textures for the web, exports a GLB.
# blender -b --python tools/megane_prepare.py -- <Mégane_Blender.Fbx> <out.glb> [<out.blend>]
import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
src, out_glb = args[0], args[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

# the main bones get the names retarget.js, the gaze, the head-follow and the lip sync look for
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
  if b: b.name = new   # Blender renames the matching vertex groups too
  else: print('missing bone', old)

# under the trousers anyway
for n in ('Underwear_Bottoms',):
  if n in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[n])

# face shapes: only what talking, blinking and smiling need (all 149 would make the file huge)
KEEP = {'Basis', 'V_Open', 'V_Explosive', 'V_Dental_Lip', 'V_Tight_O', 'V_Tight', 'V_Wide', 'V_Affricate', 'V_Lip_Open',
        'Eye_Blink_L', 'Eye_Blink_R', 'Mouth_Smile_L', 'Mouth_Smile_R', 'Jaw_Open', 'Brow_Raise_Inner_L', 'Brow_Raise_Inner_R'}
for o in bpy.data.objects:
  if o.type == 'MESH' and o.data.shape_keys:
    for k in list(o.data.shape_keys.key_blocks):
      if k.name not in KEEP: o.shape_key_remove(k)
    print(o.name, 'face shapes:', [k.name for k in o.data.shape_keys.key_blocks][1:])

# textures: 4096 -> 2048 (the hair's opacity keeps its aspect)
for img in bpy.data.images:
  w, h = img.size
  if max(w, h) > 2048: img.scale(int(w * 2048 / max(w, h)), int(h * 2048 / max(w, h)))

if len(args) > 2: bpy.ops.wm.save_as_mainfile(filepath=args[2])
bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB', export_animations=False, export_skins=True, export_morph=True,
                          export_morph_normal=False, export_image_format='AUTO', export_jpeg_quality=88, export_yup=True)
print('exported', out_glb)
