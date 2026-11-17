# Lyra v2: remove necklace, fix hair alpha, chestnut hair, soften jaw, Lyra smile,
# paint series outfit (teal long-sleeve scoop top + dark teal leggings + flats).
import bpy, bmesh, os, math
import numpy as np
from mathutils import Vector

SRC = r"D:/Lyra Real AI/model/lyra_base.blend"
OUT = r"D:/Lyra Real AI/model"
TEX = OUT + "/textures"
os.makedirs(TEX, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=SRC)
o = bpy.data.objects["Lyra"]; rig = bpy.data.objects["Lyra_Rig"]
me = o.data
mats = [m.name for m in me.materials]
HEAD_I = mats.index("f018_head"); BODY_I = mats.index("f021_body"); HAIR_I = mats.index("f018_opacity")
mw = o.matrix_world

# ---------- 1. necklace: small head-material islands below the chin ----------
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
seen = set(); kill = []
for v in bm.verts:
    if v.index in seen: continue
    isl = []; st = [v]; seen.add(v.index)
    while st:
        x = st.pop(); isl.append(x)
        for e in x.link_edges:
            y = e.other_vert(x)
            if y.index not in seen: seen.add(y.index); st.append(y)
    mi = {f.material_index for vv in isl for f in vv.link_faces}
    if mi == {HEAD_I} and len(isl) < 40 and max((mw @ vv.co).z for vv in isl) < 1.50:
        kill += isl
bmesh.ops.delete(bm, geom=kill, context="VERTS")
bm.to_mesh(me); bm.free()
print("necklace verts removed", len(kill))

# ---------- 2. hair alpha: use the texture's alpha channel ----------
hm = me.materials[HAIR_I]; nt = hm.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
for l in list(nt.links):
    if l.to_socket == bsdf.inputs["Alpha"]: nt.links.remove(l)
coltex = next(n for n in nt.nodes if n.type == "TEX_IMAGE" and n.outputs["Color"].is_linked)
nt.links.new(coltex.outputs["Alpha"], bsdf.inputs["Alpha"])
try: hm.surface_render_method = "DITHERED"
except Exception: pass

# ---------- 3. chestnut hair: shift auburn toward Lyra's brown with warm highlights ----------
def load_px(img):
    w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)
def save_img(arr, name):
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.clip(arr, 0, 1).ravel()); img.filepath_raw = f"{TEX}/{name}.png"
    img.file_format = "PNG"; img.save(); return img
def recolor_hair(px):
    rgb = px[..., :3]; lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    # Lyra chestnut: dark roots ~ (0.16,0.09,0.05), highlights ~ (0.55,0.36,0.20)
    t = np.clip(lum / max(lum.max(), 1e-3), 0, 1)[..., None] ** 0.9
    dark = np.array([0.13, 0.075, 0.04]); light = np.array([0.62, 0.41, 0.22])
    px[..., :3] = dark + (light - dark) * t
    return px
hair_px = recolor_hair(load_px(coltex.image).copy())
coltex.image = save_img(hair_px, "lyra_hair")

# ---------- 4. face: soften the jaw into the base shape (all keys move with it) ----------
kb = me.shape_keys.key_blocks
def bake_into_all(keyname, amount):
    k = kb[keyname]; basis = kb["Basis"]
    n = len(basis.data)
    b = np.empty(n * 3, np.float32); basis.data.foreach_get("co", b)
    kk = np.empty(n * 3, np.float32); k.data.foreach_get("co", kk)
    delta = (kk - b) * amount
    for key in kb:
        c = np.empty(n * 3, np.float32); key.data.foreach_get("co", c)
        key.data.foreach_set("co", c + delta)
    me.update()
bake_into_all("HB_02_JawIn", 0.45)
# default Lyra expression (kept as live values, so lip-sync still works on top)
for name, val in (("AK_44_MouthSmileLeft", 0.38), ("AK_45_MouthSmileRight", 0.38),
                  ("AU_06_CheekRaiser", 0.15), ("AK_19_EyeSquintLeft", 0.08), ("AK_20_EyeSquintRight", 0.08)):
    kb[name].value = val

