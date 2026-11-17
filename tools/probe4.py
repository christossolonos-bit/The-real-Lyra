import bpy, math
from mathutils import Vector
import numpy as np
bpy.ops.wm.open_mainfile(filepath=r"D:/Lyra Real AI/model/lyra_v4.blend")
o = bpy.data.objects["Lyra"]; me = o.data
dg = bpy.context.evaluated_depsgraph_get()
ev = o.evaluated_get(dg); em = ev.to_mesh()
mats = [m.name for m in me.materials]
def tex_of(mi):
    nt = me.materials[mi].node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    t = next(l.from_node for l in nt.links if l.to_socket == b.inputs["Base Color"]); return t.image
# camera like head_front: at (0,-0.75,1.58) looking +Y, 85mm on 36mm sensor, 512x640
cam_loc = Vector((0, -0.75, 1.58)); f = 85 / 36
inv = o.matrix_world.inverted()
for (px, py) in [(60, 570), (100, 575), (450, 570), (256, 600), (200, 620), (20, 600)]:
    # normalized coords; sensor fit auto -> width 512 maps to 36mm
    nx = (px - 256) / 640; ny = (320 - py) / 640
    d = Vector((nx / f, 1, ny / f)).normalized()
    hit, loc, nor, idx = ev.ray_cast(inv @ cam_loc, (inv.to_3x3() @ d).normalized(), distance=10000)
    if not hit: print(px, py, "miss"); continue
    poly = em.polygons[idx]; mi = poly.material_index
    uvs = [em.uv_layers.active.data[l].uv for l in poly.loop_indices]
    u = sum(x[0] for x in uvs) / len(uvs); v = sum(x[1] for x in uvs) / len(uvs)
    img = tex_of(mi); w, h = img.size
    a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); a = a.reshape(h, w, 4)
    print(px, py, mats[mi], img.name, img.filepath, "uv", round(u, 3), round(v, 3), "col", a[int(v * h), int(u * w), :3].round(2), "z", round((o.matrix_world @ loc).z, 3), "nrm", tuple(round(c,2) for c in (o.matrix_world.to_3x3() @ nor).normalized()), "poly", idx)
