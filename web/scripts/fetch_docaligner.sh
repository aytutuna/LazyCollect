#!/bin/bash
# Fetches DocAligner's FastViT-T8 page corner model (DocsaidLab/DocAligner release 1.1.1, Apache-2.0, see
# public/models/DocAligner-LICENSE.txt) into .cache, checks its SHA-256, and writes the quarter-size int8 copy the site serves
# to public/models/1.1.1/ (scripts/shrink_model.py). Neither model is checked in; without them the scanner finds no page
# by itself (the corner editor still works) and the tests that need the model skip. Needs Python 3 with venv; set PYTHON to
# pick one (onnx has no wheels for the newest releases). Runs in bash on Linux, macOS and Git Bash on Windows.
set -euo pipefail

release="https://github.com/DocsaidLab/DocAligner/releases/download/1.1.1"
web="$(cd "$(dirname "$0")/.." && pwd)"
name=fastvit_t8_h_e_bifpn_256_fp32.onnx
expected=950070fd4a46e25d46db7c35d0ed77612d9063f70d4543c7c504f0da6a943a89
source="$web/.cache/$name"
out="$web/public/models/1.1.1/docaligner-int8.onnx"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

mkdir -p "$web/.cache" "$(dirname "$out")"
if [ ! -f "$source" ] || [ "$(sha256 "$source")" != "$expected" ]; then
  curl -fsSL -o "$source.part" "$release/$name"
  hash=$(sha256 "$source.part")
  if [ "$hash" != "$expected" ]; then
    rm -f "$source.part"
    echo "$name: checksum mismatch: $hash" >&2
    exit 1
  fi
  mv "$source.part" "$source"
  echo "$name: fetched"
fi

if [ -f "$out" ] && [ "$out" -nt "$source" ] && [ "$out" -nt "$web/scripts/shrink_model.py" ]; then
  echo "docaligner-int8.onnx: up to date"
  exit 0
fi
venv="$web/.cache/venv"
if [ ! -d "$venv" ]; then
  "${PYTHON:-python3}" -m venv "$venv"
  "$venv"/*/python -m pip install -q -r "$web/scripts/requirements.txt"
fi
"$venv"/*/python "$web/scripts/shrink_model.py" "$source" "$out"
ls -l "$out" | awk '{print "docaligner-int8.onnx: " $5 " bytes"}'
