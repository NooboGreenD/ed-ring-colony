#!/usr/bin/env python3
"""Rebuild Colonial Helper's checked-in icon assets (Pillow, build-time only).

Run: python -m pip install Pillow && python scripts/build-helper-icons.py
The selected AI-generated master is preserved in uploader/assets. Runtime
bundles contain only the four small files explicitly listed in build_bundle.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
UPLOADER = ROOT / 'uploader'
MASTER = UPLOADER / 'assets' / 'colonial-helper-master.png'
APP_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
TRAY_SIZES = (16, 20, 24, 32, 40, 48, 64)


def tray_image(size: int) -> Image.Image:
    """Optical small-size redraw of the selected ring/ship, not a tiny painting.

    Broad amber arcs and an orange ship survive a 16px Windows notification
    area. Charcoal backing/outline keeps them visible on light and dark bars;
    outside corners and ring breaks remain transparent. No text or fine panels.
    """
    scale = 8
    side = size * scale
    image = Image.new('RGBA', (side, side))
    draw = ImageDraw.Draw(image)
    def points(coords):
        return [(round(x * side), round(y * side)) for x, y in coords]
    box = (round(.045 * side), round(.045 * side), round(.955 * side), round(.955 * side))
    for start, end in ((-80, 80), (100, 260)):
        draw.arc(box, start, end, fill='#20242a', width=round(.155 * side))
    inset = round(.025 * side)
    ring = (box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset)
    for start, end in ((-78, 78), (102, 258)):
        draw.arc(ring, start, end, fill='#ffb13b', width=round(.105 * side))
    hull = points(((.5, .225), (.625, .48), (.735, .64), (.735, .745),
                   (.57, .705), (.5, .805), (.43, .705), (.265, .745),
                   (.265, .64), (.375, .48)))
    draw.polygon(hull, fill='#ff9a26', outline='#20242a', width=max(1, round(.027 * side)))
    draw.polygon(points(((.5, .30), (.54, .48), (.5, .57), (.46, .48))), fill='#20242a')
    draw.ellipse((round(.465 * side), round(.405 * side), round(.535 * side), round(.475 * side)), fill='#61f5ef')
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_ico(path: Path, images: dict[int, Image.Image]) -> None:
    # Supply optical redraws explicitly: automatic ICO downsampling would
    # otherwise recreate all small frames from the most detailed painting.
    largest = images[max(images)]
    largest.save(path, format='ICO', sizes=[(n, n) for n in sorted(images)],
                 append_images=[images[n] for n in sorted(images) if n != max(images)])


def main() -> None:
    with Image.open(MASTER) as source:
        master = source.convert('RGBA')
    master.resize((512, 512), Image.Resampling.LANCZOS).save(UPLOADER / 'colonial_helper.png', optimize=True)
    tray_image(64).save(UPLOADER / 'colonial_helper_tray.png', optimize=True)
    save_ico(UPLOADER / 'colonial_helper.ico', {
        n: tray_image(n) if n <= 32 else master.resize((n, n), Image.Resampling.LANCZOS)
        for n in APP_SIZES
    })
    save_ico(UPLOADER / 'colonial_helper_tray.ico', {n: tray_image(n) for n in TRAY_SIZES})


if __name__ == '__main__':
    main()
