#!/bin/sh
# Builds build/icon.icns from build/icon.png with macOS's own tools.
set -e
cd "$(dirname "$0")"
set_dir=$(mktemp -d)/icon.iconset
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d icon.png --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o icon.icns
rm -rf "$(dirname "$set_dir")"
