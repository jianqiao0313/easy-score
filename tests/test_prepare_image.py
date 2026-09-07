import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "server" / "prepare_image.py"


class PrepareImageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.directory = Path(self.temp_dir.name)

    def run_cli(self, source: Path, output_name="prepared.png"):
        output = self.directory / output_name
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(source), str(output)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        payload = json.loads(result.stdout) if result.stdout.strip() else None
        return result, output, payload

    def save_image(self, name, size, mode="L", dpi=None, color=None, **save_options):
        source = self.directory / name
        if color is None:
            color = 0 if mode in {"1", "L"} else "white"
        image = Image.new(mode, size, color)
        options = dict(save_options)
        if dpi is not None:
            options["dpi"] = dpi
        image.save(source, **options)
        image.close()
        return source

    def assert_png(self, output, size):
        with Image.open(output) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.mode, "L")
            self.assertEqual(image.size, size)
            self.assertAlmostEqual(image.info["dpi"][0], 300, delta=0.02)
            self.assertAlmostEqual(image.info["dpi"][1], 300, delta=0.02)

    def test_150_dpi_image_is_doubled_to_300_dpi(self):
        source = self.save_image("score.png", (400, 600), dpi=(150, 150))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["sourceSize"], [400, 600])
        self.assertEqual(payload["outputSize"], [800, 1200])
        self.assertAlmostEqual(payload["sourceDpi"][0], 150, delta=0.02)
        self.assertAlmostEqual(payload["sourceDpi"][1], 150, delta=0.02)
        self.assertEqual(payload["outputDpi"], [300.0, 300.0])
        self.assertTrue(payload["resized"])
        self.assertFalse(payload["assumedDpi"])
        self.assertFalse(payload["scaleCapped"])
        self.assertEqual(payload["warnings"], [])
        self.assert_png(output, (800, 1200))

    def test_common_low_dpi_values_are_scaled_uniformly(self):
        for dpi, expected in ((96, (300, 450)), (72, (400, 600))):
            with self.subTest(dpi=dpi):
                source = self.save_image(f"score-{dpi}.png", (96, 144), dpi=(dpi, dpi))
                result, output, payload = self.run_cli(source, f"prepared-{dpi}.png")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(tuple(payload["outputSize"]), expected)
                self.assertFalse(payload["scaleCapped"])
                self.assert_png(output, expected)

    def test_png_300_dpi_rounding_does_not_resize(self):
        source = self.save_image("rounded.png", (320, 480), dpi=(300, 300))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["sourceDpi"], [299.9994, 299.9994])
        self.assertEqual(payload["outputSize"], [320, 480])
        self.assertFalse(payload["resized"])
        self.assertFalse(payload["assumedDpi"])
        self.assert_png(output, (320, 480))

    def test_high_dpi_image_keeps_pixels_and_metadata(self):
        source = self.save_image("high.png", (200, 300), dpi=(600, 600))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["outputSize"], [200, 300])
        self.assertEqual(payload["outputDpi"], payload["sourceDpi"])
        self.assertFalse(payload["resized"])
        with Image.open(output) as image:
            self.assertAlmostEqual(image.info["dpi"][0], 600, delta=0.02)

    def test_missing_dpi_uses_a4_long_edge_heuristic(self):
        source = self.save_image("unknown.png", (1000, 1400))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["sourceDpi"], None)
        self.assertEqual(payload["outputSize"], [2506, 3508])
        self.assertTrue(payload["resized"])
        self.assertTrue(payload["assumedDpi"])
        self.assertTrue(payload["warnings"])
        self.assert_png(output, (2506, 3508))

    def test_unreliable_dpi_pair_uses_page_size_heuristic(self):
        source = self.save_image("uneven.png", (1000, 1400), dpi=(72, 300))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(payload["sourceDpi"])
        self.assertTrue(payload["assumedDpi"])
        self.assertEqual(payload["outputSize"], [2506, 3508])
        self.assertTrue(payload["warnings"])

    def test_large_image_with_low_dpi_label_is_not_enlarged(self):
        source = self.save_image("large.png", (2600, 3600), mode="1", dpi=(72, 72), color=1)

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertAlmostEqual(payload["sourceDpi"][0], 72, delta=0.02)
        self.assertEqual(payload["outputSize"], [2600, 3600])
        self.assertFalse(payload["resized"])
        self.assertFalse(payload["scaleCapped"])
        self.assertIn("图片像素已达到常见300DPI页面尺寸，已保留原像素并规范DPI标记。", payload["warnings"])
        self.assert_png(output, (2600, 3600))

    def test_exif_orientation_is_applied_before_output(self):
        source = self.directory / "rotated.jpg"
        image = Image.new("RGB", (40, 20), "white")
        exif = image.getexif()
        exif[274] = 6
        image.save(source, dpi=(600, 600), exif=exif)
        image.close()

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["sourceSize"], [40, 20])
        self.assertEqual(payload["outputSize"], [20, 40])
        with Image.open(output) as prepared:
            self.assertEqual(prepared.size, (20, 40))
            self.assertEqual(prepared.mode, "L")

    def test_transparency_is_composited_on_white(self):
        source = self.directory / "alpha.png"
        image = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
        image.putpixel((1, 0), (0, 0, 0, 255))
        image.save(source, dpi=(600, 600))
        image.close()

        result, output, _ = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        with Image.open(output) as prepared:
            self.assertEqual(list(prepared.getdata()), [255, 0])

    def test_bilevel_and_cmyk_inputs_become_grayscale_png(self):
        bilevel = self.save_image("binary.png", (10, 10), mode="1", dpi=(600, 600), color=1)
        cmyk = self.save_image("cmyk.jpg", (10, 10), mode="CMYK", dpi=(600, 600), color=(0, 0, 0, 0))
        for source in (bilevel, cmyk):
            with self.subTest(source=source.name):
                result, output, _ = self.run_cli(source, f"{source.stem}-prepared.png")
                self.assertEqual(result.returncode, 0, result.stderr)
                with Image.open(output) as prepared:
                    self.assertEqual(prepared.format, "PNG")
                    self.assertEqual(prepared.mode, "L")

    def test_scale_is_capped_at_four_and_a_half_times(self):
        source = self.save_image("tiny.png", (100, 100), dpi=(36, 36))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["outputSize"], [450, 450])
        self.assertFalse(payload["assumedDpi"])
        self.assertTrue(payload["scaleCapped"])
        self.assertTrue(any("上限" in warning for warning in payload["warnings"]))
        self.assert_png(output, (450, 450))

    def test_scale_is_capped_at_5000_pixel_long_edge(self):
        source = self.save_image("wide.png", (1500, 100), dpi=(72, 72))

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["outputSize"], [5000, 333])
        self.assertTrue(payload["scaleCapped"])
        self.assert_png(output, (5000, 333))

    def test_scale_is_capped_at_twenty_megapixels(self):
        source = self.save_image("pixels.png", (1000, 1000), mode="1", dpi=(50, 50), color=1)

        result, output, payload = self.run_cli(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        width, height = payload["outputSize"]
        self.assertLessEqual(width * height, 20_000_000)
        self.assertGreater(width, 4400)
        self.assertTrue(payload["scaleCapped"])
        self.assert_png(output, (width, height))

    def test_malformed_input_fails_without_output(self):
        source = self.directory / "broken.png"
        source.write_bytes(b"not an image")

        result, output, payload = self.run_cli(source)

        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(payload)
        self.assertFalse(output.exists())

    def test_dimensions_are_rejected_before_pixel_decode(self):
        for name, size in (("side.png", (32769, 1)), ("pixels.png", (20000, 6000))):
            with self.subTest(size=size):
                source = self.directory / name
                self.write_header_only_png(source, size)
                result, output, payload = self.run_cli(source, f"{name}.out.png")
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(payload)
                self.assertFalse(output.exists())
                self.assertIn("图片尺寸超过处理上限", result.stderr)

    def test_images_beyond_preprocessing_capacity_fail_before_decode(self):
        for name, dpi in (("large-300.png", 300), ("large-unknown.png", None)):
            with self.subTest(dpi=dpi):
                source = self.directory / name
                self.write_header_only_png(source, (6000, 4000), dpi=dpi)
                original = source.read_bytes()

                result, output, payload = self.run_cli(source, f"{name}.out.png")

                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(payload)
                self.assertFalse(output.exists())
                self.assertEqual(source.read_bytes(), original)
                self.assertIn("图片尺寸超过预处理上限", result.stderr)
                self.assertIn("请使用原图识别", result.stderr)

    @staticmethod
    def write_header_only_png(path: Path, size, dpi=None):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

        width, height = size
        ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
        metadata = b""
        if dpi is not None:
            pixels_per_meter = round(dpi / 0.0254)
            metadata = chunk(b"pHYs", struct.pack(">IIB", pixels_per_meter, pixels_per_meter, 1))
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + metadata + chunk(b"IEND", b""))


if __name__ == "__main__":
    unittest.main()
