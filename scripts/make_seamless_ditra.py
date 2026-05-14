from pathlib import Path
from PIL import Image


ROOT = Path(r"C:\Users\Práce\Desktop\configurator\public\textures\fabric\2\Ditra")


def smoothstep01(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def make_tileable(im: Image.Image, margin_ratio: float = 0.12) -> Image.Image:
    im = im.convert("RGBA")
    src = im.load()
    w, h = im.size
    out = im.copy()
    dst = out.load()

    mx = max(8, int(w * margin_ratio))
    my = max(8, int(h * margin_ratio))

    # Horizontal stitch: left/right edges become mutually compatible.
    for x in range(mx):
      t = smoothstep01(x / max(1, mx - 1))
      rx = w - mx + x
      for y in range(h):
        a = src[x, y]
        b = src[rx, y]
        mid = tuple(int(round((a[i] + b[i]) * 0.5)) for i in range(4))
        left_px = tuple(int(round(mid[i] * (1.0 - t) + a[i] * t)) for i in range(4))
        right_px = tuple(int(round(mid[i] * (1.0 - t) + b[i] * t)) for i in range(4))
        dst[x, y] = left_px
        dst[rx, y] = right_px

    # Vertical stitch: top/bottom edges become mutually compatible.
    src2 = out.load()
    for y in range(my):
      t = smoothstep01(y / max(1, my - 1))
      by = h - my + y
      for x in range(w):
        a = src2[x, y]
        b = src2[x, by]
        mid = tuple(int(round((a[i] + b[i]) * 0.5)) for i in range(4))
        top_px = tuple(int(round(mid[i] * (1.0 - t) + a[i] * t)) for i in range(4))
        bottom_px = tuple(int(round(mid[i] * (1.0 - t) + b[i] * t)) for i in range(4))
        dst[x, y] = top_px
        dst[x, by] = bottom_px

    return out


def output_path_for(path: Path) -> Path:
    return path.with_name(f"{path.stem}_tile{path.suffix}")


def process(path: Path) -> None:
    out_path = output_path_for(path)
    img = Image.open(path)
    tile = make_tileable(img)

    save_kwargs = {}
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        tile = tile.convert("RGB")
        save_kwargs["quality"] = 95
    tile.save(out_path, **save_kwargs)
    print(f"created: {out_path.name}")


def main() -> None:
    shade_files = sorted(ROOT.glob("DITRA_*.jpg"))
    shade_files = [p for p in shade_files if "_tile" not in p.stem]

    for path in shade_files:
        process(path)

    for name in ("DITRA_normal.png", "DITRA_roughness.png"):
        process(ROOT / name)


if __name__ == "__main__":
    main()
