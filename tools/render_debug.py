import bpy, sys, math
pre = sys.argv[sys.argv.index("--") + 1]
cols = {"f021_body": (1, 1, 1), "f001_head": (1, 0.2, 0.2), "f018_head": (0.2, 1, 0.2), "f018_opacity": (0.9, 0.9, 0.2), "f001_opacity": (1, 0.5, 0)}
for m in bpy.data.materials:
    if not m.use_nodes: continue
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
    geo = nt.nodes.new("ShaderNodeNewGeometry"); mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.inputs[1].default_value = (*cols.get(m.name, (0.5, 0.5, 0.5)), 1); mix.inputs[2].default_value = (0, 0, 1, 1)
    nt.links.new(geo.outputs["Backfacing"], mix.inputs[0]); nt.links.new(mix.outputs[0], em.inputs[0]); nt.links.new(em.outputs[0], out.inputs[0])
sc = bpy.context.scene; sc.world = bpy.data.worlds.new("w"); sc.world.color = (0, 0, 0)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.location = (0, -0.75, 1.50); cam.rotation_euler = (math.radians(90), 0, 0); cam.data.lens = 85
sc.render.resolution_x, sc.render.resolution_y = 512, 640; sc.render.filepath = pre + "_debug.png"
bpy.ops.render.render(write_still=True)
