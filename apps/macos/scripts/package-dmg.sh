#!/bin/sh
# Packages build/Clipstead.app (from build-app.sh) as build/Clipstead.dmg, with an Applications shortcut for
# drag-to-install, and writes build/Clipstead.dmg.sha256.
set -eu
cd "$(dirname "$0")/.."

APP=build/Clipstead.app
[ -d "$APP" ] || { echo "Run ./scripts/build-app.sh first." >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f build/Clipstead.dmg
hdiutil create -volname Clipstead -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov build/Clipstead.dmg >/dev/null
(cd build && shasum -a 256 Clipstead.dmg > Clipstead.dmg.sha256)
echo "Built build/Clipstead.dmg"
