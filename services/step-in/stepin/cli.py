"""
Run Step In on your own computer.

  python -m stepin.cli -i ~/Projects/splatlab/sharp-in2 -o ~/Projects/splatlab/stepin-out --debug

Writes <name>-in.ply and <name>-out.ply (plus .compressed.ply copies when
splat-transform or npx is available) for 3D Moments Lab.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from .pipeline import Models, Settings, compress, make_moment, pick_device, write_ply

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def main() -> None:
    ap = argparse.ArgumentParser(description="Turn photos into Step In / Step Out splats.")
    ap.add_argument("-i", "--input", required=True, help="a photo, or a folder of photos")
    ap.add_argument("-o", "--output", required=True, help="folder for the .ply files")
    ap.add_argument("--size", type=int, default=1536, help="longest side in pixels (default 1536)")
    ap.add_argument("--bg-stride", type=float, default=2.5, help="background pixels per splat, 1 = full detail (default 2.5)")
    ap.add_argument("--cutout", choices=["people", "subject"], default="people",
                    help="people = every person (default); subject = the main object, people or not")
    ap.add_argument("--birefnet", default="birefnet-general",
                    help="edge model: birefnet-general (default) or birefnet-general-lite (less memory)")
    ap.add_argument("--device", default="auto", help="auto, mps, cpu or cuda")
    ap.add_argument("--no-compress", action="store_true", help="skip the compressed copies")
    ap.add_argument("--debug", action="store_true", help="also save the cutout, filled background and depth")
    args = ap.parse_args()

    src = Path(args.input).expanduser()
    photos = [src] if src.is_file() else sorted(p for p in src.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not photos:
        sys.exit(f"No photos found in {src}")
    if any(p.suffix.lower() in {".heic", ".heif"} for p in photos):
        import pillow_heif
        pillow_heif.register_heif_opener()
    out = Path(args.output).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    settings = Settings(size=args.size, bg_stride=args.bg_stride, cutout=args.cutout, birefnet=args.birefnet)
    device = pick_device(args.device)
    print(f"Using {device}. The first run downloads about 1.7 GB of models.")
    models = Models(device, settings)

    for p in photos:
        print(f"\n{p.name}")
        try:
            m = make_moment(Image.open(p), models, debug=args.debug)
        except Exception as e:
            print(f"    Skipped: {e}")
            continue
        files = {"in": m.step_in, "out": m.step_out}
        for kind, splats in files.items():
            if splats is None:
                continue
            ply = out / f"{p.stem}-{kind}.ply"
            n = write_ply(ply, splats)
            note = f"{n:,} splats"
            if not args.no_compress and compress(ply, out / f"{p.stem}-{kind}.sog"):
                note += ", small .sog copy saved"
            print(f"    Step {kind.capitalize():<4} {note}")
        print(f"    {m.people} {'person' if m.people == 1 else 'people'} found · "
              + " · ".join(f"{k} {v}s" for k, v in m.timings.items()))
        (out / f"{p.stem}-frames.json").write_text(json.dumps({"in": m.in_frame, "out": m.out_frame}, indent=2))
        if args.debug and m.debug:
            dbg = out / "debug"
            dbg.mkdir(exist_ok=True)
            m.debug["cutout"].save(dbg / f"{p.stem}-cutout.png")
            m.debug["filled"].save(dbg / f"{p.stem}-filled.jpg", quality=92)
            m.debug["depth"].save(dbg / f"{p.stem}-depth.png")

    print(f"\nDone. Drop the files from {out} into 3D Moments Lab.")


if __name__ == "__main__":
    main()
