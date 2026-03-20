#!/usr/bin/env bash
# bump.sh — Bump the app version across all manifest files.
#
# Usage:
#   ./scripts/bump.sh patch   # 0.2.1 → 0.2.2
#   ./scripts/bump.sh minor   # 0.2.1 → 0.3.0
#   ./scripts/bump.sh major   # 0.2.1 → 1.0.0
#   ./scripts/bump.sh 1.2.3   # set an explicit version

set -euo pipefail

PART=${1:-patch}

# Read current version from package.json
CURRENT=$(node -p "require('./package.json').version")

bump_version() {
    local version=$1
    local part=$2
    IFS='.' read -r major minor patch <<< "$version"
    case $part in
        major) echo "$((major + 1)).0.0" ;;
        minor) echo "${major}.$((minor + 1)).0" ;;
        patch) echo "${major}.${minor}.$((patch + 1))" ;;
        *)     echo "$part" ;;  # treat as explicit version
    esac
}

NEXT=$(bump_version "$CURRENT" "$PART")

echo "Bumping $CURRENT → $NEXT"

# package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEXT';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# src-tauri/tauri.conf.json
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
conf.version = '$NEXT';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');
"

# src-tauri/Cargo.toml — sed replace the version line
sed -i '' "s/^version = \"${CURRENT}\"/version = \"${NEXT}\"/" src-tauri/Cargo.toml

echo "Done. All manifests updated to $NEXT."
