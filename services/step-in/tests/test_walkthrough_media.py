"""Real ffmpeg: frames, joining, the burned-in label, and the checks a finished video must pass."""
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from walkthrough import media
from walkthrough.config import LABEL, LABEL_LINES, size_for


@pytest.fixture
def frames(tmp_path):
    out = []
    for i, color in enumerate(["#c0392b", "#27ae60", "#2980b9", "#8e44ad"]):
        p = tmp_path / f"f{i}.jpg"
        Image.new("RGB", (1600, 1200), color).save(p)
        out.append(str(p))
    return out


def clips(frames, tmp_path, aspect="9:16", resolution="720p", seconds=5.0):
    w, h = size_for(aspect, resolution)
    norm = []
    for i, f in enumerate(frames):
        p = tmp_path / f"norm-{aspect.replace(':', '')}-{i}.jpg"
        media.normalize_frame(Image.open(f), aspect, resolution, str(p))
        assert Image.open(p).size == (w, h)
        norm.append(str(p))
    out = []
    for i in range(len(norm) - 1):
        p = tmp_path / f"clip-{aspect.replace(':', '')}-{i}.mp4"
        media.crossfade_clip(norm[i], norm[i + 1], str(p), seconds)
        out.append(str(p))
    return out, norm


def frame_at(video, out, at=2.0):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(at), "-i", video, "-frames:v", "1", str(out)], check=True)
    return Image.open(out).convert("RGB")


def ocr(path):
    """Read the label from the bottom of a frame, as dark text on white, which suits tesseract."""
    img = Image.open(path).convert("L")
    w, h = img.size
    img = img.crop((0, int(h * 0.75), w, h)).point(lambda v: 0 if v > 170 else 255)
    img.save(path)
    done = subprocess.run(["tesseract", str(path), "stdout", "--psm", "6"], capture_output=True, text=True)
    return " ".join(done.stdout.split())


@pytest.mark.parametrize("aspect,resolution,size", [
    ("9:16", "720p", (720, 1280)), ("16:9", "720p", (1280, 720)),
    ("9:16", "480p", (480, 854)), ("16:9", "480p", (854, 480)),
])
def test_join_makes_a_phone_and_tv_ready_video(frames, tmp_path, aspect, resolution, size):
    paths, _ = clips(frames, tmp_path, aspect, resolution)
    out = tmp_path / "final.mp4"
    media.join_segments([media.Segment(p, 5.0) for p in paths], str(out), aspect, resolution)
    info = media.check_final(str(out), aspect, resolution, 15.0, tolerance=0.2)
    assert info["codec"] == "h264" and info["pix_fmt"] == "yuv420p"
    assert (info["width"], info["height"]) == size
    assert info["has_audio"] is False
    assert media.moov_first(str(out))


def test_audio_from_a_provider_clip_is_dropped(frames, tmp_path):
    paths, _ = clips(frames[:2], tmp_path)
    noisy = tmp_path / "noisy.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", paths[0], "-f", "lavfi", "-i", "anullsrc", "-shortest",
                    "-c:v", "copy", "-c:a", "aac", str(noisy)], check=True)
    assert media.probe(str(noisy))["has_audio"] is True
    out = tmp_path / "final.mp4"
    media.join_segments([media.Segment(str(noisy), 5.0)], str(out), "9:16", "720p")
    assert media.probe(str(out))["has_audio"] is False


@pytest.mark.parametrize("aspect", ["9:16", "16:9"])
@pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")
def test_label_is_burned_in_and_readable(frames, tmp_path, aspect):
    paths, _ = clips(frames, tmp_path, aspect)
    out = tmp_path / "final.mp4"
    media.join_segments([media.Segment(p, 5.0) for p in paths], str(out), aspect, "720p")
    # Every part of the video carries it: check the start, a join, and the end.
    for at in (0.1, 5.2, 14.5):
        png = tmp_path / f"frame-{aspect.replace(':', '')}-{at}.png"
        frame_at(str(out), png, at)
        text = ocr(png).replace("Al-generated", "AI-generated")  # tesseract reads this font's capital I as l
        assert LABEL in text, text


