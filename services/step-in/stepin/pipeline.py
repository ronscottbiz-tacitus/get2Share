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
COCO_CAT, COCO_DOG = 17, 18
SUBJECT_LABELS = (COCO_PERSON, COCO_CAT, COCO_DOG)  # Step Out cuts out people and pets


# ------------------------------------------------------------------ settings
@dataclass
class Settings:
    size: int = 1536             # longest side the photo is processed at
    bg_stride: float = 2.5       # background detail in pixels per splat (people are 1)
    grow: float = 1.2            # repaint this far past the people, % of image size
    cutout: str = "people"       # "people" (every person) or "subject" (main object)
    min_person: float = 0.08     # ignore people shorter than this fraction of the photo
    person_score: float = 0.4    # how sure the detector must be that it's a person (low: keep people half-hidden behind others)
    birefnet: str = "birefnet-general"
    max_people_splats: int = 360_000  # above this, the people layer is thinned evenly to fit
    edge_jump: float = 0.02      # a depth jump bigger than this (2%) between neighbor pixels is an edge


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
        labels = out["labels"].cpu().numpy()
        is_subject = np.isin(labels, SUBJECT_LABELS)
        keep = torch.from_numpy(is_subject).to(out["scores"].device) & (out["scores"] >= self.s.person_score)
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


