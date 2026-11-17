# From lyra_v2.blend: write per-texel world position maps (x,y,z) for head and body textures + export textures.
import bpy, os
import numpy as np
OUT = r"D:/Lyra Real AI/model"; WORK = OUT + "/work"; os.makedirs(WORK, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v2.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]
def base_tex(mat):
    nt = mat.node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return next(l.from_node for l in nt.links if l.to_socket == b.inputs["Base Color"])
me.calc_loop_triangles(); uvl = me.uv_layers.active.data
for key in ("f018_head", "f021_body"):
    mi = mats.index(key); img = base_tex(me.materials[mi]).image
    W, H = img.size
    a = np.empty(W * H * 4, np.float32); img.pixels.foreach_get(a)
    np.save(f"{WORK}/{key}_color.npy", a.reshape(H, W, 4))
    pos = np.full((H, W, 3), np.nan, np.float32)
    for tri in me.loop_triangles:
        if tri.material_index != mi: continue
        uv = np.array([uvl[l].uv[:] for l in tri.loops]) * [W, H]
        P = np.array([(mw @ me.vertices[v].co)[:] for v in tri.vertices])
        x0, y0 = np.floor(uv.min(0)).astype(int) - 1; x1, y1 = np.ceil(uv.max(0)).astype(int) + 2
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W), min(y1, H)
        if x1 <= x0 or y1 <= y0: continue
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        A, B, C = uv; v0 = B - A; v1 = C - A; den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-9: continue
        px, py = gx - A[0], gy - A[1]
        l1 = (px * v1[1] - v1[0] * py) / den; l2 = (v0[0] * py - px * v0[1]) / den; l0 = 1 - l1 - l2
        e = 1.5 / max(np.sqrt(abs(den)), 1)
        m = (l0 >= -e) & (l1 >= -e) & (l2 >= -e)
        pts = l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2]
        sub = pos[y0:y1, x0:x1]; sub[m] = pts[m]
    np.save(f"{WORK}/{key}_pos.npy", pos)
    print("done", key)
