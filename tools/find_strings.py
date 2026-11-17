import bpy, bmesh, sys
import numpy as np
OUT = r"D:/Lyra Real AI/model"
apply = "--apply" in sys.argv
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v3.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; B = mats.index("f021_body"); H = mats.index("f018_head")
orig = {}
for key, path in ((B, r"D:/microsoft avatar and animations/Assets/Avatars/Professions/Sports_Female_01/Textures/f021_body_color.tga"),
                  (H, r"D:/microsoft avatar and animations/Assets/Avatars/Adults/Female_Adult_15/Textures/f018_head_color.tga")):
    img = bpy.data.images.load(path); w, h = img.size
    a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); orig[key] = (a.reshape(h, w, 4), w, h)
bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.active
# islands per material
bm.faces.ensure_lookup_table()
seen = set(); kill = []
for f in bm.faces:
    if f.index in seen or f.material_index not in (B, H): continue
    isl = []; st = [f]; seen.add(f.index)
    while st:
        x = st.pop(); isl.append(x)
        for e in x.edges:
            for g in e.link_faces:
                if g.index not in seen and g.material_index == f.material_index:
                    seen.add(g.index); st.append(g)
    zs = [(mw @ v.co).z for ff in isl for v in ff.verts]
    if max(zs) < 1.25: continue
    px, w, h = orig[f.material_index]
    cols = []
    for ff in isl:
        for l in ff.loops:
            u, v = l[uv].uv; cols.append(px[min(int(v * h), h - 1), min(int(u * w), w - 1), :3])
    c = np.mean(cols, 0)
    print("ISL mat", mats[f.material_index], "faces", len(isl), "z", round(min(zs), 3), round(max(zs), 3), "col", c.round(2))
    if f.material_index == B and len(isl) < 400:
        kill += isl
print("would kill", len(kill))
if apply and kill:
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(me)
    bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v3.blend"); print("APPLIED")
