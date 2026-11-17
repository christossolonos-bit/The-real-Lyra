# Remove body faces hidden under the head's chest bib + bikini neck strings above the neckline.
import bpy, bmesh
from mathutils.bvhtree import BVHTree
OUT = r"D:/Lyra Real AI/model"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v3.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; B = mats.index("f021_body"); H = mats.index("f018_head")
bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.active
bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
# BVH of head faces in local space
hv = [v.co.copy() for v in bm.verts]
hp = [[v.index for v in f.verts] for f in bm.faces if f.material_index == H]
bvh = BVHTree.FromPolygons(hv, hp)
scale = mw.to_scale()[0]  # local units -> metres
tol = 0.006 / scale
kill = []; strings = 0; under = 0
for f in bm.faces:
    if f.material_index != B: continue
    zc = (mw @ f.calc_center_median()).z
    if zc < 1.25: continue
    u = sum(l[uv].uv.x for l in f.loops) / len(f.loops); v = sum(l[uv].uv.y for l in f.loops) / len(f.loops)
    if 0.13 < v < 0.24 and 0.28 < u < 0.88 and zc > 1.30:
        kill.append(f); strings += 1; continue
    near = all(bvh.find_nearest(vv.co)[3] is not None and bvh.find_nearest(vv.co)[3] < tol for vv in f.verts)
    if near:
        kill.append(f); under += 1
print("strings", strings, "under bib", under)
bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(me); bm.free()
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v4.blend"); print("SAVED v4")
