"""Prepare a raster score image for optical music recognition."""

import json
import math
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image, ImageOps, UnidentifiedImageError


TARGET_DPI = 300.0
TARGET_DPI_TOLERANCE = 0.5
MIN_VALID_DPI = 35.5
MAX_VALID_DPI = 2400.5
MAX_DPI_DIFFERENCE = 0.10
REFERENCE_LONG_EDGE = 3508
MAX_INPUT_PIXELS = 100_000_000
MAX_INPUT_SIDE = 32_768
MAX_OUTPUT_PIXELS = 20_000_000
MAX_OUTPUT_LONG_EDGE = 5_000
MAX_SCALE = 4.5

# Pillow otherwise rejects large images before this script can apply its stricter,
# explicit dimensions check while the file is still only header-decoded.
Image.MAX_IMAGE_PIXELS = None


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _read_dpi(image):
    raw = image.info.get("dpi")
    if not isinstance(raw, (tuple, list)) or len(raw) < 2:
        return None
    x_dpi = _number(raw[0])
    y_dpi = _number(raw[1])
    if x_dpi is None or y_dpi is None:
        return None
    if not (MIN_VALID_DPI <= x_dpi <= MAX_VALID_DPI):
        return None
    if not (MIN_VALID_DPI <= y_dpi <= MAX_VALID_DPI):
        return None
    if abs(x_dpi - y_dpi) / max(x_dpi, y_dpi) > MAX_DPI_DIFFERENCE:
        return None
    return (x_dpi, y_dpi)


def _json_dpi(dpi):
    if dpi is None:
        return None
    return [round(dpi[0], 4), round(dpi[1], 4)]


def _to_grayscale(image):
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        flattened = Image.alpha_composite(white, rgba)
        grayscale = flattened.convert("L")
        rgba.close()
        white.close()
        flattened.close()
        return grayscale
    return image.convert("L")


def _bounded_size(size, requested_scale):
    width, height = size
    scale_limits = (
        MAX_SCALE,
        MAX_OUTPUT_LONG_EDGE / max(width, height),
        math.sqrt(MAX_OUTPUT_PIXELS / (width * height)),
    )
    actual_scale = max(1.0, min(requested_scale, *scale_limits))
    scale_capped = actual_scale + 1e-9 < requested_scale
    if actual_scale <= 1.0:
        return size, scale_capped
    if scale_capped:
        output_size = (
            max(1, math.floor(width * actual_scale)),
            max(1, math.floor(height * actual_scale)),
        )
    else:
        output_size = (
            max(1, round(width * actual_scale)),
            max(1, round(height * actual_scale)),
        )
    return output_size, scale_capped


def prepare_image(source_path, output_path):
    warnings = []
    temporary_path = None
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(source_path) as opened:
            source_size = opened.size
            width, height = source_size
            if width <= 0 or height <= 0:
                raise ValueError("图片尺寸无效")
            if max(width, height) > MAX_INPUT_SIDE or width * height > MAX_INPUT_PIXELS:
                raise ValueError("图片尺寸超过处理上限（最大边32768像素、总计1亿像素）")
            if max(width, height) > MAX_OUTPUT_LONG_EDGE or width * height > MAX_OUTPUT_PIXELS:
                raise ValueError(
                    "图片尺寸超过预处理上限（最大边5000像素、总计2000万像素），请使用原图识别"
                )

            source_dpi = _read_dpi(opened)
            assumed_dpi = source_dpi is None
            oriented = ImageOps.exif_transpose(opened)
            oriented.load()

        try:
            grayscale = _to_grayscale(oriented)
        finally:
            oriented.close()

        try:
            long_edge = max(grayscale.size)
            if source_dpi is None:
                requested_scale = max(1.0, REFERENCE_LONG_EDGE / long_edge)
                output_dpi = (TARGET_DPI, TARGET_DPI)
                warnings.append("未检测到可靠DPI，已按常见页面尺寸估算并写入300 DPI标记。")
            elif min(source_dpi) >= TARGET_DPI - TARGET_DPI_TOLERANCE:
                requested_scale = 1.0
                output_dpi = source_dpi
            elif long_edge >= REFERENCE_LONG_EDGE:
                requested_scale = 1.0
                output_dpi = (TARGET_DPI, TARGET_DPI)
                warnings.append("图片像素已达到常见300DPI页面尺寸，已保留原像素并规范DPI标记。")
            else:
                requested_scale = TARGET_DPI / min(source_dpi)
                output_dpi = (TARGET_DPI, TARGET_DPI)

            output_size, scale_capped = _bounded_size(grayscale.size, requested_scale)
            resized = output_size != grayscale.size
            if scale_capped:
                warnings.append("受处理上限限制，仅进行了安全范围内的放大；放大无法恢复原图已经丢失的细节。")

            prepared = grayscale.resize(output_size, Image.Resampling.LANCZOS) if resized else grayscale.copy()
            try:
                with tempfile.NamedTemporaryFile(
                    prefix=f".{output.name}.", suffix=".tmp", dir=output.parent, delete=False
                ) as temporary:
                    temporary_path = Path(temporary.name)
                prepared.save(temporary_path, format="PNG", dpi=output_dpi, optimize=True)
                os.replace(temporary_path, output)
                temporary_path = None
            finally:
                prepared.close()
        finally:
            grayscale.close()

        result = {
            "sourceSize": list(source_size),
            "outputSize": list(output_size),
            "sourceDpi": _json_dpi(source_dpi),
            "outputDpi": _json_dpi(output_dpi),
            "resized": resized,
            "assumedDpi": assumed_dpi,
            "scaleCapped": scale_capped,
            "warnings": warnings,
        }
        return result
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 3:
        print("用法：prepare_image.py INPUT OUTPUT", file=sys.stderr)
        return 2
    try:
        result = prepare_image(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, UnidentifiedImageError) as error:
        print(f"图片预处理失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
