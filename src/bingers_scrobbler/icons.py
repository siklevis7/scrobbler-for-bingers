"""The app icon, drawn in code so no image editor is needed.

Design: a bold rounded play button with a check mark cut out of it ("play -> done"), trailed by
two fading play buttons (episode after episode), on a violet-to-orange gradient tile.

`python -m bingers_scrobbler.icons` regenerates assets/icon.png and assets/icon.ico.
"""

from __future__ import annotations

from importlib import resources
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

# Gradient stops, top-left to bottom-right.
GRADIENT = [(0.0, (91, 33, 182)), (0.5, (219, 39, 119)), (1.0, (251, 146, 60))]

SUPERSAMPLE = 4


def _lerp(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def _gradient(s: int) -> Image.Image:
    """A diagonal multi-stop gradient filling an s x s square."""
    n = 512
    line = Image.new("RGB", (n, 1))
    for i in range(n):
        t = i / (n - 1)
        for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
            if t0 <= t <= t1:
                line.putpixel((i, 0), _lerp(c0, c1, (t - t0) / (t1 - t0)))
                break
    big = int(s * 1.5)
    square = line.resize((big, big), Image.BILINEAR).rotate(-45, resample=Image.BICUBIC)
    off = (big - s) // 2
    return square.crop((off, off, off + s, off + s))


def _rounded_triangle(s: int, pts: list[tuple[float, float]], roundness: float) -> Image.Image:
    """Mask of a triangle with soft, rounded corners."""
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).polygon([(x * s, y * s) for x, y in pts], fill=255)
    blurred = mask.filter(ImageFilter.GaussianBlur(s * roundness))
    return blurred.point(lambda v: 255 if v > 128 else 0)


def _dilate(mask: Image.Image, px: int) -> Image.Image:
    size = px * 2 + 1
    return mask.filter(ImageFilter.MaxFilter(size if size % 2 else size + 1))


def _check(s: int, pts: list[tuple[float, float]], width: float) -> Image.Image:
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)
    xy = [(x * s, y * s) for x, y in pts]
    w = int(width * s)
    d.line(xy, fill=255, width=w, joint="curve")
    r = w / 2
    for x, y in (xy[0], xy[-1]):  # round caps
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    return mask


def _chevron(s: int, tip_x: float, half_h: float, depth: float, width: float) -> Image.Image:
    """A rounded '>' stroke whose point sits at (tip_x, 0.5)."""
    return _check(s, [(tip_x - depth, 0.5 - half_h), (tip_x, 0.5), (tip_x - depth, 0.5 + half_h)], width)


def draw_icon(size: int = 256) -> Image.Image:
    s = size * SUPERSAMPLE
    sh = 0.005  # centre the whole group optically
    tiny = size <= 24  # tray sizes: fewer, bolder shapes

    # The play button.
    main = _rounded_triangle(s, [(0.44 + sh, 0.24), (0.44 + sh, 0.76), (0.84 + sh, 0.50)], 0.022)
    # "Play -> done": a check mark cut out of it.
    check = _check(s, [(0.505 + sh, 0.505), (0.562 + sh, 0.568), (0.668 + sh, 0.438)], 0.06)
    main = ImageChops.subtract(main, check)
    # Motion chevrons trailing behind: episode after episode.
    near = _chevron(s, 0.385 + sh, 0.15, 0.13, 0.075 if tiny else 0.058)
    far = Image.new("L", (s, s), 0) if tiny else _chevron(s, 0.265 + sh, 0.11, 0.10, 0.05)

    # Tile: gradient plus a gentle top-down sheen, clipped to a rounded square.
    tile = _gradient(s).convert("RGBA")
    sheen = Image.linear_gradient("L").resize((s, s)).point(lambda v: max(0, int((150 - v) * 0.22)))
    white = Image.new("RGBA", (s, s), (255, 255, 255, 255))
    tile = Image.composite(white, tile, sheen)

    for mask, alpha in ((far, 0.38), (near, 0.7), (main, 1.0)):
        tile = Image.composite(white, tile, mask.point(lambda v, a=alpha: int(v * a)))

    clip = Image.new("L", (s, s), 0)
    ImageDraw.Draw(clip).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.235), fill=255)
    tile.putalpha(clip)
    return tile.resize((size, size), Image.LANCZOS)


def load_icon(paused: bool = False) -> Image.Image:
    """The tray image; greyed out while tracking is paused."""
    try:
        with resources.files("bingers_scrobbler").joinpath("assets/icon.png").open("rb") as fh:
            img = Image.open(fh).convert("RGBA")
            img.load()
    except (FileNotFoundError, OSError):
        img = draw_icon(64)
    if paused:
        alpha = img.getchannel("A")
        grey = ImageOps.grayscale(img).convert("RGBA")
        grey.putalpha(alpha)
        img = grey
    return img


def write_assets(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    big = draw_icon(512)
    big.resize((256, 256), Image.LANCZOS).save(folder / "icon.png")
    # Each size rendered on its own, so small sizes stay crisp.
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [draw_icon(n) for n in sizes]
    frames[-1].save(folder / "icon.ico", sizes=[(n, n) for n in sizes], append_images=frames[:-1])


if __name__ == "__main__":
    out = Path(__file__).parent / "assets"
    write_assets(out)
    print(f"Wrote icons to {out}")
