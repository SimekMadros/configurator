from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
VENICE_DIR = ROOT / "public" / "textures" / "fabric" / "3" / "Venice"
SOURCE_FILE = VENICE_DIR / "Venice-default.png"


# Approximate palette sampled by eye from the user's Venice screenshots.
VENICE_COLORS = {
    "01": "#F0EFE7",
    "07": "#5C4D42",
    "08": "#C92F34",
    "11": "#516373",
    "111": "#9D8B7D",
    "13": "#A8ADAD",
    "131": "#62625B",
    "15": "#303538",
    "156": "#D7D1C1",
    "213": "#777C7C",
    "214": "#2F3F47",
    "250": "#D8CCB9",
    "266": "#A64A48",
    "27": "#96564F",
    "271": "#77797B",
    "29": "#B96C5D",
    "300": "#B8BDB7",
    "324": "#E6E4DA",
    "336": "#D6D9D8",
    "339": "#3F4B43",
    "349": "#9C8974",
    "43": "#7C8674",
    "458": "#B8543C",
    "46": "#BFB8B2",
    "50": "#ECEBE1",
    "510": "#3F7E90",
    "514": "#D19700",
    "53": "#658291",
    "60": "#344151",
    "602": "#859096",
    "61": "#737A59",
    "618": "#696846",
    "62": "#B75D43",
    "625": "#D99132",
    "667": "#873A3E",
    "69": "#B8BCB7",
    "80": "#C8BEB3",
    "91": "#964D31",
    "93": "#365457",
    "94": "#9AACB5",
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

    factor = 0.70 + 0.62 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)
    out = shaded * 0.86 + target_rgb[None, None, :] * 0.14

    flat = out.reshape(-1, 3)
    med = np.median(flat, axis=0)
    scale = target_rgb / np.maximum(med, 0.01)
    scale = np.clip(scale, 0.68, 1.38)
    return np.clip(out * scale[None, None, :], 0.0, 1.0)


def sort_key(item: tuple[str, str]) -> tuple[int, int | str]:
    code = item[0]
    return (len(code), int(code) if code.isdigit() else code)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []
    for code, color in sorted(VENICE_COLORS.items(), key=sort_key):
        recolored = recolor_texture(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = VENICE_DIR / f"VENICE_{code}.png"
        out_img.save(out_path, optimize=True)
        output_files.append((code, out_path))
    return output_files


def build_preview_sheet(files: list[tuple[str, Path]]) -> None:
    thumb_size = 132
    cols = 5
    rows = (len(files) + cols - 1) // cols
    padding = 22

    canvas = Image.new(
        "RGB",
        (
            cols * (thumb_size + padding) + padding,
            rows * (thumb_size + 48 + padding) + padding,
        ),
        color=(24, 24, 24),
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
        draw.rounded_rectangle(
            (x - 1, y - 1, x + thumb_size + 1, y + thumb_size + 1),
            radius=10,
            outline=(72, 72, 72),
            width=2,
        )
        draw.text((x, y + thumb_size + 10), f"VENICE {code}", fill=(236, 236, 236), font=font)

    canvas.save(VENICE_DIR / "Venice-generated-preview.png", optimize=True)


def main() -> None:
    src = load_source()
    files = save_variants(src)
    build_preview_sheet(files)
    print(f"Generated {len(files)} Venice variants in {VENICE_DIR}")


if __name__ == "__main__":
    main()
