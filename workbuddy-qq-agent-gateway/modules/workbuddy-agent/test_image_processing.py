"""Run with the module venv Python; no SDK/model/network calls."""

import base64
import hashlib
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

from bridge import Bridge, MAX_PROMPT_IMAGE_RAW_BYTES
from image_processing import prepare_image


def main():
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        source = directory / "source.png"
        Image.frombytes("RGB", (1300, 1300), random.Random(7).randbytes(1300 * 1300 * 3)).save(source)
        digest = hashlib.sha256(source.read_bytes()).digest()
        assert source.stat().st_size > MAX_PROMPT_IMAGE_RAW_BYTES
        payload = Bridge._build_prompt("test", [str(source)] * 8)
        images = [block for block in payload["message"]["content"] if block["type"] == "image"]
        assert len(images) == 8
        assert sum(len(base64.b64decode(block["source"]["data"])) for block in images) <= MAX_PROMPT_IMAGE_RAW_BYTES
        assert hashlib.sha256(source.read_bytes()).digest() == digest
        jpeg = directory / "source.jpg"
        with Image.open(source) as original_image:
            original_image.save(jpeg, quality=95)
        data, mime, optimized = prepare_image(jpeg, 128 * 1024)
        assert optimized and mime == "image/jpeg" and len(data) <= 128 * 1024

        animation = directory / "animation.gif"
        Image.new("RGB", (20, 20), "red").save(animation, save_all=True, append_images=[Image.new("RGB", (20, 20), "blue")], duration=100, loop=0)
        original = animation.read_bytes()
        assert prepare_image(animation, len(original))[0] == original
        for suffix in ("gif", "png"):
            animated = directory / f"animated.{suffix}"
            Image.new("RGBA", (20, 20), "red").save(animated, save_all=True, append_images=[Image.new("RGBA", (20, 20), "blue")], duration=100, loop=0)
            assert Bridge._prepare_prompt_image(str(animated), 1, str(directory), 0) is None

        transparent = directory / "transparent.png"
        Image.new("RGBA", (40, 20), (255, 0, 0, 0)).save(transparent)
        output = directory / "preview.png"
        script = Path(__file__).with_name("image_processing.py")
        command = [sys.executable, str(script), str(transparent), str(output), "--max-dimension", "10", "--quality", "72"]
        subprocess.run(command, check=True)
        with Image.open(output) as preview:
            assert preview.size == (10, 5)
            assert preview.getpixel((0, 0))[3] == 0
        saved_output = output.read_bytes()
        failed = subprocess.run(command + ["--max-bytes", "1"], capture_output=True)
        assert failed.returncode == 1  # Existing output remains untouched on budget rejection.
        assert output.read_bytes() == saved_output
        before = transparent.read_bytes()
        assert subprocess.run([sys.executable, str(script), str(transparent), str(transparent)], capture_output=True).returncode == 1
        assert transparent.read_bytes() == before
        assert animation.read_bytes() == original
    print("PASS: shared 4MiB budget, unchanged originals, GIF/APNG rejection, PNG alpha and CLI bounds")


if __name__ == "__main__":
    main()
