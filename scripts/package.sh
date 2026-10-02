#!/usr/bin/env bash
# @ref LLP 0007 — one zip a Mac can run: revu.app with the sidecar compiled
# into it (Contents/Resources/revu-sidecar, plus skills/ and revu.config.json),
# ad-hoc signed by default. `--release` signs with the Developer ID (hardened
# runtime, timestamp, the push entitlement), notarizes through the
# `revu-notary` keychain profile, and staples (LLP 0007, LLP 0009);
# `--release --no-notarize` stops after signing, for a local check.
# Usage: scripts/package.sh [version] [--release] [--no-notarize]
set -euo pipefail
RELEASE=0; NOTARIZE=1; VERSION_ARG=""
for a in "$@"; do case "$a" in --release) RELEASE=1;; --no-notarize) NOTARIZE=0;; *) VERSION_ARG="$a";; esac; done
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

VERSION="${VERSION_ARG:-$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')}"
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

echo "== icon catalog"
scripts/icon-catalog.sh "$STAGE/revu.app"

if [ "$RELEASE" = 1 ]; then
  IDENTITY="${EXACT_DEVELOPER_ID:-$(security find-identity -v -p codesigning | sed -n 's/.*\([0-9A-F]\{40\}\) "Developer ID Application: .*/\1/p' | head -1)}"
  [ -n "$IDENTITY" ] || { echo "no Developer ID Application identity in the keychain (EXACT_DEVELOPER_ID names one)"; exit 1; }
  PROFILE="${EXACT_NOTARY_PROFILE:-revu-notary}"
  echo "== sign (Developer ID $IDENTITY, hardened runtime)"
  ENT="$DIST/entitlements.plist"
  cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.developer.aps-environment</key><string>production</string>
</dict></plist>
PLIST
  # The sidecar is a compiled Bun binary: a JIT, so the hardened runtime
  # needs these two for it (and for nothing else in the bundle).
  SIDECAR_ENT="$DIST/entitlements-sidecar.plist"
  cat > "$SIDECAR_ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST
  # The push entitlement is a provisioned one: outside the App Store the
  # kernel admits it only with a Developer ID provisioning profile for the
  # app id embedded in the bundle (launch fails with POSIX 163 otherwise).
  # REVU_PROVISION_PROFILE names the .provisionprofile; without it the app is
  # signed without aps-environment and stays on polling (LLP 0009).
  if [ -n "${REVU_PROVISION_PROFILE:-}" ] && [ -f "$REVU_PROVISION_PROFILE" ]; then
    cp "$REVU_PROVISION_PROFILE" "$STAGE/revu.app/Contents/embedded.provisionprofile"
    echo "provisioning profile: embedded ($(basename "$REVU_PROVISION_PROFILE"))"
  else
    echo "no REVU_PROVISION_PROFILE: signing without the push entitlement"
    cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
PLIST
  fi
  # Inside out: every dylib, the sidecar, then the bundle.
  find "$STAGE/revu.app/Contents" -name "*.dylib" -print0 | while IFS= read -r -d '' f; do
    codesign --force --sign "$IDENTITY" --options runtime --timestamp "$f"
  done
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$SIDECAR_ENT" "$RES/revu-sidecar"
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --identifier dev.donadel.revu --entitlements "$ENT" "$STAGE/revu.app"
  codesign --verify --deep --strict --verbose=1 "$STAGE/revu.app"
  codesign -d --entitlements - "$STAGE/revu.app" 2>/dev/null | grep -q "aps-environment" && echo "push entitlement: present" || echo "push entitlement: absent"
else
  echo "== sign (ad hoc)"
  codesign --force --sign - --timestamp=none "$RES/revu-sidecar"
  codesign --force --deep --sign - --timestamp=none "$STAGE/revu.app"
  codesign --verify --deep --strict "$STAGE/revu.app"
fi

echo "== zip"
ZIP="$DIST/revu-$VERSION-macos-$ARCH.zip"
rm -f "$ZIP"
(cd "$STAGE" && ditto -c -k --sequesterRsrc --keepParent revu.app "../$(basename "$ZIP")")

if [ "$RELEASE" = 1 ] && [ "$NOTARIZE" = 1 ]; then
  echo "== notarize ($PROFILE) — Apple's turn, usually a minute or two"
  xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$STAGE/revu.app"
  rm -f "$ZIP"
  (cd "$STAGE" && ditto -c -k --sequesterRsrc --keepParent revu.app "../$(basename "$ZIP")")
  spctl --assess --type execute --verbose=2 "$STAGE/revu.app" && echo "Gatekeeper: accepted"
fi
shasum -a 256 "$ZIP" | tee "$ZIP.sha256"
du -h "$ZIP" | cut -f1
