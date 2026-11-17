# Blender headless: render head + full-body previews of Rocketbox candidates.
# Usage: blender -b -P render_candidates.py -- OUTDIR NAME1 NAME2 ...
import bpy, sys, os, glob, math
from mathutils import Vector

ROOT = r"D:/microsoft avatar and animations/Assets/Avatars"
argv = sys.argv[sys.argv.index("--") + 1:]
out, names = argv[0], argv[1:]
os.makedirs(out, exist_ok=True)

def find(name):
    for sub in ("Adults", "Professions"):
        p = os.path.join(ROOT, sub, name)
        if os.path.isdir(p):
            return p

def fix_textures(folder):
    tex = os.path.join(folder, "Textures")
    for img in bpy.data.images:
        base = os.path.basename(img.filepath)
        cand = os.path.join(tex, base)
        if base and os.path.exists(cand):
            img.filepath = cand
            img.reload()

for name in names:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    folder = find(name)
    bpy.ops.import_scene.fbx(filepath=os.path.join(folder, "Export", name + ".fbx"))
    fix_textures(folder)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    zmin = min(p.z for p in pts); zmax = max(p.z for p in pts)
    h = zmax - zmin
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
    sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.25, 0.25, 0.27)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    def shot(target_z, dist, lens, suffix, res):
        cam.location = (0, -dist, target_z); cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.lens = lens
        sc.render.resolution_x, sc.render.resolution_y = res
        sc.render.filepath = os.path.join(out, f"{name}_{suffix}.png")
        bpy.ops.render.render(write_still=True)
    shot(zmin + h * 0.93, h * 0.35, 85, "head", (512, 640))
    shot(zmin + h * 0.5, h * 2.6, 50, "body", (400, 800))
