#!/usr/bin/env python3
"""Generate the PWA / App Store icon set for the HVAC Field Assistant.

Draws a refrigeration gauge glyph (dial, tick marks, needle, hub, stem) in white on an
industrial-amber rounded square using only Pillow primitives, supersampled 4x for clean
anti-aliased edges. Outputs (under web/icons/):

  icon-192.png, icon-512.png         "any" purpose icons (rounded square, transparent corners)
  icon-maskable-512.png              full-bleed square; glyph kept inside the 80 % safe zone
  apple-touch-icon-180.png           opaque square (iOS applies its own corner mask)
  favicon-32.png                     small rounded square

Run: python3 scripts/gen_icons.py
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (245, 166, 35, 255)  # --accent (amber)
ACCENT_DEEP = (214, 137, 20, 255)  # subtle bottom shade for depth
WHITE = (255, 255, 255, 255)
INK = (20, 16, 10, 255)  # accent-contrast for the needle hub

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "icons"
SS = 4  # supersampling factor


def draw_background(draw: ImageDraw.ImageDraw, size: int, rounded: bool) -> None:
    radius = int(size * 0.22) if rounded else 0
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=ACCENT)
    # Gentle two-tone: a slightly deeper band at the bottom keeps the flat color from looking dead.
    band = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.rounded_rectangle((0, int(size * 0.55), size - 1, size - 1), radius=radius, fill=(ACCENT_DEEP[0], ACCENT_DEEP[1], ACCENT_DEEP[2], 70))
    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
        band.putalpha(Image.composite(band.getchannel("A"), Image.new("L", (size, size), 0), mask))
    draw._image.alpha_composite(band)  # type: ignore[attr-defined]


def draw_gauge(draw: ImageDraw.ImageDraw, size: int, scale: float) -> None:
    """Gauge glyph centred in the canvas. `scale` = fraction of the canvas the glyph may use."""
    cx = size / 2
    cy = size / 2 + size * 0.02
    r = size * 0.36 * scale
    stroke = max(2, int(size * 0.075 * scale))

    # Dial ring (open at the bottom like a real gauge face).
    box = (cx - r, cy - r, cx + r, cy + r)
    draw.arc(box, start=135, end=405, fill=WHITE, width=stroke)

    # Tick marks along the arc.
    tick_len_major = r * 0.22
    tick_len_minor = r * 0.12
    tick_w_major = max(2, int(stroke * 0.55))
    tick_w_minor = max(1, int(stroke * 0.32))
    for i in range(0, 9):
        ang = math.radians(135 + i * (270 / 8))
        major = i % 2 == 0
        length = tick_len_major if major else tick_len_minor
        r_out = r - stroke * 0.9
        r_in = r_out - length
        x0, y0 = cx + math.cos(ang) * r_out, cy + math.sin(ang) * r_out
        x1, y1 = cx + math.cos(ang) * r_in, cy + math.sin(ang) * r_in
        draw.line((x0, y0, x1, y1), fill=WHITE, width=tick_w_major if major else tick_w_minor)

    # Needle: points to ~2 o'clock (a healthy head-pressure reading).
    ang = math.radians(-35)
    n_len = r * 0.72
    n_w = max(2, int(stroke * 0.7))
    tail = r * 0.18
    x_tip, y_tip = cx + math.cos(ang) * n_len, cy + math.sin(ang) * n_len
    x_tail, y_tail = cx - math.cos(ang) * tail, cy - math.sin(ang) * tail
    draw.line((x_tail, y_tail, x_tip, y_tip), fill=WHITE, width=n_w)
    # Tapered tip.
    tip_r = n_w * 0.5
    draw.ellipse((x_tip - tip_r, y_tip - tip_r, x_tip + tip_r, y_tip + tip_r), fill=WHITE)

    # Hub.
    hub = r * 0.16
    draw.ellipse((cx - hub, cy - hub, cx + hub, cy + hub), fill=WHITE)
    inner = hub * 0.45
    draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=ACCENT)

    # Stem / fitting below the dial.
    stem_w = r * 0.26
    stem_top = cy + r * 0.62
    stem_h = r * 0.34
    draw.rounded_rectangle((cx - stem_w / 2, stem_top, cx + stem_w / 2, stem_top + stem_h), radius=stem_w * 0.25, fill=WHITE)
    fit_w = r * 0.42
    fit_top = stem_top + stem_h * 0.7
    draw.rounded_rectangle((cx - fit_w / 2, fit_top, cx + fit_w / 2, fit_top + stem_h * 0.55), radius=stem_w * 0.2, fill=WHITE)


def render(size: int, *, rounded: bool, safe_zone: bool = False) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_background(draw, big, rounded)
    draw_gauge(draw, big, 0.78 if safe_zone else 1.0)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "icon-192.png": render(192, rounded=True),
        "icon-512.png": render(512, rounded=True),
        "icon-maskable-512.png": render(512, rounded=False, safe_zone=True),
        "apple-touch-icon-180.png": render(180, rounded=False),
        "favicon-32.png": render(32, rounded=True),
    }
    for name, img in outputs.items():
        path = OUT_DIR / name
        img.save(path, format="PNG", optimize=True)
        print(f"wrote {os.path.relpath(path)} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
