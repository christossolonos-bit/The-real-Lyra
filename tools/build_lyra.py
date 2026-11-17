# Build Lyra: Sports_Female_01 body + Female_Adult_15 head/hair, one rig, face shape keys kept.
# Usage: blender -b -P build_lyra.py
import bpy, bmesh, os, math
from mathutils import Vector

AV = r"D:/microsoft avatar and animations/Assets/Avatars"
BODY = (AV + "/Professions/Sports_Female_01", "Sports_Female_01")
HEAD = (AV + "/Adults/Female_Adult_15", "Female_Adult_15")
OUT = r"D:/Lyra Real AI/model"
os.makedirs(OUT, exist_ok=True)

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
                            n.image.filepath = p; n.image.reload()
    arm = next(o for o in new if o.type == "ARMATURE")
    mesh = next(o for o in new if o.type == "MESH")
    return arm, mesh

def keep_materials(obj, keep_names):
    bm = bmesh.new(); bm.from_mesh(obj.data)
    names = [m.name for m in obj.data.materials]
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not any(k in names[f.material_index] for k in keep_names)], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data); bm.free()

body_arm, body = imp(*BODY)
head_arm, head = imp(*HEAD)

# Body keeps only its body skin/swimwear; head keeps head + hair (opacity).
keep_materials(body, ["_body"])
keep_materials(head, ["_head", "_opacity"])

# Head mesh onto the body's skeleton (identical bind pose).
head.parent = body_arm
for mod in head.modifiers:
    if mod.type == "ARMATURE":
        mod.object = body_arm

# Join body into head so the head's 176 facial shape keys stay; body gets matching keys by name.
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True); head.select_set(True)
bpy.context.view_layer.objects.active = head
bpy.ops.object.join()
lyra = head
lyra.name = "Lyra"

# Clean up the unused rig.
bpy.data.objects.remove(head_arm, do_unlink=True)
body_arm.name = "Lyra_Rig"

# Weld the neck seam: merge boundary verts that are within 2 mm.
bm = bmesh.new(); bm.from_mesh(lyra.data)
boundary = [v for v in bm.verts if v.is_boundary]
res = bmesh.ops.remove_doubles(bm, verts=boundary, dist=0.002)
bm.to_mesh(lyra.data); bm.free()

# Hair: alpha-blended cards need alpha hashed/blended to show strands.
for m in lyra.data.materials:
    if "_opacity" in m.name:
        try:
            m.surface_render_method = "DITHERED"
        except Exception:
            m.blend_method = "HASHED"

print("LYRA verts", len(lyra.data.vertices), "keys", len(lyra.data.shape_keys.key_blocks),
      "mats", [m.name for m in lyra.data.materials])

bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_base.blend")

# Preview renders
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE_NEXT" if hasattr(bpy.types, "EEVEE_NEXT") else sc.render.engine
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.25, 0.25, 0.27)
for ang, en in ((50, 3.0), (-30, 1.2)):
    s = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); s.data.energy = en
    s.rotation_euler = (math.radians(55), 0, math.radians(ang)); sc.collection.objects.link(s)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam

def shot(z, dist, lens, yaw, name, res):
    r = math.radians(yaw)
    cam.location = (math.sin(r) * dist, -math.cos(r) * dist, z)
    cam.rotation_euler = (math.radians(90), 0, r)
    cam.data.lens = lens
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.filepath = f"{OUT}/preview_{name}.png"
    bpy.ops.render.render(write_still=True)

shot(1.60, 0.62, 85, 0, "head_front", (512, 640))
shot(1.60, 0.62, 85, 40, "head_34", (512, 640))
shot(1.55, 0.62, 85, 90, "head_side", (512, 640))
shot(0.88, 4.6, 50, 0, "body_front", (450, 900))
shot(0.88, 4.6, 50, 35, "body_34", (450, 900))
