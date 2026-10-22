"""
Step In / Step Out: one photo in, two Gaussian splats out.

  Step In   the whole scene, with the background behind the people filled in
  Step Out  just the people, as a floating cutout

Every model here allows commercial use:
  MoGe-2 (Microsoft, MIT)            depth + lens for every pixel
  Mask R-CNN (torchvision, BSD-3)    finds every person in the photo
  BiRefNet via rembg (MIT)           fine, soft edges for the cutout
  LaMa (Apache 2.0)                  paints in the background hidden behind people

Saved splat files are upright: y up, the original camera at the origin looking
down +z (SHARP's OpenCV layout turned 180° around z). Viewers and SuperSplat show
them right side up with no flip, compressed or not.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

MOGE_CKPT = "Ruicheng/moge-2-vitl-normal"
LAMA_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"
SH0 = 0.28209479177387814
COCO_PERSON = 1


# ------------------------------------------------------------------ settings
@dataclass
class Settings:
    size: int = 1024             # longest side the photo is processed at
    bg_stride: int = 2           # background detail: 1 = every pixel, 2 = every other
    grow: float = 1.2            # repaint this far past the people, % of image size
    cutout: str = "people"       # "people" (every person) or "subject" (main object)
    min_person: float = 0.12     # ignore people shorter than this fraction of the photo
    person_score: float = 0.6    # how sure the detector must be that it's a person
    birefnet: str = "birefnet-general"
    max_people_splats: int = 200_000  # above this, the people layer uses every other pixel


@dataclass
class Moment:
    step_in: dict                # splat arrays for the whole scene
    step_out: dict | None        # splat arrays for the people only (None if no people)
    in_frame: dict               # framing hints for viewers
    out_frame: dict | None
    people: int
    timings: dict = field(default_factory=dict)
    debug: dict = field(default_factory=dict)


# ------------------------------------------------------------------ models
def pick_device(requested: str = "auto"):
    import torch
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def lama_checkpoint() -> Path:
    from torch.hub import download_url_to_file, get_dir
    ckpt = Path(get_dir()) / "checkpoints" / "big-lama.pt"
    if not ckpt.exists():
        ckpt.parent.mkdir(parents=True, exist_ok=True)
        download_url_to_file(LAMA_URL, str(ckpt), progress=False)
    return ckpt


def download_all(birefnet: str = "birefnet-general") -> None:
    """Fetch every model once (used when building the cloud image)."""
    import torchvision
    from moge.model.v2 import MoGeModel
    from rembg import new_session
    MoGeModel.from_pretrained(MOGE_CKPT)
    new_session(birefnet)
    lama_checkpoint()
    torchvision.models.detection.maskrcnn_resnet50_fpn_v2(
        weights=torchvision.models.detection.MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT)


class Models:
    """Loads each model once; reuse it for every photo."""

    def __init__(self, device=None, settings: Settings | None = None, log=print):
        import torch
        self.torch = torch
        self.s = settings or Settings()
        self.device = device or pick_device()
        self.log = log

        log("Loading MoGe-2 (depth)…")
        from moge.model.v2 import MoGeModel
        self.moge = MoGeModel.from_pretrained(MOGE_CKPT).to(self.device).eval()

        log("Loading person finder…")
        import torchvision
        w = torchvision.models.detection.MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT
        self.det_device = self.device if self.device.type == "cuda" else torch.device("cpu")
        self.detector = torchvision.models.detection.maskrcnn_resnet50_fpn_v2(weights=w).to(self.det_device).eval()

        log(f"Loading BiRefNet ({self.s.birefnet})…")
        if self.device.type == "cuda":
            try:  # let onnxruntime find the CUDA libraries that came with torch
                import onnxruntime as ort
                ort.preload_dlls()
            except Exception:
                pass
        from rembg import new_session
        self.birefnet = new_session(self.s.birefnet)

        log("Loading LaMa (background fill)…")
        ckpt = lama_checkpoint()
        self.lama_device = self.device
        try:
            self.lama = torch.jit.load(str(ckpt), map_location=self.device).eval()
        except Exception:
            self.lama_device = torch.device("cpu")
            self.lama = torch.jit.load(str(ckpt), map_location="cpu").eval()

    # depth (H, W), valid (H, W), normalized fx, fy
    def depth(self, img: Image.Image, fov_x: float | None = None):
        torch = self.torch
        x = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0).permute(2, 0, 1).to(self.device)
        with torch.inference_mode():
            out = self.moge.infer(x, apply_mask=False, fov_x=fov_x, use_fp16=self.device.type == "cuda")
        d = out["depth"].float().cpu().numpy()
        valid = out["mask"].cpu().numpy().astype(bool) if "mask" in out else np.isfinite(d)
        K = out["intrinsics"].float().cpu().numpy()
        return d, valid, float(K[0, 0]), float(K[1, 1])

    # soft mask of the main subject, 0..1
    def subject(self, img: Image.Image) -> np.ndarray:
        return np.asarray(self.birefnet.predict(img)[0], dtype=np.float32) / 255.0

    # soft mask of every person, 0..1, and how many were found
    def persons(self, img: Image.Image):
        torch = self.torch
        h = img.height
        x = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0).permute(2, 0, 1).to(self.det_device)
        with torch.inference_mode():
            out = self.detector([x])[0]
        keep = (out["labels"] == COCO_PERSON) & (out["scores"] >= self.s.person_score)
        boxes = out["boxes"][keep].cpu().numpy()
        masks = out["masks"][keep, 0].cpu().numpy()
        tall = (boxes[:, 3] - boxes[:, 1]) >= self.s.min_person * h if len(boxes) else np.zeros(0, bool)
        masks = masks[tall]
        if not len(masks):
            return np.zeros((img.height, img.width), np.float32), 0
        return masks.max(0).astype(np.float32), int(len(masks))

    # people cutout: the person finder decides WHO, BiRefNet draws the fine edges
    def cutout(self, img: Image.Image):
        sal = self.subject(img)
        if self.s.cutout == "subject":
            return sal, int((sal > 0.5).any())
        people, n = self.persons(img)
        if n == 0:
            return np.zeros_like(sal), 0
        grow = max(3, round(max(img.size) * 0.02))
        zone = ndimage.binary_dilation(people > 0.5, iterations=grow)
        # The person finder's outline is blobby and drags in background (grass, walls).
        # Use only its inner core, for people BiRefNet missed; BiRefNet draws the edges.
        core = ndimage.binary_erosion(people > 0.5, iterations=max(2, round(max(img.size) * 0.012)))
        return np.maximum(sal * zone, core.astype(np.float32)).astype(np.float32), n

    def fill(self, img: Image.Image, hole: np.ndarray) -> Image.Image:
        torch = self.torch
        arr = np.asarray(img, dtype=np.float32).transpose(2, 0, 1) / 255.0
        m = hole[None].astype(np.float32)
        h, w = hole.shape
        ph, pw = (-h) % 8, (-w) % 8
        arr = np.pad(arr, ((0, 0), (0, ph), (0, pw)), mode="symmetric")
        m = np.pad(m, ((0, 0), (0, ph), (0, pw)), mode="symmetric")

        def run(device):
            ti = torch.from_numpy(arr)[None].to(device)
            tm = (torch.from_numpy(m)[None].to(device) > 0) * 1
            with torch.inference_mode():
                return self.lama(ti, tm)[0].permute(1, 2, 0).float().cpu().numpy()

        try:
            out = run(self.lama_device)
        except Exception:
            if self.lama_device.type == "cpu":
                raise
            self.lama = self.lama.to("cpu")
            self.lama_device = torch.device("cpu")
            out = run(self.lama_device)
        return Image.fromarray(np.clip(out[:h, :w] * 255, 0, 255).astype(np.uint8))


# ------------------------------------------------------------------ geometry
def prepare_image(img: Image.Image, long_side: int) -> Image.Image:
    img = ImageOps.exif_transpose(img).convert("RGB")
    scale = long_side / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
    return img


def fill_invalid_depth(depth, valid):
    """Sky and other 'no surface' pixels go on a far backdrop instead of infinity."""
    d = depth.copy()
    good = valid & np.isfinite(d) & (d > 0)
    if good.sum() < 100:
        raise RuntimeError("Couldn't read depth from this photo.")
    far = np.percentile(d[good], 99) * 1.4
    d[~good] = far
    return np.minimum(d, far)


def edge_safe_depth(depth, solid, band):
    """Cutout edges blend person and background depth. Give them the nearest solid person depth."""
    d = depth.copy()
    if solid.any() and band.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
        d[band] = depth[iy[band], ix[band]]
    return d


def pixels_to_splats(depth, colors, opacity, select, fx_n, fy_n, stride, size_boost=1.0):
    h, w = depth.shape
    ys, xs = np.mgrid[0:h:stride, 0:w:stride]
    keep = select[ys, xs]
    ys, xs = ys[keep], xs[keep]
    z = depth[ys, xs]
    fx, fy = fx_n * w, fy_n * h
    x = ((xs + 0.5) - 0.5 * w) / fx * z
    y = ((ys + 0.5) - 0.5 * h) / fy * z
    sxy = np.maximum(z / fx * stride * 0.62 * size_boost, 1e-5)
    a = opacity[ys, xs] if isinstance(opacity, np.ndarray) else np.full(len(z), opacity, np.float32)
    return dict(xyz=np.stack([x, y, z], 1).astype(np.float32), rgb=colors[ys, xs].astype(np.float32),
                alpha=np.clip(a, 0.02, 0.995).astype(np.float32), sxy=sxy.astype(np.float32),
                sz=(sxy * 0.25).astype(np.float32))


def merge(*parts):
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def frame_hints(s: dict, centered: bool) -> dict:
    """What a viewer needs to frame the splat: orbit pivot depth, view center, extents.
    All as tangents (x/z, y/z) in the saved file's upright layout."""
    xyz = s["xyz"] * np.array([-1, -1, 1], np.float32)
    z = xyz[:, 2]
    ok = z > 1e-3
    tx, ty, z = xyz[ok, 0] / z[ok], xyz[ok, 1] / z[ok], z[ok]
    cx = float(np.median(tx)) if centered else 0.0
    cy = float(np.median(ty)) if centered else 0.0
    return {
        "pivot": round(float(np.percentile(z, 50 if centered else 35)), 4),
        "cx": round(cx, 4), "cy": round(cy, 4),
        "tanH": round(float(np.percentile(np.abs(tx - cx), 97)), 4),
        "tanV": round(float(np.percentile(np.abs(ty - cy), 97)), 4),
        "convention": "upright",
    }


