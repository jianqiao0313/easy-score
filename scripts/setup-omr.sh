#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OMR_DIR="$ROOT_DIR/.local/omr"
DMG_PATH="$OMR_DIR/Audiveris-5.11.0-macosx-arm64.dmg"
APP_PATH="$OMR_DIR/Audiveris.app"
TESSDATA_DIR="$OMR_DIR/tessdata"
URL="https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-macosx-arm64.dmg"
ENG_URL="https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata"

mkdir -p "$OMR_DIR"
if [ ! -s "$DMG_PATH" ]; then
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$DMG_PATH" "$URL"
fi

MOUNT_POINT=$(mktemp -d "${TMPDIR:-/tmp}/score-player-audiveris.XXXXXX")
cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [ ! -x "$APP_PATH/Contents/MacOS/Audiveris" ]; then
  hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
  SOURCE_APP=$(find "$MOUNT_POINT" -maxdepth 2 -type d -name 'Audiveris.app' -print -quit)
  if [ -z "$SOURCE_APP" ]; then
    echo "Audiveris.app was not found in the disk image." >&2
    exit 1
  fi
  ditto "$SOURCE_APP" "$APP_PATH"
  xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
fi
printf 'Y\n' | "$APP_PATH/Contents/MacOS/Audiveris" -version

mkdir -p "$TESSDATA_DIR"
if [ ! -s "$TESSDATA_DIR/eng.traineddata" ]; then
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$TESSDATA_DIR/eng.traineddata" "$ENG_URL"
fi
echo "English OCR data installed in $TESSDATA_DIR"
