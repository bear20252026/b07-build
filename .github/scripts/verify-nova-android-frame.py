#!/usr/bin/env python3
"""Reject a system-splash-like empty frame without depending on OCR or network."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify-nova-android-frame.py <screenshot>")
        return 2

    screenshot = Path(sys.argv[1])
    if not screenshot.is_file():
        print("frame=missing")
        return 1

    image = Image.open(screenshot).convert("RGB")
    width, height = image.size
    # Ignore Android's bottom gesture area; it is dark even when the app frame is blank.
    content_height = max(1, height - max(72, height // 10))
    pixels = list(image.crop((0, 0, width, content_height)).getdata())
    total = len(pixels)
    non_light = sum(1 for red, green, blue in pixels if min(red, green, blue) < 238)
    dark = sum(1 for red, green, blue in pixels if min(red, green, blue) < 210)
    non_light_ratio = non_light / total
    dark_ratio = dark / total
    rendered = non_light_ratio >= 0.01 or dark_ratio >= 0.003
    print(
        f"frame={'rendered' if rendered else 'blank'} "
        f"non_light_ratio={non_light_ratio:.6f} dark_ratio={dark_ratio:.6f}"
    )
    return 0 if rendered else 1


if __name__ == "__main__":
    raise SystemExit(main())