def write_ply(path: Path, s: dict) -> int:
    n = len(s["alpha"])
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, 14), dtype=np.float32)
    data[:, 0:3] = s["xyz"] * np.array([-1, -1, 1], np.float32)  # OpenCV -> upright
    data[:, 3:6] = (s["rgb"] - 0.5) / SH0
    a = s["alpha"]
    data[:, 6] = np.log(a / (1 - a))
    data[:, 7] = np.log(s["sxy"])
    data[:, 8] = np.log(s["sxy"])
    data[:, 9] = np.log(s["sz"])
    data[:, 10] = 1.0
    header = ("ply\nformat binary_little_endian 1.0\n"
              "comment Get2Share Step In (MoGe-2 + Mask R-CNN + BiRefNet + LaMa)\n"
              f"element vertex {n}\n" + "".join(f"property float {p}\n" for p in names) + "end_header\n")
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())
    return n


def compress(src: Path, dst: Path) -> bool:
    """Shrink a .ply about 4× with PlayCanvas splat-transform, if it's installed."""
    import shutil
    import subprocess
    exe = shutil.which("splat-transform")
    cmd = [exe] if exe else (["npx", "--yes", "@playcanvas/splat-transform@3.8.0"] if shutil.which("npx") else None)
    if not cmd:
        return False
    r = subprocess.run(cmd + [str(src), str(dst)], capture_output=True, text=True)
    return r.returncode == 0 and dst.exists()


