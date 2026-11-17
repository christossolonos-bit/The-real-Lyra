import bpy
OUT = r"D:/Lyra Real AI/model"
bpy.ops.wm.open_mainfile(filepath=OUT + "/lyra_v2.blend")
o = bpy.data.objects["Lyra"]; me = o.data
def base_tex(mat):
    nt = mat.node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return next(l.from_node for l in nt.links if l.to_socket == b.inputs["Base Color"])
for matname, f in (("f018_head", "lyra_head_v3"), ("f021_body", "lyra_body_series_v3")):
    base_tex(me.materials[matname]).image = bpy.data.images.load(f"{OUT}/textures/{f}.png")
kb = me.shape_keys.key_blocks
for k in kb: k.value = 0
for name, val in (("AK_44_MouthSmileLeft", 0.5), ("AK_45_MouthSmileRight", 0.5),
                  ("AU_06_CheekRaiser", 0.25), ("AK_19_EyeSquintLeft", 0.1), ("AK_20_EyeSquintRight", 0.1)):
    kb[name].value = val
bpy.ops.file.make_paths_relative()
bpy.ops.wm.save_as_mainfile(filepath=OUT + "/lyra_v3.blend"); print("SAVED v3")
