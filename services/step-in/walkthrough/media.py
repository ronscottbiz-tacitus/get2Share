"""Frames and video: crop photos to shape, make non-AI segments, join clips, burn in the label."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

from .config import LABEL, LABEL_LINES, size_for

FPS = 24
FONT_CANDIDATES = (
    os.environ.get("WALKTHROUGH_FONT", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # fonts-dejavu-core, in the Modal image
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",     # a Mac, for local runs
)


class MediaError(Exception):
    pass


def font_path() -> str:
    for candidate in FONT_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    # Never fall back to an unlabeled video.
    raise MediaError("No font found for the AI label.")


def _run(cmd: list[str], timeout: int = 300) -> None:
    done = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if done.returncode != 0:
        raise MediaError(f"{cmd[0]} failed: {done.stderr[-800:]}")


# ------------------------------------------------------------------ frames
def normalize_frame(img: Image.Image, aspect: str, resolution: str, out: str) -> tuple[int, int]:
    """Center-crop a photo to the video's shape and size, upright, as a JPEG."""
    w, h = size_for(aspect, resolution)
    img = ImageOps.exif_transpose(img).convert("RGB")
    ImageOps.fit(img, (w, h), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5)).save(out, "JPEG", quality=92)
    return w, h


# ------------------------------------------------------------------ non-AI segments
def crossfade_clip(start: str, end: str, out: str, seconds: float) -> None:
    """What the fake provider "generates": one frame fading into the other. Never paid for."""
    fade = max(0.5, seconds - 1)
    _run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-t", f"{seconds}", "-i", start,
        "-loop", "1", "-t", f"{seconds}", "-i", end,
        "-filter_complex", f"[0:v][1:v]xfade=transition=fade:duration={fade}:offset=0.5,format=yuv420p[v]",
        "-map", "[v]", "-t", f"{seconds}", "-r", str(FPS), "-c:v", "libx264", "-preset", "ultrafast", out,
    ])


def hold_clip(image: str, out: str, seconds: float, w: int, h: int, zoom: bool = False) -> None:
    """A still photo for a moment, optionally with a slow push in. No AI involved."""
    frames = max(1, round(seconds * FPS))
    if zoom:
        vf = (f"zoompan=z='min(1+0.0012*on,1.12)':d={frames}:s={w}x{h}:fps={FPS}:"
              "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", image, "-vf", f"{vf},format=yuv420p", "-frames:v", str(frames)]
    else:
        vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},format=yuv420p"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", image, "-vf", vf, "-frames:v", str(frames), "-r", str(FPS)]
    _run(cmd + ["-c:v", "libx264", "-preset", "ultrafast", out])


# ------------------------------------------------------------------ the label
def label_filter(w: int, h: int, text_dir: str) -> str:
    """drawtext filters for the label. Sized from the short side, clear of the edge (TVs crop
    edges and phones keep controls there). Text comes from files, so the apostrophe needs no
    escaping. One line on horizontal video; two on vertical, where one line wouldn't fit."""
    font = font_path()
    short = min(w, h)
    size = max(16, round(short * 0.036))
    pad = max(6, round(size * 0.42))
    line_gap = size + 2 * pad + max(2, round(size * 0.2))
    bottom = round(h * 0.07)
    lines = list(LABEL_LINES) if w < h else [LABEL]
    parts = []
    for i, line in enumerate(lines):
        path = Path(text_dir) / f"label-{i}.txt"
        path.write_text(line, encoding="utf-8")
        y = h - bottom - (len(lines) - i) * line_gap + pad
        parts.append(
            f"drawtext=fontfile={font}:textfile={path}:expansion=none:fontsize={size}:fontcolor=white:"
            f"box=1:boxcolor=black@0.62:boxborderw={pad}:x=(w-text_w)/2:y={y}"
        )
    return ",".join(parts)


