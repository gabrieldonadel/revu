#!/usr/bin/env bash
# @ref LLP 0007 — the app icon as an asset catalog (Assets.car + CFBundleIconName)
# beside the .icns the bundle build writes: macOS 26 draws notification banners
# and System Settings rows from the catalog icon, not the legacy .icns.
# Usage: scripts/icon-catalog.sh <revu.app>
set -euo pipefail
APP="$1"
cd "$(dirname "$0")/.."
SRC="revu-app/icon.png"
WORK="$(mktemp -d)"
SET="$WORK/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$SET"
declare -a IMAGES=()
for spec in "16 1" "16 2" "32 1" "32 2" "128 1" "128 2" "256 1" "256 2" "512 1" "512 2"; do
  set -- $spec; px=$(( $1 * $2 )); name="icon_${1}x${1}@${2}x.png"
  sips -z "$px" "$px" "$SRC" --out "$SET/$name" >/dev/null
  IMAGES+=("{\"filename\":\"$name\",\"idiom\":\"mac\",\"scale\":\"${2}x\",\"size\":\"${1}x${1}\"}")
done
printf '{"images":[%s],"info":{"author":"revu","version":1}}\n' "$(IFS=,; echo "${IMAGES[*]}")" > "$SET/Contents.json"
printf '{"info":{"author":"revu","version":1}}\n' > "$WORK/Assets.xcassets/Contents.json"
xcrun actool "$WORK/Assets.xcassets" --compile "$APP/Contents/Resources" --platform macosx --minimum-deployment-target 14.0 --app-icon AppIcon --output-partial-info-plist "$WORK/partial.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleIconName AppIcon" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string AppIcon" "$APP/Contents/Info.plist"
rm -rf "$WORK"
echo "icon catalog: $(ls "$APP/Contents/Resources" | grep -c 'Assets.car') Assets.car in $APP"
