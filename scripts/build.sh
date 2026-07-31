#!/usr/bin/env bash
# build.sh — build Linux packages (AppImage + deb + rpm)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing dependencies..."
npm ci

echo "==> Building Linux packages..."
npx electron-builder --linux AppImage deb rpm

echo ""
echo "Done! Packages are in dist/"
ls -lh dist/*.AppImage dist/*.deb dist/*.rpm 2>/dev/null || true
