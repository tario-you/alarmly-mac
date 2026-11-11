#!/bin/zsh
# Builds Wake.app and installs it to /Applications.
#   ./build.sh               build, install, launch
#   ./build.sh --no-install  build to app/build/Wake.app only
# BUNDLE_ID (default com.tario.wake) is also the defaults domain the alarms live in.
set -e
cd "${0:A:h}"
bundle=${BUNDLE_ID:-com.tario.wake}
out=build/Wake.app
rm -rf build && mkdir -p $out/Contents/MacOS
xcrun swiftc -O -swift-version 5 -o $out/Contents/MacOS/Wake main.swift 2>&1 | grep -v warning || true
[[ -x $out/Contents/MacOS/Wake ]]
cat > $out/Contents/Info.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$bundle</string>
<key>CFBundleName</key><string>Wake</string>
<key>CFBundleExecutable</key><string>Wake</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.1</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Wake turns the volume up while the alarm rings.</string>
<key>CFBundleURLTypes</key><array><dict>
  <key>CFBundleURLName</key><string>$bundle.ring</string>
  <key>CFBundleURLSchemes</key><array><string>wake</string></array>
</dict></array>
</dict></plist>
PL
codesign --force --sign - $out
[[ "$1" == "--no-install" ]] && { echo "built $PWD/$out"; exit 0; }
pkill -x Wake 2>/dev/null || true
rm -rf /Applications/Wake.app && cp -R $out /Applications/Wake.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Wake.app
echo installed /Applications/Wake.app
open /Applications/Wake.app
sleep 4
pgrep -x Wake >/dev/null || { echo "FAIL: Wake exited after launch"; exit 1; }
echo "Wake running, pid $(pgrep -x Wake)"
