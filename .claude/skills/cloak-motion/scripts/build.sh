#!/usr/bin/env bash
# Score → check → render → contact sheet, for a project made with new.sh.
#   bash .claude/skills/cloak-motion/scripts/build.sh <dir> <out.mp4> [sheet times, default "1 3 5 7 9 11"]
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(cd "${1:?dir}" && pwd)"
OUT="$(realpath -m "${2:?out.mp4}")"
TIMES="${3:-1 3 5 7 9 11}"
python3 "$SKILL/scripts/score.py" "$DIR/cues.json" "$DIR/assets/score.wav"
(cd "$DIR" && npx --yes hyperframes@0.8.145 check 2>&1 | grep -E "✗|error\(s\)|Contrast|Layout|Motion|Runtime" || true)
(cd "$DIR" && npx --yes hyperframes@0.8.145 render -o "$OUT" -q delivery --quiet >/dev/null)
ffprobe -v error -show_entries format=duration,size -of compact "$OUT"
SHEET="${OUT%.mp4}-sheet.png"
TMP="$(mktemp -d)"
i=0
for t in $TIMES; do ffmpeg -v error -y -ss "$t" -i "$OUT" -frames:v 1 -vf scale=960:-1 "$TMP/$i.png"; i=$((i + 1)); done
n=$i; inputs=""; layout=""
for ((k = 0; k < n; k++)); do inputs="$inputs -i $TMP/$k.png"; layout="$layout|$(((k % 2) * 960))_$(((k / 2) * 540))"; done
if [ "$n" -gt 1 ]; then
  ffmpeg -v error -y $inputs -filter_complex "xstack=inputs=$n:layout=${layout#|}:fill=black" "$SHEET"
else
  cp "$TMP/0.png" "$SHEET"
fi
echo "sheet $SHEET"
