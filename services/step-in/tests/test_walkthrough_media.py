"""Real ffmpeg: frames, joining, the burned-in label, and the checks a finished video must pass."""
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from walkthrough import media
from walkthrough.config import LABEL, size_for


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
    img = img.crop((0, int(h * 0.85), w, h)).resize((w * 3, int(h * 0.15) * 3), Image.Resampling.LANCZOS).point(lambda v: 0 if v > 170 else 255)
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


def test_full_range_clips_come_out_as_standard_video(tmp_path):
    """Providers and newer ffmpeg can hand back full-range video (yuvj420p). Phones and TVs get yuv420p."""
    src = tmp_path / "full.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=720x1280:d=2:r=24",
                    "-vf", "format=yuvj420p", "-c:v", "libx264", "-preset", "ultrafast", str(src)], check=True)
    assert media.probe(str(src))["pix_fmt"] == "yuvj420p"
    out = tmp_path / "out.mp4"
    media.join_segments([media.Segment(str(src), 2.0)], str(out), "9:16", "720p")
    assert media.check_final(str(out), "9:16", "720p", 2.0)["pix_fmt"] == "yuv420p"


def test_label_can_be_left_off(frames, tmp_path):
    paths, _ = clips(frames, tmp_path, "16:9")
    out, with_label = tmp_path / "off.mp4", tmp_path / "on.mp4"
    media.join_segments([media.Segment(paths[0], 5.0)], str(with_label), "16:9", "720p")
    media.join_segments([media.Segment(paths[0], 5.0)], str(out), "16:9", "720p", label=False)
    media.check_final(str(out), "16:9", "720p", 5.0)
    bottom = lambda p: frame_at(str(p), tmp_path / "f.png", 0.1).convert("L").crop((0, 620, 1280, 700)).tobytes()
    assert bottom(out) != bottom(with_label)


# ---- Style editing: dissolves, the warm tint, the push in ----

def mean_rgb(image):
    img = Image.open(image).convert("RGB").resize((1, 1))
    return img.getpixel((0, 0))


def test_a_dissolve_shortens_the_video_by_the_overlaps(frames, tmp_path):
    made, _ = clips(frames, tmp_path, seconds=3.0)
    segs = [media.Segment(c, 3.0) for c in made]
    out = str(tmp_path / "fade.mp4")
    media.join_segments(segs, out, "9:16", "720p", crossfade=0.6)
    expected = media.joined_seconds(segs, 0.6)
    assert expected == pytest.approx(9.0 - 2 * 0.6)
    media.check_final(out, "9:16", "720p", expected, tolerance=0.25)


def test_a_dissolve_blends_two_clips(frames, tmp_path):
    made, _ = clips(frames[:3], tmp_path, seconds=3.0)
    segs = [media.Segment(c, 3.0) for c in made]
    cut, fade = str(tmp_path / "cut.mp4"), str(tmp_path / "fade.mp4")
    media.join_segments(segs, cut, "9:16", "720p", label=False)
    media.join_segments(segs, fade, "9:16", "720p", label=False, crossfade=1.0)
    # Halfway through the dissolve the picture is a mix of the first clip's end and the second's start.
    frame_at(fade, tmp_path / "mid.jpg", at=2.5)
    frame_at(cut, tmp_path / "end1.jpg", at=2.9)
    frame_at(cut, tmp_path / "start2.jpg", at=3.1)
    mid, a, b = mean_rgb(tmp_path / "mid.jpg"), mean_rgb(tmp_path / "end1.jpg"), mean_rgb(tmp_path / "start2.jpg")
    assert all(min(x, y) - 25 <= m <= max(x, y) + 25 for m, x, y in zip(mid, a, b))


def test_a_dissolve_copes_with_a_short_clip_and_speed_changes(frames, tmp_path):
    made, _ = clips(frames, tmp_path, seconds=2.6)  # shorter than the 3 seconds asked for
    segs = [media.Segment(c, 3.0, 1.25) for c in made]
    out = str(tmp_path / "slow-fade.mp4")
    media.join_segments(segs, out, "9:16", "720p", crossfade=0.6)
    media.check_final(out, "9:16", "720p", media.joined_seconds(segs, 0.6), tolerance=0.25)


