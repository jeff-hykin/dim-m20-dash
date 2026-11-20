#!/bin/sh
# Rebuilds hide_tailscale.so (committed; setup copies it to AOS, nothing is built there) for the boards' aarch64 glibc
# 2.31, on any computer with zig. Checked in an arm64 Ubuntu 20.04 container: test_hide_tailscale.c with and without
# the preload, a tailscale0 dummy interface hidden, the list head hidden for 300k rounds.
set -eu
cd "$(dirname "$0")"
zig cc -target aarch64-linux-gnu.2.31 -O2 -g0 -s -Wall -Wextra -shared -fPIC -o hide_tailscale.so hide_tailscale.c -ldl
