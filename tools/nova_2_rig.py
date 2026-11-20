# Nova step 2: build a skeleton with the bone names her animation code already knows (bone_Head, bone_Jaw, ...),
# skin the mesh to it, give her a working jaw, and export a GLB for the hologram.
# blender -b <nova_1.blend> --python tools/nova_2_rig.py -- <out.blend> <out.glb>
import bpy, sys, math, mathutils
from mathutils import Vector as V3
args = sys.argv[sys.argv.index('--') + 1:]
out_blend, out_glb = args[0], args[1]
body = bpy.data.objects['Nova']

# ---- skeleton (Blender: +x her left, -y her front, z up). Measured from her T-pose mesh. ----
B = {  # name: (head, tail, parent)
  'bone_Root':          ((0, .01, .92), (0, .01, 1.00), None),
  'bone_SpineLow':      ((0, .01, 1.00), (0, .01, 1.12), 'bone_Root'),
  'bone_EXP_C1_Spine2': ((0, .01, 1.12), (0, .01, 1.26), 'bone_SpineLow'),
  'bone_Chest':         ((0, .01, 1.26), (0, .00, 1.50), 'bone_EXP_C1_Spine2'),
  'bone_EXP_C1_Neck1':  ((0, .00, 1.50), (0, .02, 1.60), 'bone_Chest'),
  'bone_Head':          ((0, .02, 1.60), (0, .02, 1.80), 'bone_EXP_C1_Neck1'),
  'bone_Jaw':           ((0, .00, 1.655), (0, -.085, 1.598), 'bone_Head'),
}
LEG = {'L': (.10, .136, .139, 'bone_20'), 'R': (-.09, -.094, -.105, 'bone_19')}  # hip x, knee x, ankle x, foot name
for s, sg in (('L', 1), ('R', -1)):
    B[f'bone_Shoulder{s}'] = ((.02 * sg, 0, 1.50), (.15 * sg, .02, 1.49), 'bone_Chest')
    B[f'bone_Arm{s}'] = ((.15 * sg, .02, 1.49), (.37 * sg, .02, 1.475), f'bone_Shoulder{s}')
    B[f'bone_Elbow{s}'] = ((.37 * sg, .02, 1.475), (.585 * sg, .02, 1.468), f'bone_Arm{s}')
    B[f'bone_Hand{s}'] = ((.585 * sg, .02, 1.468), (.65 * sg, .02, 1.466), f'bone_Elbow{s}')
    B[f'bone_MiddleFinger{s}'] = ((.65 * sg, .02, 1.466), (.74 * sg, .02, 1.462), f'bone_Hand{s}')
    B[f'bone_Thumb{s}'] = ((.60 * sg, -.005, 1.462), (.645 * sg, -.045, 1.458), f'bone_Hand{s}')
    hx, kx, ax, foot = LEG[s]
    B[f'bone_EXP_{s}1_Leg1Twist1'] = ((hx, .01, .92), (kx, -.005, .50), 'bone_Root')
    B[f'bone_EXP_{s}1_Leg2Twist1'] = ((kx, -.005, .50), (ax, .0, .10), f'bone_EXP_{s}1_Leg1Twist1')
    B[foot] = ((ax, .0, .10), (ax, -.17, .03), f'bone_EXP_{s}1_Leg2Twist1')

# ---- a mouth that can open: Meshy sculpted her lips closed, as one surface ----
# Cut along the line where her lips meet (z 1.640, measured on the full-detail mesh), leaving the corners joined,
# and put a dark mouth with upper teeth just behind the lips, so opening the jaw parts her lips instead of stretching them.
import bmesh
SEAM, HALF = 1.640, 0.023
me = body.data
def material(name, rgb, rough):
    m = bpy.data.materials.new(name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF'); bsdf.inputs['Base Color'].default_value = (*rgb, 1); bsdf.inputs['Roughness'].default_value = rough
    me.materials.append(m); return len(me.materials) - 1
MOUTH_MAT = material('mouth', (0.045, 0.012, 0.012), 0.9)
TEETH_MAT = material('teeth', (0.80, 0.77, 0.70), 0.45)
bm = bmesh.new(); bm.from_mesh(me)
region = [f for f in bm.faces if abs(f.calc_center_median().x) < HALF + 0.012 and 1.62 < f.calc_center_median().z < 1.66 and f.calc_center_median().y < -0.085]
geom = list({e for f in region for e in f.edges}) + region + list({v for f in region for v in f.verts})
res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, SEAM), plane_no=(0, 0, 1))
cut = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge) and all(abs(v.co.x) < HALF - 0.002 and v.co.y < -0.09 for v in e.verts)]
bmesh.ops.split_edges(bm, edges=cut)
print('lip cut edges:', len(cut))
def quad(x0, x1, z0, z1, y, mat):
    vs = [bm.verts.new((x0, y, z0)), bm.verts.new((x1, y, z0)), bm.verts.new((x1, y, z1)), bm.verts.new((x0, y, z1))]
    f = bm.faces.new(vs); f.material_index = mat; f.normal_update()
    if f.normal.y > 0: f.normal_flip()  # face the viewer (-y)
# the inside of her mouth: narrower at the bottom so it stays inside her chin when the mouth is closed
vs = [bm.verts.new(c) for c in ((-0.014, -0.094, 1.624), (0.014, -0.094, 1.624), (0.022, -0.094, 1.648), (-0.022, -0.094, 1.648))]
f = bm.faces.new(vs); f.material_index = MOUTH_MAT; f.normal_update()
if f.normal.y > 0: f.normal_flip()
quad(-0.017, 0.017, 1.6355, 1.6425, -0.0985, TEETH_MAT)  # upper teeth
bm.to_mesh(me); bm.free()
# which side of the lip line each vertex is on (the cut made two copies of every vertex along it)
vert_side = {}
for f in me.polygons:
    for i in f.vertices: vert_side.setdefault(i, []).append((f.center.z, f.material_index))