def test_the_warm_tint_warms_the_picture(tmp_path):
    grey = tmp_path / "grey.jpg"
    Image.new("RGB", (720, 1280), "#808080").save(grey)
    clip = str(tmp_path / "grey.mp4")
    media.hold_clip(str(grey), clip, 2.0, 720, 1280)
    plain, warm = str(tmp_path / "plain.mp4"), str(tmp_path / "warm.mp4")
    media.join_segments([media.Segment(clip, 2.0)], plain, "9:16", "720p", label=False)
    media.join_segments([media.Segment(clip, 2.0)], warm, "9:16", "720p", label=False, warm=True)
    frame_at(plain, tmp_path / "plain.jpg", at=1.0)
    frame_at(warm, tmp_path / "warm.jpg", at=1.0)
    (r0, _, b0), (r1, _, b1) = mean_rgb(tmp_path / "plain.jpg"), mean_rgb(tmp_path / "warm.jpg")
    assert r1 > r0 and b1 < b0


def test_the_push_in_starts_close_and_ends_on_the_full_picture(tmp_path):
    # A white picture with a black border: pushed in, the border is cropped away.
    img = Image.new("RGB", (720, 1280), "black")
    img.paste(Image.new("RGB", (640, 1200), "white"), (40, 40))
    still = tmp_path / "border.jpg"
    img.save(still)
    clip = str(tmp_path / "border.mp4")
    media.hold_clip(str(still), clip, 2.0, 720, 1280)
    out = str(tmp_path / "punch.mp4")
    media.join_segments([media.Segment(clip, 2.0)], out, "9:16", "720p", label=False, punch=True)
    media.check_final(out, "9:16", "720p", 2.0, tolerance=0.25)
    frame_at(out, tmp_path / "first.jpg", at=0.0)
    frame_at(out, tmp_path / "later.jpg", at=1.5)
    assert sum(mean_rgb(tmp_path / "first.jpg")) > sum(mean_rgb(tmp_path / "later.jpg")) + 20


def test_a_plain_join_is_unchanged_by_the_new_options(frames, tmp_path):
    made, _ = clips(frames, tmp_path, seconds=3.0)
    segs = [media.Segment(c, 3.0) for c in made]
    out = str(tmp_path / "plain.mp4")
    media.join_segments(segs, out, "9:16", "720p")
    media.check_final(out, "9:16", "720p", media.joined_seconds(segs), tolerance=0.25)


def test_lingering_rests_on_the_last_frame_of_each_clip(frames, tmp_path):
    made, _ = clips(frames[:3], tmp_path, seconds=3.0)
    segs = [media.Segment(c, 3.0) for c in made]
    out = str(tmp_path / "linger.mp4")
    media.join_segments(segs, out, "9:16", "720p", label=False, linger=0.6)
    expected = media.joined_seconds(segs, linger=0.6)
    assert expected == pytest.approx(2 * 3.6)
    media.check_final(out, "9:16", "720p", expected, tolerance=0.25)
    # The rest between the two clips is one still picture.
    frame_at(out, tmp_path / "rest-a.jpg", at=3.1)
    frame_at(out, tmp_path / "rest-b.jpg", at=3.5)
    assert all(abs(x - y) <= 3 for x, y in zip(mean_rgb(tmp_path / "rest-a.jpg"), mean_rgb(tmp_path / "rest-b.jpg")))


# ---- The end card ----

def test_the_end_card_shows_the_name_in_brand_blue_on_black(tmp_path):
    out = tmp_path / "card.jpg"
    media.end_card_image(str(out), 720, 1280, "Nia's 30th")
    img = Image.open(out).convert("RGB")
    assert img.size == (720, 1280)
    assert img.getpixel((5, 5)) == (0, 0, 0) or sum(img.getpixel((5, 5))) < 12
    pixels = list(img.getdata())
    blue = sum(1 for r, g, b in pixels if b > 200 and r < 60 and g < 130)
    white = sum(1 for r, g, b in pixels if r > 230 and g > 230 and b > 230)
    assert blue > 1500 and white > 1500


