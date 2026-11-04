// Facts about a Deep Robotics M20 (Lynx) and the way we set them up: addresses, logins, which board is which.
export const VERSION = "0.3.8"
export const REPO = "jeff-hykin/dim-m20-dash"
export const RELEASE_TAG = `m20tool-v${VERSION}`
export const INSTALL_ONE_LINER = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/m20tool/install.sh | sh`

export const USER = "user"
/** every board's login password, and AOS's sudo password: one apostrophe */
export const BOARD_PASSWORD = "'"
export const HOTSPOT_PASSWORD = "12345678"
export const GOS_IP = "10.21.31.104"
export const AOS_IP = "10.21.31.103"
export const NOS_IP = "10.21.31.106"
/** AOS's address on its own hotspot */
export const AOS_HOTSPOT_IP = "10.21.41.1"
export const GOS_CABLE_IP = "192.168.3.2"
export const LAPTOP_CABLE_IP = "192.168.3.1"
export const TAILSCALE_GOS = "m20-gos"
export const TAILSCALE_AOS = "m20-aos"
/** where m20tool goes on the boards (on PATH for every shell, ssh commands included) */
export const BOARD_BIN = "/usr/local/bin/m20tool"
/** the old Python CLI's path, which M20 Ctrl and the Controller's action buttons call: now a wrapper */
export const OLD_CLI = "/home/user/.local/bin/m20"
export const DOCK_LOG = "m20_dock.log"

export const CABLE_INSTRUCTIONS = `Connect a direct Ethernet cable from this computer to GOS:
  1. Plug a USB-C to Ethernet adapter (Realtek RTL8153, the common kind) into GOS's USB-C port. It is on the side
     of the dog WITHOUT the battery slots.
  2. Run an Ethernet cable from that adapter to this computer (a USB-Ethernet adapter on this end is fine too).
  3. Rerun \`m20tool setup\`. It gives this computer ${LAPTOP_CABLE_IP} on that adapter (GOS is always ${GOS_CABLE_IP}
     on the cable) and does the rest over the cable, so changing the dog's Wi-Fi can't cut you off.`

export const HELP = `m20tool ${VERSION}: set up and operate a Deep Robotics M20 (Lynx) robot dog.

THE BOARDS (login: ${USER}, password: ${BOARD_PASSWORD}  <- a single apostrophe)
  AOS  ${AOS_IP}   motion control: the vendor's basic_server (UDP 30000 / TCP 30001), the Wi-Fi radio (wlan0:
                    hotspot OR a Wi-Fi network), cameras, lidars. sudo asks for the password.
  GOS  ${GOS_IP}   general compute, ours: Ubuntu 20.04 aarch64, dimos, DimOS Desktop, M20 Ctrl. sudo needs no password.
                    Its USB-C port takes a USB-Ethernet adapter: the direct cable (GOS ${GOS_CABLE_IP}).
  NOS  ${NOS_IP}   the PTP time master (and the vendor's zenoh/DDS bridge).
  Tailscale (once \`m20tool setup\` logged them in): ${TAILSCALE_GOS}, ${TAILSCALE_AOS}.

WAYS IN
  1. The dog's hotspot (AP mode): join Wi-Fi "CA9B_NO.<number>_5G", password ${HOTSPOT_PASSWORD}. AOS is ${AOS_HOTSPOT_IP} on it.
     Reach the other boards by routing the internal net through AOS:
        macOS: sudo route -n add -net 10.21.31.0/24 ${AOS_HOTSPOT_IP}
        Linux: sudo ip route add 10.21.31.0/24 via ${AOS_HOTSPOT_IP}
     then: ssh ${USER}@${GOS_IP}   (and ${USER}@${AOS_IP}, ${USER}@${NOS_IP})
  2. The direct cable (after \`m20tool setup\` phase 1): a USB-C to Ethernet adapter in GOS's USB-C port, on the
     side of the dog WITHOUT the battery slots; this computer at ${LAPTOP_CABLE_IP}/24, then ssh ${USER}@${GOS_CABLE_IP},
     and AOS through it: ssh -J ${USER}@${GOS_CABLE_IP} ${USER}@${AOS_IP}
  3. Tailscale: ssh ${USER}@${TAILSCALE_GOS} / ssh ${USER}@${TAILSCALE_AOS}
  4. Last resort: the rear Ethernet port under the aviation-plug cover (3 M3 screws) is on the internal switch;
     a laptop at 10.21.31.50/24 reaches every board.

AP MODE (the hotspot) vs WI-FI
  AOS has one radio: it is either the hotspot or a client on a Wi-Fi network, never both. After setup,
  network-safety (a service on AOS, ~/readme/network_safety.md there) picks one and always falls back to the hotspot:
  the hotspot stays up while someone is on it; with nobody on it for 15 min it tries the saved Wi-Fi networks (15 min
  to find internet, then 15 min for any network), and lands back on the hotspot when those fail. To force the
  hotspot now: ssh into AOS (cable or Tailscale) and run \`sudo systemctl stop network-safety\` (it starts the hotspot
  as it stops); \`sudo systemctl start network-safety\` hands the radio back to it.

COMMANDS
  m20tool setup                 set up a dog from this computer (asks for the Wi-Fi to join; safe to rerun;
                                --dry-run shows every step and command and changes nothing)
  m20tool install-on-dog        install this m20tool on GOS and AOS (also the last step of setup)
  m20tool status | battery      read-only: what the robot reports (sends only basic_server's heartbeat)
  m20tool stand | direct | lie_down | dock | undock | stop     move the robot (see m20tool <command> --help)
  The robot commands work on GOS and AOS with no arguments (basic_server is ${AOS_IP}); on a laptop they talk to
  ${AOS_IP} directly when it answers (hotspot), else run on GOS over ssh. --dry-run prints every frame, sends none.
  \`m20\` (~/.local/bin/m20 on the boards) is the same tool, for M20 Ctrl and the Controller's buttons.

Install: ${INSTALL_ONE_LINER}`
