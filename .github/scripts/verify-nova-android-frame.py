#!/usr/bin/env python3
"""Reject uniform Android system splash frames without OCR or third-party Python."""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def paeth(left: int, above: int, upper_left: int) -> int:
    prediction = left + above - upper_left
    distances = (abs(prediction - left), abs(prediction - above), abs(prediction - upper_left))
    return (left, above, upper_left)[distances.index(min(distances))]


def read_rgba_rows(path: Path) -> tuple[int, int, list[bytes]]:
    raw = path.read_bytes()
    if not raw.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG")
    offset = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = None
    chunks: list[bytes] = []
    while offset < len(raw):
        length = struct.unpack(">I", raw[offset:offset + 4])[0]
        kind = raw[offset + 4:offset + 8]
        payload = raw[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if (bit_depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("expected non-interlaced 8-bit RGBA PNG")
        elif kind == b"IDAT":
            chunks.append(payload)
        elif kind == b"IEND":
            break
    if not width or not height:
        raise ValueError("missing PNG header")
    packed = zlib.decompress(b"".join(chunks))
    stride = width * 4
    rows: list[bytes] = []
    previous = bytearray(stride)
    cursor = 0
    for _ in range(height):
        filter_type = packed[cursor]
        cursor += 1
        encoded = packed[cursor:cursor + stride]
        cursor += stride
        current = bytearray(stride)
        for index, value in enumerate(encoded):
            left = current[index - 4] if index >= 4 else 0
            above = previous[index]
            upper_left = previous[index - 4] if index >= 4 else 0
            if filter_type == 0:
                current[index] = value
            elif filter_type == 1:
                current[index] = (value + left) & 255
            elif filter_type == 2:
                current[index] = (value + above) & 255
            elif filter_type == 3:
                current[index] = (value + ((left + above) // 2)) & 255
            elif filter_type == 4:
                current[index] = (value + paeth(left, above, upper_left)) & 255
            else:
                raise ValueError(f"unknown PNG filter {filter_type}")
        rows.append(bytes(current))
        previous = current
    return width, height, rows


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify-nova-android-frame.py <screenshot>")
        return 2

    screenshot = Path(sys.argv[1])
    if not screenshot.is_file():
        print("frame=missing")
        return 1

    try:
        width, height, rows = read_rgba_rows(screenshot)
    except (OSError, ValueError, zlib.error) as error:
        print(f"frame=invalid error={error}")
        return 1
    # Ignore Android's bottom gesture area; it is dark even when the app frame is blank.
    content_height = max(1, height - max(72, height // 10))
    total = width * content_height
    non_light = 0
    dark = 0
    light = 0
    visible = 0
    bright = 0
    for row in rows[:content_height]:
        for offset in range(0, len(row), 4):
            red, green, blue = row[offset:offset + 3]
            channel_min = min(red, green, blue)
            channel_max = max(red, green, blue)
            non_light += channel_min < 238
            dark += channel_max < 16
            light += channel_min > 238
            visible += channel_max >= 16
            bright += channel_max >= 80
    non_light_ratio = non_light / total
    dark_ratio = dark / total
    light_ratio = light / total
    visible_ratio = visible / total
    bright_ratio = bright / total
    # An all-black Android Splash and an all-white fallback both satisfy the old
    # "non-light" check. A real Workbench frame must contain a small but visible
    # amount of contrast while not being a virtually uniform dark/light screen.
    rendered = (
        visible_ratio >= 0.002
        and bright_ratio >= 0.0005
        and dark_ratio < 0.998
        and light_ratio < 0.998
    )
    print(
        f"frame={'rendered' if rendered else 'blank'} "
        f"non_light_ratio={non_light_ratio:.6f} dark_ratio={dark_ratio:.6f} "
        f"light_ratio={light_ratio:.6f} visible_ratio={visible_ratio:.6f} "
        f"bright_ratio={bright_ratio:.6f}"
    )
    return 0 if rendered else 1


if __name__ == "__main__":
    raise SystemExit(main())
