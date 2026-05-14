from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ZEUS_DIR = ROOT / "public" / "textures" / "fabric" / "3" / "Zeus"
SOURCE_FILE = ZEUS_DIR / "Zeus-default.png"


# Palette sampled from the Zeus 01-20 swatches.
ZEUS_COLORS = {
    "01": "#373A39",
    "02": "#4B4C42",
    "03": "#89887D",
    "04": "#B2B4AC",
    "05": "#D2CAB6",
    "06": "#304553",
    "07": "#5A797A",
    "08": "#C5B59A",
    "09": "#A59474",
    "10": "#81725D",
    "11": "#241B19",
    "12": "#C28204",
    "13": "#1D1D1D",
    "14": "#7C490D",
    "15": "#D25604",
    "16": "#BC1B22",
    "17": "#985446",
    "18": "#032F32",
    "19": "#6BA28F",
    "20": "#034722",
}


def hex_to_rgb01(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array(
        [int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)],
        dtype=np.float32,
    ) / 255.0


def load_source() -> np.ndarray:
    img = Image.open(SOURCE_FILE).convert("RGB")
    return np.asarray(img, dtype=np.float32) / 255.0


def recolor_texture(src: np.ndarray, target_rgb: np.ndarray) -> np.ndarray:
    lum = (
        src[..., 0] * 0.2126
        + src[..., 1] * 0.7152
        + src[..., 2] * 0.0722
    )

    p_low = np.percentile(lum, 2.0)
    p_high = np.percentile(lum, 98.0)
    if p_high <= p_low:
        norm = np.clip(lum, 0.0, 1.0)
    else:
        norm = np.clip((lum - p_low) / (p_high - p_low), 0.0, 1.0)

    factor = 0.72 + 0.56 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)
    out = shaded * 0.88 + target_rgb[None, None, :] * 0.12

    # Keep the median of each generated texture close to the sampled swatch.
    flat = out.reshape(-1, 3)
    med = np.median(flat, axis=0)
    scale = target_rgb / np.maximum(med, 0.01)
    scale = np.clip(scale, 0.7, 1.35)
    return np.clip(out * scale[None, None, :], 0.0, 1.0)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []
    for code, color in sorted(ZEUS_COLORS.items()):
        recolored = recolor_texture(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = ZEUS_DIR / f"ZEUS_{code}.png"
        out_img.save(out_path, optimize=True)
        output_files.append((code, out_path))
    return output_files


def build_preview_sheet(files: list[tuple[str, Path]]) -> None:
    thumb_size = 160
    cols = 5
    rows = (len(files) + cols - 1) // cols
    padding = 24

    canvas = Image.new(
        "RGB",
        (
            cols * (thumb_size + padding) + padding,
            rows * (thumb_size + 54 + padding) + padding,
        ),
        color=(24, 24, 24),
    )
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()

    for idx, (code, path) in enumerate(files):
        row = idx // cols
        col = idx % cols
        x = padding + col * (thumb_size + padding)
        y = padding + row * (thumb_size + 54 + padding)
        tile = Image.open(path).convert("RGB").resize((thumb_size, thumb_size))
        canvas.paste(tile, (x, y))
        draw.rounded_rectangle(
            (x - 1, y - 1, x + thumb_size + 1, y + thumb_size + 1),
            radius=14,
            outline=(72, 72, 72),
            width=2,
        )
        draw.text((x, y + thumb_size + 10), f"ZEUS {code}", fill=(236, 236, 236), font=font)

    canvas.save(ZEUS_DIR / "Zeus-generated-preview.png", optimize=True)


def main() -> None:
    src = load_source()
    files = save_variants(src)
    build_preview_sheet(files)
    print(f"Generated {len(files)} Zeus variants in {ZEUS_DIR}")


if __name__ == "__main__":
    main()
