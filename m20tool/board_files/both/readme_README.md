# This Deep Robotics M20 (how it is set up)

Written by `m20tool setup` (github.com/jeff-hykin/dim-m20-dash, `m20tool/`). `m20tool help` prints the short
version. Login on every board: `user`, password `'` (a single apostrophe).

## Rules (read first)

- Never restart, cycle or reconfigure Wi-Fi, NetworkManager, network interfaces, routes, iptables or the network
  services, and never reboot a board, without a human's OK and a second, tested way in. Twice this locked everyone
  out of the dog.
- Prefer changes that a power cycle undoes; make them persistent only once they're proven.
- `pkill -f <pattern>` over ssh matches your own ssh command line and kills your session: use `pkill -f 'patter[n]'`.
- Motion only on a person's request: `m20tool stand / lie_down / dock / undock / direct / stop` move the robot.

## Boards

| Board | Internal address | What |
|---|---|---|
| AOS | 10.21.31.103 (eth2) | motion control: the vendor's basic_server (UDP 30000, TCP 30001), cameras (/dev/video0 front, /dev/video2 rear), lidars on eth0 (10.21.33.x), the only Wi-Fi radio (wlan0). sudo asks for the password. |
| GOS | 10.21.31.104 (eth0) | ours: Ubuntu 20.04 aarch64, dimos, DimOS Desktop (:5555), M20 Ctrl. Passwordless sudo. Root is an overlayroot whose upper layer is on /userdata, so changes persist. |
| NOS | 10.21.31.106 | the PTP time master and the vendor's zenoh/DDS bridge. |

Tailscale (dimensionalos.com tailnet): `m20-gos`, `m20-aos`.

## Ways in

1. The hotspot (AP mode, when network-safety has it up): Wi-Fi `CA9B_NO.<n>_5G`, password `12345678`. AOS is
   10.21.41.1 there; route 10.21.31.0/24 via 10.21.41.1 to reach the others.
2. The direct cable: any RTL8153 USB-C to Ethernet adapter in GOS's USB-C port (on the side of the dog without the
   battery slots). GOS is always 192.168.3.2 on it (plus DHCP); the laptop takes 192.168.3.1/24. AOS through GOS:
   `ssh -J user@192.168.3.2 user@10.21.31.103`.
3. Tailscale: `ssh user@m20-gos`, `ssh user@m20-aos` (when the dog has internet).
4. Last resort: the rear Ethernet port under the aviation-plug cover (3 M3 screws), on the internal switch: a laptop
   at 10.21.31.50/24 reaches every board.

## Network layout and quirks

- AOS has ONE radio: wlan0 is either the factory hotspot or a client on a Wi-Fi network, never both (trying both at
  once gave 100% loss). **network-safety** (a service on AOS) chooses, and always falls back to the hotspot. Details,
  states and timers: `~/readme/network_safety.md` on AOS. The vendor's own hotspot babysitter (`loop_start_ap.sh`,
  launched by `/opt/robot/scripts/board_resources/wifi/host_start.sh`) is commented out (backup:
  `host_start.sh.orig-before-network-safety`); `start.service` stays on because it also starts PTP and eth2.
- Saved Wi-Fi networks on AOS have autoconnect off, so NetworkManager never fights network-safety. Add one with
  `sudo nmcli connection add type wifi ifname wlan0 con-name <name> ssid <ssid> wifi-sec.key-mgmt wpa-psk
  wifi-sec.psk <password> connection.autoconnect no`.
- **DDS-flood firewall**: AOS drops UDP 7400-7700 (DDS/ROS 2 discovery and data) on wlan0, in INPUT, OUTPUT and
  FORWARD. The vendor's DDS multicast flooded the Wi-Fi and took the dog offline; keep these rules. They live in
  `/usr/local/bin/office-nat` (`office-nat.service`), which also NATs the internal net out wlan0 for GOS and NOS.
  Local DDS/LCM traffic should stay on `lo` or the wired interfaces.
- Internet: AOS's Wi-Fi is the uplink. GOS's default route goes via AOS (`aos-uplink.service`, metric 600). With the
  direct cable, `usb-ethernet.service` on GOS adds a default via the laptop (192.168.3.1, metric 700) and NATs the
  internal net out the cable, if the laptop shares its internet.
- Clock: the boards boot with a 2024 clock from PTP (NOS is the master), which breaks TLS. `real-time-offset.timer`
  (every minute, GOS and AOS) computes real time minus PTP time from an HTTP Date header (AOS asks GOS over ssh as
  root) and phc2sys applies it (`/etc/systemd/system/phc2sys.service.d/real-time.conf`); PTP itself is untouched.
- GOS's kernel driver r8152 fails on RTL8153 adapters, so it's blacklisted and the adapter runs as cdc_ether
  (`/usr/local/bin/usb-ethernet-up`, `90-usb-ethernet.rules`).
- Every M20 has the same internal addresses, so ssh host keys for 10.21.31.x / 192.168.3.2 differ between dogs.

## m20tool (/usr/local/bin/m20tool; ~/.local/bin/m20 runs it)

- `m20tool help`: addresses, logins, ways in. `m20tool status`, `m20tool battery`: read-only (heartbeat only).
- `m20tool stand` (navigation mode, for dimos), `direct` (regular mode, for axis commands), `lie_down`, `dock`
  (returns at once; a background copy logs to `~/m20_dock.log`), `undock`, `stop`. `--dry-run` prints every frame and
  sends nothing. They talk to basic_server at 10.21.31.103.
- The robot resets its usage mode to regular on every sit->stand and on undock: dimos only drives it after
  `m20tool stand`.
- `m20tool setup` (from a laptop) set all of this up; rerunning it only does what's missing.

## Recovery

- Lost the dog on Wi-Fi: wait. With nobody connected, network-safety returns to the hotspot within about 30-45 min
  (15 min Discovery per Wi-Fi mode). Or plug in the direct cable (way in 2) and, on AOS,
  `sudo systemctl stop network-safety` (it brings the hotspot up as it stops).
- Hotspot won't come back: on AOS, `sudo /opt/robot/scripts/board_resources/wifi/ap_start.sh start 5G`.
- Hand the radio back to the vendor: `sudo systemctl disable --now network-safety`, then restore `host_start.sh` from
  `host_start.sh.orig-before-network-safety`.
- Clock wrong (TLS errors): `sudo systemctl start real-time-offset.service`, then check `date -u`.
- Files m20tool replaced are kept as `<file>.bak-m20tool-<time>`; the old Python `m20` as `~/.local/bin/m20.python-bak`.
