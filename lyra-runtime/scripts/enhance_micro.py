"""
Amplify ARKit micro-expression shape keys so brows / squints / smiles read on camera.

  blender --background --python enhance_micro.py -- in.glb out.glb

Leaves viseme_* and jaw drivers mostly alone (already baked for lip sync).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import bpy

# name pattern → scale of (shape - basis) delta
SCALES: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"^brow(Down|InnerUp|OuterUp)", re.I), 2.35),
    (re.compile(r"^eyeSquint", re.I), 3.0),
    (re.compile(r"^eyeWide", re.I), 2.8),
    (re.compile(r"^cheekSquint", re.I), 2.5),
    (re.compile(r"^cheekPuff$", re.I), 1.6),
    (re.compile(r"^mouthSmile", re.I), 1.85),
    (re.compile(r"^mouthFrown", re.I), 2.0),
    (re.compile(r"^mouthPress", re.I), 2.1),
    (re.compile(r"^mouthDimple", re.I), 2.0),
    (re.compile(r"^mouth(Left|Right)$", re.I), 1.7),
    (re.compile(r"^noseSneer", re.I), 2.4),
    (re.compile(r"^mouthRoll(Lower|Upper)$", re.I), 1.7),
    (re.compile(r"^mouthShrug", re.I), 1.6),
    # Soft blink lift — keep below 1.5 so lids still close cleanly.
    (re.compile(r"^eyeBlink", re.I), 1.35),
]

SKIP = re.compile(r"^(Basis|viseme_|jawOpen|jawForward|jawLeft|jawRight|mouthOpen|tongueOut)", re.I)
# Mouth funnel/pucker are shared with lip sync — light touch only.
SOFT = {
    "mouthFunnel": 1.15,
    "mouthPucker": 1.2,
    "mouthLowerDownLeft": 1.15,
    "mouthLowerDownRight": 1.15,
    "mouthUpperUpLeft": 1.25,
    "mouthUpperUpRight": 1.25,
    "mouthStretchLeft": 1.25,
    "mouthStretchRight": 1.25,
    "mouthClose": 1.2,
}


def scale_for(name: str) -> float | None:
    if SKIP.match(name):
        return None
    if name in SOFT:
        return SOFT[name]
    for pat, s in SCALES:
        if pat.search(name):
            return s
    return None


def enhance_mesh(obj: bpy.types.Object) -> list[str]:
    if obj.type != "MESH" or not obj.data.shape_keys:
        return []
    kb = obj.data.shape_keys.key_blocks
    if len(kb) < 2:
        return []
    basis = kb[0]
    changed: list[str] = []
    for key in kb[1:]:
        s = scale_for(key.name)
        if not s or abs(s - 1.0) < 0.01:
            continue
        for i, vert in enumerate(key.data):
            b = basis.data[i].co
            delta = vert.co - b
            vert.co = b + delta * s
        changed.append(f"{key.name}×{s:.2f}")
    return changed


def main() -> None:
    argv = sys.argv
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    if len(args) < 2:
        raise SystemExit("Usage: blender --background --python enhance_micro.py -- in.glb out.glb")
    src, dst = Path(args[0]), Path(args[1])
    if not src.exists():
        raise SystemExit(f"Missing: {src}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(src))

    report = []
    for obj in list(bpy.data.objects):
        changed = enhance_mesh(obj)
        if changed:
            report.append(f"{obj.name}: {len(changed)} keys")

    dst.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(dst),
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_morph=True,
        export_skins=True,
        export_apply=False,
    )
    print("===MICRO_DONE===")
    print(f"in={src}")
    print(f"out={dst}")
    for line in report or ["WARNING: nothing enhanced"]:
        print(line)


if __name__ == "__main__":
    main()