def snap_depth_edges(depth, jump=0.02, window=5):
    """Where depth jumps (one person in front of another, a head against the wall), pixels on
    the boundary get a depth in between and float in mid-air, which shows as slivers when the
    camera moves. Snap each boundary pixel to the near or far side, whichever it's closer to."""
    d = depth.astype(np.float32)
    gy = np.abs(np.diff(d, axis=0, prepend=d[:1]))
    gx = np.abs(np.diff(d, axis=1, prepend=d[:, :1]))
    edge = np.maximum(gx, gy) > jump * d
    if not edge.any():
        return d, edge
    edge = ndimage.binary_dilation(edge, iterations=window // 2)
    lo = ndimage.minimum_filter(d, size=window)
    hi = ndimage.maximum_filter(d, size=window)
    snapped = np.where(d - lo < hi - d, lo, hi)
    return np.where(edge, snapped, d), edge


def camera_points(depth, fx_n, fy_n):
    """(H, W, 3) camera-space points, OpenCV layout (x right, y down, z forward)."""
    h, w = depth.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    z = depth.astype(np.float32)
    x = ((xs + 0.5) - 0.5 * w) / (fx_n * w) * z
    y = ((ys + 0.5) - 0.5 * h) / (fy_n * h) * z
    return np.stack([x, y, z], -1)


def surface_normals(points, edge=None):
    """Unit normals facing the camera, from the point map. Across depth edges, and on
    surfaces seen nearly edge-on, they lean back toward the camera so splats don't vanish."""
    p = ndimage.gaussian_filter(points, sigma=(1.2, 1.2, 0))
    du = np.gradient(p, axis=1)
    dv = np.gradient(p, axis=0)
    n = np.cross(du, dv)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12
    view = points / (np.linalg.norm(points, axis=-1, keepdims=True) + 1e-12)
    facing = np.sum(n * view, axis=-1, keepdims=True)
    n = np.where(facing > 0, -n, n)  # face the camera
    cos = np.abs(facing)
    toward = -view
    # Mostly the real surface; blend toward the camera where it's nearly edge-on or at an edge.
    t = np.clip((0.45 - cos) / 0.3, 0, 1)
    if edge is not None:
        t = np.maximum(t, edge[..., None].astype(np.float32))
    n = n * (1 - t) + toward * t
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12
    return n, np.abs(np.sum(n * view, axis=-1))


def quat_z_to(n):
    """Quaternions (w, x, y, z) that turn +z onto each normal: flat splats lie on the surface."""
    m = np.where(n[:, 2:3] < 0, -n, n)  # a flat disc looks the same from both sides
    q = np.stack([1 + m[:, 2], -m[:, 1], m[:, 0], np.zeros(len(m), np.float32)], 1)
    return (q / (np.linalg.norm(q, axis=1, keepdims=True) + 1e-12)).astype(np.float32)


def sample_grid(h, w, step):
    """Pixel rows and columns every `step` pixels (step can be fractional)."""
    ys = np.unique(np.minimum(h - 1, np.round(np.arange(0, h, step)).astype(int)))
    xs = np.unique(np.minimum(w - 1, np.round(np.arange(0, w, step)).astype(int)))
    return np.meshgrid(ys, xs, indexing="ij")


def pixels_to_splats(depth, colors, opacity, select, fx_n, fy_n, stride, size_boost=1.0, edge=None):
    """One flat splat per sampled pixel, lying on the surface (from the depth's normals)."""
    h, w = depth.shape
    pts = camera_points(depth, fx_n, fy_n)
    normals, facing = surface_normals(pts, edge)
    ys, xs = sample_grid(h, w, stride)
    keep = select[ys, xs]
    ys, xs = ys[keep], xs[keep]
    z = depth[ys, xs]
    # Big enough to cover the pixel's footprint even where the surface turns away from us.
    sxy = np.maximum(z / (fx_n * w) * stride * 0.62 * size_boost / np.maximum(facing[ys, xs], 0.45), 1e-5)
    a = opacity[ys, xs] if isinstance(opacity, np.ndarray) else np.full(len(z), opacity, np.float32)
    # A perfectly regular grid of splats turns into a visible grid pattern once the file is
    # compressed (positions are rounded). A small random nudge within each pixel hides it.
    rng = np.random.default_rng(0)
    nudge = (rng.random((len(z), 2), dtype=np.float32) - 0.5) * 0.5 * stride
    xyz = pts[ys, xs].copy()
    xyz[:, 0] += nudge[:, 0] * z / (fx_n * w)
    xyz[:, 1] += nudge[:, 1] * z / (fy_n * h)
    return dict(xyz=xyz.astype(np.float32), rgb=colors[ys, xs].astype(np.float32),
                alpha=np.clip(a, 0.02, 0.995).astype(np.float32), sxy=sxy.astype(np.float32),
                sz=(sxy * 0.12).astype(np.float32), rot=quat_z_to(normals[ys, xs]))


def merge(*parts):
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def frame_hints(s: dict, centered: bool, photo_tan: tuple[float, float] | None = None) -> dict:
    """What a viewer needs to frame the splat: orbit pivot depth, view center, extents.
    All as tangents (x/z, y/z) in the saved file's upright layout. For Step In, photo_tan
    gives the photo's exact edges, so the first frame lines up with the photo."""
    xyz = s["xyz"] * np.array([-1, -1, 1], np.float32)
    z = xyz[:, 2]
    ok = z > 1e-3
    tx, ty, z = xyz[ok, 0] / z[ok], xyz[ok, 1] / z[ok], z[ok]
    cx = float(np.median(tx)) if centered else 0.0
    cy = float(np.median(ty)) if centered else 0.0
    tan_h = photo_tan[0] if photo_tan else float(np.percentile(np.abs(tx - cx), 97))
    tan_v = photo_tan[1] if photo_tan else float(np.percentile(np.abs(ty - cy), 97))
    return {
        "pivot": round(float(np.percentile(z, 50 if centered else 35)), 4),
        "cx": round(cx, 4), "cy": round(cy, 4),
        "tanH": round(tan_h, 4), "tanV": round(tan_v, 4),
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
    # Rotations are in OpenCV layout; turning the scene 180° about z maps (w, x, y, z) to (w, -x, -y, z).
    rot = s.get("rot")
    if rot is None:
        data[:, 10] = 1.0
    else:
        data[:, 10:14] = rot * np.array([1, -1, -1, 1], np.float32)
    header = ("ply\nformat binary_little_endian 1.0\n"
              "comment Get2Share Step In (MoGe-2 + Mask R-CNN + BiRefNet + LaMa)\n"
              f"element vertex {n}\n" + "".join(f"property float {p}\n" for p in names) + "end_header\n")
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())
    return n


def compress(src: Path, dst: Path) -> bool:
    """Shrink a .ply with PlayCanvas splat-transform, if it's installed. The output format
    follows dst's extension: .sog (about 15-20x smaller, what the app uses) or
    .compressed.ply (about 4x smaller, opens in more tools)."""
    import shutil
    import subprocess
    exe = shutil.which("splat-transform")
    cmd = [exe] if exe else (["npx", "--yes", "@playcanvas/splat-transform@3.8.0"] if shutil.which("npx") else None)
    if not cmd:
        return False
    r = subprocess.run(cmd + ["-w", str(src), str(dst)], capture_output=True, text=True)
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

    bg_depth, bg_edge = snap_depth_edges(bg_depth, s.edge_jump)
    background = pixels_to_splats(bg_depth, np.asarray(filled, dtype=np.float32) / 255.0, 0.99,
                                  np.ones((h, w), bool), fx_n, fy_n, stride=s.bg_stride, size_boost=1.25,
                                  edge=bg_edge)
    people_splats = None
    if has_people:
        fg_select = alpha > 0.15  # faint edge pixels are mostly old background color
        solid = ndimage.binary_erosion(alpha > 0.9, iterations=2)
        fg_depth = edge_safe_depth(depth, solid, fg_select & ~solid)
        # Where one person stands in front of another, split the boundary cleanly. Outside the
        # cutout, extend the people's own depth so their outline isn't treated as an edge.
        _, (iy, ix) = ndimage.distance_transform_edt(~fg_select, return_indices=True)
        fg_depth, fg_edge = snap_depth_edges(fg_depth[iy, ix], s.edge_jump)
        fg_rgb = rgb
        try:  # keep the old background from bleeding into soft edges
            from pymatting import estimate_foreground_ml
            fg_rgb = np.clip(estimate_foreground_ml(rgb.astype(np.float64), alpha.astype(np.float64)), 0, 1).astype(np.float32)
        except Exception:
            pass
        # Close-ups can be mostly people; thin them out evenly so files stay small for phones and TVs
        n_people = int(fg_select.sum())
        fg_stride = 1.0 if n_people <= s.max_people_splats else float(np.sqrt(n_people / s.max_people_splats))
        people_splats = pixels_to_splats(fg_depth, fg_rgb, alpha, fg_select, fx_n, fy_n,
                                         stride=fg_stride, size_boost=1.25 if fg_stride == 1 else 1.35,
                                         edge=fg_edge)
    lap("splats")

    step_in = merge(background, people_splats) if people_splats else background
    timings["total"] = round(time.perf_counter() - t0, 2)
    dbg = {}
    if debug:
        dbg = {"cutout": Image.fromarray((alpha * 255).astype(np.uint8)), "filled": filled,
               "depth": Image.fromarray((255 * (1 - np.clip((depth - depth.min()) / max(1e-6, np.percentile(depth, 98) - depth.min()), 0, 1))).astype(np.uint8))}
    return Moment(step_in=step_in, step_out=people_splats,
                  in_frame=frame_hints(step_in, centered=False, photo_tan=(0.5 / fx_n, 0.5 / fy_n)),
                  out_frame=frame_hints(people_splats, centered=True) if people_splats else None,
                  people=people if has_people else 0, timings=timings, debug=dbg)