def test_label_text_is_the_exact_words():
    assert LABEL == "AI-generated video. Some moments and details aren't real."
    assert " ".join(LABEL_LINES) == LABEL


def test_app_shows_the_same_label():
    src = (Path(__file__).resolve().parents[3] / "src" / "walkthrough.ts").read_text()
    assert LABEL in src


def test_label_stays_on_screen(frames, tmp_path):
    # Label boxes on a white frame show exactly where the drawn text lands.
    white = tmp_path / "white.jpg"
    for aspect, resolution in (("9:16", "480p"), ("9:16", "720p"), ("16:9", "480p"), ("16:9", "720p")):
        w, h = size_for(aspect, resolution)
        Image.new("RGB", (w, h), "white").save(white)
        clip = tmp_path / "c.mp4"
        media.hold_clip(str(white), str(clip), 1.0, w, h)
        out = tmp_path / "o.mp4"
        media.join_segments([media.Segment(str(clip), 1.0)], str(out), aspect, resolution)
        img = frame_at(str(out), tmp_path / "o.png", 0.5).convert("L")
        dark = img.point(lambda v: 255 if v < 150 else 0).getbbox()
        assert dark, "no label found"
        left, top, right, bottom = dark
        assert left >= 4 and right <= w - 4, f"{aspect} {resolution}: label runs off the side {dark}"
        assert bottom <= h * 0.95, f"{aspect} {resolution}: label is too near the bottom {dark}"


def test_no_font_means_no_video(frames, tmp_path, monkeypatch):
    monkeypatch.setattr(media, "FONT_CANDIDATES", ("/nope.ttf",))
    paths, _ = clips(frames[:2], tmp_path)
    with pytest.raises(media.MediaError):
        media.join_segments([media.Segment(paths[0], 5.0)], str(tmp_path / "x.mp4"), "9:16", "720p")


def test_slowdown_stretches_a_clip(frames, tmp_path):
    paths, _ = clips(frames[:3], tmp_path)
    out = tmp_path / "slow.mp4"
    media.join_segments([media.Segment(paths[0], 5.0, 2.0), media.Segment(paths[1], 5.0)], str(out), "9:16", "720p")
    assert media.probe(str(out))["duration"] == pytest.approx(15.0, abs=0.2)


@pytest.mark.parametrize("zoom", [False, True])
def test_hold_segments(frames, tmp_path, zoom):
    paths, norm = clips(frames[:2], tmp_path, "16:9")
    hold = tmp_path / f"hold{zoom}.mp4"
    media.hold_clip(norm[0], str(hold), 2.0, 1280, 720, zoom)
    assert media.probe(str(hold))["duration"] == pytest.approx(2.0, abs=0.1)
    out = tmp_path / f"o{zoom}.mp4"
    media.join_segments([media.Segment(str(hold), 2.0), media.Segment(paths[0], 5.0)], str(out), "16:9", "720p")
    assert media.probe(str(out))["duration"] == pytest.approx(7.0, abs=0.2)


def test_crop_is_centered_and_upright(tmp_path):
    img = Image.new("RGB", (1000, 1000), "black")
    img.paste((255, 0, 0), (450, 0, 550, 1000))  # a red stripe down the middle
    out = tmp_path / "c.jpg"
    media.normalize_frame(img, "9:16", "720p", str(out))
    got = Image.open(out)
    assert got.size == (720, 1280)
    r, g, b = got.getpixel((360, 640))
    assert r > 180 and g < 80 and b < 80


def test_check_final_refuses_a_wrong_video(frames, tmp_path):
    paths, _ = clips(frames[:2], tmp_path)
    with pytest.raises(media.MediaError):  # the raw clip: wrong duration, and not faststart
        media.check_final(paths[0], "9:16", "720p", 15.0)
