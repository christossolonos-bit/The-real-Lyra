# Nova (Meshy) step 1: import the FBX, shrink it for the web, stand her on the floor, save a .blend.
# blender -b --python tools/nova_1_prepare.py -- <in.fbx> <out.blend> [target_triangles]
import bpy, sys, mathutils
args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
target = int(args[2]) if len(args) > 2 else 70000
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in bpy.data.objects:
    if o.type != 'MESH': bpy.data.objects.remove(o)
bpy.context.view_layer.objects.active = meshes[0]
for o in meshes: o.select_set(True)
if len(meshes) > 1: bpy.ops.object.join()
o = bpy.context.view_layer.objects.active
o.name = 'Nova'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
print(f'triangles before: {tris}')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0001); bpy.ops.object.mode_set(mode='OBJECT')
# two passes: everything evenly to ~250k first, then only the body down to the target, so her face keeps
# the even 250k-level detail (no stretched patches) while the cardigan and jeans take the cuts
bpy.ops.object.mode_set(mode='OBJECT')
d = o.modifiers.new('even', 'DECIMATE'); d.ratio = min(1.0, 250000 / tris); d.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier='even')
zs = [v.co.z for v in o.data.vertices]; z0 = min(zs); H = max(zs) - z0
face = o.vertex_groups.new(name='keep_face')
face.add([v.index for v in o.data.vertices if v.co.z - z0 > 0.82 * H and abs(v.co.x) < 0.11 and v.co.y < 0.0], 1.0, 'REPLACE')
now = sum(len(p.vertices) - 2 for p in o.data.polygons)
d = o.modifiers.new('shrink', 'DECIMATE'); d.ratio = min(1.0, target / now); d.use_collapse_triangulate = True
d.vertex_group = 'keep_face'; d.invert_vertex_group = True; d.vertex_group_factor = 1000.0
bpy.ops.object.modifier_apply(modifier='shrink')
if 'keep_face' in o.vertex_groups: o.vertex_groups.remove(o.vertex_groups['keep_face'])
# feet on the floor, centred
bb = [o.matrix_world @ mathutils.Vector(c) for c in o.bound_box]
mn = mathutils.Vector([min(v[i] for v in bb) for i in range(3)]); mx = mathutils.Vector([max(v[i] for v in bb) for i in range(3)])
o.location = (-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)
bpy.ops.object.transform_apply(location=True)
print(f'triangles after: {sum(len(p.vertices) - 2 for p in o.data.polygons)}  height: {mx.z - mn.z:.3f}')
# textures to 2048 (4096 is too heavy for a web page)
for img in bpy.data.images:
    if img.size[0] > 2048: img.scale(2048, 2048)
    img.pack()
bpy.ops.wm.save_as_mainfile(filepath=out)
print('saved', out)
