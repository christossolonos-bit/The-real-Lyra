"""
Bake Oculus/Ready Player Me viseme shape keys from ARKit mouth controls.

Uses Blender headless:
  blender --background --python bake_visemes.py -- in.glb out.glb

Recipes match amy-smith avatar lip-sync (slightly stronger so lips read on camera).
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import bpy

# Stronger than the runtime ARKit fallback — baked once into the mesh.
RECIPES: dict[str, dict[str, float]] = {
    "viseme_sil": {},
    "viseme_aa": {
        "jawOpen": 0.42,
        "mouthOpen": 0.35,
        "mouthLowerDownLeft": 0.55,
        "mouthLowerDownRight": 0.55,
    },
    "viseme_O": {
        "jawOpen": 0.28,
        "mouthOpen": 0.18,
        "mouthFunnel": 0.95,
    },
    "viseme_U": {
        "jawOpen": 0.12,
        "mouthOpen": 0.08,
        "mouthPucker": 0.95,
        "mouthFunnel": 0.25,
    },
    "viseme_E": {
        "jawOpen": 0.22,
        "mouthOpen": 0.16,
        "mouthStretchLeft": 0.7,
        "mouthStretchRight": 0.7,
    },
    "viseme_I": {
        "jawOpen": 0.14,
        "mouthOpen": 0.1,
        "mouthStretchLeft": 0.55,
        "mouthStretchRight": 0.55,
        "mouthSmileLeft": 0.18,
        "mouthSmileRight": 0.18,
    },
    "viseme_SS": {
        "jawOpen": 0.06,
        "mouthStretchLeft": 0.5,
        "mouthStretchRight": 0.5,
    },
    "viseme_CH": {
        "jawOpen": 0.16,
        "mouthFunnel": 0.55,
        "mouthPucker": 0.35,
    },
    "viseme_PP": {
        "mouthPressLeft": 0.85,
        "mouthPressRight": 0.85,
        "jawOpen": 0.02,
        "mouthClose": 0.35,
    },
    "viseme_FF": {
        "mouthPressLeft": 0.45,
        "mouthPressRight": 0.45,
        "mouthUpperUpLeft": 0.4,
        "mouthUpperUpRight": 0.4,
        "jawOpen": 0.05,
    },
    "viseme_TH": {
        "jawOpen": 0.1,
        "tongueOut": 0.55,
        "mouthStretchLeft": 0.22,
        "mouthStretchRight": 0.22,
    },
    "viseme_DD": {
        "jawOpen": 0.14,
        "mouthLowerDownLeft": 0.35,
        "mouthLowerDownRight": 0.35,
    },
    "viseme_kk": {
        "jawOpen": 0.18,
        "mouthOpen": 0.1,
    },
    "viseme_nn": {
        "jawOpen": 0.08,
        "mouthLowerDownLeft": 0.22,
        "mouthLowerDownRight": 0.22,
    },
    "viseme_RR": {
        "jawOpen": 0.12,
        "mouthPucker": 0.4,
        "mouthFunnel": 0.25,
    },
}

# If mouthOpen is missing, bake a readable stand-in from jaw + lips.
MOUTH_OPEN_RECIPE = {
    "jawOpen": 0.55,
    "mouthLowerDownLeft": 0.4,
    "mouthLowerDownRight": 0.4,
}


def argv_paths() -> tuple[Path, Path]:
    argv = sys.argv
    if "--" in argv:
        args = argv[argv.index("--") + 1 :]
    else:
        args = []
    if len(args) < 2:
        raise SystemExit("Usage: blender --background --python bake_visemes.py -- in.glb out.glb")
    return Path(args[0]), Path(args[1])


def zero_keys(obj: bpy.types.Object) -> None:
    kb = obj.data.shape_keys.key_blocks
    for key in kb:
        if key.name != "Basis":
            key.value = 0.0


def apply_recipe(obj: bpy.types.Object, recipe: dict[str, float]) -> int:
    kb = obj.data.shape_keys.key_blocks
    used = 0
    for name, weight in recipe.items():
        if name in kb:
            kb[name].value = float(weight)
            used += 1
    return used


def replace_shape_from_mix(obj: bpy.types.Object, name: str) -> None:
    kb = obj.data.shape_keys.key_blocks
    # Remove existing target so from_mix captures only the ARKit mix.
    if name in kb:
        obj.shape_key_remove(kb[name])
    bpy.context.view_layer.update()
    key = obj.shape_key_add(name=name, from_mix=True)
    key.value = 0.0


def bake_mesh(obj: bpy.types.Object) -> list[str]:
    if obj.type != "MESH" or not obj.data.shape_keys:
        return []
    kb = obj.data.shape_keys.key_blocks
    names = {k.name for k in kb}
    # Need at least one mouth/jaw driver to bake from.
    drivers = (
        "jawOpen",
        "mouthFunnel",
        "mouthPucker",
        "mouthPressLeft",
        "mouthStretchLeft",
        "mouthLowerDownLeft",
        "mouthOpen",
    )
    if not any(d in names for d in drivers):
        return []

    made: list[str] = []
    # Ensure mouthOpen exists for runtime helpers.
    if "mouthOpen" not in names and "jawOpen" in names:
        zero_keys(obj)
        if apply_recipe(obj, MOUTH_OPEN_RECIPE):
            replace_shape_from_mix(obj, "mouthOpen")
            made.append("mouthOpen")
        zero_keys(obj)
        names = {k.name for k in obj.data.shape_keys.key_blocks}

    for viseme, recipe in RECIPES.items():
        zero_keys(obj)
        # Don't include any existing viseme keys in the mix.
        used = apply_recipe(obj, recipe)
        if not used and viseme != "viseme_sil":
            # Teeth-only meshes often only have jaw* — still bake jaw-driven ones.
            jaw_only = {k: v for k, v in recipe.items() if k.startswith("jaw") and k in names}
            if not jaw_only and "jawOpen" in names and any(
                k in recipe for k in ("jawOpen", "mouthOpen")
            ):
                jaw_only = {"jawOpen": recipe.get("jawOpen", 0.2)}
            used = apply_recipe(obj, jaw_only)
        if viseme == "viseme_sil" or used:
            replace_shape_from_mix(obj, viseme)
            made.append(viseme)
        zero_keys(obj)
    return made


def main() -> None:
    src, dst = argv_paths()
    if not src.exists():
        raise SystemExit(f"Missing input: {src}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(src))

    report = []
    for obj in list(bpy.data.objects):
        made = bake_mesh(obj)
        if made:
            report.append(f"{obj.name}: {', '.join(made)}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    # Export GLB; keep morphs.
    bpy.ops.export_scene.gltf(
        filepath=str(dst),
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_morph=True,
        export_skins=True,
        export_apply=False,
    )

    print("===BAKE_DONE===")
    print(f"in={src}")
    print(f"out={dst}")
    if report:
        for line in report:
            print(line)
    else:
        print("WARNING: no meshes received baked visemes")


if __name__ == "__main__":
    main()
