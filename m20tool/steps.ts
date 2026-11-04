// What `m20tool setup` does on GOS and AOS, one step at a time. Each step's check (read-only) and actions run ON the
// board (board.ts, inside the m20tool there); the laptop only orders them, and prints the same actions as the plan.
import {
    type Action,
    active,
    blockCurrent,
    enabled,
    exec,
    exists,
    killAll,
    online,
    type Params,
    processes,
    put,
    readText,
    sameFile,
    untgz,
} from "./board.ts"
import { BOARD_BIN, GOS_IP, OLD_CLI, VERSION } from "./dog.ts"
import { MASK } from "./scripts.ts"

export type BoardName = "GOS" | "AOS"

/** the pinned Deno our board services run on (their units' ExecStart), installed by the deno step */
export const DENO = "/usr/local/bin/deno"
const DENO_RUN = [DENO, "run", "--no-remote", "--cached-only", "--no-lock", "--no-config", "--no-prompt", "-A"]
/** network-safety, compiled (no Deno needed, so no Deno change can break it) */
export const NETWORK_SAFETY_BIN = "/usr/local/libexec/m20-network-safety"
export type CheckResult = { todos: string[]; data?: unknown }
export type BoardStep = {
    id: string
    board: BoardName
    title: string
    /** check and apply need root (sudo) */
    root: boolean
    check: (p: Params) => Promise<CheckResult>
    actions: (p: Params) => Action[]
}

export const fileText = (path: string) => Deno.readTextFileSync(new URL(`./board_files/${path}`, import.meta.url))

export const WRAPPER = `#!/bin/sh
# m20 is m20tool now (github.com/jeff-hykin/dim-m20-dash, m20tool/); the old Python CLI, if there was one, is m20.python-bak
exec ${BOARD_BIN} "$@"
`

type FileSpec = { path: string; content: string; mode: number; owner?: "user" }
const file = (path: string, source: string, mode: number, owner?: "user"): FileSpec => ({
    path,
    content: fileText(source),
    mode,
    owner,
})
const putAll = (files: FileSpec[]): Action[] => files.map((f) => ({ kind: "put", ...f }))
const sys = (...argv: string[]): Action => ({ kind: "exec", argv })
const sysMaybe = (...argv: string[]): Action => ({ kind: "exec", argv, okCodes: [0, 1, 2, 3, 4, 5, 6, 7, 8] })
const filesDiffer = (files: FileSpec[]) =>
    files.filter((f) => !sameFile(f.path, f.content)).map((f) => `${f.path} missing or different`)
const stillThere = (...paths: string[]) => paths.filter(exists).map((path) => `old ${path} still there`)
const removeAll = (...paths: string[]): Action => ({
    kind: "do",
    text: `remove the old ${paths.join(", ")} (if there)`,
    run: () => paths.filter(exists).forEach((path) => Deno.removeSync(path)),
})
const notEnabled = async (...units: string[]) =>
    (await Promise.all(units.map(async (u) => ((await enabled(u)) ? "" : `${u} not enabled`)))).filter(Boolean)
const clockTodo = () =>
    new Date().getUTCFullYear() >= 2025
        ? []
        : [`the clock says ${new Date().toISOString().slice(0, 10)} (PTP's 2024 time base)`]

// ---------------------------------------------------------------------------------------------------- keys, docs

