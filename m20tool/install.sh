#!/bin/sh
# Installs m20tool (github.com/jeff-hykin/dim-m20-dash, m20tool/): one prebuilt binary, no other dependencies.
#   curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dim-m20-dash/main/m20tool/install.sh | sh
# Linux x86_64/aarch64 (glibc), macOS x86_64/arm64. Goes to /usr/local/bin (with sudo if needed), else ~/.local/bin;
# M20TOOL_INSTALL_DIR picks the folder, M20TOOL_VERSION the release.
set -e
version="${M20TOOL_VERSION:-0.3.8}"
repo="jeff-hykin/dim-m20-dash"

case "$(uname -s)" in
    Linux) os="unknown-linux-gnu" ;;
    Darwin) os="apple-darwin" ;;
    *) echo "m20tool: no build for $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    aarch64 | arm64) arch="aarch64" ;;
    *) echo "m20tool: no build for $(uname -m)" >&2; exit 1 ;;
esac
url="https://github.com/$repo/releases/download/m20tool-v$version/m20tool-$arch-$os"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "downloading $url"
if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar -o "$tmp" "$url"
else
    wget -q -O "$tmp" "$url"
fi
chmod 755 "$tmp"

if [ -n "$M20TOOL_INSTALL_DIR" ]; then
    dir="$M20TOOL_INSTALL_DIR"
    mkdir -p "$dir" && install -m 755 "$tmp" "$dir/m20tool"
elif [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
    install -m 755 "$tmp" "$dir/m20tool"
elif command -v sudo >/dev/null 2>&1 && echo "installing to /usr/local/bin/m20tool (sudo)" && sudo install -m 755 "$tmp" /usr/local/bin/m20tool; then
    dir=/usr/local/bin
else
    dir="$HOME/.local/bin"
    mkdir -p "$dir" && install -m 755 "$tmp" "$dir/m20tool"
fi
echo "installed $dir/m20tool"
case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "note: $dir is not on your PATH" ;;
esac
"$dir/m20tool" --version
echo "next: m20tool help"
