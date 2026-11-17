# Lyra v3 on top of v2: clean neck/chest skin, paint head-mesh collar edge, stronger smile, warmer lips.
import bpy, os
import numpy as np

OUT = r"D:/Lyra Real AI/model"; TEX = OUT + "/textures"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v2.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]
HEAD_I = mats.index("f018_head"); BODY_I = mats.index("f021_body")
TOP = np.array([0.055, 0.25, 0.30])

def base_tex(mat):
    nt = mat.node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return next(l.from_node for l in nt.links if l.to_socket == b.inputs["Base Color"])
def load_px(img):
    w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); return a.reshape(h, w, 4)
def save_img(arr, name):
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.clip(arr, 0, 1).ravel()); img.filepath_raw = f"{TEX}/{name}.png"
    img.file_format = "PNG"; img.save(); return img

def neckline(x, y):
    return (1.315 + 4.5 * x * x) if y < 0.06 else (1.40 + 2.0 * x * x)

def is_skin(c):
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    return (r > g) & (g > b) & (r - b > 0.12) & (r > 0.3) & (r - g < 0.35)

def process(mat_i, fn):
    tex = base_tex(me.materials[mat_i]); px = load_px(tex.image); H, W, _ = px.shape
    uvl = me.uv_layers.active.data
    me.calc_loop_triangles()
    for tri in me.loop_triangles:
        if tri.material_index != mat_i: continue
        P = np.array([(mw @ me.vertices[v].co)[:] for v in tri.vertices])
        if P[:, 2].max() < 1.15 or P[:, 2].min() > 1.56: continue
        uv = np.array([uvl[l].uv[:] for l in tri.loops]) * [W, H]
        x0, y0 = np.floor(uv.min(0)).astype(int) - 1; x1, y1 = np.ceil(uv.max(0)).astype(int) + 2
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W), min(y1, H)
        if x1 <= x0 or y1 <= y0: continue
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a, b, c = uv; v0 = b - a; v1 = c - a; den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-9: continue
        pxx, pyy = gx - a[0], gy - a[1]
        l1 = (pxx * v1[1] - v1[0] * pyy) / den; l2 = (v0[0] * pyy - pxx * v0[1]) / den; l0 = 1 - l1 - l2
        e = 1.5 / max(np.sqrt(abs(den)), 1)
        m = (l0 >= -e) & (l1 >= -e) & (l2 >= -e)
        if not m.any(): continue
        pts = (l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2])[m]
        ys, xs = np.nonzero(m); ys += y0; xs += x0
        fn(px, ys, xs, pts)
    return tex, px

# skin reference colour from the clean neck of the head texture
def make_fixer(skin_col, paint_top):
    def fix(px, ys, xs, pts):
        x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]
        covered = (z <= np.where(np.abs(x) < 0.17, np.where(y < 0.06, 1.315 + 4.5 * x * x, 1.40 + 2.0 * x * x), 1.47))
        if paint_top:
            px[ys[covered], xs[covered], :3] = TOP
        sk = ~covered
        cols = px[ys[sk], xs[sk], :3]
        bad = ~is_skin(cols)
        tgt_y, tgt_x = ys[sk][bad], xs[sk][bad]
        px[tgt_y, tgt_x, :3] = skin_col
    return fix

head_tex = base_tex(me.materials[HEAD_I]); hpx = load_px(head_tex.image)
body_tex = base_tex(me.materials[BODY_I]); bpx = load_px(body_tex.image)
skin_samples = bpx[..., :3].reshape(-1, 3)
skin_samples = skin_samples[is_skin(skin_samples)]
skin_col = np.median(skin_samples, axis=0); print("skin", skin_col)

t, px = process(BODY_I, make_fixer(skin_col, False)); t.image = save_img(px, "lyra_body_series_v3")
t, px = process(HEAD_I, make_fixer(skin_col, True))

# warmer, fuller-looking lips: tint the lip area (pinkish pixels in the lower-middle face of the head texture)
r, g, b = px[..., 0], px[..., 1], px[..., 2]
lip = (r > 0.35) & (r - g > 0.18) & (b > g * 0.75) & (r - g < 0.5)
px[lip, :3] = px[lip, :3] * np.array([1.08, 0.86, 0.9])
t.image = save_img(px, "lyra_head_v3")

kb = me.shape_keys.key_blocks
for name, val in (("AK_44_MouthSmileLeft", 0.6), ("AK_45_MouthSmileRight", 0.6), ("HB_07_MouthSmile", 0.25),
                  ("AU_06_CheekRaiser", 0.3), ("AK_19_EyeSquintLeft", 0.12), ("AK_20_EyeSquintRight", 0.12),
                  ("AK_03_BrowInnerUp", 0.1)):
    kb[name].value = val
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v3.blend"); print("SAVED v3")
