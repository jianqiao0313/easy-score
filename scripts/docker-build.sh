#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${1:-easy-score:local}
PLATFORM=${PLATFORM:-linux/amd64}

if [ "$PLATFORM" != "linux/amd64" ]; then
  echo "Audiveris 5.11.0 publishes Linux installers for x86_64 only; use PLATFORM=linux/amd64." >&2
  exit 2
fi

exec docker buildx build \
  --platform "$PLATFORM" \
  --load \
  --tag "$IMAGE" \
  "$ROOT_DIR"
