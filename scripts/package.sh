#!/usr/bin/env bash
# @ref LLP 0007 — one zip a Mac can run: revu.app with the sidecar compiled
# into it (Contents/Resources/revu-sidecar, plus skills/ and revu.config.json),
# ad-hoc signed. Usage: scripts/package.sh [version]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

VERSION="${1:-$(python3 -c 'import json;print(json.load(open("revu-app/app.json"))["version"])')}"
ARCH="$(uname -m)"
DIST="dist"
mkdir -p "$DIST"

echo "== sidecar: compile"
bun build --compile --minify sidecar/src/index.ts --outfile "$DIST/revu-sidecar"

echo "== app: bundle"
bun run app:bundle >"$DIST/bundle.log" 2>&1 || { tail -20 "$DIST/bundle.log"; exit 1; }
APP="$(ls -d revu-app/target/clients/*/dev.donadel.revu/macos/revu.app | head -1)"
[ -d "$APP" ] || { echo "no revu.app built"; exit 1; }

echo "== assemble"
STAGE="$DIST/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/revu.app"
RES="$STAGE/revu.app/Contents/Resources"
cp "$DIST/revu-sidecar" "$RES/revu-sidecar"
chmod +x "$RES/revu-sidecar"
rm -rf "$RES/skills"
mkdir -p "$RES/skills"
for skill in skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$RES/skills/$name"
  cp "$skill"/SKILL.md "$RES/skills/$name/"
  [ -f "$skill/post-review.ts" ] && cp "$skill/post-review.ts" "$RES/skills/$name/"
  [ -f "$skill/package.json" ] && cp "$skill/package.json" "$RES/skills/$name/"
done
cp revu.config.json "$RES/revu.config.json"
# The version the app reports (the build stamps its own; this is the release's).
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$STAGE/revu.app/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$STAGE/revu.app/Contents/Info.plist"

echo "== sign (ad hoc)"
codesign --force --sign - --timestamp=none "$RES/revu-sidecar"
codesign --force --deep --sign - --timestamp=none "$STAGE/revu.app"
codesign --verify --deep --strict "$STAGE/revu.app"

echo "== zip"
ZIP="$DIST/revu-$VERSION-macos-$ARCH.zip"
rm -f "$ZIP"
(cd "$STAGE" && ditto -c -k --keepParent revu.app "../$(basename "$ZIP")")
shasum -a 256 "$ZIP" | tee "$ZIP.sha256"
du -h "$ZIP" | cut -f1
