from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(r"C:\Users\Práce\Desktop\configurator")
MYSTIC_DIR = ROOT / "public" / "textures" / "fabric" / "3" / "Mystic"
SOURCE_FILE = MYSTIC_DIR / "Mystic-default.png"


# Approximate palette sampled by eye from the user's Aquaclean Mystic screenshots.
MYSTIC_COLORS = {
    "01": "#ECE4CC",
    "03": "#B3AB97",
    "05": "#A66E76",
    "07": "#332821",
    "08": "#A61F35",
    "100": "#DDB95D",
    "104": "#A58E6C",
    "105": "#D5B437",
    "11": "#2D3C53",
    "112": "#BBB9B6",
    "114": "#6E5B4E",
    "12": "#C3C0A7",
    "13": "#2E3E3C",
    "131": "#686351",
    "136": "#D8DDD4",
    "144": "#575047",
    "15": "#46483E",
    "161": "#C0754E",
    "165": "#EFE9D0",
    "176": "#C9CCCA",
    "177": "#F1ECDD",
    "18": "#A39A84",
    "187": "#5AA669",
    "190": "#5D4754",
    "21": "#B1B5A9",
    "213": "#8F8E89",
    "214": "#59615A",
    "244": "#E8DFAC",
    "248": "#949268",
    "250": "#D9D1AB",
    "252": "#B7AEA4",
    "311": "#60737B",
    "313": "#979694",
    "32": "#C2B485",
    "320": "#A2A598",
    "324": "#EFEBD5",
    "373": "#C87456",
    "38": "#D42A36",
    "387": "#A0BC85",
    "395": "#536B65",
    "50": "#D9D09F",
    "503": "#D9C0AF",
    "51": "#BEB382",
    "510": "#5E97A6",
    "514": "#BB9822",
    "52": "#A09B89",
    "523": "#E8EDE9",
    "525": "#BFC7BE",
    "526": "#DCE4DF",
    "528": "#C4D7B8",
    "537": "#BED9D7",
    "545": "#DED59E",
    "546": "#EAE3C1",
    "549": "#C8C1C0",
    "551": "#AF886A",
    "553": "#B9784A",
    "556": "#C3C8BB",
    "559": "#BCB08C",
    "56": "#A63F31",
    "59": "#202329",
    "602": "#A8BEC3",
    "603": "#879DA8",
    "61": "#A5B33E",
    "62": "#BB723C",
    "64": "#D87731",
    "65": "#952045",
    "66": "#B54E76",
    "68": "#4F8E8A",
    "69": "#93917A",
    "73": "#A89650",
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
    # Build a neutral luminance layer from the original seamless texture.
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

    # Keep the Mystic weave detail, but center the value around the target tone.
    factor = 0.76 + 0.48 * norm
    shaded = np.clip(target_rgb[None, None, :] * factor[..., None], 0.0, 1.0)

    # Blend a little of the flat target back in so the color stays stable.
    out = shaded * 0.82 + target_rgb[None, None, :] * 0.18
    return np.clip(out, 0.0, 1.0)


def save_variants(src: np.ndarray) -> list[tuple[str, Path]]:
    output_files = []
    for code, color in sorted(MYSTIC_COLORS.items(), key=lambda item: (len(item[0]), item[0])):
        recolored = recolor_texture(src, hex_to_rgb01(color))
        out_img = Image.fromarray((recolored * 255.0).astype(np.uint8), mode="RGB")
        out_path = MYSTIC_DIR / f"MYSTIC_{code}.png"
        out_img.save(out_path, optimize=True)
        output_files.append((code, out_path))
    return output_files


def build_preview_sheet(files: list[tuple[str, Path]]) -> None:
    thumb_size = 160
    cols = 5
    rows = (len(files) + cols - 1) // cols
    padding = 24
    header_h = 34

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
        draw.text((x, y + thumb_size + 10), f"MYSTIC {code}", fill=(236, 236, 236), font=font)

    canvas.save(MYSTIC_DIR / "Mystic-generated-preview.png", optimize=True)


def main() -> None:
    src = load_source()
    files = save_variants(src)
    build_preview_sheet(files)
    print(f"Generated {len(files)} Mystic variants in {MYSTIC_DIR}")


if __name__ == "__main__":
    main()
