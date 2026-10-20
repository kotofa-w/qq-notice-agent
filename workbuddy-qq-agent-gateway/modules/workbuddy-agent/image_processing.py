"""Shared static JPEG/PNG previews; source files are never written."""

import argparse
import io
import mimetypes
import os
import sys
from pathlib import Path

from PIL import Image, ImageOps


REDUCTION_ATTEMPTS = [(1600, 72), (1280, 65), (1024, 58), (768, 50), (512, 42), (384, 35)]


def compressed_bytes(source, max_dimension=1600, quality=72, output_format="JPEG"):
    if max_dimension <= 0 or not 1 <= quality <= 100:
        raise ValueError("max_dimension must be positive and quality must be 1..100")
    if output_format not in ("JPEG", "PNG"):
        raise ValueError("output format must be JPEG or PNG")
    with Image.open(source) as original:
        if original.format not in ("JPEG", "PNG") or getattr(original, "is_animated", False):
            raise ValueError("only static JPEG/PNG images can be compressed; GIF/animation is preserved or rejected")
        preview = ImageOps.exif_transpose(original)
        preview.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        if output_format == "JPEG":
            rgba = preview.convert("RGBA")
            preview = Image.new("RGB", rgba.size, "white")
            preview.paste(rgba, mask=rgba.getchannel("A"))
        buffer = io.BytesIO()
        preview.save(buffer, format=output_format, **({"quality": quality, "optimize": True} if output_format == "JPEG" else {"optimize": True}))
        return buffer.getvalue()


def prepare_image(source, target_bytes):
    """Return (bytes, MIME, optimized), or fail without flattening animation."""
    if target_bytes <= 0:
        raise ValueError("target_bytes must be positive")
    size = os.path.getsize(source)
    if 0 < size <= target_bytes:
        return Path(source).read_bytes(), mimetypes.guess_type(source)[0] or "image/png", False
    for dimension, quality in REDUCTION_ATTEMPTS:
        data = compressed_bytes(source, dimension, quality)
        if len(data) <= target_bytes:
            return data, "image/jpeg", True
    raise ValueError(f"image cannot fit within {target_bytes} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--max-dimension", type=int, default=1600)
    parser.add_argument("--quality", type=int, default=72)
    parser.add_argument("--max-bytes", type=int)
    args = parser.parse_args()
    try:
        source, output = Path(args.source), Path(args.output)
        if source.resolve() == output.resolve() or (output.exists() and os.path.samefile(source, output)):
            raise ValueError("source and output must be different files")
        output_format = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG"}.get(output.suffix.lower())
        data = compressed_bytes(source, args.max_dimension, args.quality, output_format)
        if args.max_bytes is not None and (args.max_bytes <= 0 or len(data) > args.max_bytes):
            raise ValueError(f"compressed image exceeds {args.max_bytes} bytes")
        output.write_bytes(data)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
