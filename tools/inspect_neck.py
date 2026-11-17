import bpy, bmesh
import numpy as np
bpy.ops.wm.open_mainfile(filepath=r"D:/Lyra Real AI/model/lyra_v2.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; H = mats.index("f018_head"); B = mats.index("f021_body")
bm = bmesh.new(); bm.from_mesh(me)
for mi, nm in ((H, "head"), (B, "body")):
    bverts = set()
    for e in bm.edges:
        fs = [f for f in e.link_faces if f.material_index == mi]
        if len(fs) == 1:
            bverts |= set(e.verts)
    P = np.array([(mw @ v.co)[:] for v in bverts])
    near = P[(P[:, 2] > 1.2) & (P[:, 2] < 1.6)]
    if len(near):
        print(nm, "boundary near neck: n", len(near), "z", near[:, 2].min().round(3), near[:, 2].max().round(3),
              "front z", near[near[:, 1] < 0, 2].min().round(3) if (near[:, 1] < 0).any() else None)
# body faces near the chest/neck: z range of faces, and bikini-top separate islands
P = np.array([(mw @ f.calc_center_median())[:] for f in bm.faces])
mi = np.array([f.material_index for f in bm.faces])
hb = P[mi == H]
print("head faces z<1.44:", (hb[:, 2] < 1.44).sum(), "of", len(hb), " of which front y<0:", ((hb[:, 2] < 1.44) & (hb[:, 1] < 0)).sum())
bb = P[mi == B]
print("body faces z>1.30:", (bb[:, 2] > 1.30).sum(), "max z", bb[:, 2].max().round(3))
