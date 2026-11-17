# Clean Adult_01 head texture: chestnut scalp hair, remove pink collar on the neck/chest bib.
import numpy as np, cv2
W = r"D:/Lyra Real AI/model/work"; T = r"D:/Lyra Real AI/model/textures"
c = np.load(f"{W}/f001_head_color.npy"); p = np.load(f"{W}/f001_head_pos.npy")
rgb = c[..., :3].copy(); valid = ~np.isnan(p[..., 2]); pp = np.nan_to_num(p, nan=-9)
x, y, z = pp[..., 0], pp[..., 1], pp[..., 2]
lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)

# --- scalp hair -> chestnut (same mapping as the long hair) ---
scalp = valid & ((z > 1.70) | ((y > 0.075) & (z > 1.50)) | ((np.abs(x) > 0.07) & (z > 1.66) & (y > 0.0)))
t = np.clip(lum / max(np.percentile(lum[scalp], 99), 1e-3), 0, 1)[..., None] ** 0.9
dark = np.array([0.13, 0.075, 0.04]); light = np.array([0.62, 0.41, 0.22])
hair = dark + (light - dark) * t
# soft blend at the hairline
soft = cv2.GaussianBlur(scalp.astype(np.float32), (0, 0), 6)[..., None]
soft = np.where(valid[..., None], soft, 0)
rgb = rgb * (1 - soft) + hair * soft

# --- collar on the bib (below the chin): pink / dark / desaturated fabric -> skin by inpainting ---
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
neck = valid & (z < 1.47)
pink = (r - g > 0.22) & (b > g + 0.02)
bad = neck & (pink | (lum < 0.3))
mask = cv2.dilate(bad.astype(np.uint8) * 255, np.ones((7, 7), np.uint8)); mask[~valid] = 0
print("scalp px", scalp.sum(), "collar px", bad.sum())
to8 = lambda a: (np.clip(a, 0, 1)[..., ::-1] * 255).astype(np.uint8)
fixed = cv2.inpaint(to8(rgb), mask, 11, cv2.INPAINT_TELEA)[..., ::-1].astype(np.float32) / 255
out = np.concatenate([fixed, c[..., 3:]], -1)[::-1]
cv2.imwrite(f"{T}/lyra_head01_v7.png", cv2.cvtColor((np.clip(out, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGBA2BGRA))
cv2.imwrite(f"{W}/head01_check.jpg", cv2.resize(to8(out[..., :3]), (1024, 1024)))
