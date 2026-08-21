from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ASSET_DIRECTORY = REPOSITORY_ROOT / 'apps' / 'workbench' / 'src' / 'assets' / 'companions'


def remove_chroma(path: Path) -> None:
    image = Image.open(path).convert('RGBA')
    pixels = np.asarray(image).copy()
    red = pixels[..., 0].astype(np.int16)
    green = pixels[..., 1].astype(np.int16)
    blue = pixels[..., 2].astype(np.int16)

    # Generated temporary background is intentionally high-chroma magenta or green;
    # gray/white/black character materials cannot meet either condition.
    magenta = (red > 145) & (blue > 145) & (green < 155) & ((red + blue) - (2 * green) > 105)
    chroma_green = (green > 120) & (green > red + 35) & (green > blue + 35)
    chroma_spill = (np.maximum(np.maximum(red, green), blue) - np.minimum(np.minimum(red, green), blue)) > 38
    mask = magenta | chroma_green | chroma_spill

    pixels[mask, 3] = 0
    pixels[mask, 0:3] = 0
    processed = Image.fromarray(pixels, mode='RGBA')
    processed.thumbnail((320, 320), Image.Resampling.LANCZOS)
    processed.save(path, optimize=True)


def main() -> None:
    for path in sorted(ASSET_DIRECTORY.glob('*.png')):
        remove_chroma(path)
        print(f'cleared temporary chroma from {path.name}')


if __name__ == '__main__':
    main()
