import bpy, json, sys
from pathlib import Path

def inspect(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    out = {"file": str(path), "meshes": []}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        keys = []
        if obj.data.shape_keys and obj.data.shape_keys.key_blocks:
            keys = [kb.name for kb in obj.data.shape_keys.key_blocks]
        out["meshes"].append({"name": obj.name, "verts": len(obj.data.vertices), "shape_keys": keys})
    return out

paths = [
    Path(r"D:\HalMini-share\amy-smith\data\avatar.glb"),
    Path(r"D:\HalMini-share\amy-smith\data\characters\leo.glb"),
]
results = []
for p in paths:
    try:
        results.append(inspect(p))
    except Exception as e:
        results.append({"file": str(p), "error": str(e)})
print("===MORPH_JSON===")
print(json.dumps(results, indent=2))