# ------------------------------------------------------------------ joining
@dataclass(frozen=True)
class Segment:
    path: str
    seconds: float         # how much of the source to use
    slowdown: float = 1.0  # 2.0 plays at half speed, so it lasts twice as long

    @property
    def output_seconds(self) -> float:
        return self.seconds * self.slowdown


def join_segments(segments: list[Segment], out: str, aspect: str, resolution: str) -> None:
    """Re-encodes every segment to one MP4 that phones and TVs can play: H.264 in yuv420p,
    no audio track, the index at the front (faststart), and the label burned into every frame."""
    if not segments:
        raise MediaError("Nothing to join.")
    w, h = size_for(aspect, resolution)
    with tempfile.TemporaryDirectory() as td:
        inputs: list[str] = []
        parts: list[str] = []
        for i, s in enumerate(segments):
            inputs += ["-i", s.path]
            speed = f"setpts={s.slowdown:.4f}*PTS," if s.slowdown != 1.0 else ""
            parts.append(
                f"[{i}:v]trim=duration={s.seconds:.3f},setpts=PTS-STARTPTS,{speed}fps={FPS},"
                f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,format=yuv420p[v{i}]"
            )
        chain = "".join(f"[v{i}]" for i in range(len(segments)))
        graph = ";".join(parts) + f";{chain}concat=n={len(segments)}:v=1:a=0[joined];[joined]{label_filter(w, h, td)}[final]"
        _run([
            "ffmpeg", "-y", "-loglevel", "error", *inputs,
            "-filter_complex", graph, "-map", "[final]", "-an",
            "-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
            "-preset", "veryfast", "-crf", "20", "-g", str(FPS * 2),
            "-movflags", "+faststart", "-f", "mp4", out,
        ], timeout=900)


def poster_frame(video: str, out: str, at: float = 0.5) -> None:
    _run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{at}", "-i", video, "-frames:v", "1", "-q:v", "3", out])


# ------------------------------------------------------------------ checking
def probe(path: str) -> dict:
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        capture_output=True, text=True, timeout=60,
    )
    if done.returncode != 0:
        raise MediaError(f"ffprobe couldn't read the file: {done.stderr[-300:]}")
    info = json.loads(done.stdout)
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError("The file has no video.")
    return {
        "codec": video.get("codec_name"),
        "pix_fmt": video.get("pix_fmt"),
        "width": video.get("width"),
        "height": video.get("height"),
        "duration": float(info.get("format", {}).get("duration") or video.get("duration") or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in info.get("streams", [])),
    }


def moov_first(path: str) -> bool:
    """True if the MP4's index comes before its data (faststart), so it plays while downloading."""
    with open(path, "rb") as f:
        while True:
            head = f.read(8)
            if len(head) < 8:
                return False
            size = int.from_bytes(head[:4], "big")
            kind = head[4:8]
            if kind == b"moov":
                return True
            if kind == b"mdat":
                return False
            if size == 1:
                size = int.from_bytes(f.read(8), "big") - 8
            if size < 8:
                return False
            f.seek(size - 8, 1)


def check_final(path: str, aspect: str, resolution: str, expected_seconds: float, tolerance: float = 1.0) -> dict:
    """A video only reaches a host if it is what was promised. Raises MediaError otherwise."""
    info = probe(path)
    w, h = size_for(aspect, resolution)
    problems = []
    if info["codec"] != "h264":
        problems.append(f"codec {info['codec']}")
    if info["pix_fmt"] != "yuv420p":
        problems.append(f"pixels {info['pix_fmt']}")
    if (info["width"], info["height"]) != (w, h):
        problems.append(f"size {info['width']}x{info['height']}")
    if info["has_audio"]:
        problems.append("has audio")
    if not moov_first(path):
        problems.append("not faststart")
    if abs(info["duration"] - expected_seconds) > tolerance:
        problems.append(f"duration {info['duration']:.2f}, expected {expected_seconds:.2f}")
    if problems:
        raise MediaError("Finished video failed its check: " + ", ".join(problems))
    return info


def tools_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
