#!/usr/bin/env bash
# Installs an Orbit CLI release from the GitHub fork's Releases.
# Usage: scripts/orbit-install-cli.sh 0.0.46-orbit.5
set -euo pipefail

if [[ $# -ne 1 ]] || [[ ! $1 =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  printf 'Usage: %s VERSION\n' "$0" >&2
  exit 2
fi
version=$1

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf 'Unsupported Linux architecture.\n' >&2; exit 2 ;;
esac
if [[ $(uname -s) != Linux ]]; then
  printf 'This installer currently supports Linux VMs.\n' >&2
  exit 2
fi

repo=${ORBIT_GH_REPO:-Vikaspogu/t3code}
filename="t3-$version-linux-$arch.tar.gz"
stem=${filename%.tar.gz}
url="https://github.com/$repo/releases/download/orbit-v$version"
releases="$HOME/.local/share/t3code-orbit/releases"
mkdir -p "$releases" "$HOME/.local/bin"
scratch=$(mktemp -d "$releases/.install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

curl --fail-with-body --silent --show-error --location \
  --output "$scratch/$filename" "$url/$filename"
curl --fail-with-body --silent --show-error --location \
  --output "$scratch/$filename.sha256" "$url/$filename.sha256"
(
  cd "$scratch"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --status "$filename.sha256"
  else
    shasum -a 256 --check --status "$filename.sha256"
  fi
)
tar -xzf "$scratch/$filename" -C "$scratch"
if [[ ! -x "$scratch/$stem/t3" ]] || [[ ! -f "$scratch/$stem/client/index.html" ]]; then
  printf 'Package is missing the T3 executable or web client.\n' >&2
  exit 1
fi
if [[ $("$scratch/$stem/t3" --version) != *"$version"* ]]; then
  printf 'Package executable version does not match the requested version.\n' >&2
  exit 1
fi

target="$releases/$version"
if [[ ! -e $target ]]; then
  mv "$scratch/$stem" "$target"
fi
if [[ ! -x "$target/t3" ]]; then
  printf 'Installed package has no executable.\n' >&2
  exit 1
fi
if [[ $("$target/t3" --version) != *"$version"* ]]; then
  printf 'Installed executable version does not match the package.\n' >&2
  exit 1
fi
link="$HOME/.local/bin/t3-orbit"
temporary_link="$HOME/.local/bin/.t3-orbit.$$"
ln -s "$target/t3" "$temporary_link"
mv -f "$temporary_link" "$link"
printf 'Installed t3code-orbit %s at %s\n' "$version" "$link"
