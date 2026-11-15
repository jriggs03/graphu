#!/bin/sh
# Turn one audio file into text with whisper.cpp. Graphu runs this for voice notes.
#
#   in:  $1 = path to an audio file (mp3, m4a, wav, ...)
#   out: the transcript on standard output
#
# Use it by starting the server with:
#   GRAPHU_TRANSCRIBE_CMD='scripts/transcribe.sh "$1"' cargo run -p graphu-server
#
# Needs: whisper-cli (brew install whisper-cpp), ffmpeg, and a model file.
# The model path comes from GRAPHU_WHISPER_MODEL, default models/ggml-small.bin.
set -eu

audio="$1"
here="$(cd "$(dirname "$0")/.." && pwd)"
model="${GRAPHU_WHISPER_MODEL:-$here/models/ggml-small.bin}"

if [ ! -f "$model" ]; then
  echo "Whisper model not found at $model. See README: Voice notes." >&2
  exit 1
fi

# whisper.cpp wants 16 kHz mono WAV, so convert whatever was uploaded.
wav="$(mktemp -t graphu-audio).wav"
trap 'rm -f "$wav"' EXIT
if ! ffmpeg -nostdin -loglevel error -y -i "$audio" -ar 16000 -ac 1 -f wav "$wav" 2>/dev/null; then
  echo "This recording could not be decoded." >&2
  exit 1
fi

# -nt: no timestamps, -np: print only the transcript, -l auto: detect the language.
whisper-cli -m "$model" -f "$wav" -l auto -nt -np 2>/dev/null
