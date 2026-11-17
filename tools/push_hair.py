# Push head-material verts (hair drapes / bib) that sink into the sports body back out above its surface.
import bpy, bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
OUT = r"D:/Lyra Real AI/model"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v4.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; B = mats.index("f021_body"); H = mats.index("f018_head"); HAIR = mats.index("f018_opacity")
scale = mw.to_scale()[0]
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
body_faces = [[v.index for v in f.verts] for f in bm.faces if f.material_index == B]
bvh = BVHTree.FromPolygons([v.co.copy() for v in bm.verts], body_faces)
cand = set()
for f in bm.faces:
    if f.material_index in (H, HAIR):
        for v in f.verts:
            if (mw @ v.co).z < 1.50: cand.add(v.index)
body_v = {v.index for f in bm.faces if f.material_index == B for v in f.verts}
cand -= body_v  # never move welded seam verts
gap = 0.006 / scale; reach = 0.05 / scale
delta = {}
for i in cand:
    co = bm.verts[i].co
    loc, nrm, fi, d = bvh.find_nearest(co, reach)
    if loc is None: continue
    side = (co - loc).dot(nrm)
    if side < gap:
        delta[i] = nrm * (gap - side)
print("moved verts", len(delta), "of", len(cand))
n = len(me.vertices)
D = np.zeros((n, 3), np.float32)
for i, dv in delta.items(): D[i] = dv[:]
for kb in me.shape_keys.key_blocks:
    c = np.empty(n * 3, np.float32); kb.data.foreach_get("co", c)
    kb.data.foreach_set("co", (c.reshape(n, 3) + D).ravel())
me.update()
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v4.blend"); print("SAVED")
