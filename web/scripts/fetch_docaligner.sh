#!/bin/bash
# Fetches DocAligner's FastViT-T8 page corner model (DocsaidLab/DocAligner release 1.1.1, Apache-2.0, see
# public/models/DocAligner-LICENSE.txt) into .cache, checks its SHA-256, and writes the quarter-size int8 copy the site serves
# (scripts/shrink_model.py) to public/models/<first 12 hex of its SHA-256>/docaligner-int8.onnx. The int8 file is checked
# against src/scan/model.json, which the app reads to build the same path, so a changed model gets a new immutable URL.
# Neither model is checked in; without them the scanner finds no page by itself (the corner editor still works) and the
# tests that need the model skip. Needs Python 3 with venv; set PYTHON to pick one (onnx has no wheels for the newest
# releases). Runs in bash on Linux, macOS and Git Bash on Windows.
set -euo pipefail

release="https://github.com/DocsaidLab/DocAligner/releases/download/1.1.1"
web="$(cd "$(dirname "$0")/.." && pwd)"
name=fastvit_t8_h_e_bifpn_256_fp32.onnx
expected=950070fd4a46e25d46db7c35d0ed77612d9063f70d4543c7c504f0da6a943a89
expected_int8=$(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$web/src/scan/model.json")
source="$web/.cache/$name"
out="$web/public/models/${expected_int8:0:12}/docaligner-int8.onnx"

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

if [ -f "$out" ] && [ "$(sha256 "$out")" = "$expected_int8" ]; then
  echo "docaligner-int8.onnx: up to date"
  exit 0
fi

# the venv is trusted only once pip has finished, and is rebuilt when the requirements change
venv="$web/.cache/venv"
wanted=$(sha256 "$web/scripts/requirements.txt")
if [ ! -f "$venv/stamp" ] || [ "$(cat "$venv/stamp")" != "$wanted" ]; then
  rm -rf "$venv"
  "${PYTHON:-python3}" -m venv "$venv"
  "$venv"/*/python -m pip install -q -r "$web/scripts/requirements.txt"
  echo "$wanted" > "$venv/stamp"
fi
"$venv"/*/python "$web/scripts/shrink_model.py" "$source" "$out"
hash=$(sha256 "$out")
if [ "$hash" != "$expected_int8" ]; then
  rm -f "$out"
  echo "docaligner-int8.onnx: checksum mismatch: $hash (update src/scan/model.json if the model changed on purpose)" >&2
  exit 1
fi
ls -l "$out" | awk '{print "docaligner-int8.onnx: " $5 " bytes"}'
