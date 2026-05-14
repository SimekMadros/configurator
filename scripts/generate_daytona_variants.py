from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(r"C:\Users\Práce\Desktop\configurator")
DAYTONA_DIR = ROOT / "public" / "textures" / "fabric" / "3" / "Daytona"
SOURCE_FILE = DAYTONA_DIR / "Daytona-default.jpg"


# Approximate palette sampled by eye from the user's Daytona screenshots.
DAYTONA_COLORS = {
    "49": "#8C9472",
    "60": "#EFECE6",
    "72": "#6A584E",
    "76": "#D9DDE3",
    "77": "#AEB4B7",
    "78": "#627487",
    "80": "#956053",
    "81": "#E7D18A",
    "86": "#D8D8BE",
    "91": "#333A40",
    "98": "#BD5A56",
    "102": "#C9C3AE",
    "108": "#B8B29C",
    "109": "#2E3B58",
    "110": "#6F6F6F",
    "131": "#F2C94C",
    "137": "#4D4748",
    "138": "#B09163",
    "139": "#C0C5B4",
    "142": "#C8774E",
    "145": "#A8BB4B",
    "146": "#3B92A9",
    "151": "#E6D4A2",
    "152": "#95979D",
    "153": "#8B6775",
    "155": "#9ED0C0",
    "156": "#557C73",
    "157": "#A8AF8B",
    "158": "#AE8944",
    "163": "#6C625E",
    "164": "#B5B1AF",
    "165": "#B2BEC1",
    "183": "#CD1A1C",
    "184": "#C3D0DC",
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

    factor = 0.78 + 0.44 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)
    out = shaded * 0.84 + target_rgb[None, None, :] * 0.16
    return np.clip(out, 0.0, 1.0)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []
    for code, color in sorted(DAYTONA_COLORS.items(), key=lambda item: (len(item[0]), item[0])):
        recolored = recolor_texture(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = DAYTONA_DIR / f"DAYTONA_HP_{code}.png"
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
        draw.text((x, y + thumb_size + 10), f"DAYTONA HP {code}", fill=(236, 236, 236), font=font)

    canvas.save(DAYTONA_DIR / "Daytona-generated-preview.png", optimize=True)


def main() -> None:
    src = load_source()
    files = save_variants(src)
    build_preview_sheet(files)
    print(f"Generated {len(files)} Daytona variants in {DAYTONA_DIR}")


if __name__ == "__main__":
    main()
