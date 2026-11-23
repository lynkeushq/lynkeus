#!/usr/bin/env bash
# Publishes lynkeus_agent, lynkeus_headless and lynkeus_plugins to pub.dev, in dependency order.
# Run it by hand from the release commit, after the v* tag exists (the npm packages go out from CI on that tag;
# Dart packages need a maintainer's pub.dev login, so they go out from here).
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: hack/release/publish-flutter-packages.sh [--dry-run | --yes-publish]

  (no flag)       print what would happen and exit 2; nothing is checked or published
  --dry-run       run every check and `dart pub publish --dry-run` for each package; publishes nothing
  --yes-publish   the checks, the dry runs, then `dart pub publish` for each package in order;
                  pub asks for a y/N confirmation before each upload

Checks (all of them must pass): the working tree is clean, HEAD has an exact tag vX.Y.Z, each pubspec's version is
X.Y.Z, each CHANGELOG.md has a "## X.Y.Z" heading, and each dependent asks for lynkeus_agent ^X.Y.Z.
Needs `dart` on PATH (set DART to use another command, e.g. `mise exec flutter@3.50.1 -- dart`) and a pub.dev login
(`dart pub login`) for --yes-publish.
USAGE
}

mode=plan
case "${1:-}" in
  "") ;;
  -h | --help) usage; exit 0 ;;
  --dry-run) mode=dry ;;
  --yes-publish) mode=publish ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dart_cmd=${DART:-dart}
packages=(lynkeus_agent lynkeus_headless lynkeus_plugins)

echo "Packages, in the order they are published:"
for p in "${packages[@]}"; do echo "  flutter/$p"; done
echo "Steps: check the tree and tag, run 'dart pub publish --dry-run' for each, then (--yes-publish only)"
echo "publish each, waiting for lynkeus_agent to appear on pub.dev before the packages that need it."
if [ "$mode" = plan ]; then
  echo "Nothing was done: pass --dry-run to check, or --yes-publish to publish."
  exit 2
fi

cd "$root"
[ -z "$(git status --porcelain)" ] || { echo "refusing: the working tree is not clean" >&2; exit 1; }
tag=$(git describe --exact-match --tags HEAD 2>/dev/null) || { echo "refusing: HEAD has no tag" >&2; exit 1; }
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refusing: tag $tag is not vX.Y.Z" >&2; exit 1; }
version=${tag#v}

for p in "${packages[@]}"; do
  dir=flutter/$p
  found=$(sed -n 's/^version: *//p' "$dir/pubspec.yaml")
  [ "$found" = "$version" ] || { echo "refusing: $dir/pubspec.yaml is $found, the tag is $tag" >&2; exit 1; }
  grep -q "^## $version\$" "$dir/CHANGELOG.md" || { echo "refusing: $dir/CHANGELOG.md has no '## $version' heading" >&2; exit 1; }
  if [ "$p" != lynkeus_agent ]; then
    grep -q "^  lynkeus_agent: \^$version\$" "$dir/pubspec.yaml" || { echo "refusing: $dir/pubspec.yaml does not ask for lynkeus_agent ^$version" >&2; exit 1; }
  fi
done
echo "Tag $tag, clean tree, versions and changelogs agree."

# shellcheck disable=SC2086
for p in "${packages[@]}"; do
  echo "== dry run: $p"
  (cd "flutter/$p" && $dart_cmd pub get && $dart_cmd pub publish --dry-run)
done
if [ "$mode" = dry ]; then
  echo "Dry runs passed. Nothing was published."
  exit 0
fi

# shellcheck disable=SC2086
for p in "${packages[@]}"; do
  echo "== publish: $p $version"
  (cd "flutter/$p" && $dart_cmd pub publish)
  if [ "$p" = lynkeus_agent ]; then
    echo "waiting for lynkeus_agent $version on pub.dev"
    for _ in $(seq 1 30); do
      curl -fsS "https://pub.dev/api/packages/lynkeus_agent/versions/$version" >/dev/null 2>&1 && break
      sleep 10
    done
    curl -fsS "https://pub.dev/api/packages/lynkeus_agent/versions/$version" >/dev/null || { echo "lynkeus_agent $version is not on pub.dev yet: rerun for the other two once it is" >&2; exit 1; }
  fi
done
echo "Published lynkeus_agent, lynkeus_headless and lynkeus_plugins $version."
