import bpy, json
from pathlib import Path

def head_keys(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    info = []
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not obj.data.shape_keys:
            continue
        kb = obj.data.shape_keys.key_blocks
        names = [k.name for k in kb]
        # Measure max displacement of a few key shapes
        stats = {}
        for want in ["viseme_aa","viseme_O","viseme_U","jawOpen","mouthOpen","mouthPucker","mouthFunnel","mouthSmileLeft"]:
            if want not in kb: continue
            key = kb[want]
            # relative to basis
            basis = kb[0].data
            mx = 0.0
            for i, v in enumerate(key.data):
                d = (v.co - basis[i].co).length
                if d > mx: mx = d
            stats[want] = round(mx, 5)
        info.append({"mesh": obj.name, "count": len(names), "has_visemes": any(n.startswith("viseme_") for n in names), "keys": names, "disp": stats})
    return info

print("===LUNA===")
print(json.dumps(head_keys(Path(r"D:\HalMini-share\amy-smith\data\avatar.glb")), indent=2))
print("===LEO===")
print(json.dumps(head_keys(Path(r"D:\HalMini-share\amy-smith\data\characters\leo.glb")), indent=2))
