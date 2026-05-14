from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(r"C:\Users\Práce\Desktop\configurator")
LEATHER_DIR = ROOT / "public" / "textures" / "fabric" / "leather"
SOURCE_FILE = LEATHER_DIR / "FabricLeatherSheepskinTopGrain001_COL_VAR3_2K.jpg"
GLOSS_FILE = LEATHER_DIR / "FabricLeatherSheepskinTopGrain001_GLOSS_2K.jpg"


FLORIDA_COLORS = {
    "Optic White": "#F1F0EC",
    "Milk": "#DDD7CC",
    "Sand": "#C8BEAA",
    "Cream": "#DDD1BB",
    "Almond": "#B89F87",
    "Camel": "#AA825F",
    "Tabacco": "#775641",
    "Elephant": "#8D837A",
    "Taupe": "#8F857A",
    "Ebony": "#413733",
    "Forest": "#4D6553",
    "Red": "#A52022",
    "Ocean": "#457D93",
    "Cement": "#9D9C98",
    "Ash": "#B5BEC2",
    "Anthracite": "#55595C",
    "Black": "#1E1D1E",
}


def slugify(name: str) -> str:
    return name.upper().replace(" ", "_")


def hex_to_rgb01(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array(
        [int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)],
        dtype=np.float32,
    ) / 255.0


def load_source() -> np.ndarray:
    img = Image.open(SOURCE_FILE).convert("RGB")
    return np.asarray(img, dtype=np.float32) / 255.0


def recolor_leather(src: np.ndarray, target_rgb: np.ndarray) -> np.ndarray:
    lum = (
        src[..., 0] * 0.2126
        + src[..., 1] * 0.7152
        + src[..., 2] * 0.0722
    )
    p_low = np.percentile(lum, 1.5)
    p_high = np.percentile(lum, 98.5)
    norm = np.clip((lum - p_low) / max(1e-6, (p_high - p_low)), 0.0, 1.0)

    factor = 0.80 + 0.38 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)
    out = shaded * 0.88 + target_rgb[None, None, :] * 0.12
    return np.clip(out, 0.0, 1.0)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []
    for label, color in FLORIDA_COLORS.items():
        recolored = recolor_leather(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = LEATHER_DIR / f"FLORIDA_{slugify(label)}.png"
        out_img.save(out_path, optimize=True)
        output_files.append((label, out_path))
    return output_files


def generate_roughness_from_gloss() -> Path:
    gloss = Image.open(GLOSS_FILE).convert("L")
    rough = ImageOps.invert(gloss)
    out_path = LEATHER_DIR / "FabricLeatherSheepskinTopGrain001_Roughness_FromGloss_2K.png"
    rough.save(out_path, optimize=True)
    return out_path


def build_preview_sheet(files: list[tuple[str, Path]]) -> None:
    thumb_size = 160
    cols = 4
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

    for idx, (label, path) in enumerate(files):
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
        draw.text((x, y + thumb_size + 10), f"FLORIDA {label}", fill=(236, 236, 236), font=font)

    canvas.save(LEATHER_DIR / "Florida-generated-preview.png", optimize=True)


def main() -> None:
    src = load_source()
    files = save_variants(src)
    roughness_path = generate_roughness_from_gloss()
    build_preview_sheet(files)
    print(f"Generated {len(files)} Florida variants in {LEATHER_DIR}")
    print(f"Generated roughness map: {roughness_path.name}")


if __name__ == "__main__":
    main()
