from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ZOYA_DIR = ROOT / "public" / "textures" / "fabric" / "2" / "Zoya"

SOURCE_FILE = ZOYA_DIR / "Zoya-default.jpg"
NORMAL_FILE = ZOYA_DIR / "FabricSuedePatchy001_NRM_2K.jpg"
GLOSS_FILE = ZOYA_DIR / "FabricSuedePatchy001_GLOSS_2K.jpg"

# Přibližné barvy podle screenu Zoya
ZOYA_COLORS = {
    "01": "#C8C2B8",
    "02": "#A59A95",
    "03": "#8B767D",
    "04": "#4E2E39",
    "05": "#5E5554",
    "06": "#274848",

    "07": "#5B7485",
    "08": "#546A6C",
    "09": "#394960",
    "10": "#636A71",
    "11": "#70757A",
    "12": "#B7BCBA",

    "13": "#9F8441",
    "14": "#586147",
    "15": "#2E5C8D",
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
    # Luminance pro zachování struktury suede textury
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

    # Zoya je suede / semiš -> jemný, matnější, bez přepálených kontrastů
    factor = 0.82 + 0.34 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)

    # Lehké promíchání s cílovou barvou, aby textura neztratila odstín
    out = shaded * 0.90 + target_rgb[None, None, :] * 0.10

    # Dorovnání mediánu, aby výsledek seděl na cílový odstín
    flat = out.reshape(-1, 3)
    med = np.median(flat, axis=0)
    scale = target_rgb / np.maximum(med, 0.01)
    scale = np.clip(scale, 0.80, 1.20)

    return np.clip(out * scale[None, None, :], 0.0, 1.0)


def invert_gloss_to_roughness() -> Path:
    """
    Gloss je opak roughness.
    U semiše chceme spíš matnější povrch,
    takže po invertu roughness ještě posuneme do matnějšího rozsahu.
    """
    img = Image.open(GLOSS_FILE).convert("L")
    gloss = np.asarray(img, dtype=np.float32) / 255.0

    # gloss -> roughness
    rough = 1.0 - gloss

    # semiš by měl být dost matný
    rough = 0.72 + rough * 0.24
    rough = np.clip(rough, 0.72, 0.96)

    out = (rough * 255.0).astype(np.uint8)
    out_img = Image.fromarray(out, mode="L").convert("RGB")

    out_path = ZOYA_DIR / "FabricSuedePatchy001_Roughness_FromGloss_2K.png"
    out_img.save(out_path, optimize=True)

    return out_path


def sort_key(item: tuple[str, str]) -> tuple[int, int | str]:
    code = item[0]
    return (len(code), int(code) if code.isdigit() else code)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []

    for code, color in sorted(ZOYA_COLORS.items(), key=sort_key):
        recolored = recolor_texture(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = ZOYA_DIR / f"ZOYA_{code}.png"
        out_img.save(out_path, optimize=True)
        output_files.append((code, out_path))

    return output_files


def build_preview_sheet(files: list[tuple[str, Path]]) -> None:
    thumb_size = 132
    cols = 6
    rows = (len(files) + cols - 1) // cols
    padding = 22

    canvas = Image.new(
        "RGB",
        (
            cols * (thumb_size + padding) + padding,
            rows * (thumb_size + 48 + padding) + padding,
        ),
        color=(245, 245, 245),
    )

    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()

    for idx, (code, path) in enumerate(files):
        row = idx // cols
        col = idx % cols
        x = padding + col * (thumb_size + padding)
        y = padding + row * (thumb_size + 48 + padding)

        tile = Image.open(path).convert("RGB").resize((thumb_size, thumb_size))
        canvas.paste(tile, (x, y))

        draw.text(
            (x + 42, y + thumb_size + 10),
            f"{code}",
            fill=(80, 56, 32),
            font=font,
        )

    canvas.save(ZOYA_DIR / "Zoya-generated-preview.png", optimize=True)


def main() -> None:
    if not SOURCE_FILE.exists():
        raise FileNotFoundError(f"Missing source file: {SOURCE_FILE}")
    if not NORMAL_FILE.exists():
        raise FileNotFoundError(f"Missing normal file: {NORMAL_FILE}")
    if not GLOSS_FILE.exists():
        raise FileNotFoundError(f"Missing gloss file: {GLOSS_FILE}")

    src = load_source()
    files = save_variants(src)
    roughness_path = invert_gloss_to_roughness()
    build_preview_sheet(files)

    print(f"Generated {len(files)} Zoya variants in {ZOYA_DIR}")
    print(f"Using normal map: {NORMAL_FILE}")
    print(f"Generated roughness from gloss: {roughness_path}")


if __name__ == "__main__":
    main()