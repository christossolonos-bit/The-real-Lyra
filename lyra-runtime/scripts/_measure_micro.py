import bpy, json
from pathlib import Path

FOCUS = [
  "browDownLeft","browDownRight","browInnerUp","browOuterUpLeft","browOuterUpRight",
  "eyeSquintLeft","eyeSquintRight","eyeWideLeft","eyeWideRight",
  "cheekSquintLeft","cheekSquintRight","cheekPuff",
  "mouthSmileLeft","mouthSmileRight","mouthFrownLeft","mouthFrownRight",
  "mouthPressLeft","mouthPressRight","mouthDimpleLeft","mouthDimpleRight",
  "noseSneerLeft","noseSneerRight","mouthPucker","mouthFunnel",
]

def measure(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    out = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not obj.data.shape_keys: continue
        if "Head" not in obj.name and obj.name != "Head_Mesh": continue
        kb = obj.data.shape_keys.key_blocks
        basis = kb[0].data
        stats = {}
        for name in FOCUS:
            if name not in kb: continue
            mx = 0.0
            for i,v in enumerate(kb[name].data):
                d = (v.co - basis[i].co).length
                if d > mx: mx = d
            stats[name] = round(mx, 5)
        out[obj.name] = stats
    return out

print(json.dumps({"luna": measure(Path(r"D:\HalMini-share\amy-smith\data\avatar.glb")),
                  "leo": measure(Path(r"D:\HalMini-share\amy-smith\data\characters\leo.glb"))}, indent=2))