# ---------- 5. series outfit painted into a new body texture ----------
bodymat = me.materials[BODY_I]; bnt = bodymat.node_tree
bbsdf = next(n for n in bnt.nodes if n.type == "BSDF_PRINCIPLED")
btex = next(l.from_node for l in bnt.links if l.to_socket == bbsdf.inputs["Base Color"])
skin = load_px(btex.image)
H, W, _ = skin.shape
hand_x = abs((rig.matrix_world @ rig.data.bones["Bip01 L Hand"].head_local).x)

TOP = np.array([0.055, 0.25, 0.30]); LEG = np.array([0.035, 0.11, 0.13]); SHOE = np.array([0.05, 0.06, 0.065])
def region(p):  # world-space point -> 0 skin, 1 top, 2 leggings, 3 shoes
    x, y, z = p; ax = abs(x)
    if z < 0.075: return 3
    if ax > hand_x - 0.015: return 0                        # hands
    if z > 1.47: return 0                                   # neck
    neck_front = 1.315 + 4.5 * x * x
    neck_back = 1.40 + 2.0 * x * x
    if ax < 0.17:
        lim = neck_front if y < 0.06 else neck_back
        if z > lim: return 0
    if z > 0.865: return 1                                  # top to just below the hip
    return 2

uvl = me.uv_layers.active.data
out = skin.copy()
lum = skin[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32)
me.calc_loop_triangles()
done = np.zeros((H, W), bool)
colors = {1: TOP, 2: LEG, 3: SHOE}
for tri in me.loop_triangles:
    if tri.material_index != BODY_I: continue
    uv = np.array([uvl[l].uv[:] for l in tri.loops]) * [W, H]
    P = np.array([(mw @ me.vertices[v].co)[:] for v in tri.vertices])
    x0, y0 = np.floor(uv.min(0)).astype(int) - 1; x1, y1 = np.ceil(uv.max(0)).astype(int) + 2
    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W), min(y1, H)
    if x1 <= x0 or y1 <= y0: continue
    gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    a, b, c = uv; v0 = b - a; v1 = c - a
    den = v0[0] * v1[1] - v1[0] * v0[1]
    if abs(den) < 1e-9: continue
    px_, py_ = gx - a[0], gy - a[1]
    l1 = (px_ * v1[1] - v1[0] * py_) / den; l2 = (v0[0] * py_ - px_ * v0[1]) / den; l0 = 1 - l1 - l2
    e = 1.5 / max(np.sqrt(abs(den)), 1)  # grow a little to close seams
    m = (l0 >= -e) & (l1 >= -e) & (l2 >= -e)
    if not m.any(): continue
    pts = (l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2])[m]
    reg = np.array([region(p) for p in pts])
    ys, xs = np.nonzero(m); ys += y0; xs += x0
    for r, col in colors.items():
        s = reg == r
        if s.any():
            shade = 0.85 + 0.3 * np.clip(lum[ys[s], xs[s]] / 0.55, 0, 1.2)[:, None] * 0.5
            out[ys[s], xs[s], :3] = col * shade
    sk = reg == 0
    out[ys[sk], xs[sk], :3] = skin[ys[sk], xs[sk], :3]
btex.image = save_img(out, "lyra_body_series")
# keep the bikini texture alongside as the alternate look
save_img(skin, "lyra_body_bikini")

# flatten normal map under clothing so bikini edges don't show through
nrm_node = next(l.from_node for l in bnt.links if l.to_socket.node.type == "NORMAL_MAP")
nrm = load_px(nrm_node.image)
cloth = np.any(np.abs(out[..., :3] - skin[..., :3]) > 1e-4, axis=-1)
flat = nrm.copy(); flat[cloth, :3] = [0.5, 0.5, 1.0]
nrm_node.image = save_img(flat, "lyra_body_series_normal")
nrm_node.image.colorspace_settings.name = "Non-Color"
bbsdf.inputs["Roughness"].default_value = 0.7

bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v2.blend")
print("SAVED v2")
