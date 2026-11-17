import bpy, json
from pathlib import Path

def check(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    out = []
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not obj.data.shape_keys: continue
        kb = obj.data.shape_keys.key_blocks
        if "viseme_aa" not in kb: continue
        basis = kb[0].data
        stats = {}
        for want in ["viseme_aa","viseme_O","viseme_U","viseme_E","jawOpen"]:
            if want not in kb: continue
            mx = 0.0
            for i,v in enumerate(kb[want].data):
                d = (v.co - basis[i].co).length
                if d > mx: mx = d
            stats[want] = round(mx, 5)
        out.append({"mesh": obj.name, "disp": stats})
    return out

print("===VERIFY_LUNA===")
print(json.dumps(check(Path(r"D:\HalMini-share\amy-smith\data\avatar.baked.glb")), indent=2))
print("===VERIFY_LEO===")
print(json.dumps(check(Path(r"D:\HalMini-share\amy-smith\data\characters\leo.baked.glb")), indent=2))
