#!/bin/bash
# Victor macOS build and sign script.
#
# Ad-hoc signing (no Apple Developer ID required — default):
#   ./build_macos.sh
#   Installation: right-click Victor → Open → Open (to bypass Gatekeeper)
#
# Developer ID signing (for notarization):
#   APPLE_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./build_macos.sh

set -euo pipefail

VERSION="${BUILD_VERSION:-1.1.1}"
IDENTITY="${APPLE_IDENTITY:-}"

export BUILD_VERSION="$VERSION"
python - <<'VERSION_PY'
import os
from pathlib import Path
Path('_version.py').write_text('__version__ = ' + repr(os.environ['BUILD_VERSION']) + '\n')
VERSION_PY

echo "==> Building with PyInstaller (version ${VERSION})"
ICON_ARG=""
if [ -f "assets/icon.icns" ]; then
  ICON_ARG="--icon=assets/icon.icns"
fi
# shellcheck disable=SC2086
pyinstaller --clean --name Victor --windowed \
  $ICON_ARG \
  --osx-bundle-identifier com.victor.agent \
  app.py

# ── Inject URL scheme into Info.plist ────────────────────────────────────────
# Registers victor:// (plus legacy buildharvey://) so the website can deep-link into the running app.
echo "==> Applying Victor bundle metadata and URL schemes"
INFOPLIST="dist/Victor.app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$INFOPLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$INFOPLIST"
plutil -remove CFBundleURLTypes "$INFOPLIST" 2>/dev/null || true
plutil -insert CFBundleURLTypes \
  -json '[{"CFBundleURLName":"Victor Protocol","CFBundleURLSchemes":["victor","buildharvey"]}]' \
  "$INFOPLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Victor" "$INFOPLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleName string Victor" "$INFOPLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Victor" "$INFOPLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Victor" "$INFOPLIST"
/usr/libexec/PlistBuddy -c "Set :NSScreenCaptureUsageDescription Victor needs permission to observe your work so it can organize completed tasks into your weekly report." "$INFOPLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :NSScreenCaptureUsageDescription string 'Victor needs permission to observe your work so it can organize completed tasks into your weekly report.'" "$INFOPLIST"

# ── Code signing ─────────────────────────────────────────────────────────────

if [ -n "$IDENTITY" ]; then
  echo "==> Signing with Developer ID: $IDENTITY"
  SIGN_OPTS="--options runtime"

  find dist/Victor.app -name "*.so" -o -name "*.dylib" | while read -r f; do
    codesign --force --sign "$IDENTITY" $SIGN_OPTS "$f" 2>/dev/null || true
  done

  if [ -d "dist/Victor.app/Contents/Frameworks/Python.framework" ]; then
    codesign --force --sign "$IDENTITY" $SIGN_OPTS \
      "dist/Victor.app/Contents/Frameworks/Python.framework"
  fi

  codesign --force --sign "$IDENTITY" $SIGN_OPTS \
    --entitlements BuildHarvey.entitlements \
    dist/Victor.app

  echo "==> Verifying Developer ID signature"
  codesign --verify --deep --strict dist/Victor.app
  spctl --assess --type exec dist/Victor.app
else
  echo "==> Ad-hoc code signing (no Developer ID required)"
  find dist/Victor.app -name "*.so" -o -name "*.dylib" | while read -r f; do
    codesign --force --sign - "$f" 2>/dev/null || true
  done
  codesign --force --sign - --deep \
    --entitlements BuildHarvey.entitlements \
    dist/Victor.app

  echo "==> Verifying ad-hoc signature"
  codesign --verify --deep dist/Victor.app
  echo "    NOTE: Gatekeeper will warn on first open. Instruct users:"
  echo "    Right-click Victor → Open → Open"
fi

# ── Package ──────────────────────────────────────────────────────────────────

echo "==> Creating drag-to-Applications DMG"
STAGE_DIR="dist/dmg-stage"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -R dist/Victor.app "$STAGE_DIR/Victor.app"
ln -s /Applications "$STAGE_DIR/Applications"

hdiutil create -volname Victor \
  -srcfolder "$STAGE_DIR" \
  -ov -format UDZO \
  "dist/Victor-${VERSION}-mac.dmg"

echo "==> Done: dist/Victor-${VERSION}-mac.dmg"

# ── Notarization (Developer ID only — uncomment and configure) ───────────────
# Requires: xcrun notarytool credentials configured
#
# if [ -n "$IDENTITY" ]; then
#   echo "==> Submitting for notarization"
#   xcrun notarytool submit "dist/Victor-${VERSION}-mac.dmg" \
#     --apple-id "developer@email.com" \
#     --team-id "TEAMID" \
#     --password "app-specific-password" \
#     --wait
#   echo "==> Stapling notarization ticket"
#   xcrun stapler staple "dist/Victor-${VERSION}-mac.dmg"
# fi
