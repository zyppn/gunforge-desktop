#!/usr/bin/env bash
set -e

# Usage: ./release.sh patch   (1.0.0 → 1.0.1)
#        ./release.sh minor   (1.0.0 → 1.1.0)
#        ./release.sh major   (1.0.0 → 2.0.0)
#        ./release.sh 1.4.2   (set exact version)

TYPE=${1:-patch}

# Read current version from package.json
CURRENT=$(node -p "require('./package.json').version")

# Calculate next version
if [[ "$TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEXT="$TYPE"
else
  IFS='.' read -r MA MI PA <<< "$CURRENT"
  case "$TYPE" in
    major) NEXT="$((MA+1)).0.0" ;;
    minor) NEXT="$MA.$((MI+1)).0" ;;
    patch) NEXT="$MA.$MI.$((PA+1))" ;;
    *) echo "Usage: ./release.sh [patch|minor|major|x.y.z]"; exit 1 ;;
  esac
fi

echo "Releasing $CURRENT → $NEXT"

# Bump version in package.json
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json','utf8'));
  p.version = '$NEXT';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

git add package.json
git commit -m "release v$NEXT"
git tag "v$NEXT"
git push
git push --tags

echo ""
echo "✓ v$NEXT pushed — build starting at:"
echo "  https://github.com/zyppn/gunforge-desktop/actions"
echo ""
echo "When the build goes green, publish the release at:"
echo "  https://github.com/zyppn/gunforge-desktop/releases"