arm_data = bpy.data.armatures.new('NovaRig'); rig = bpy.data.objects.new('NovaRig', arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
for n, (h, t, p) in B.items():
    e = arm_data.edit_bones.new(n); e.head = h; e.tail = t
    e.roll = 0
for n, (h, t, p) in B.items():
    if p: arm_data.edit_bones[n].parent = arm_data.edit_bones[p]; arm_data.edit_bones[n].use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

# ---- skin weights: each vertex follows its nearest sensible bones ----
def seg_dist(p, a, b):
    ab = b - a; t = max(0, min(1, (p - a).dot(ab) / ab.length_squared)); return (p - (a + ab * t)).length
segs = {n: (V3(h), V3(t)) for n, (h, t, p) in B.items()}
ARM = lambda s: [f'bone_Arm{s}', f'bone_Elbow{s}', f'bone_Hand{s}', f'bone_MiddleFinger{s}', f'bone_Thumb{s}']
LEGB = lambda s: [f'bone_EXP_{s}1_Leg1Twist1', f'bone_EXP_{s}1_Leg2Twist1', LEG[s][3]]
CORE = ['bone_Root', 'bone_SpineLow', 'bone_EXP_C1_Spine2', 'bone_Chest', 'bone_EXP_C1_Neck1', 'bone_Head', 'bone_ShoulderL', 'bone_ShoulderR']
groups = {n: body.vertex_groups.new(name=n) for n in B}
for v in body.data.vertices:
    p = v.co; s = 'L' if p.x > 0 else 'R'; ax = abs(p.x)
    # the mouth: teeth stay with the head; the lower lip, chin and the lower half of the inner mouth go with the jaw
    sides = vert_side.get(v.index, [])
    mats = {m for _, m in sides}
    if TEETH_MAT in mats:
        groups['bone_Head'].add([v.index], 1.0, 'REPLACE'); continue
    if 1.57 < p.z < SEAM + 0.0005 and p.y < -0.03 and ax < 0.065:
        lower = bool(sides) and all(z < SEAM for z, _ in sides)
        wx = max(0.0, min(1.0, (0.065 - ax) / 0.03))
        w = wx * max(0.0, min(1.0, (p.z - 1.575) / 0.02)) * max(0.0, min(1.0, (-0.03 - p.y) / 0.03))
        if lower and p.z > SEAM - 0.008: w = max(w, wx)       # the lower lip moves fully with the jaw
        if MOUTH_MAT in mats: w = 1.0 if p.z < SEAM - 0.01 else 0.0
        if not lower and MOUTH_MAT not in mats: w = 0.0      # upper-lip copies of the cut stay
        if w > 0: groups['bone_Jaw'].add([v.index], w, 'REPLACE')
        if w < 1: groups['bone_Head'].add([v.index], 1 - w, 'REPLACE')
        continue
    if p.z > 1.60 and ax < 0.16:  # head and hair
        groups['bone_Head'].add([v.index], 1.0, 'REPLACE'); continue
    cands = list(CORE)
    if p.z > 1.38 or ax > 0.26: cands += ARM(s)            # arms (not the torso under them)
    if p.z < 0.98: cands += LEGB(s)                        # legs, by side
    cands = [c for c in cands if not (c.startswith('bone_Shoulder') and c[-1] != s)]
    d = sorted(((seg_dist(p, *segs[c]) + 0.008) ** -4, c) for c in cands)[-3:]
    tot = sum(x for x, _ in d)
    for x, c in d: groups[c].add([v.index], x / tot, 'REPLACE')

body.parent = rig
mod = body.modifiers.new('rig', 'ARMATURE'); mod.object = rig
# soften the joints: blend each vertex's weights with its neighbours' (not the jaw: it keeps a crisp lip line)
me = body.data; n = len(me.vertices)
nbr = [[] for _ in range(n)]
for e in me.edges: a_, b_ = e.vertices; nbr[a_].append(b_); nbr[b_].append(a_)
W = {g.name: [0.0] * n for g in body.vertex_groups}
idx = {g.index: g.name for g in body.vertex_groups}
for v in me.vertices:
    for ge in v.groups: W[idx[ge.group]][v.index] = ge.weight
for name, w in W.items():
    if name in ('bone_Jaw', 'bone_Head'): continue
    for _ in range(3):
        w[:] = [0.5 * w[i] + 0.5 * (sum(w[j] for j in nbr[i]) / len(nbr[i]) if nbr[i] else w[i]) for i in range(n)]
for i in range(n):
    tot = sum(w[i] for w in W.values())
    if tot <= 0: W['bone_Chest'][i] = 1.0; tot = 1.0
    for name, w in W.items():
        x = w[i] / tot
        if x > 0.002: body.vertex_groups[name].add([i], x, 'REPLACE')
        else: body.vertex_groups[name].remove([i])
bpy.ops.wm.save_as_mainfile(filepath=out_blend)

bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True); body.select_set(True)
bpy.ops.export_scene.gltf(filepath=out_glb, use_selection=True, export_format='GLB', export_animations=False,
                          export_image_format='JPEG', export_jpeg_quality=88, export_skins=True, export_yup=True)
print('exported', out_glb)
