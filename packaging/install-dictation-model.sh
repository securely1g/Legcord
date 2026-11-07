#!/bin/bash
set -euo pipefail

speech_dir="${XDG_CONFIG_HOME:-$HOME/.config}/legcord/speech"
model="$speech_dir/ggml-base.bin"
checksum=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
mkdir -p "$speech_dir"
chmod 700 "$speech_dir"

if [[ -f "$model" ]]; then
    printf '%s  %s\n' "$checksum" "$model" | sha256sum --check -
    exit 0
fi

download=$(mktemp "$speech_dir/ggml-base.bin.XXXXXX")
trap 'rm -f "$download"' EXIT
curl --fail --location --retry 2 \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
    --output "$download"
printf '%s  %s\n' "$checksum" "$download" | sha256sum --check -
chmod 600 "$download"
mv "$download" "$model"
