#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination=${1:-"$HOME/Applications/Little Zen Launcher.app"}
if [ -e "$destination" ]; then
  identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)
  [ "$identifier" = com.palexander.little-zen-launcher ] || {
    echo "Refusing to overwrite a different application: $destination" >&2; exit 1;
  }
  if pgrep -x LittleZenLauncher >/dev/null 2>&1; then
    echo "Quit Little Zen Launcher before updating it." >&2; exit 1
  fi
fi
"$root/macos/build-launcher.sh" "$destination"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
echo "Installed. After verifying the updated Little Zen script is loaded, enable with:"
echo "\"$destination/Contents/MacOS/LittleZenLauncher\" --set-default"
echo "macOS may ask you to confirm the browser change."