# ------------------------------------------------------------------ the pipeline
def make_moment(img: Image.Image, models: Models, debug: bool = False) -> Moment:
    s = models.s
    t0 = last = time.perf_counter()
    timings: dict = {}

    def lap(k):
        nonlocal last
        now = time.perf_counter()
        timings[k] = round(now - last, 2)
        last = now

    img = prepare_image(img, s.size)
    rgb = np.asarray(img, dtype=np.float32) / 255.0
    h, w = rgb.shape[:2]

    depth, valid, fx_n, fy_n = models.depth(img)
    depth = fill_invalid_depth(depth, valid)
    fov_x = float(np.degrees(2 * np.arctan(0.5 / fx_n)))
    lap("depth")

    alpha, people = models.cutout(img)
    has_people = people > 0 and (alpha > 0.5).mean() > 0.003
    lap("cutout")

    grow = max(3, round(max(h, w) * s.grow / 100))
    hole = ndimage.binary_dilation(alpha > 0.08, iterations=grow) if has_people else np.zeros((h, w), bool)
    filled = models.fill(img, hole) if hole.any() else img
    lap("fill")

    if hole.any():
        bg_depth, bg_valid, _, _ = models.depth(filled, fov_x=fov_x)
        bg_depth = fill_invalid_depth(bg_depth, bg_valid)
        ref = ~hole & valid
        if ref.sum() > 500:
            bg_depth *= float(np.median(depth[ref] / bg_depth[ref]))
        # Use the people-free depth for the whole background, not just the hole: the original
        # depth blurs across people's outlines and leaves splats floating mid-air there.
        bg_depth = np.where(hole, np.maximum(bg_depth, depth * 1.02), bg_depth)
    else:
        bg_depth = depth
    lap("background depth")

    background = pixels_to_splats(bg_depth, np.asarray(filled, dtype=np.float32) / 255.0, 0.99,
                                  np.ones((h, w), bool), fx_n, fy_n, stride=s.bg_stride, size_boost=1.25)
    people_splats = None
    if has_people:
        fg_select = alpha > 0.15  # faint edge pixels are mostly old background color
        solid = ndimage.binary_erosion(alpha > 0.9, iterations=2)
        fg_depth = edge_safe_depth(depth, solid, fg_select & ~solid)
        fg_rgb = rgb
        try:  # keep the old background from bleeding into soft edges
            from pymatting import estimate_foreground_ml
            fg_rgb = np.clip(estimate_foreground_ml(rgb.astype(np.float64), alpha.astype(np.float64)), 0, 1).astype(np.float32)
        except Exception:
            pass
        # Close-ups can be mostly people; thin them out so files stay small for phones and TVs
        fg_stride = 1 if fg_select.sum() <= s.max_people_splats else 2
        people_splats = pixels_to_splats(fg_depth, fg_rgb, alpha, fg_select, fx_n, fy_n,
                                         stride=fg_stride, size_boost=1.0 if fg_stride == 1 else 1.15)
    lap("splats")

    step_in = merge(background, people_splats) if people_splats else background
    timings["total"] = round(time.perf_counter() - t0, 2)
    dbg = {}
    if debug:
        dbg = {"cutout": Image.fromarray((alpha * 255).astype(np.uint8)), "filled": filled,
               "depth": Image.fromarray((255 * (1 - np.clip((depth - depth.min()) / max(1e-6, np.percentile(depth, 98) - depth.min()), 0, 1))).astype(np.uint8))}
    return Moment(step_in=step_in, step_out=people_splats,
                  in_frame=frame_hints(step_in, centered=False),
                  out_frame=frame_hints(people_splats, centered=True) if people_splats else None,
                  people=people if has_people else 0, timings=timings, debug=dbg)
