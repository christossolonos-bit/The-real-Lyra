# Blender headless: gather chosen Rocketbox female animations onto ONE Bip01 armature and export a GLB
# with one animation per clip (skeleton only, no mesh).  blender -b -P convert_rocketbox_anims.py
import bpy, os

SRC = r"D:/microsoft avatar and animations/Assets/Animations/all_animations_max_motextr_static"
OUT = r"D:/Lyra Real AI/customizer/models/rocketbox_anims.glb"

CLIPS = [
    # idle
    *[f"f_idle_neutral_0{i}" for i in range(1, 10)], "f_idle_breathe_01", "f_idle_breathe_02", "f_idle_breathe_03",
    "f_idle_look_around_01", "f_idle_look_around_02", "f_idle_look_around_03", "f_idle_touch_hair_01",
    "f_idle_touch_face_01", "f_idle_waiting_01", "f_idle_roll_head_01", "f_idle_move_leg_01", "f_idle_nervous_01",
    # talking, by mood
    "f_gestic_talk_neutral_01", "f_gestic_talk_neutral_02", "f_gestic_talk_neutral_03", "f_gestic_talk_relaxed_01",
    "f_gestic_talk_relaxed_02", "f_gestic_talk_excited_01", "f_gestic_talk_excited_02", "f_gestic_talk_self-assured_01",
    "f_gestic_talk_self-assured_02", "f_gestic_talk_sad_01", "f_gestic_talk_nervous_01", "f_gestic_talk_nervous_02",
    "f_gestic_talk_angry_01", "f_gestic_talk_cool", "f_gestic_talk_left_01", "f_gestic_talk_right_01",
    # listening, by mood
    "f_gestic_listen_neutral_01", "f_gestic_listen_neutral_02", "f_gestic_listen_neutral_03", "f_gestic_listen_relaxed_01",
    "f_gestic_listen_excited_01", "f_gestic_listen_sad_01", "f_gestic_listen_nervous_01", "f_gestic_listen_self-assured_01",
    "f_gestic_listen_accept_01", "f_gestic_listen_accept_02", "f_gestic_listen_accept_03",
    "f_gestic_listen_deny_01", "f_gestic_listen_deny_02",
    # gestures
    "f_wave_01", "f_wave_02", "f_gestic_laugh_low", "f_gestic_laugh_loud", "f_gestic_shrug_01", "f_gestic_thoughtful_01",
    "f_cheer_01", "f_claphands_01", "f_gestic_presentation_right_01", "f_gestic_presentation_left_01", "f_dancing_affective",
]

bpy.ops.wm.read_factory_settings(use_empty=True)
base = None
for name in CLIPS:
    path = os.path.join(SRC, name + ".max.fbx")
    if not os.path.exists(path):
        print("MISSING", name); continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=False)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in new if o.type == "ARMATURE"), None)
    if not arm or not arm.animation_data or not arm.animation_data.action:
        print("NO ACTION", name)
        for o in new: bpy.data.objects.remove(o, do_unlink=True)
        continue
    act = arm.animation_data.action
    act.name = name; act.use_fake_user = True
    if base is None:
        base = arm; base.name = "Rocketbox"
        for o in new:
            if o is not arm: bpy.data.objects.remove(o, do_unlink=True)
    else:
        for o in new: bpy.data.objects.remove(o, do_unlink=True)
    print("OK", name, int(act.frame_range[0]), int(act.frame_range[1]))

# drop the spare actions the FBX importer creates; keep only the chosen clips
for act in list(bpy.data.actions):
    if act.name not in CLIPS:
        bpy.data.actions.remove(act)
# put every action on its own NLA track so the exporter writes them all
base.animation_data_create()
base.animation_data.action = None
for act in bpy.data.actions:
    tr = base.animation_data.nla_tracks.new(); tr.name = act.name
    st = tr.strips.new(act.name, int(act.frame_range[0]), act); tr.mute = True

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=False, export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_frame_step=2,
                          export_skins=False, export_morph=False, export_def_bones=False)
print("EXPORTED", OUT, len(bpy.data.actions), "clips")
