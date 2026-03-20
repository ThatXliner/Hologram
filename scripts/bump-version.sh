#!/usr/bin/env bash
# Usage: ./scripts/bump-version.sh <major|minor|patch|x.y.z>
set -euo pipefail

CURRENT=$(node -p "require('./package.json').version")

bump() {
  local version=$1 part=$2
  IFS='.' read -r major minor patch <<< "$version"
  case $part in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

ARG=${1:-patch}

case $ARG in
  major|minor|patch) NEW=$(bump "$CURRENT" "$ARG") ;;
  *) NEW=$ARG ;;
esac

echo "Bumping $CURRENT → $NEW"

# package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Cargo.toml (first occurrence of version = "...")
sed -i '' "0,/^version = \"[^\"]*\"/{s/^version = \"[^\"]*\"/version = \"$NEW\"/}" src-tauri/Cargo.toml

# tauri.conf.json
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
cfg.version = '$NEW';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(cfg, null, 2) + '\n');
"

echo "Done. Updated package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json"
