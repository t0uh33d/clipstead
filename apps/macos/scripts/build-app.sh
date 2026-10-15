#!/bin/sh
# Builds build/Clipstead.app: a universal (Apple silicon + Intel) release build, wrapped in an app bundle and signed.
#
#   ./scripts/build-app.sh                       # ad-hoc signature, fine for use on this Mac
#   SIGN_IDENTITY="Developer ID Application: …" ./scripts/build-app.sh
#   BUNDLE_ID=com.example.clipstead ./scripts/build-app.sh
set -eu
cd "$(dirname "$0")/.."

BUNDLE_ID="${BUNDLE_ID:-dev.clipstead.mac}"
VERSION="${VERSION:-0.1.0}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
APP=build/Clipstead.app

swift build -c release --arch arm64 --arch x86_64
BIN_DIR=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_DIR/Clipstead" "$APP/Contents/MacOS/Clipstead"
sed -e "s/__BUNDLE_ID__/$BUNDLE_ID/" -e "s/__VERSION__/$VERSION/" Resources/Info.plist > "$APP/Contents/Info.plist"

if [ "$SIGN_IDENTITY" = "-" ]; then
  codesign --force --sign - "$APP"
else
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
fi
codesign --verify --strict "$APP"
echo "Built $APP ($BUNDLE_ID $VERSION)"
