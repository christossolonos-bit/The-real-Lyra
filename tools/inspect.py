import bpy, sys
argv = sys.argv[sys.argv.index("--") + 1:]
for path in argv:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    print("=====", path)
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            me = o.data
            counts = {}
            for p in me.polygons:
                counts[p.material_index] = counts.get(p.material_index, 0) + 1
            print("MESH", o.name, "verts", len(me.vertices), "parent", o.parent and o.parent.name,
                  "shapekeys", len(me.shape_keys.key_blocks) if me.shape_keys else 0)
            for i, m in enumerate(me.materials):
                imgs = []
                if m and m.use_nodes:
                    imgs = [n.image.name for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]
                print("   mat", i, m and m.name, counts.get(i, 0), imgs)
            print("   uv", [u.name for u in me.uv_layers])
        elif o.type == "ARMATURE":
            b = o.data.bones
            print("ARM", o.name, len(b), "head bone:", [x.name for x in b if "Head" in x.name][:3])
            for n in ("Bip01 Head", "Bip01 Neck", "Bip01 Pelvis", "Bip01 L Foot"):
                if n in b:
                    print("   ", n, tuple(round(v, 3) for v in (o.matrix_world @ b[n].head_local)))
