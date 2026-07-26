#!/usr/bin/env python3
"""Generate AudioSlice home-screen icons (spectrogram + band motif)."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BG = (10, 14, 20)


def heat(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    if t < 0.2:
        u = t / 0.2
        return (int(8 + u * 20), int(12 + u * 40), int(28 + u * 90))
    if t < 0.45:
        u = (t - 0.2) / 0.25
        return (int(28 + u * 30), int(52 + u * 90), int(118 + u * 110))
    if t < 0.7:
        u = (t - 0.45) / 0.25
        return (int(58 + u * 40), int(142 + u * 90), int(228 - u * 40))
    if t < 0.88:
        u = (t - 0.7) / 0.18
        return (int(98 + u * 140), int(232 - u * 30), int(188 - u * 100))
    u = (t - 0.88) / 0.12
    return (int(238 + u * 17), int(202 + u * 53), int(88 + u * 167))


def build_icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    px = img.load()
    for x in range(size):
        tcol = x / max(1, size - 1)
        for y in range(size):
            yn = 1.0 - y / max(1, size - 1)
            e1 = math.exp(-((yn - 0.72) ** 2) / 0.004) * (
                0.55 + 0.45 * math.sin(tcol * 18 + yn * 9)
            )
            e2 = math.exp(-((yn - 0.55) ** 2) / 0.008) * (
                0.35 + 0.4 * math.sin(tcol * 11)
            )
            e3 = math.exp(-((yn - 0.18) ** 2) / 0.03) * 0.45
            spark = 0.15 * math.sin(tcol * 40 + yn * 60) ** 8
            v = min(1.0, e1 + e2 + e3 + spark)
            v *= 0.35 + 0.65 * tcol
            px[x, y] = heat(v)

    base = img.convert("RGBA")
    y1, y2 = int(size * 0.28), int(size * 0.48)
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle((0, y1, size, y2), fill=(61, 156, 245, 55))
    od.line((0, y1, size, y1), fill=(61, 156, 245, 230), width=max(2, size // 128))
    od.line((0, y2, size, y2), fill=(61, 156, 245, 230), width=max(2, size // 128))
    mid = (y1 + y2) // 2
    od.line((0, mid, size, mid), fill=(250, 204, 21, 200), width=max(2, size // 160))
    base = Image.alpha_composite(base, overlay)

    vignette = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    pad = int(size * 0.06)
    vd.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=size // 8,
        outline=(61, 156, 245, 180),
        width=max(2, size // 64),
    )
    base = Image.alpha_composite(base, vignette)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        (size * 0.15, size * 0.15, size * 0.85, size * 0.85),
        fill=(61, 156, 245, 28),
    )
    base = Image.alpha_composite(
        base, glow.filter(ImageFilter.GaussianBlur(radius=size // 18))
    )
    return base.convert("RGB")


def save_icons() -> None:
    icon_512 = build_icon(512)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    icon_180 = icon_512.resize((180, 180), Image.Resampling.LANCZOS)
    icon_180.save(ROOT / "apple-touch-icon.png", "PNG")
    print(f"Wrote {ROOT / 'icon-512.png'}")
    print(f"Wrote {ROOT / 'apple-touch-icon.png'}")


if __name__ == "__main__":
    save_icons()
