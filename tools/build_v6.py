# Lyra v6: Adult_01 face + Adult_15 long hair + Sports body (series outfit from v5).
import bpy, bmesh, os
import numpy as np
from mathutils.bvhtree import BVHTree

AV = r"D:/microsoft avatar and animations/Assets/Avatars/Adults"
OUT = r"D:/Lyra Real AI/model"; WORK = OUT + "/work"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v5.blend")
lyra = bpy.data.objects["Lyra"]; rig = bpy.data.objects["Lyra_Rig"]; mw = lyra.matrix_world
me = lyra.data
mats = [m.name for m in me.materials]
H15 = mats.index("f018_head"); O15 = mats.index("f018_opacity"); B = mats.index("f021_body")

# ---------- 1. keep only the HAIR part of Adult_15's head ----------
img = bpy.data.images.load(AV + "/Female_Adult_15/Textures/f018_head_color.tga")
w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); tex15 = a.reshape(h, w, 4)
bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.active; bm.faces.ensure_lookup_table()
def lum_at(u, v):
    c = tex15[min(int(v * h), h - 1), min(int(u * w), w - 1), :3]; return c @ np.array([0.3, 0.59, 0.11])
def face_zone(c):  # front of face, where we never want 15's hair
    return c.y < 0.035 and 1.48 < c.z < 1.70 and abs(c.x) < 0.075
hair = set()
for f in bm.faces:
    if f.material_index != H15: continue
    c = mw @ f.calc_center_median()
    if face_zone(c) or c.z < 1.40 and c.y < 0.07 and abs(c.x) < 0.09: continue
    ls = [lum_at(*l[uv].uv) for l in f.loops]
    u = sum(l[uv].uv.x for l in f.loops) / len(f.loops); v = sum(l[uv].uv.y for l in f.loops) / len(f.loops)
    ls.append(lum_at(u, v))
    if np.median(ls) < 0.47: hair.add(f.index)
# close small holes / drop specks (3 passes)
for _ in range(3):
    add, rem = set(), set()
    for f in bm.faces:
        if f.material_index != H15: continue
        nb = {g.index for e in f.edges for g in e.link_faces if g is not f and g.material_index == H15}
        if not nb: continue
        frac = len(nb & hair) / len(nb)
        c = mw @ f.calc_center_median()
        if f.index not in hair and frac >= 0.66 and not face_zone(c): add.add(f.index)
        if f.index in hair and frac <= 0.25: rem.add(f.index)
    hair = (hair | add) - rem
print("15 hair faces", len(hair))
kill = [f for f in bm.faces if f.material_index == H15 and f.index not in hair]
# drop 15's eyelash cards (opacity islands at eye height in front)
kill += [f for f in bm.faces if f.material_index == O15 and (lambda c: c.y < 0.035 and 1.55 < c.z < 1.67 and abs(c.x) < 0.08)(mw @ f.calc_center_median())]
bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(me); bm.free()

# ---------- 2. import Adult_01, keep head + eyelashes ----------
before = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=AV + "/Female_Adult_01/Export/Female_Adult_01_facial.fbx")
new = [o for o in bpy.data.objects if o not in before]
a01 = next(o for o in new if o.type == "ARMATURE"); h01 = next(o for o in new if o.type == "MESH")
for m in h01.data.materials:
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            p = AV + "/Female_Adult_01/Textures/" + os.path.basename(n.image.filepath)
            if os.path.exists(p): n.image.filepath = p; n.image.reload()
m01 = [m.name for m in h01.data.materials]
bm = bmesh.new(); bm.from_mesh(h01.data); mw01 = h01.matrix_world
def keep01(f):
    nm = m01[f.material_index]
    if "_head" in nm: return True
    if "_opacity" in nm:
        c = mw01 @ f.calc_center_median(); return c.y < 0.035 and 1.55 < c.z < 1.67 and abs(c.x) < 0.08
    return False
bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep01(f)], context="FACES_ONLY")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(h01.data); bm.free()
h01.parent = rig
for md in h01.modifiers:
    if md.type == "ARMATURE": md.object = rig
