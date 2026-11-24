#!/bin/bash
# Fetches DocAligner's FastViT-T8 page corner model (DocsaidLab/DocAligner release 1.1.1, Apache-2.0) into android/models,
# where the Gradle build picks it up as an app asset. It is the float original of the int8 copy the web app serves
# (web/scripts/fetch_docaligner.sh checks the same download against the same hash). Not checked in; without it the app does
# not package. Runs in bash on Linux, macOS and Git Bash on Windows.
set -euo pipefail

release="https://github.com/DocsaidLab/DocAligner/releases/download/1.1.1"
name=fastvit_t8_h_e_bifpn_256_fp32.onnx
expected=950070fd4a46e25d46db7c35d0ed77612d9063f70d4543c7c504f0da6a943a89
models="$(cd "$(dirname "$0")/.." && pwd)/models"
file="$models/$name"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

mkdir -p "$models"
if [ -f "$file" ] && [ "$(sha256 "$file")" = "$expected" ]; then
  echo "$name: already fetched"
  exit 0
fi
curl -fsSL --retry 3 --retry-all-errors --retry-delay 10 -o "$file.part" "$release/$name"
hash=$(sha256 "$file.part")
if [ "$hash" != "$expected" ]; then
  rm -f "$file.part"
  echo "$name: checksum mismatch: $hash" >&2
  exit 1
fi
mv "$file.part" "$file"
echo "$name: fetched"
