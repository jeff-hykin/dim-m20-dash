# m20tool

Set up and operate a Deep Robotics M20 (Lynx) robot dog: one Deno-compiled binary, no other dependencies. It lives in
the M20 Ctrl repo but installs on its own:

```sh
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dim-m20-dash/main/m20tool/install.sh | sh
```

Linux x86_64 / aarch64 (glibc; the dog's boards are aarch64, glibc 2.31) and macOS x86_64 / arm64. It installs to
`/usr/local/bin` (sudo if needed), else `~/.local/bin`; `M20TOOL_INSTALL_DIR` picks the folder.

`m20tool help` (or `--help`) is how to reach the dog: the boards, their addresses and logins, the hotspot (AP mode), the
direct cable.

## Commands

| Command                              | What                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m20tool help`                       | boards, addresses, passwords, ways in, AP mode vs Wi-Fi                                                                                                                                                  |
| `m20tool setup [--dry-run]`          | set a dog up from a laptop (below); asks for the Wi-Fi to join first                                                                                                                                     |
| `m20tool install-on-dog [--dry-run]` | install this m20tool and the docs on GOS and AOS                                                                                                                                                         |
| `m20tool status`                     | motion state, gait, usage mode, charge, battery, errors (read-only)                                                                                                                                      |
| `m20tool battery`                    | both battery packs and the charge state (read-only)                                                                                                                                                      |
| `m20tool stand`                      | ready for dimos: Stand, RL Control, navigation mode, agile stairs gait                                                                                                                                   |
| `m20tool direct`                     | ready for axis driving: Stand, RL Control, regular mode, Basic gait                                                                                                                                      |
| `m20tool lie_down`                   | zero velocity, then Sit                                                                                                                                                                                  |
| `m20tool dock`                       | start autonomous charging (standing ~2 m in front of the dock, facing both reflectors); returns once the robot took it, a background copy watches it (log `~/m20_dock.log`; `--foreground` watches here) |
| `m20tool undock`                     | leave the dock, then stand                                                                                                                                                                               |
| `m20tool stop`                       | zero velocity (regular mode only; in navigation mode use `lie_down`)                                                                                                                                     |

The robot commands talk to the vendor's basic_server on AOS (UDP 10.21.31.103:30000, TCP 30001 for the usage mode),
through `../backend/basic_server.ts`, the same protocol code M20 Ctrl uses. On GOS and AOS they need no arguments. On a
laptop they go straight to 10.21.31.103 when it answers (the dog's hotspot), else run the same command on GOS over ssh
(the cable, 10.21.31.104, then Tailscale `m20-gos`). `--host` / `M20_HOST` pick the address; `--dry-run` prints every
frame (address, port, JSON, header) and sends nothing. `status` and `battery` send only the heartbeat.

A port of the Python `m20` CLI, keeping its sequences and gotchas: the robot resets its usage mode to regular (and the
gait to Basic) on every sit->stand and on undock, so the mode is set after standing; the axis command's floats go out as
`0.0` (basic_server drops `"X":0`); a gait sent during a mode reset is dropped, so it confirms Basic, then sends the
gait again on a miss. On the boards `~/.local/bin/m20` is a wrapper that runs m20tool (the Python one is kept as
`m20.python-bak`), so M20 Ctrl and the Controller's action buttons keep calling `m20 <command>`.

## setup

Every step has a read-only check, so a rerun does only what's missing, and `--dry-run` runs just the checks and prints
every step with the commands it would run.

1. Asks for the Wi-Fi network (SSID, password) the dog should join. Empty: leave its Wi-Fi alone.
2. **Phase 1**, over any way in (the dog's hotspot `CA9B_NO.<n>_5G` / `12345678` with a route to 10.21.31.0/24 via
   10.21.41.1, Tailscale, the rear Ethernet port): this computer's ssh key (made if missing) onto GOS, AOS and NOS (it
   does the `ssh-copy-id` itself, with the board password), docs on GOS and AOS for people and agents (below), then the
   USB-Ethernet fallback on GOS (r8152 blacklisted, the RTL8153 adapter runs as cdc_ether at a fixed 192.168.3.2 plus
   DHCP, NAT for the other boards). Then it stops and asks for the direct cable: a USB-C to Ethernet adapter in GOS's
   USB-C port, on the side of the dog WITHOUT the battery slots, cabled to this computer.
3. **Phase 2**, rerun over the cable (this computer gets 192.168.3.1 on it until it reboots):
   - internet for the dog: this computer's, NATed (macOS pf anchor `com.apple/m20`; Linux iptables, else nft; until
     reboot); skipped when GOS already has internet. AOS gets a route via GOS for the rest of setup (removed at the
     end).
   - the clock: `real-time-offset` + its timer and a `phc2sys` drop-in on GOS and AOS (the robot's 2024 PTP time base
     stays; phc2sys gets the offset), AOS asking GOS over ssh as root.
   - the vendor's hotspot babysitter off: `host_start.sh`'s `loop_start_ap.sh` line commented out after a backup
     (`host_start.sh.orig-before-network-safety`); an older dead-man / hotspot-off flag undone.
   - network-safety on AOS (hotspot or Wi-Fi, always falling back to the hotspot; Deno 2.9.8 at /usr/local/bin/deno).
   - the DDS-flood firewall: UDP 7400-7700 dropped on wlan0 (INPUT, OUTPUT, FORWARD), in `office-nat`, which also shares
     AOS's Wi-Fi with GOS/NOS.
   - Tailscale on GOS (`m20-gos`) and AOS (`m20-aos`): the latest arm64 tarball, then `tailscale up` prints a login
     link.
   - Wi-Fi on both bands (radio on, no saved network pinned to one band).
   - joins the Wi-Fi from step 1: saved with autoconnect off (network-safety alone decides), network-safety restarted
     into Wi-Fi mode, then it waits for wlan0 to be on it and pings over wlan0.
   - GOS's uplink through AOS's Wi-Fi (`aos-uplink`), once AOS has internet.
   - m20tool itself on GOS and AOS (`/usr/local/bin/m20tool`, `~/.local/bin/m20`).
4. Prints the dog's addresses and logins as an `~/.ssh/config` block.

Docs on each board: `~/readme/README.md` (the boards, network layout and quirks, network-safety, the DDS-flood firewall,
m20tool, recovery; source `board_files/both/readme_README.md`), `~/AGENTS.md` (points there, plus the networking rules)
and `~/CLAUDE.local.md` (points to `~/AGENTS.md`). Each is a block between `<!-- m20tool:begin ... -->` /
`<!-- m20tool:end -->` lines: a rerun replaces only that block, and anything else in the file (or a file that was
already there) stays.

The files it puts on the boards are in `board_files/` (copied from the dog set up by hand in Nov 2026). Changed files
are backed up as `<file>.bak-m20tool-<time>` first.

## System commands it runs

On the laptop (setup / install-on-dog only; the robot commands run none, except `ssh` for the GOS fallback and `setsid`
for dock's background watcher):

- `ssh` (every board command; the board password comes from a throwaway `SSH_ASKPASS` script), `ssh-keygen` (only when
  there's no key), `sudo`
- macOS: `networksetup -listallhardwareports`, `ifconfig` (find the cable; add 192.168.3.1 as an alias),
  `route -n get default`, `sysctl -w net.inet.ip.forwarding=1`, `pfctl -a com.apple/m20 -f -`, `pfctl -E`
- Linux: `ip addr add`, `ip link set`, `sysctl -w net.ipv4.ip_forward=1`, `iptables` (else `nft`)
- downloads (Deno `fetch`, no curl): Deno 2.9.8 aarch64, the Tailscale arm64 tarball, m20tool's aarch64 release

On the boards (through ssh; root through `sudo -S`): `sh`, `base64`, `cmp`, `cp`, `mv`, `chmod`, `chown`, `mkdir`, `rm`,
`install`, `mktemp`, `tar`, `cat`, `grep`, `sed`, `awk`, `date`, `tr`, `printf`, `systemctl`, `udevadm`, `rmmod`, `ip`,
`iptables`, `resolvectl`, `nmcli`, `iw`, `ping`, `curl`, `pgrep`, `pkill`, `ssh-keygen`, `tailscale`,
`/usr/local/bin/office-nat`, `/usr/local/bin/m20tool --version`; and what the installed services run themselves
(`usb-ethernet-up`: `ip`, `dhclient`, `iptables`, `sysctl`, `resolvectl`; `real-time-offset`: `phc_ctl`, `curl`, `ssh`,
`systemctl restart phc2sys`; network-safety: `nmcli`, `iw`, `tailscale`, the vendor's `ap_start.sh`).

## Develop

- `deno task m20tool <args>` runs it from source; `deno task test` includes `m20tool/robot_test.ts` (every robot command
  against a stand-in basic_server, no robot).
- `deno task m20tool-build` compiles all four targets into `m20tool/dist/`; `deno run -A m20tool/build.ts --release`
  also uploads them to the GitHub release `m20tool-v<VERSION>` (version: `dog.ts`, `install.sh`).
