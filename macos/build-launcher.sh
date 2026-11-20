#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-"$HOME/Library/Caches/LittleZenLauncher/Little Zen Launcher.app"}
[ "$(uname -s)" = Darwin ] || { echo "This launcher requires macOS." >&2; exit 1; }
staging=$(mktemp -d "${TMPDIR:-/tmp}/little-zen-launcher.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
bundle="$staging/Little Zen Launcher.app"
cache="$HOME/Library/Caches/LittleZenLauncher/SwiftModules"
mkdir -p "$bundle/Contents/MacOS" "$cache"
cp -X "$root/macos/Info.plist" "$bundle/Contents/Info.plist"
cp -X "$root/macos/LittleZenLauncher.swift" "$staging/LittleZenLauncher.swift"
xcrun swiftc -O -module-cache-path "$cache" \
  -target "$(uname -m)-apple-macos12.0" \
  "$staging/LittleZenLauncher.swift" -o "$bundle/Contents/MacOS/LittleZenLauncher"
codesign --force --sign - "$bundle"
mkdir -p "$(dirname -- "$output")"
ditto --norsrc --noextattr "$bundle" "$output"
codesign --verify --deep --strict "$output"
echo "$output"