for o in bpy.data.objects: o.select_set(False)
h01.select_set(True); lyra.select_set(True); bpy.context.view_layer.objects.active = lyra
bpy.ops.object.join()
bpy.data.objects.remove(a01, do_unlink=True)
me = lyra.data; mats = [m.name for m in me.materials]
H01 = mats.index("f001_head"); H15 = mats.index("f018_head"); O15 = mats.index("f018_opacity"); B = mats.index("f021_body")

# ---------- 3. weld 01 neck to the body ----------
bm = bmesh.new(); bm.from_mesh(me)
res = bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v.is_boundary], dist=0.002 / mw.to_scale()[0])
bm.to_mesh(me)

# ---------- 4. push 15's hair out of 01's skull ----------
bm.verts.ensure_lookup_table()
bvh = BVHTree.FromPolygons([v.co.copy() for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces if f.material_index == H01])
hairv = {v.index for f in bm.faces if f.material_index in (H15, O15) for v in f.verts}
headv = {v.index for f in bm.faces if f.material_index == H01 for v in f.verts}
sc = mw.to_scale()[0]; gap = 0.004 / sc
n = len(me.vertices); D = np.zeros((n, 3), np.float32); moved = 0
for i in hairv - headv:
    co = bm.verts[i].co; loc, nrm, fi, d = bvh.find_nearest(co, 0.04 / sc)
    if loc is None: continue
    side = (co - loc).dot(nrm)
    if side < gap: D[i] = (nrm * (gap - side))[:]; moved += 1
bm.free()
for kb in me.shape_keys.key_blocks:
    c = np.empty(n * 3, np.float32); kb.data.foreach_get("co", c); kb.data.foreach_set("co", (c.reshape(n, 3) + D).ravel())
me.update(); print("hair verts pushed", moved)

kb = me.shape_keys.key_blocks
for k in kb: k.value = 0
for nm, val in (("AK_44_MouthSmileLeft", 0.5), ("AK_45_MouthSmileRight", 0.5), ("AU_06_CheekRaiser", 0.25),
                ("AK_19_EyeSquintLeft", 0.1), ("AK_20_EyeSquintRight", 0.1)):
    kb[nm].value = val
print("MATS", [m.name for m in me.materials])
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v6.blend"); print("SAVED v6")

# ---------- 5. position map for 01 head texture (for the collar cleanup) ----------
mi = H01; nt = me.materials[mi].node_tree
bs = next(x for x in nt.nodes if x.type == "BSDF_PRINCIPLED")
img = next(l.from_node for l in nt.links if l.to_socket == bs.inputs["Base Color"]).image
W, Hh = img.size; a = np.empty(W * Hh * 4, np.float32); img.pixels.foreach_get(a)
np.save(f"{WORK}/f001_head_color.npy", a.reshape(Hh, W, 4))
pos = np.full((Hh, W, 3), np.nan, np.float32)
me.calc_loop_triangles(); uvl = me.uv_layers.active.data
for tri in me.loop_triangles:
    if tri.material_index != mi: continue
    U = np.array([uvl[l].uv[:] for l in tri.loops]) * [W, Hh]
    P = np.array([(mw @ me.vertices[v].co)[:] for v in tri.vertices])
    x0, y0 = np.floor(U.min(0)).astype(int) - 1; x1, y1 = np.ceil(U.max(0)).astype(int) + 2
    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W), min(y1, Hh)
    if x1 <= x0 or y1 <= y0: continue
    gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    A_, B_, C_ = U; v0 = B_ - A_; v1 = C_ - A_; den = v0[0] * v1[1] - v1[0] * v0[1]
    if abs(den) < 1e-9: continue
    px_, py_ = gx - A_[0], gy - A_[1]
    l1 = (px_ * v1[1] - v1[0] * py_) / den; l2 = (v0[0] * py_ - px_ * v0[1]) / den; l0 = 1 - l1 - l2
    e = 1.5 / max(np.sqrt(abs(den)), 1); m = (l0 >= -e) & (l1 >= -e) & (l2 >= -e)
    pts = l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2]
    sub = pos[y0:y1, x0:x1]; sub[m] = pts[m]
np.save(f"{WORK}/f001_head_pos.npy", pos); print("POSMAP done")
