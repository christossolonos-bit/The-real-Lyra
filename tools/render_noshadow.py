# blender -b BLEND -P render_preview.py -- OUTPREFIX
import bpy, sys, math
pre = sys.argv[sys.argv.index("--") + 1]
sc = bpy.context.scene
for ob in [x for x in sc.objects if x.type in ("CAMERA", "LIGHT")]:
    bpy.data.objects.remove(ob, do_unlink=True)
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.1, 0.11, 0.12)
for ang, en, el in ((35, 3.0, 50), (-40, 1.4, 35), (180, 2.0, 20)):
    s = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); s.data.energy = en; s.data.use_shadow = False
    s.rotation_euler = (math.radians(el), 0, math.radians(ang)); sc.collection.objects.link(s)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
def shot(z, dist, lens, yaw, name, res):
    r = math.radians(yaw)
    cam.location = (math.sin(r) * dist, -math.cos(r) * dist, z)
    cam.rotation_euler = (math.radians(90), 0, r); cam.data.lens = lens
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.filepath = f"{pre}_{name}.png"; bpy.ops.render.render(write_still=True)
shot(1.58, 0.75, 85, 0, "head_front", (512, 640))
shot(1.58, 0.75, 85, 30, "head_34", (512, 640))
