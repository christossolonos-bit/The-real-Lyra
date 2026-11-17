import bpy, bmesh
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=r"D:/Lyra Real AI/model/lyra_base.blend")
o = bpy.data.objects["Lyra"]
print("KEYS", [k.name for k in o.data.shape_keys.key_blocks])
for m in o.data.materials:
    print("MAT", m.name)
    for l in m.node_tree.links:
        a = l.from_node; b = l.to_node
        print("   ", a.type, getattr(a, "image", None) and a.image.name, l.from_socket.name, "->", b.type, l.to_socket.name)
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            print("    IMG", n.image.name, n.image.filepath, n.image.size[:], n.image.channels, n.image.depth)
bm = bmesh.new(); bm.from_mesh(o.data)
bm.verts.ensure_lookup_table()
seen = set(); islands = []
for v in bm.verts:
    if v.index in seen: continue
    stack = [v]; isl = []
    seen.add(v.index)
    while stack:
        x = stack.pop(); isl.append(x)
        for e in x.link_edges:
            y = e.other_vert(x)
            if y.index not in seen:
                seen.add(y.index); stack.append(y)
    mats = {f.material_index for vv in isl for f in vv.link_faces}
    zs = [vv.co.z for vv in isl]
    islands.append((len(isl), round(min(zs), 3), round(max(zs), 3), sorted(mats)))
islands.sort(reverse=True)
print("ISLANDS", len(islands))
for i in islands[:60]:
    print("  ", i)
