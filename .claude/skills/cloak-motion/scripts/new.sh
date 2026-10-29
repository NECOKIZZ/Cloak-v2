#!/usr/bin/env bash
# Scaffold a Cloak motion project: brand assets, the starter template (or an example), pinned HyperFrames scripts.
#   bash .claude/skills/cloak-motion/scripts/new.sh <dir> [template|sdk-on-npm|elysium-eco]
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:?usage: new.sh <dir> [template|sdk-on-npm|elysium-eco]}"
FROM="${2:-template}"
mkdir -p "$DIR/assets"
cp "$SKILL"/assets/{glass.jpg,intertight.woff2,mono.woff2} "$DIR/assets/"
if [ "$FROM" = "template" ]; then
  cp "$SKILL/templates/sting.html" "$DIR/index.html"
  cp "$SKILL/templates/cues.json" "$DIR/cues.json"
else
  cp "$SKILL/examples/$FROM/index.html" "$DIR/index.html"
  cp "$SKILL/examples/$FROM/cues.json" "$DIR/cues.json"
  find "$SKILL/examples/$FROM" -maxdepth 1 -type f ! -name index.html ! -name cues.json -exec cp {} "$DIR/assets/" \;
fi
NAME="$(basename "$DIR")"
cat > "$DIR/package.json" <<JSON
{
  "name": "$NAME",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "npx --yes hyperframes@0.8.145 check",
    "render": "npx --yes hyperframes@0.8.145 render"
  }
}
JSON
echo "scaffolded $DIR from $FROM"
