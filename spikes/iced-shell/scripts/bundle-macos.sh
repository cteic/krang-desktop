#!/bin/sh
# Builds Krang Shell.app from the release binary. iced has no bundler, and
# macOS needs a bundle for the Dock, the app switcher and a sharp window on
# a Retina screen.
#
#   scripts/bundle-macos.sh [output-dir]     # default: target/release
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/target/release"}
app="$out/Krang Shell.app"

cargo build --release --manifest-path "$here/Cargo.toml"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/target/release/krang-shell" "$app/Contents/MacOS/krang-shell"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Krang Shell</string>
  <key>CFBundleDisplayName</key><string>Krang Shell</string>
  <key>CFBundleIdentifier</key><string>ie.cteic.krang-shell</string>
  <key>CFBundleExecutable</key><string>krang-shell</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
echo "$app"
