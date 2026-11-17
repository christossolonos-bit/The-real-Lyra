# v6 -> v7: drop 15's hair drapes in front of the shoulders, apply cleaned 01 head texture.
import bpy, bmesh, sys
OUT = r"D:/Lyra Real AI/model"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v7.blend")
o = bpy.data.objects["Lyra"]; me = o.data; mw = o.matrix_world
mats = [m.name for m in me.materials]; H15 = mats.index("f018_head"); O15 = mats.index("f018_opacity")
bm = bmesh.new(); bm.from_mesh(me)
kill = [f for f in bm.faces if f.material_index in (H15, O15) and (lambda c: c.z < 1.50 and c.y < 0.115)(mw @ f.calc_center_median())]
print("front drape faces", len(kill))
bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(me); bm.free()
nt = me.materials["f001_head"].node_tree; bs = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
next(l.from_node for l in nt.links if l.to_socket == bs.inputs["Base Color"]).image = bpy.data.images.load(OUT + "/textures/lyra_head01_v7.png")
bpy.ops.file.make_paths_relative()
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v7.blend"); print("SAVED v7b")