def test_a_very_long_event_name_still_fits(tmp_path):
    out = tmp_path / "long.jpg"
    media.end_card_image(str(out), 720, 1280, "The Extremely Long And Wordy Family Reunion Of Twenty Twenty Six " * 3)
    img = Image.open(out).convert("RGB")
    # Nothing is drawn against the left or right edge.
    assert all(sum(img.getpixel((x, y))) < 40 for x in (2, 717) for y in range(0, 1280, 8))


def test_an_end_card_closes_the_video_without_the_label_or_the_style_on_it(frames, tmp_path):
    made, _ = clips(frames[:3], tmp_path, seconds=3.0)
    card = str(tmp_path / "card.mp4")
    media.end_card_clip(card, 720, 1280, 2.5, "Party")
    segs = [media.Segment(c, 3.0) for c in made] + [media.Segment(card, 2.5, plain=True)]
    out = str(tmp_path / "with-card.mp4")
    media.join_segments(segs, out, "9:16", "720p", warm=True, punch=True, linger=0.6)
    expected = media.joined_seconds(segs, linger=0.6)
    assert expected == pytest.approx(2 * 3.6 + 2.5)
    media.check_final(out, "9:16", "720p", expected, tolerance=0.25)
    # Near the end it is the card as drawn: black corners, no tint, no label line near the bottom.
    frame_at(out, tmp_path / "end.jpg", at=expected - 0.5)
    img = Image.open(tmp_path / "end.jpg").convert("RGB")
    assert sum(img.getpixel((10, 10))) < 30
    label_y = 1280 - round(1280 * 0.06) - 8
    assert max(sum(img.getpixel((x, label_y))) for x in range(100, 620, 4)) < 90
    # And the AI part before it still carries the label.
    frame_at(out, tmp_path / "mid.jpg", at=1.5)
    mid = Image.open(tmp_path / "mid.jpg").convert("RGB")
    assert max(sum(mid.getpixel((x, y))) for x in range(100, 620, 2) for y in range(label_y - 12, label_y + 12)) > 500


def test_the_end_card_is_set_in_the_brand_type(tmp_path):
    from PIL import ImageDraw
    lockup = media._brand_font(media.LOCKUP_FONT, 80)
    text = media._brand_font(media.TEXT_FONT, 40)
    assert "Archivo" in lockup.getname()[0] and "Jakarta" in text.getname()[0]
    # Expanded Black is much wider than the label's font at the same size.
    draw = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    from PIL import ImageFont
    plain = ImageFont.truetype(media.font_path(), 80)
    assert draw.textlength("Get2Share", font=lockup) > draw.textlength("Get2Share", font=plain) * 1.1


def test_the_brand_name_fits_both_shapes(tmp_path):
    for w, h in ((720, 1280), (1280, 720), (480, 854)):
        out = tmp_path / f"card-{w}.jpg"
        media.end_card_image(str(out), w, h, "Party")
        img = Image.open(out).convert("RGB")
        assert all(sum(img.getpixel((x, y))) < 40 for x in (int(w * 0.04), int(w * 0.96)) for y in range(0, h, 6))


def test_a_name_in_another_script_falls_back_to_the_wider_font(tmp_path):
    assert media._plain_latin("Nia’s 30th – Café") and not media._plain_latin("Свадьба")
    out = tmp_path / "cyr.jpg"
    media.end_card_image(str(out), 720, 1280, "Свадьба")
    assert Image.open(out).size == (720, 1280)


def test_missing_brand_fonts_fall_back_to_the_label_font(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "FONT_DIRS", (str(tmp_path / "nowhere"),))
    out = tmp_path / "plain.jpg"
    media.end_card_image(str(out), 720, 1280, "Party")
    assert Image.open(out).size == (720, 1280)
