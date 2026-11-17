import bpy, bmesh
import numpy as np
OUT = r"D:/Lyra Real AI/model"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v4.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; H = mats.index("f018_head")
img = bpy.data.images.load(r"D:/microsoft avatar and animations/Assets/Avatars/Adults/Female_Adult_15/Textures/f018_head_color.tga")
w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); px = a.reshape(h, w, 4)
bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.active
kill = []
for f in bm.faces:
    if f.material_index != H: continue
    c = mw @ f.calc_center_median()
    if c.z > 1.47 or c.y > 0.09 or abs(c.x) < 0.07: continue
    u = sum(l[uv].uv.x for l in f.loops) / len(f.loops); v = sum(l[uv].uv.y for l in f.loops) / len(f.loops)
    if v > 0.35: continue
    col = px[min(int(v * h), h - 1), min(int(u * w), w - 1), :3]
    lum = col @ np.array([0.3, 0.59, 0.11])
    if lum < 0.38:
        kill.append(f)
print("hair end faces", len(kill))
bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(me); bm.free()
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v5.blend"); print("SAVED v5")
