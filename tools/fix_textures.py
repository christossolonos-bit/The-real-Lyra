# Run with normal python. Uses work/*_color.npy (+ pos maps) from lyra_v2 to make clean v3 textures.
import numpy as np, cv2
W = r"D:/Lyra Real AI/model/work"; T = r"D:/Lyra Real AI/model/textures"
TOP = np.array([0.055, 0.25, 0.30])

def covered(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    neck = np.where(y < 0.06, 1.315 + 4.5 * x * x, 1.40 + 2.0 * x * x)
    lim = np.where(np.abs(x) < 0.17, neck, 1.47)
    return z <= lim

def to8(rgb): return (np.clip(rgb, 0, 1)[..., ::-1] * 255).astype(np.uint8)
def from8(b): return b[..., ::-1].astype(np.float32) / 255

def shade_teal(rgb):
    lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    return TOP * (0.85 + 0.15 * np.clip(lum / 0.55, 0, 1.2))[..., None]

# ---------- head: chest "bib" only (largest connected region in the neck band) ----------
c = np.load(f"{W}/f018_head_color.npy"); p = np.load(f"{W}/f018_head_pos.npy")
rgb = c[..., :3].copy(); valid = ~np.isnan(p[..., 2]); z = np.nan_to_num(p[..., 2], nan=9)
band = valid & (z < 1.47)
n, lab, stats, _ = cv2.connectedComponentsWithStats(band.astype(np.uint8), 8)
big = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA]); bib = lab == big
print("bib px", bib.sum(), "components", n - 1)
cov = bib & covered(np.nan_to_num(p, nan=9))
rgb[cov] = shade_teal(rgb[cov])
# leftover dark collar bits on visible bib skin -> inpaint from the skin around them
lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
sat = rgb.max(-1) - rgb.min(-1)
dark = bib & ~cov & ((lum < 0.3) | (sat < 0.08))
mask = cv2.dilate(dark.astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
mask[~bib] = 0
rgb = from8(cv2.inpaint(to8(rgb), mask, 9, cv2.INPAINT_TELEA))
# a soft dark seam line where the top meets skin, like a fabric edge
edge = cv2.morphologyEx(cov.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(bool) & cov
rgb[edge] *= 0.8
out = np.concatenate([rgb, c[..., 3:]], -1)
np.save(f"{W}/head_v3.npy", out)

# ---------- body: pink bikini straps / dark cord on visible skin -> skin ----------
c = np.load(f"{W}/f021_body_color.npy"); p = np.load(f"{W}/f021_body_pos.npy")
rgb = c[..., :3].copy(); valid = ~np.isnan(p[..., 2]); pp = np.nan_to_num(p, nan=9)
cov = valid & covered(pp) & (pp[..., 2] > 0.075)
vis = valid & ~cov & (pp[..., 2] > 1.2)
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
pink = (r - g > 0.22) & (b > g + 0.02)
dark = lum < 0.28
bad = vis & (pink | dark)
mask = cv2.dilate(bad.astype(np.uint8) * 255, np.ones((5, 5), np.uint8)); mask[~vis] = 0
print("body strap px", bad.sum())
rgb = from8(cv2.inpaint(to8(rgb), mask, 9, cv2.INPAINT_TELEA))
edge = cv2.morphologyEx(cov.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(bool) & cov & (pp[..., 2] > 1.2)
rgb[edge] *= 0.8
np.save(f"{W}/body_v3.npy", np.concatenate([rgb, c[..., 3:]], -1))
for nm in ("head_v3", "body_v3"):
    a = np.load(f"{W}/{nm}.npy")[::-1]
    cv2.imwrite(f"{W}/{nm}_check.jpg", cv2.resize(to8(a[..., :3]), (1024, 1024)))
