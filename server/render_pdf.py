from pathlib import Path
import sys

from PIL import Image


def main() -> None:
    output = Path(sys.argv[1])
    dpi = int(sys.argv[2])
    page_paths = [Path(value) for value in sys.argv[3:]]
    if len(page_paths) < 2:
        raise ValueError("At least two rendered pages are required for a multi-frame TIFF")

    pages = [Image.open(page).convert("L") for page in page_paths]
    try:
        pages[0].save(
            output,
            save_all=True,
            append_images=pages[1:],
            compression="tiff_deflate",
            dpi=(dpi, dpi),
        )
    finally:
        for page in pages:
            page.close()


if __name__ == "__main__":
    main()