function authorizedKey(id: string, board: BoardName, title: string, key: (p: Params) => string | undefined): BoardStep {
    const path = "/home/user/.ssh/authorized_keys"
    const has = (k: string) => (readText(path) ?? "").split("\n").some((line) => line.trim() === k.trim())
    return {
        id,
        board,
        title,
        root: false,
        check: (p) => Promise.resolve({ todos: key(p) && has(key(p)!) ? [] : ["key not in ~/.ssh/authorized_keys"] }),
        actions: (p) => [{
            kind: "do",
            text: `append the key to ${path} (~/.ssh mode 700, the file 600)`,
            run: () => {
                const k = key(p)?.trim()
                if (!k || has(k)) {
                    return
                }
                Deno.mkdirSync("/home/user/.ssh", { recursive: true, mode: 0o700 })
                const text = readText(path) ?? ""
                Deno.writeTextFileSync(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${k}\n`, {
                    mode: 0o600,
                })
            },
        }],
    }
}

function docs(board: BoardName): BoardStep {
    const agents = [
        `# ${board}: a board of a Deep Robotics M20 robot dog`,
        "",
        `Read ~/readme/ before changing anything here: start with ~/readme/README.md (the boards, the network layout and its quirks, the network-safety service, the DDS-flood firewall, m20tool, recovery)${
            board === "AOS" ? "; ~/readme/network_safety.md is the hotspot/Wi-Fi service on this board" : ""
        }.`,
        "",
        "Networking quirks: never cycle or restart Wi-Fi, NetworkManager, network interfaces, routes or network services, and never reboot, without a human's OK (it has locked everyone out of the dog twice). AOS drops DDS multicast (UDP 7400-7700) on wlan0 on purpose: keep it. Robot: `m20tool status` is read-only; anything that moves it only when a person asks.",
    ].join("\n")
    const claude = "See [~/AGENTS.md](AGENTS.md): this machine's setup and its rules.\n\n@AGENTS.md"
    const blocks: [string, string][] = [
        ["/home/user/readme/README.md", fileText("both/readme_README.md")],
        ["/home/user/AGENTS.md", agents],
        ["/home/user/CLAUDE.local.md", claude],
    ]
    return {
        id: `${board.toLowerCase()}/docs`,
        board,
        title: `${board}: docs for people and agents (~/readme/README.md, ~/AGENTS.md, ~/CLAUDE.local.md)`,
        root: false,
        check: () =>
            Promise.resolve({
                todos: blocks.filter(([path, body]) => !blockCurrent(path, body)).map(([path]) =>
                    `${path}: no current m20tool block`
                ),
            }),
        actions: () => blocks.map(([path, body]) => ({ kind: "block", path, body })),
    }
}

// ---------------------------------------------------------------------------------------------------- GOS

const USB_FILES = () => [
    file("/etc/modprobe.d/blacklist-r8152.conf", "gos/blacklist-r8152.conf", 0o644),
    file("/usr/local/bin/usb-ethernet-up", "gos/usb-ethernet-up", 0o755),
    file("/etc/systemd/system/usb-ethernet.service", "gos/usb-ethernet.service", 0o644),
    file("/etc/udev/rules.d/90-usb-ethernet.rules", "gos/90-usb-ethernet.rules", 0o644),
]

const usbEthernet: BoardStep = {
    id: "gos/usb-ethernet",
    board: "GOS",
    title:
        "GOS: USB-Ethernet fallback (any RTL8153 USB-C adapter -> GOS 192.168.3.2, shares its internet with the other boards)",
    root: true,
    check: async () => ({ todos: [...filesDiffer(USB_FILES()), ...(await notEnabled("usb-ethernet.service"))] }),
    actions: (p) => [
        ...putAll(USB_FILES()),
        sys("udevadm", "control", "--reload"),
        sys("systemctl", "daemon-reload"),
        sys("systemctl", "enable", "usb-ethernet.service"),
        // not while we're on the cable: a restart would drop this very link for a moment
        ...(p.onCable ? [] : [sysMaybe("rmmod", "r8152"), sysMaybe("systemctl", "restart", "usb-ethernet.service")]),
    ],
}

const AOS_UPLINK_FILES = () => [
    file("/usr/local/bin/aos-uplink-up", "gos/aos-uplink-up", 0o755),
    file("/etc/systemd/system/aos-uplink.service", "gos/aos-uplink.service", 0o644),
]

const aosUplink: BoardStep = {
    id: "gos/aos-uplink",
    board: "GOS",
    title: "GOS: internet through AOS's Wi-Fi (aos-uplink), once AOS has internet over wlan0",
    root: true,
    check: async () => ({ todos: [...filesDiffer(AOS_UPLINK_FILES()), ...(await notEnabled("aos-uplink.service"))] }),
    actions: (p) =>
        p.aosWlanOnline === false
            ? [{ kind: "do", text: "skipped: AOS has no internet over wlan0 yet (rerun once it has)", run: () => {} }]
            : [
                ...putAll(AOS_UPLINK_FILES()),
                sys("systemctl", "daemon-reload"),
                sys("systemctl", "enable", "aos-uplink.service"),
                sys("systemctl", "restart", "aos-uplink.service"),
            ],
}

// ---------------------------------------------------------------------------------------------------- both

function deno(board: BoardName): BoardStep {
    return {
        id: `${board.toLowerCase()}/deno`,
        board,
        title: `${board}: Deno at ${DENO} (what our board services run on; one that's already there is kept)`,
        root: true,
        check: async () => ({ todos: (await exec([DENO, "--version"])).code === 0 ? [] : [`no working ${DENO}`] }),
        actions: (p) => [{
            kind: "do",
            text: `install the uploaded deno 2.9.8 aarch64 as ${DENO} (755); remove the upload`,
            run: () => {
                if (p.upload) {
                    put(DENO, Deno.readFileSync(p.upload), 0o755)
                    Deno.removeSync(p.upload)
                }
            },
        }],
    }
}

const TIME_FILES = (aos: boolean) => [
    file("/usr/local/bin/real-time-offset", "both/real-time-offset", 0o755),
    file("/etc/systemd/system/real-time-offset.service", "both/real-time-offset.service", 0o644),
    file("/etc/systemd/system/real-time-offset.timer", "both/real-time-offset.timer", 0o644),
    file("/etc/systemd/system/phc2sys.service.d/real-time.conf", "both/phc2sys-real-time.conf", 0o644),
    ...(aos ? [file("/etc/default/real-time-offset", "aos/real-time-offset.default", 0o644)] : []),
]

function time(board: BoardName): BoardStep {
    const aos = board === "AOS"
    return {
        id: `${board.toLowerCase()}/time`,
        board,
        title: aos
            ? "AOS: real time (asks GOS for the offset over ssh as root, so it gets a root ssh key)"
            : "GOS: real time (the robot's PTP time base stays as is; phc2sys gets an offset)",
        root: true,
        check: async () => ({
            todos: [
                ...filesDiffer(TIME_FILES(aos)),
                ...stillThere("/usr/local/bin/phc2sys-real-time"),
                ...(await notEnabled("real-time-offset.timer")),
                ...(aos && !exists("/root/.ssh/id_ed25519.pub") ? ["AOS has no root ssh key"] : []),
                ...(aos ? [] : clockTodo()),
            ],
            data: aos ? readText("/root/.ssh/id_ed25519.pub")?.trim() : undefined,
        }),
        actions: () => [
            {
                kind: "do",
                text:
                    "first, /run/phc2sys-offset.env = PHC2SYS_OFFSET=<the offset phc2sys runs with now, /run/phc2sys-offset> so a phc2sys restart under the new drop-in keeps it",
                run: () => {
                    const current = (readText("/run/phc2sys-offset") ?? "0").trim()
                    Deno.writeTextFileSync(
                        "/run/phc2sys-offset.env",
                        `PHC2SYS_OFFSET=${/^-?\d+$/.test(current) ? current : "0"}\n`,
                    )
                },
            },
            ...putAll(TIME_FILES(aos)),
            removeAll("/usr/local/bin/phc2sys-real-time"),
            ...(aos
                ? [{
                    kind: "do" as const,
                    text: `ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/id_ed25519 (only if there's no root key)`,
                    run: async () => {
                        if (!exists("/root/.ssh/id_ed25519")) {
                            Deno.mkdirSync("/root/.ssh", { recursive: true, mode: 0o700 })
                            const r = await exec([
                                "ssh-keygen",
                                "-q",
                                "-t",
                                "ed25519",
                                "-N",
                                "",
                                "-f",
                                "/root/.ssh/id_ed25519",
                            ])
                            if (r.code !== 0) {
                                throw new Error(`ssh-keygen: ${r.stderr}`)
                            }
                        }
                    },
                }]
                : []),
            sys("systemctl", "daemon-reload"),
            sys("systemctl", "enable", "--now", "real-time-offset.timer"),
            sysMaybe("systemctl", "start", "real-time-offset.service"),
        ],
    }
}

/** AOS, after GOS trusts its root key: the offset now, and the clock checked */
const aosTimeStart: BoardStep = {
    id: "aos/time-start",
    board: "AOS",
    title: "AOS: clock on real time (offset fetched from GOS)",
    root: true,
    check: () => Promise.resolve({ todos: clockTodo() }),
    actions: () => [sysMaybe("systemctl", "start", "real-time-offset.service")],
}

function tailscale(board: BoardName): BoardStep {
    const host = board === "GOS" ? "m20-gos" : "m20-aos"
    return {
        id: `${board.toLowerCase()}/tailscale`,
        board,
        title: `${board}: Tailscale (as ${host}; the first time it prints a login link)`,
        root: true,
        check: async () => ({
            todos: [
                ...(exists("/usr/bin/tailscale") && exists("/usr/sbin/tailscaled") ? [] : ["tailscale not installed"]),
                ...(await notEnabled("tailscaled")),
                ...((await exec(["tailscale", "status"])).code === 0 ? [] : ["not logged in to Tailscale"]),
            ],
        }),
        actions: (p) => [
            {
                kind: "do",
                text:
                    "(only when not installed) unpack the uploaded tailscale arm64 tarball: tailscale -> /usr/bin, tailscaled -> /usr/sbin, systemd/tailscaled.service -> /etc/systemd/system, tailscaled.defaults -> /etc/default/tailscaled (if missing); remove the upload",
                run: async () => {
                    if (!p.upload) {
                        return
                    }
                    const dir = Deno.makeTempDirSync({ prefix: "m20tool-tailscale-" })
                    try {
                        await untgz(p.upload, dir)
                        put("/usr/bin/tailscale", Deno.readFileSync(`${dir}/tailscale`), 0o755)
                        put("/usr/sbin/tailscaled", Deno.readFileSync(`${dir}/tailscaled`), 0o755)
                        put(
                            "/etc/systemd/system/tailscaled.service",
                            Deno.readFileSync(`${dir}/systemd/tailscaled.service`),
                            0o644,
                        )
                        if (!exists("/etc/default/tailscaled")) {
                            put(
                                "/etc/default/tailscaled",
                                Deno.readFileSync(`${dir}/systemd/tailscaled.defaults`),
                                0o644,
                            )
                        }
                    } finally {
                        Deno.removeSync(dir, { recursive: true })
                        Deno.removeSync(p.upload)
                    }
                },
            },
            sys("systemctl", "daemon-reload"),
            sys("systemctl", "enable", "--now", "tailscaled"),
            {
                kind: "do",
                text:
                    `(only when not logged in) tailscale up --accept-dns=false --hostname=${host}, its login link shown here`,
                run: () => {},
            },
        ],
    }
}

/** `tailscale up`, with the terminal attached (board-step's interactive mode) */
export const tailscaleUpArgv = (
    board: BoardName,
) => ["tailscale", "up", "--accept-dns=false", `--hostname=${board === "GOS" ? "m20-gos" : "m20-aos"}`]

function selfInstall(board: BoardName): BoardStep {
    return {
        id: `${board.toLowerCase()}/self-install`,
        board,
        title: `${board}: m20tool (${BOARD_BIN}; ~/.local/bin/m20 runs it, for M20 Ctrl and the Controller)`,
        root: true,
        check: async () => {
            const version = (await exec([BOARD_BIN, "--version"])).stdout
            return {
                todos: [
                    ...(version === `m20tool ${VERSION}`
                        ? []
                        : [`${BOARD_BIN} is ${version || "missing"}, not ${VERSION}`]),
                    ...(sameFile(OLD_CLI, WRAPPER) ? [] : [`${OLD_CLI} missing or different`]),
                ],
            }
        },
        actions: () => [
            {
                kind: "do",
                text: `copy this m20tool to ${BOARD_BIN} (mode 755)`,
                run: () => {
                    if (Deno.execPath() !== BOARD_BIN) {
                        put(BOARD_BIN, Deno.readFileSync(Deno.execPath()), 0o755)
                    }
                },
            },
            {
                kind: "do",
                text: `keep an old non-wrapper ${OLD_CLI} as ${OLD_CLI}.python-bak`,
                run: () => {
                    const old = readText(OLD_CLI)
                    if (old !== null && !old.includes("m20tool")) {
                        Deno.renameSync(OLD_CLI, `${OLD_CLI}.python-bak`)
                    }
                },
            },
            { kind: "put", path: OLD_CLI, content: WRAPPER, mode: 0o755, owner: "user" },
        ],
    }
}

// ---------------------------------------------------------------------------------------------------- AOS

const aosRoute: BoardStep = {
    id: "aos/route",
    board: "AOS",
    title: "internet for AOS through GOS while setting up (a route until reboot; removed at the end)",
    root: true,
    check: async () => ({ todos: (await online()) ? [] : ["AOS has no internet"] }),
    actions: () => [{
        kind: "do",
        text:
            `ip route replace default via ${GOS_IP} dev <the 10.21.31.x interface> metric 700; resolvectl dns <it> 1.1.1.1 8.8.8.8`,
        run: async () => {
            const dev = Deno.networkInterfaces().find((i) => i.address.startsWith("10.21.31."))?.name
            if (!dev) {
                throw new Error("no 10.21.31.x interface")
            }
            const r = await exec(["ip", "route", "replace", "default", "via", GOS_IP, "dev", dev, "metric", "700"])
            if (r.code !== 0) {
                throw new Error(`ip route: ${r.stderr}`)
            }
            await exec(["resolvectl", "dns", dev, "1.1.1.1", "8.8.8.8"])
        },
    }],
}

const dropRoute: BoardStep = {
    id: "aos/drop-route",
    board: "AOS",
    title: "AOS: the setup-time route via GOS removed",
    root: false,
    check: async () => ({
        todos: (await exec(["ip", "route", "show", "default"])).stdout.includes(`via ${GOS_IP}`)
            ? ["AOS still has the setup-time route via GOS"]
            : [],
    }),
    actions: () => [sysMaybe("ip", "route", "del", "default", "via", GOS_IP)],
}

const HOST_START = "/opt/robot/scripts/board_resources/wifi/host_start.sh"
const AP_START = "/opt/robot/scripts/board_resources/wifi/ap_start.sh"
const VENDOR_LINE = /^[ \t]*(\/opt\/robot\/scripts\/wifi\/loop_start_ap\.sh.*)$/m
const VENDOR_LOOP = /loop_start_ap\.sh/

const vendor: BoardStep = {
    id: "aos/vendor",
    board: "AOS",
    title:
        "AOS: the vendor's hotspot babysitter off (comments out loop_start_ap.sh in host_start.sh, after a backup; start.service stays: it also starts PTP and eth2)",
    root: true,
    check: async () => ({
        todos: [
            ...(VENDOR_LINE.test(readText(HOST_START) ?? "")
                ? ["host_start.sh still starts the vendor's hotspot loop"]
                : []),
            ...(exists(`${HOST_START}.orig-before-network-safety`) ? [] : ["no backup of host_start.sh"]),
            ...(processes(VENDOR_LOOP).length ? ["the vendor's hotspot loop is running"] : []),
            ...((await enabled("m20-wifi-deadman")) ? ["m20-wifi-deadman is enabled"] : []),
            ...(exists("/etc/m20-hotspot-off") ? ["/etc/m20-hotspot-off exists"] : []),
            ...((readText(AP_START) ?? "").includes("m20-hotspot-off")
                ? ["ap_start.sh has the hotspot-off guard"]
                : []),
        ],
    }),
    actions: () => [
        {
            kind: "do",
            text:
                `back up ${HOST_START} as host_start.sh.orig-before-network-safety (once), then comment out its loop_start_ap.sh line`,
            run: () => {
                const backup = `${HOST_START}.orig-before-network-safety`
                if (!exists(backup)) {
                    Deno.copyFileSync(HOST_START, backup)
                }
                const text = readText(HOST_START)!
                if (VENDOR_LINE.test(text)) {
                    put(
                        HOST_START,
                        text.replace(
                            VENDOR_LINE,
                            "# network-safety: vendor hotspot babysitter off (backup: host_start.sh.orig-before-network-safety)\n# $1",
                        ),
                        Deno.statSync(HOST_START).mode! & 0o777,
                    )
                }
            },
        },
        {
            kind: "do",
            text:
                "stop the running vendor loop (SIGTERM to each process whose /proc/<pid>/cmdline has loop_start_ap.sh)",
            run: () => killAll(VENDOR_LOOP),
        },
        {
            kind: "do",
            text:
                "an older setup's leftovers: systemctl disable --now m20-wifi-deadman (if enabled), remove /etc/m20-hotspot-off, restore ap_start.sh from .orig-before-hotspot-flag (if it has the guard)",
            run: async () => {
                if (await enabled("m20-wifi-deadman")) {
                    await exec(["systemctl", "disable", "--now", "m20-wifi-deadman"])
                }
                if (exists("/etc/m20-hotspot-off")) {
                    Deno.removeSync("/etc/m20-hotspot-off")
                }
                const original = `${AP_START}.orig-before-hotspot-flag`
                if ((readText(AP_START) ?? "").includes("m20-hotspot-off") && exists(original)) {
                    Deno.copyFileSync(original, AP_START)
                }
            },
        },
    ],
}

const SAFETY_FILES = () => [
    file("/home/user/readme/network_safety.md", "aos/network_safety.md", 0o644, "user"),
    file("/etc/systemd/system/network-safety.service", "aos/network-safety.service", 0o644),
]
const OLD_SAFETY = [
    "/home/user/readme/network_safety/main.js",
    "/home/user/readme/network_safety/network-safety.service",
]

async function sha256(path: string): Promise<string> {
    try {
        const digest = await crypto.subtle.digest("SHA-256", Deno.readFileSync(path))
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    } catch {
        return ""
    }
}

/** Never restarted here: a restart brings the hotspot up (ExecStopPost). A running old one switches to the new unit at
 * its next restart (crash, watchdog, boot); started only when it isn't running. */
const networkSafety: BoardStep = {
    id: "aos/network-safety",
    board: "AOS",
    title:
        `AOS: network-safety, compiled at ${NETWORK_SAFETY_BIN} (hotspot or Wi-Fi on wlan0, always falling back to the hotspot; ~/readme/network_safety.md)`,
    root: true,
    check: async (p) => ({
        todos: [
            ...filesDiffer(SAFETY_FILES()),
            ...((await sha256(NETWORK_SAFETY_BIN)) === p.networkSafetySha256
                ? []
                : [`${NETWORK_SAFETY_BIN} missing or not this build`]),
            ...stillThere(...OLD_SAFETY),
            ...(await notEnabled("network-safety.service")),
            ...((await active("network-safety.service")) ? [] : ["network-safety.service not running"]),
        ],
    }),
    actions: (p) => [
        {
            kind: "do",
            text:
                `(only when it differs) install the uploaded compiled network-safety as ${NETWORK_SAFETY_BIN} (755); remove the upload`,
            run: () => {
                if (p.upload) {
                    Deno.mkdirSync("/usr/local/libexec", { recursive: true })
                    put(NETWORK_SAFETY_BIN, Deno.readFileSync(p.upload), 0o755)
                    Deno.removeSync(p.upload)
                }
            },
        },
        ...putAll(SAFETY_FILES()),
        removeAll(...OLD_SAFETY),
        {
            kind: "do",
            text: "chown user:user /home/user/readme /home/user/readme/network_safety",
            run: () => {
                const info = Deno.statSync("/home/user")
                for (const dir of ["/home/user/readme", "/home/user/readme/network_safety"]) {
                    Deno.mkdirSync(dir, { recursive: true })
                    Deno.chownSync(dir, info.uid!, info.gid!)
                }
            },
        },
        sys("systemctl", "daemon-reload"),
        sys("systemctl", "enable", "network-safety.service"),
        {
            kind: "do",
            text:
                "systemctl start network-safety.service only if it isn't running (never a restart: that brings the hotspot up; a running one picks up the new unit at its next restart)",
            run: async () => {
                if (!(await active("network-safety.service"))) {
                    await exec(["systemctl", "start", "network-safety.service"])
                }
            },
        },
    ],
}

const DDS_RULES = [["INPUT", "-i"], ["OUTPUT", "-o"], ["FORWARD", "-o"]]
const FIREWALL_FILES = () => [
    file("/usr/local/bin/office-nat", "aos/office-nat", 0o755),
    file("/etc/systemd/system/office-nat.service", "aos/office-nat.service", 0o644),
]

const firewall: BoardStep = {
    id: "aos/firewall",
    board: "AOS",
    title: "AOS: DDS-flood firewall (UDP 7400-7700 dropped on wlan0) + sharing AOS's Wi-Fi with GOS/NOS (office-nat)",
    root: true,
    check: async () => {
        const todos = [...filesDiffer(FIREWALL_FILES()), ...(await notEnabled("office-nat.service"))]
        for (const [chain, flag] of DDS_RULES) {
            const r = await exec([
                "iptables",
                "-C",
                chain,
                flag,
                "wlan0",
                "-p",
                "udp",
                "--dport",
                "7400:7700",
                "-j",
                "DROP",
            ])
            if (r.code !== 0) {
                todos.push(`no DDS drop rule: ${chain} ${flag} wlan0`)
            }
        }
        return { todos }
    },
    actions: () => [
        ...putAll(FIREWALL_FILES()),
        sys("systemctl", "daemon-reload"),
        sys("systemctl", "enable", "office-nat.service"),
        sys(...DENO_RUN, "/usr/local/bin/office-nat"),
    ],
}

/** the saved Wi-Fi client profiles (not the hotspot), from `nmcli -t` (":" inside a name comes escaped) */
async function wifiProfiles(): Promise<string[]> {
    const out = (await exec(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"])).stdout
    return out.split("\n").map((line) => line.split(/(?<!\\):/).map((f) => f.replaceAll("\\:", ":")))
        .filter(([name, type]) => type === "802-11-wireless" && name !== "myap50G").map(([name]) => name)
}
const field = async (profile: string, name: string, secrets = false) =>
    (await exec(["nmcli", ...(secrets ? ["-s"] : []), "-g", name, "connection", "show", profile])).stdout

async function wlanSsid(): Promise<string> {
    const current = (await exec(["nmcli", "-g", "GENERAL.CONNECTION", "device", "show", "wlan0"])).stdout
    return current ? await field(current, "802-11-wireless.ssid") : ""
}

async function findProfile(ssid: string): Promise<string | undefined> {
    for (const profile of await wifiProfiles()) {
        if ((await field(profile, "802-11-wireless.ssid")) === ssid) {
            return profile
        }
    }
}

const bands: BoardStep = {
    id: "aos/bands",
    board: "AOS",
    title: "AOS: Wi-Fi on both 2.4 GHz and 5 GHz (radio on; no saved network pinned to one band)",
    root: true,
    check: async () => {
        const todos: string[] = []
        if ((await exec(["nmcli", "radio", "wifi"])).stdout !== "enabled") {
            todos.push("the Wi-Fi radio is off")
        }
        for (const profile of await wifiProfiles()) {
            const band = await field(profile, "802-11-wireless.band")
            if (band) {
                todos.push(`${profile} only uses band ${band}`)
            }
        }
        const channels = (await exec(["iw", "list"])).stdout.split("\n").filter((l) => /\* \d{4}(\.0)? MHz/.test(l))
            .filter((l) => !l.includes("disabled"))
        if (!channels.some((l) => /\* 24\d\d/.test(l))) {
            todos.push("the radio has no 2.4 GHz channel enabled")
        }
        if (!channels.some((l) => /\* 5\d{3}/.test(l))) {
            todos.push("the radio has no 5 GHz channel enabled")
        }
        return { todos }
    },
    actions: () => [
        sys("nmcli", "radio", "wifi", "on"),
        {
            kind: "do",
            text: `nmcli connection modify <each saved network pinned to a band> 802-11-wireless.band ""`,
            run: async () => {
                for (const profile of await wifiProfiles()) {
                    if (await field(profile, "802-11-wireless.band")) {
                        await exec(["nmcli", "connection", "modify", profile, "802-11-wireless.band", ""])
                    }
                }
            },
        },
    ],
}

/** The password goes only to nmcli's stdin (its edit mode); plans show MASK. */
const wifi: BoardStep = {
    id: "aos/wifi",
    board: "AOS",
    title: "AOS: join the Wi-Fi asked for (saved for network-safety, which joins it) and verify it",
    root: true,
    check: async (p) => {
        const todos: string[] = []
        const found = await findProfile(p.ssid!)
        if (!found) {
            todos.push("no saved network for this SSID")
        } else if (p.password && (await field(found, "802-11-wireless-security.psk", true)) !== p.password) {
            todos.push("the saved password differs")
        }
        for (const profile of await wifiProfiles()) {
            if ((await field(profile, "connection.autoconnect")) !== "no") {
                todos.push(`${profile} autoconnects (would fight network-safety)`)
            }
        }
        const current = await wlanSsid()
        if (current !== p.ssid) {
            todos.push(`wlan0 is on ${current || "the hotspot / nothing"}, not this network`)
        } else if ((await exec(["ping", "-I", "wlan0", "-c1", "-W4", "1.1.1.1"])).code !== 0) {
            todos.push("joined, but no internet over wlan0")
        }
        return { todos }
    },
    actions: (p) => {
        const name = `m20tool-${(p.ssid ?? "").replace(/[^\w.-]/g, "_")}`
        return [
            {
                kind: "do",
                text:
                    `the saved network for "${p.ssid}" (else nmcli connection add type wifi ifname wlan0 con-name ${name} ssid '${p.ssid}' connection.autoconnect no), then nmcli connection modify <it> connection.autoconnect no 802-11-wireless.band ""` +
                    (p.password
                        ? `, then the password on nmcli's stdin: nmcli connection edit id <it>   <<< "set 802-11-wireless-security.key-mgmt wpa-psk / set 802-11-wireless-security.psk ${MASK} / save persistent / quit"`
                        : ""),
                run: async () => {
                    let profile = await findProfile(p.ssid!)
                    if (!profile) {
                        const r = await exec([
                            "nmcli",
                            "connection",
                            "add",
                            "type",
                            "wifi",
                            "ifname",
                            "wlan0",
                            "con-name",
                            name,
                            "ssid",
                            p.ssid!,
                            "connection.autoconnect",
                            "no",
                        ])
                        if (r.code !== 0) {
                            throw new Error(`nmcli connection add: ${r.stderr}`)
                        }
                        profile = name
                    }
                    await exec([
                        "nmcli",
                        "connection",
                        "modify",
                        profile,
                        "connection.autoconnect",
                        "no",
                        "802-11-wireless.band",
                        "",
                    ])
                    if (p.password) {
                        const r = await exec(
                            ["nmcli", "connection", "edit", "id", profile],
                            `set 802-11-wireless-security.key-mgmt wpa-psk\nset 802-11-wireless-security.psk ${p.password}\nsave persistent\nquit\n`,
                        )
                        if (r.code !== 0) {
                            throw new Error(`nmcli connection edit failed (exit ${r.code})`)
                        }
                    }
                },
            },
            {
                kind: "do",
                text: "saved networks never autoconnect: nmcli connection modify <each> connection.autoconnect no",
                run: async () => {
                    for (const profile of await wifiProfiles()) {
                        await exec(["nmcli", "connection", "modify", profile, "connection.autoconnect", "no"])
                    }
                },
            },
            {
                kind: "do",
                text:
                    `unless wlan0 is already on it: network-safety's config.json savedMode -> "wifiInternet", then systemctl restart network-safety (it takes the hotspot down, scans both bands, joins)`,
                run: async () => {
                    if ((await wlanSsid()) === p.ssid) {
                        return
                    }
                    const path = "/home/user/readme/network_safety/config.json"
                    try {
                        const config = JSON.parse(readText(path) ?? "{}")
                        config.savedMode = "wifiInternet"
                        Deno.writeTextFileSync(path, JSON.stringify(config, null, 4) + "\n")
                    } catch {
                        // network-safety rewrites a config it can't read
                    }
                    await exec(["systemctl", "restart", "network-safety"])
                },
            },
        ]
    },
}

// ---------------------------------------------------------------------------------------------------- queries

const query = (id: string, board: BoardName, root: boolean, run: (p: Params) => Promise<CheckResult>): BoardStep => ({
    id,
    board,
    title: id,
    root,
    check: run,
    actions: () => [],
})

export const STEPS: BoardStep[] = [
    deno("GOS"),
    deno("AOS"),
    authorizedKey("gos/ssh-key", "GOS", "this computer's key on GOS", (p) => p.pubkey),
    authorizedKey("aos/ssh-key", "AOS", "this computer's key on AOS", (p) => p.pubkey),
    authorizedKey("gos/trust-aos", "GOS", "GOS trusts AOS's root key (AOS's clock asks GOS)", (p) => p.aosRootKey),
    docs("GOS"),
    docs("AOS"),
    usbEthernet,
    time("GOS"),
    time("AOS"),
    aosTimeStart,
    aosRoute,
    vendor,
    networkSafety,
    firewall,
    tailscale("GOS"),
    tailscale("AOS"),
    bands,
    wifi,
    aosUplink,
    dropRoute,
    selfInstall("GOS"),
    selfInstall("AOS"),
    query("gos/online", "GOS", false, async () => ({ todos: (await online()) ? [] : ["GOS has no internet"] })),
    query(
        "aos/wifi-joined",
        "AOS",
        false,
        async (p) => ({ todos: (await wlanSsid()) === p.ssid ? [] : ["not joined yet"] }),
    ),
    query("aos/wlan-online", "AOS", false, async () => ({
        todos: (await exec(["ping", "-I", "wlan0", "-c1", "-W4", "1.1.1.1"])).code === 0
            ? []
            : ["no internet over wlan0"],
    })),
    query(
        "gos/tailscale-ip",
        "GOS",
        false,
        async () => ({ todos: [], data: (await exec(["tailscale", "ip", "-4"])).stdout.split("\n")[0] }),
    ),
    query(
        "aos/tailscale-ip",
        "AOS",
        false,
        async () => ({ todos: [], data: (await exec(["tailscale", "ip", "-4"])).stdout.split("\n")[0] }),
    ),
]

export const stepById = (id: string) => STEPS.find((s) => s.id === id)
