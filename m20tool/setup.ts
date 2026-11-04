// `m20tool setup`: set a dog up from a laptop, in two phases, every step idempotent. Each step has a read-only check
// (which is what --dry-run runs, so a dry run against a set-up dog reports "done" everywhere) and an apply.
//   Phase 1 (any way in: the dog's hotspot, Tailscale, ...): ssh keys on the boards, then the USB-Ethernet fallback on
//     GOS. Then it stops and asks for the direct cable.
//   Phase 2 (over the direct cable, so a Wi-Fi change can't cut us off): internet for the dog through the laptop,
//     the clock, the vendor's hotspot babysitter off, network-safety, the DDS firewall, Tailscale, both Wi-Fi bands,
//     joining the Wi-Fi asked for at the start, GOS's uplink through AOS, and m20tool itself on GOS and AOS.
// Board-side sources: m20tool/board_files (what runs on the dog we set up by hand, 2026-11-02..04).
import { $ } from "dax"
import {
    AOS_IP,
    CABLE_INSTRUCTIONS,
    GOS_CABLE_IP,
    GOS_IP,
    LAPTOP_CABLE_IP,
    NOS_IP,
    TAILSCALE_AOS,
    TAILSCALE_GOS,
    USER,
} from "./dog.ts"
import { type Board, describe, keyWorks, run, runInteractive, sshPortOpen, upload } from "./remote.ts"
import { boardBinary, installedCheckScript, installOnBoardScript } from "./install.ts"
import { CheckScript, q, Script } from "./scripts.ts"
import { denoForBoard, tailscaleForBoard } from "./downloads.ts"

export type SetupOptions = {
    dryRun: boolean
    wifiSsid?: string
    wifiPassword?: string
    /** ssh targets that override the search */
    gos?: string
    aos?: string
    laptopIface?: string
}

type Check = { done: boolean; detail: string; skip?: boolean }
type Step = {
    title: string
    where: string
    check: () => Promise<Check>
    /** what apply runs, for --dry-run */
    plan: () => string[]
    apply: () => Promise<void>
}

const HOME = Deno.env.get("HOME") ?? "."
const fileText = (path: string) => Deno.readTextFileSync(new URL(`./board_files/${path}`, import.meta.url))

/** Runs a check script (as root with `root`) on `board`. */
async function runCheck(board: Board, check: CheckScript, root = false): Promise<Check> {
    const result = await run(board, check.text(), { root, timeoutSeconds: 60 })
    if (result.code === 255) {
        throw new Error(`can't reach ${board.name} (${describe(board)}): ${result.stderr}`)
    }
    const todo = result.stdout.split("\n").filter((line) => line.startsWith("TODO ")).map((line) => line.slice(5))
    if (result.code !== 0 && !todo.length) {
        todo.push(`check failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 300)}`)
    }
    return { done: !todo.length, detail: todo.join("; ") }
}

/** Runs an apply script; throws with its output when it fails. */
async function runApply(board: Board, script: Script, extra: { stdinPath?: string } = {}) {
    const result = await run(board, script.text(), { root: script.root, timeoutSeconds: 600, ...extra })
    if (result.stdout) {
        console.log(result.stdout.replace(/^/gm, "    "))
    }
    if (result.code !== 0) {
        throw new Error(`${board.name}: exit ${result.code}: ${result.stderr || result.stdout}`)
    }
}

const planOf = (board: Board, script: Script) => [
    `on ${board.name} (${describe(board)})${script.root ? " as root" : ""}:`,
    ...script.shown.map((line) => `  | ${line}`),
]

// ---------------------------------------------------------------------------------------------------- the laptop

function publicKeyPath(): string | null {
    for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
        try {
            Deno.statSync(`${HOME}/.ssh/${name}.pub`)
            return `${HOME}/.ssh/${name}.pub`
        } catch {
            // next
        }
    }
    return null
}

const laptopKeyStep: Step = {
    title: "this computer's ssh key",
    where: "laptop",
    check: () => {
        const path = publicKeyPath()
        return Promise.resolve(
            path ? { done: true, detail: path } : { done: false, detail: "no ~/.ssh/id_ed25519.pub" },
        )
    },
    plan: () => [`ssh-keygen -q -t ed25519 -N "" -f ${HOME}/.ssh/id_ed25519`],
    apply: async () => {
        Deno.mkdirSync(`${HOME}/.ssh`, { recursive: true, mode: 0o700 })
        await $`ssh-keygen -q -t ed25519 -N ${""} -f ${HOME}/.ssh/id_ed25519`
    },
}

const hasAddress = (address: string) => Deno.networkInterfaces().some((i) => i.address === address)
const linkLocalOrNone = (iface: string) =>
    Deno.networkInterfaces().filter((i) => i.name === iface && i.family === "IPv4")
        .every((i) => i.address.startsWith("169.254."))

/** Wired interfaces with a link and no real IPv4 address: where a cable to the dog would be. */
async function cableCandidates(): Promise<string[]> {
    const found: string[] = []
    if (Deno.build.os === "darwin") {
        const ports = await $`networksetup -listallhardwareports`.noThrow().text()
        for (const block of ports.split(/\n\s*\n/)) {
            const port = block.match(/Hardware Port: (.*)/)?.[1] ?? ""
            const device = block.match(/Device: (\S+)/)?.[1] ?? ""
            if (!device || /Wi-Fi|Bluetooth|Thunderbolt Bridge|iPhone|iPad|VPN/i.test(port)) {
                continue
            }
            const info = await $`ifconfig ${device}`.noThrow().stderr("null").text()
            if (/status: active/.test(info) && linkLocalOrNone(device)) {
                found.push(device)
            }
        }
    } else {
        for (const entry of Deno.readDirSync("/sys/class/net")) {
            const dir = `/sys/class/net/${entry.name}`
            const read = (file: string) => {
                try {
                    return Deno.readTextFileSync(`${dir}/${file}`).trim()
                } catch {
                    return ""
                }
            }
            let physical = true
            try {
                Deno.statSync(`${dir}/device`)
                Deno.statSync(`${dir}/wireless`)
                physical = false
            } catch {
                try {
                    Deno.statSync(`${dir}/device`)
                } catch {
                    physical = false
                }
            }
            if (physical && read("type") === "1" && read("carrier") === "1" && linkLocalOrNone(entry.name)) {
                found.push(entry.name)
            }
        }
    }
    return found
}

function laptopCableStep(options: SetupOptions): Step {
    let iface: string | null = null
    const commands = () =>
        Deno.build.os === "darwin"
            ? [`sudo ifconfig ${iface ?? "<the cable's interface>"} alias ${LAPTOP_CABLE_IP} netmask 255.255.255.0`]
            : [
                `sudo ip addr add ${LAPTOP_CABLE_IP}/24 dev ${iface ?? "<the cable's interface>"}`,
                `sudo ip link set ${iface ?? "<the cable's interface>"} up`,
            ]
    return {
        title: `this computer at ${LAPTOP_CABLE_IP} on the direct cable (until it reboots)`,
        where: "laptop",
        check: async () => {
            if (hasAddress(LAPTOP_CABLE_IP)) {
                return { done: true, detail: "already has it" }
            }
            const candidates = options.laptopIface ? [options.laptopIface] : await cableCandidates()
            if (!candidates.length) {
                return { done: true, skip: true, detail: "no cable plugged in here (no wired interface with a link)" }
            }
            iface = candidates[0]
            return {
                done: false,
                detail: `wired interface ${iface} has a link and no address${
                    candidates.length > 1 ? ` (also: ${candidates.slice(1).join(", ")}; --laptop-iface picks)` : ""
                }`,
            }
        },
        plan: commands,
        apply: async () => {
            for (const command of commands()) {
                await $.raw`${command}`
            }
        },
    }
}

/** The laptop's internet shared with the cable (NAT; until the laptop reboots). */
async function laptopNatCommands(): Promise<{ commands: string[]; stdin?: string }[]> {
    if (Deno.build.os === "darwin") {
        const uplink = (await $`route -n get default`.noThrow().stderr("null").text()).match(/interface: (\S+)/)?.[1]
        const ifaces = [...new Set([uplink, "en0", ...Array.from({ length: 16 }, (_, n) => `utun${n}`)])]
            .filter(Boolean) as string[]
        const rules = ifaces.map((i) => `nat on ${i} from 192.168.3.0/24 to any -> (${i})`).join("\n") + "\n"
        return [
            { commands: ["sudo sysctl -w net.inet.ip.forwarding=1"] },
            { commands: ["sudo pfctl -a com.apple/m20 -f -"], stdin: rules },
            { commands: ["sudo pfctl -E"] },
        ]
    }
    const subnet = "192.168.3.0/24"
    if (await $.commandExists("iptables")) {
        const rule = (table: string, chain: string, spec: string, insert = false) =>
            `sudo iptables -t ${table} -C ${chain} ${spec} 2>/dev/null || sudo iptables -t ${table} ${
                insert ? "-I" : "-A"
            } ${chain} ${spec}`
        return [{
            commands: [
                "sudo sysctl -w net.ipv4.ip_forward=1",
                rule("nat", "POSTROUTING", `-s ${subnet} ! -d ${subnet} -j MASQUERADE`),
                rule("filter", "FORWARD", `-s ${subnet} -j ACCEPT`, true),
                rule("filter", "FORWARD", `-d ${subnet} -m state --state RELATED,ESTABLISHED -j ACCEPT`, true),
            ],
        }]
    }
    return [{
        commands: [
            "sudo sysctl -w net.ipv4.ip_forward=1",
            "sudo nft add table ip m20tool",
            "sudo nft 'add chain ip m20tool post { type nat hook postrouting priority 100 ; }'",
            "sudo nft 'add chain ip m20tool fwd { type filter hook forward priority -1 ; }'",
            "sudo nft flush chain ip m20tool post",
            "sudo nft flush chain ip m20tool fwd",
            `sudo nft add rule ip m20tool post ip saddr ${subnet} ip daddr != ${subnet} masquerade`,
            `sudo nft add rule ip m20tool fwd ip saddr ${subnet} accept`,
            `sudo nft add rule ip m20tool fwd ip daddr ${subnet} ct state related,established accept`,
        ],
    }]
}

// ---------------------------------------------------------------------------------------------------- finding the dog

export type Dog = { gos: Board; aos: Board; nos: Board; wired: boolean; how: string }

/** Finds GOS (cable, then the internal address, then Tailscale), and AOS/NOS behind it. */
export async function findDog(options: Pick<SetupOptions, "gos" | "aos">): Promise<Dog | null> {
    let gos: Board | null = null
    let how = ""
    if (options.gos) {
        gos = { name: "GOS", target: options.gos, sharedAddress: false }
        how = "as given (--gos)"
    } else if (await sshPortOpen(GOS_CABLE_IP)) {
        gos = { name: "GOS", target: `${USER}@${GOS_CABLE_IP}`, sharedAddress: true }
        how = "the direct cable"
    } else if (await sshPortOpen(GOS_IP)) {
        gos = { name: "GOS", target: `${USER}@${GOS_IP}`, sharedAddress: true }
        how = hasInternalAddress() ? "the internal network (wired)" : "the dog's hotspot"
    } else if (await sshPortOpen(TAILSCALE_GOS)) {
        gos = { name: "GOS", target: `${USER}@${TAILSCALE_GOS}`, sharedAddress: false }
        how = "Tailscale"
    }
    if (!gos) {
        return null
    }
    const wired = gos.target.endsWith(`@${GOS_CABLE_IP}`) || hasInternalAddress()
    let aos: Board
    if (options.aos) {
        aos = { name: "AOS", target: options.aos, sharedAddress: false }
    } else if (gos.target.endsWith(`@${GOS_IP}`) && await sshPortOpen(AOS_IP)) {
        aos = { name: "AOS", target: `${USER}@${AOS_IP}`, sharedAddress: true }
    } else {
        aos = { name: "AOS", target: `${USER}@${AOS_IP}`, sharedAddress: true, via: gos }
    }
    const nos: Board = { name: "NOS", target: `${USER}@${NOS_IP}`, sharedAddress: true, via: gos }
    return { gos, aos, nos, wired, how }
}

/** On the dog's internal switch (the rear Ethernet port): a wired way in too. */
const hasInternalAddress = () =>
    Deno.networkInterfaces().some((i) => i.address.startsWith("10.21.31.") && !i.name.startsWith("utun"))

// ---------------------------------------------------------------------------------------------------- board steps

function keyStep(board: Board, optional = false): Step {
    const pub = () => Deno.readTextFileSync(publicKeyPath()!).trim()
    const script = () =>
        new Script(false).line(
            "umask 077",
            "mkdir -p ~/.ssh",
            `grep -qxF ${q(pub())} ~/.ssh/authorized_keys 2>/dev/null || echo ${q(pub())} >> ~/.ssh/authorized_keys`,
        )
    return {
        title: `this computer's key on ${board.name}${optional ? " (optional)" : ""}`,
        where: board.name,
        check: async () => {
            if (await keyWorks(board)) {
                return { done: true, detail: "ssh with the key works" }
            }
            return { done: false, detail: "key not accepted yet (installs it with the board password)" }
        },
        plan: () => [
            `ssh ${describe(board)} with the board password (SSH_ASKPASS), then:`,
            ...script().shown.map((line) => `  | ${line}`),
        ],
        apply: async () => {
            const result = await run(board, script().text(), { password: true, timeoutSeconds: 60 })
            if (result.code !== 0) {
                const message = `${board.name}: couldn't install the key: ${result.stderr || result.stdout}`
                if (optional) {
                    console.log(`    skipped: ${message}`)
                    return
                }
                throw new Error(message)
            }
        },
    }
}

/** A step that installs files (and runs `after`), checked by content and `extra`. */
function filesStep(
    board: Board,
    title: string,
    files: { path: string; content: string; mode: string; owner?: string }[],
    extra: (check: CheckScript) => void,
    after: string[],
    options: { checkAsRoot?: boolean; before?: (script: Script) => Promise<void> } = {},
): Step {
    const script = () => {
        const s = new Script(true)
        files.forEach((f) => s.file(f.path, f.content, f.mode, f.owner))
        return s.line(...after)
    }
    return {
        title,
        where: board.name,
        check: () => {
            const check = new CheckScript()
            files.forEach((f) => check.file(f.path, f.content))
            extra(check)
            return runCheck(board, check, options.checkAsRoot)
        },
        plan: () => planOf(board, script()),
        apply: async () => {
            const s = script()
            await options.before?.(s)
            await runApply(board, s)
        },
    }
}

const internetCheck = (check: CheckScript, what: string) =>
    check.line(
        `curl -sI -m 6 http://www.google.com >/dev/null 2>&1 || ping -c1 -W3 1.1.1.1 >/dev/null 2>&1 || echo "TODO ${what} has no internet"`,
    )

function usbEthernetStep(dog: Dog): Step {
    return filesStep(
        dog.gos,
        `GOS: USB-Ethernet fallback (any RTL8153 USB-C adapter -> GOS ${GOS_CABLE_IP}, shares its internet with the other boards)`,
        [
            {
                path: "/etc/modprobe.d/blacklist-r8152.conf",
                content: fileText("gos/blacklist-r8152.conf"),
                mode: "644",
            },
            { path: "/usr/local/bin/usb-ethernet-up", content: fileText("gos/usb-ethernet-up"), mode: "755" },
            {
                path: "/etc/systemd/system/usb-ethernet.service",
                content: fileText("gos/usb-ethernet.service"),
                mode: "644",
            },
            {
                path: "/etc/udev/rules.d/90-usb-ethernet.rules",
                content: fileText("gos/90-usb-ethernet.rules"),
                mode: "644",
            },
        ],
        (check) => check.enabled("usb-ethernet.service"),
        [
            "udevadm control --reload",
            "systemctl daemon-reload",
            "systemctl enable usb-ethernet.service",
            // not while we're on the cable: a restart would drop this very link for a moment
            ...(dog.gos.target.endsWith(`@${GOS_CABLE_IP}`)
                ? []
                : ["rmmod r8152 2>/dev/null || true", "systemctl restart usb-ethernet.service || true"]),
        ],
    )
}

function dogInternetStep(dog: Dog): Step {
    let plan: { commands: string[]; stdin?: string }[] = []
    return {
        title: "internet for the dog (this computer's, shared over the cable; until it reboots)",
        where: "laptop",
        check: async () => {
            const result = await runCheck(dog.gos, internetCheck(new CheckScript(), "GOS"))
            plan = await laptopNatCommands()
            return result.done ? { done: true, detail: "GOS already has internet" } : result
        },
        plan: () => [
            ...plan.flatMap((p) => p.commands.map((c) => (p.stdin ? `${c}   <<< ${JSON.stringify(p.stdin)}` : c))),
            "then waits up to 30 s for GOS to reach the internet",
        ],
        apply: async () => {
            for (const part of plan) {
                for (const command of part.commands) {
                    const c = $.raw`${command}`
                    await (part.stdin ? c.stdinText(part.stdin) : c)
                }
            }
            for (let i = 0; i < 15; i++) {
                if ((await runCheck(dog.gos, internetCheck(new CheckScript(), "GOS"))).done) {
                    return
                }
                await $.sleep(2000)
            }
            throw new Error("GOS still has no internet through this computer (is this computer online?)")
        },
    }
}

function aosInternetStep(dog: Dog): Step {
    const script = () =>
        new Script(true).line(
            `dev=$(ip -o -4 addr show | awk '/10\\.21\\.31\\./{print $2; exit}')`,
            `ip route replace default via ${GOS_IP} dev "$dev" metric 700`,
            `resolvectl dns "$dev" 1.1.1.1 8.8.8.8 2>/dev/null || true`,
        )
    return {
        title: "internet for AOS through GOS while setting up (a route until reboot; removed at the end)",
        where: "AOS",
        check: () => runCheck(dog.aos, internetCheck(new CheckScript(), "AOS")),
        plan: () => planOf(dog.aos, script()),
        apply: () => runApply(dog.aos, script()),
    }
}

function timeFiles(peer: boolean) {
    const files = [
        { path: "/usr/local/bin/real-time-offset", content: fileText("both/real-time-offset"), mode: "755" },
        { path: "/usr/local/bin/phc2sys-real-time", content: fileText("both/phc2sys-real-time"), mode: "755" },
        {
            path: "/etc/systemd/system/real-time-offset.service",
            content: fileText("both/real-time-offset.service"),
            mode: "644",
        },
        {
            path: "/etc/systemd/system/real-time-offset.timer",
            content: fileText("both/real-time-offset.timer"),
            mode: "644",
        },
        {
            path: "/etc/systemd/system/phc2sys.service.d/real-time.conf",
            content: fileText("both/phc2sys-real-time.conf"),
            mode: "644",
        },
    ]
    if (peer) {
        files.push({
            path: "/etc/default/real-time-offset",
            content: fileText("aos/real-time-offset.default"),
            mode: "644",
        })
    }
    return files
}

const clockCheck = (check: CheckScript) =>
    check.line(`[ "$(date -u +%Y)" -ge 2025 ] || echo "TODO the clock says $(date -u +%F) (PTP's 2024 time base)"`)

function timeStep(board: Board): Step {
    return filesStep(
        board,
        `${board.name}: real time (the robot's PTP time base stays as is; phc2sys gets an offset)`,
        timeFiles(false),
        (check) => clockCheck(check.enabled("real-time-offset.timer")),
        [
            "systemctl daemon-reload",
            "systemctl enable --now real-time-offset.timer",
            "systemctl start real-time-offset.service",
        ],
    )
}

function aosTimeStep(dog: Dog): Step {
    const files = timeFiles(true)
    const install = () => {
        const s = new Script(true)
        files.forEach((f) => s.file(f.path, f.content, f.mode))
        return s.line(
            "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
            `test -f /root/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519`,
            "systemctl daemon-reload",
            "systemctl enable --now real-time-offset.timer",
        )
    }
    const rootKey = async () => (await run(dog.aos, "cat /root/.ssh/id_ed25519.pub", { root: true })).stdout.trim()
    const trust = (key: string) =>
        new Script(false).line(
            "umask 077",
            "mkdir -p ~/.ssh",
            `grep -qxF ${q(key)} ~/.ssh/authorized_keys 2>/dev/null || echo ${q(key)} >> ~/.ssh/authorized_keys`,
        )
    return {
        title: "AOS: real time (asks GOS for the offset over ssh as root, so GOS trusts AOS's root key)",
        where: "AOS",
        check: async () => {
            const check = new CheckScript()
            files.forEach((f) => check.file(f.path, f.content))
            check.enabled("real-time-offset.timer")
            clockCheck(check)
            check.line(`test -f /root/.ssh/id_ed25519.pub || echo "TODO AOS has no root ssh key"`)
            const result = await runCheck(dog.aos, check, true)
            const key = await rootKey()
            if (key) {
                const onGos = await run(dog.gos, `grep -qxF ${q(key)} ~/.ssh/authorized_keys`)
                if (onGos.code !== 0) {
                    result.done = false
                    result.detail = [result.detail, "GOS doesn't trust AOS's root key"].filter(Boolean).join("; ")
                }
            }
            return result
        },
        plan: () => [
            ...planOf(dog.aos, install()),
            `then reads AOS's /root/.ssh/id_ed25519.pub, and on GOS (${describe(dog.gos)}):`,
            ...trust("<AOS root key>").shown.map((line) => `  | ${line}`),
            `then on AOS as root: systemctl start real-time-offset.service`,
        ],
        apply: async () => {
            await runApply(dog.aos, install())
            await runApply(dog.gos, trust(await rootKey()))
            await runApply(dog.aos, new Script(true).line("systemctl start real-time-offset.service"))
        },
    }
}

const HOST_START = "/opt/robot/scripts/board_resources/wifi/host_start.sh"
const AP_START = "/opt/robot/scripts/board_resources/wifi/ap_start.sh"

function vendorStep(dog: Dog): Step {
    const script = () =>
        new Script(true).line(
            `[ -f ${HOST_START}.orig-before-network-safety ] || cp -p ${HOST_START} ${HOST_START}.orig-before-network-safety`,
            `sed -i 's|^[[:space:]]*\\(/opt/robot/scripts/wifi/loop_start_a[p].sh.*\\)$|# network-safety: vendor hotspot babysitter off (backup: host_start.sh.orig-before-network-safety)\\n# \\1|' ${HOST_START}`,
            "# the vendor's babysitter loop, if it runs (the [p]s keep pgrep/pkill/grep from matching this very script, whose",
            "# text is in this shell's command line: it must never contain the loop's name spelled out)",
            "pkill -f 'loop_start_a[p].sh' || true",
            "# an older setup's dead-man and hotspot-off flag (network-safety replaces them)",
            "systemctl disable --now m20-wifi-deadman 2>/dev/null || true",
            "rm -f /etc/m20-hotspot-off",
            `if grep -q m20-hotspot-off ${AP_START} && [ -f ${AP_START}.orig-before-hotspot-flag ]; then cp -p ${AP_START}.orig-before-hotspot-flag ${AP_START}; fi`,
        )
    return {
        title:
            "AOS: the vendor's hotspot babysitter off (comments out loop_start_ap.sh in host_start.sh, after a backup; start.service stays: it also starts PTP and eth2)",
        where: "AOS",
        check: () =>
            runCheck(
                dog.aos,
                new CheckScript().line(
                    `grep -q '^[[:space:]]*/opt/robot/scripts/wifi/loop_start_a[p].sh' ${HOST_START} && echo "TODO host_start.sh still starts the vendor's hotspot loop"`,
                    `[ -f ${HOST_START}.orig-before-network-safety ] || echo "TODO no backup ${HOST_START}.orig-before-network-safety"`,
                    `pgrep -f 'loop_start_a[p].sh' >/dev/null && echo "TODO the vendor's hotspot loop is running"`,
                    `[ "$(systemctl is-enabled m20-wifi-deadman 2>/dev/null)" = enabled ] && echo "TODO m20-wifi-deadman is enabled"`,
                    `[ -e /etc/m20-hotspot-off ] && echo "TODO /etc/m20-hotspot-off exists"`,
                    `grep -q m20-hotspot-off ${AP_START} && echo "TODO ap_start.sh has the hotspot-off guard"`,
                    "true",
                ),
            ),
        plan: () => planOf(dog.aos, script()),
        apply: () => runApply(dog.aos, script()),
    }
}

function networkSafetyStep(dog: Dog): Step {
    const files = [
        {
            path: "/home/user/readme/network_safety.md",
            content: fileText("aos/network_safety.md"),
            mode: "644",
            owner: "user:user",
        },
        {
            path: "/home/user/readme/network_safety/main.js",
            content: fileText("aos/network_safety_main.js"),
            mode: "755",
            owner: "user:user",
        },
        {
            path: "/etc/systemd/system/network-safety.service",
            content: fileText("aos/network-safety.service"),
            mode: "644",
        },
    ]
    let needsDeno = false
    const step = filesStep(
        dog.aos,
        "AOS: network-safety (hotspot or Wi-Fi on wlan0, always falling back to the hotspot; ~/readme/network_safety.md)",
        files,
        (check) =>
            check.line(`/usr/local/bin/deno --version >/dev/null 2>&1 || echo "TODO no /usr/local/bin/deno"`)
                .enabled("network-safety.service").active("network-safety.service"),
        [
            "chown user:user /home/user/readme /home/user/readme/network_safety",
            "systemctl daemon-reload",
            "systemctl enable --now network-safety.service",
        ],
    )
    return {
        ...step,
        check: async () => {
            const result = await step.check()
            needsDeno = result.detail.includes("deno")
            return result
        },
        plan: () => [
            ...(needsDeno
                ? [
                    "downloads deno 2.9.8 aarch64-unknown-linux-gnu here (github.com/denoland/deno releases), unzips it, uploads it to AOS /tmp, then as root: install -m 755 it /usr/local/bin/deno; rm the upload",
                ]
                : []),
            ...step.plan(),
        ],
        apply: async () => {
            if (needsDeno) {
                const local = await denoForBoard()
                const remote = await upload(dog.aos, local, "deno")
                await runApply(
                    dog.aos,
                    new Script(true).line(`install -m 755 ${remote} /usr/local/bin/deno`, `rm -f ${remote}`),
                )
            }
            await step.apply()
        },
    }
}

const DDS_RULES = ["INPUT -i wlan0", "OUTPUT -o wlan0", "FORWARD -o wlan0"]

function firewallStep(dog: Dog): Step {
    return filesStep(
        dog.aos,
        "AOS: DDS-flood firewall (UDP 7400-7700 dropped on wlan0) + sharing AOS's Wi-Fi with GOS/NOS (office-nat)",
        [
            { path: "/usr/local/bin/office-nat", content: fileText("aos/office-nat"), mode: "755" },
            {
                path: "/etc/systemd/system/office-nat.service",
                content: fileText("aos/office-nat.service"),
                mode: "644",
            },
        ],
        (check) => {
            check.enabled("office-nat.service")
            DDS_RULES.forEach((spec) =>
                check.line(
                    `iptables -C ${spec} -p udp --dport 7400:7700 -j DROP 2>/dev/null || echo "TODO no DDS drop rule: ${spec}"`,
                )
            )
        },
        ["systemctl daemon-reload", "systemctl enable office-nat.service", "/usr/local/bin/office-nat"],
        { checkAsRoot: true },
    )
}

function tailscaleStep(board: Board, hostname: string): Step {
    let installed = true
    let loggedIn = true
    const install = (remote: string) =>
        new Script(true).line(
            `dir=$(mktemp -d /tmp/m20tool-tailscale.XXXXXX)`,
            `tar xzf ${remote} -C "$dir" --strip-components=1`,
            `install -m 755 "$dir/tailscale" /usr/bin/tailscale`,
            `install -m 755 "$dir/tailscaled" /usr/sbin/tailscaled`,
            `install -m 644 "$dir/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service`,
            `[ -f /etc/default/tailscaled ] || install -m 644 "$dir/systemd/tailscaled.defaults" /etc/default/tailscaled`,
            `rm -rf "$dir" ${remote}`,
            "systemctl daemon-reload",
            "systemctl enable --now tailscaled",
        )
    const up = `tailscale up --accept-dns=false --hostname=${hostname}`
    return {
        title: `${board.name}: Tailscale (as ${hostname}; the first time it prints a login link)`,
        where: board.name,
        check: async () => {
            const result = await runCheck(
                board,
                new CheckScript().line(
                    `command -v tailscale >/dev/null || echo "TODO tailscale not installed"`,
                    `[ "$(systemctl is-enabled tailscaled 2>/dev/null)" = enabled ] || echo "TODO tailscaled not enabled"`,
                    `tailscale status >/dev/null 2>&1 || echo "TODO not logged in to Tailscale"`,
                ),
            )
            installed = !result.detail.includes("not installed") && !result.detail.includes("not enabled")
            loggedIn = !result.detail.includes("not logged in")
            return result
        },
        plan: () => [
            `${
                installed
                    ? "(installed, skipped) "
                    : ""
            }downloads the latest tailscale arm64 tarball here (pkgs.tailscale.com/stable), uploads it to /tmp, then:`,
            ...planOf(board, install("/tmp/m20tool-upload-tailscale.tgz")),
            `${
                loggedIn
                    ? "(logged in, skipped) "
                    : ""
            }on ${board.name} as root (interactive: open the link it prints): ${up}`,
        ],
        apply: async () => {
            if (!installed) {
                const local = await tailscaleForBoard()
                const remote = await upload(board, local, "tailscale.tgz")
                await runApply(board, install(remote))
            }
            if (!loggedIn) {
                console.log(`    log ${board.name} into Tailscale with the link below (the dimensionalos.com account):`)
                const code = await runInteractive(board, up, true)
                if (code !== 0) {
                    throw new Error(`${board.name}: tailscale up exited ${code}`)
                }
            }
        },
    }
}

/** the wifi client profiles (not the hotspot) as shell: for c in $(...) */
const WIFI_PROFILES =
    `nmcli -t -f NAME,TYPE connection show | awk -F: '$2 == "802-11-wireless" && $1 != "myap50G" {print $1}'`

function bandsStep(dog: Dog): Step {
    const script = () =>
        new Script(true).line(
            "nmcli radio wifi on",
            `${WIFI_PROFILES} | while IFS= read -r c; do [ -z "$(nmcli -g 802-11-wireless.band connection show "$c")" ] || nmcli connection modify "$c" 802-11-wireless.band ""; done`,
        )
    return {
        title: "AOS: Wi-Fi on both 2.4 GHz and 5 GHz (radio on; no saved network pinned to one band)",
        where: "AOS",
        check: () =>
            runCheck(
                dog.aos,
                new CheckScript().line(
                    `[ "$(nmcli radio wifi)" = enabled ] || echo "TODO the Wi-Fi radio is off"`,
                    `${WIFI_PROFILES} | while IFS= read -r c; do b=$(nmcli -g 802-11-wireless.band connection show "$c"); [ -z "$b" ] || echo "TODO $c only uses band $b"; done`,
                    `iw list 2>/dev/null | grep -E '\\* 24[0-9]{2}(\\.0)? MHz' | grep -vq disabled || echo "TODO the radio has no 2.4 GHz channel enabled"`,
                    `iw list 2>/dev/null | grep -E '\\* 5[0-9]{3}(\\.0)? MHz' | grep -vq disabled || echo "TODO the radio has no 5 GHz channel enabled"`,
                ),
            ),
        plan: () => planOf(dog.aos, script()),
        apply: () => runApply(dog.aos, script()),
    }
}

function wifiStep(dog: Dog, ssid: string, password: string): Step {
    const name = `m20tool-${ssid.replace(/[^\w.-]/g, "_")}`
    const security = password ? `wifi-sec.key-mgmt wpa-psk wifi-sec.psk ${q(password)}` : ""
    const find =
        `found=$(${WIFI_PROFILES} | while IFS= read -r c; do [ "$(nmcli -g 802-11-wireless.ssid connection show "$c")" = ${
            q(ssid)
        } ] && { printf %s "$c"; break; }; done)`
    const current =
        `cur=$(nmcli -g GENERAL.CONNECTION device show wlan0); curssid=""; [ -n "$cur" ] && curssid=$(nmcli -g 802-11-wireless.ssid connection show "$cur" 2>/dev/null)`
    const script = () =>
        new Script(true).line(
            find,
            `if [ -n "$found" ]; then nmcli connection modify "$found" ${security} connection.autoconnect no 802-11-wireless.band ""; else nmcli connection add type wifi ifname wlan0 con-name ${
                q(name)
            } ssid ${q(ssid)} ${security} connection.autoconnect no; fi`,
            "# saved networks never autoconnect: network-safety alone decides between the hotspot and Wi-Fi",
            `${WIFI_PROFILES} | while IFS= read -r c; do nmcli connection modify "$c" connection.autoconnect no; done`,
            current,
            `if [ "$curssid" != ${
                q(ssid)
            } ]; then sed -i 's/"savedMode": *"[A-Za-z]*"/"savedMode": "wifiInternet"/' /home/user/readme/network_safety/config.json 2>/dev/null; systemctl restart network-safety; fi`,
        )
    return {
        title: `AOS: join Wi-Fi "${ssid}" (saved for network-safety, which joins it) and verify it`,
        where: "AOS",
        check: () =>
            runCheck(
                dog.aos,
                new CheckScript().line(
                    find,
                    `[ -n "$found" ] || echo "TODO no saved network for this SSID"`,
                    password
                        ? `[ -z "$found" ] || [ "$(nmcli -s -g 802-11-wireless-security.psk connection show "$found")" = ${
                            q(password)
                        } ] || echo "TODO the saved password differs"`
                        : "true",
                    `${WIFI_PROFILES} | while IFS= read -r c; do [ "$(nmcli -g connection.autoconnect connection show "$c")" = no ] || echo "TODO $c autoconnects (would fight network-safety)"; done`,
                    current,
                    `[ "$curssid" = ${
                        q(ssid)
                    } ] || echo "TODO wlan0 is on \${curssid:-the hotspot / nothing}, not this network"`,
                    `[ "$curssid" != ${
                        q(ssid)
                    } ] || ping -I wlan0 -c1 -W4 1.1.1.1 >/dev/null 2>&1 || echo "TODO joined, but no internet over wlan0"`,
                ),
                true,
            ),
        plan: () => [
            ...planOf(dog.aos, script()),
            "then waits up to 6 min (network-safety: hotspot down, scan both bands, join, hold 60 s) for wlan0 to be on it, and pings 1.1.1.1 over wlan0",
        ],
        apply: async () => {
            await runApply(dog.aos, script())
            const check = new CheckScript().line(
                current,
                `[ "$curssid" = ${q(ssid)} ] || echo "TODO not joined yet"`,
            )
            for (let waited = 0; waited < 360; waited += 10) {
                if ((await runCheck(dog.aos, check)).done) {
                    const online = await run(dog.aos, "ping -I wlan0 -c1 -W4 1.1.1.1 >/dev/null 2>&1")
                    console.log(
                        online.code === 0
                            ? `    joined "${ssid}", internet over wlan0 works`
                            : `    joined "${ssid}", but no internet over wlan0 (network-safety keeps it as "Wi-Fi No Internet")`,
                    )
                    return
                }
                await $.sleep(10_000)
            }
            throw new Error(
                `AOS didn't join "${ssid}" within 6 min (out of range, or the password is wrong?); network-safety keeps trying, then falls back to the hotspot`,
            )
        },
    }
}

function gosUplinkStep(dog: Dog): Step {
    const step = filesStep(
        dog.gos,
        "GOS: internet through AOS's Wi-Fi (aos-uplink; then the setup-time AOS route is removed)",
        [
            { path: "/usr/local/bin/aos-uplink-up", content: fileText("gos/aos-uplink-up"), mode: "755" },
            {
                path: "/etc/systemd/system/aos-uplink.service",
                content: fileText("gos/aos-uplink.service"),
                mode: "644",
            },
        ],
        (check) => check.enabled("aos-uplink.service"),
        ["systemctl daemon-reload", "systemctl enable aos-uplink.service", "systemctl restart aos-uplink.service"],
    )
    const dropRoute = new Script(true).line(`ip route del default via ${GOS_IP} 2>/dev/null || true`)
    return {
        ...step,
        check: async () => {
            const result = await step.check()
            const route = await run(dog.aos, `ip route show default | grep -q 'via ${GOS_IP}' && echo yes || true`)
            if (route.stdout === "yes") {
                result.done = false
                result.detail = [result.detail, "AOS still has the setup-time route via GOS"].filter(Boolean).join("; ")
            }
            return result
        },
        plan: () => [
            "only once AOS has internet over wlan0:",
            ...step.plan(),
            ...planOf(dog.aos, dropRoute),
        ],
        apply: async () => {
            const online = await run(dog.aos, "ping -I wlan0 -c1 -W4 1.1.1.1 >/dev/null 2>&1")
            if (online.code !== 0) {
                console.log("    skipped: AOS has no internet over wlan0 yet (rerun once it has)")
                return
            }
            await step.apply()
            await runApply(dog.aos, dropRoute)
        },
    }
}

/** ~/readme/README.md, ~/AGENTS.md, ~/CLAUDE.local.md: for people and agents on the board (managed blocks: the rest of
 * each file is theirs and stays) */
export function docsStep(board: Board): Step {
    const agents = [
        `# ${board.name}: a board of a Deep Robotics M20 robot dog`,
        "",
        `Read ~/readme/ before changing anything here: start with ~/readme/README.md (the boards, the network layout and its quirks, the network-safety service, the DDS-flood firewall, m20tool, recovery)${
            board.name === "AOS" ? "; ~/readme/network_safety.md is the hotspot/Wi-Fi service on this board" : ""
        }.`,
        "",
        "Networking quirks: never cycle or restart Wi-Fi, NetworkManager, network interfaces, routes or network services, and never reboot, without a human's OK (it has locked everyone out of the dog twice). AOS drops DDS multicast (UDP 7400-7700) on wlan0 on purpose: keep it. Robot: `m20tool status` is read-only; anything that moves it only when a person asks.",
    ].join("\n")
    const claude = "See [~/AGENTS.md](AGENTS.md): this machine's setup and its rules.\n\n@AGENTS.md"
    const files: [string, string][] = [
        ["/home/user/readme/README.md", fileText("both/readme_README.md")],
        ["/home/user/AGENTS.md", agents],
        ["/home/user/CLAUDE.local.md", claude],
    ]
    const script = () => {
        const s = new Script(false)
        files.forEach(([path, body]) => s.block(path, body))
        return s
    }
    return {
        title: `${board.name}: docs for people and agents (~/readme/README.md, ~/AGENTS.md, ~/CLAUDE.local.md)`,
        where: board.name,
        check: () => {
            const check = new CheckScript()
            files.forEach(([path, body]) => check.block(path, body))
            return runCheck(board, check)
        },
        plan: () => planOf(board, script()),
        apply: () => runApply(board, script()),
    }
}

export function selfInstallStep(board: Board): Step {
    return {
        title:
            `${board.name}: m20tool (/usr/local/bin/m20tool; ~/.local/bin/m20 runs it, for M20 Ctrl and the Controller)`,
        where: board.name,
        check: () => runCheck(board, installedCheckScript()),
        plan: () => [
            "gets m20tool for aarch64 Linux (this binary when it is one, else the GitHub release), uploads it to /tmp, then:",
            ...planOf(board, installOnBoardScript("/tmp/m20tool-upload-m20tool")),
        ],
        apply: async () => {
            const remote = await upload(board, await boardBinary(), "m20tool")
            await runApply(board, installOnBoardScript(remote))
        },
    }
}

// ---------------------------------------------------------------------------------------------------- running it

export async function runStep(step: Step, dryRun: boolean): Promise<boolean> {
    let check: Check
    try {
        check = await step.check()
    } catch (error) {
        console.log(`[????] ${step.title}\n       can't check: ${(error as Error).message}`)
        return false
    }
    const tag = check.skip ? "[skip]" : check.done ? "[done]" : "[todo]"
    console.log(`${tag} ${step.title}${check.detail ? `\n       ${check.detail}` : ""}`)
    if (dryRun) {
        const plan = step.plan()
        if (plan.length) {
            console.log(
                `       ${check.done ? "already done: runs nothing. If it weren't, it would run" : "would run"}:`,
            )
            plan.forEach((line) => console.log(`         ${line}`))
        }
        return true
    }
    if (check.done) {
        return true
    }
    try {
        await step.apply()
    } catch (error) {
        console.log(`       FAILED: ${(error as Error).message}`)
        return false
    }
    const after = await step.check().catch((error) => ({ done: false, detail: (error as Error).message }))
    console.log(after.done ? "       now done" : `       still not done: ${after.detail}`)
    return true
}

export function sshConfigBlock(dog: Dog | null, tailscale: { gos?: string; aos?: string } = {}): string {
    const fixed = "    # every M20 has this address, so its host key isn't pinned\n" +
        "    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR"
    return [
        `# Deep Robotics M20 (from m20tool setup). Login: ${USER}, password: ' (a single apostrophe)`,
        `Host M20GosCable`,
        `    HostName ${GOS_CABLE_IP}`,
        `    User ${USER}`,
        fixed,
        `# on the dog's hotspot (route 10.21.31.0/24 via 10.21.41.1 first), or the rear Ethernet port`,
        `Host M20Gos`,
        `    HostName ${GOS_IP}`,
        `    User ${USER}`,
        fixed,
        `Host M20Aos`,
        `    HostName ${AOS_IP}`,
        `    User ${USER}`,
        `    ProxyJump M20GosCable`,
        fixed,
        `Host M20Nos`,
        `    HostName ${NOS_IP}`,
        `    User ${USER}`,
        `    ProxyJump M20GosCable`,
        fixed,
        `Host ${TAILSCALE_GOS}`,
        `    HostName ${tailscale.gos ?? TAILSCALE_GOS}`,
        `    User ${USER}`,
        `Host ${TAILSCALE_AOS}`,
        `    HostName ${tailscale.aos ?? TAILSCALE_AOS}`,
        `    User ${USER}`,
        ...(dog ? [`# found GOS just now through ${dog.how} (${describe(dog.gos)})`] : []),
    ].join("\n")
}

export async function setup(options: SetupOptions) {
    let ssid = options.wifiSsid
    let password = options.wifiPassword
    if (ssid === undefined) {
        ssid = (await $.prompt("Wi-Fi network for the dog to join (SSID; empty = don't change its Wi-Fi):", {
            noClear: true,
        })).trim()
    }
    if (ssid && password === undefined) {
        password = await $.prompt(`Password for "${ssid}" (empty = an open network):`, { mask: true, noClear: true })
    }
    if (options.dryRun) {
        console.log("DRY RUN: only read-only checks run; every change is printed, none is made.\n")
    }

    console.log("== This computer")
    if (!(await runStep(laptopKeyStep, options.dryRun))) {
        return 1
    }
    await runStep(laptopCableStep(options), options.dryRun)

    const dog = await findDog(options)
    if (!dog) {
        console.log(
            `\nCan't reach GOS (tried ${GOS_CABLE_IP}, ${GOS_IP}, ${TAILSCALE_GOS}). Join the dog's hotspot first (see m20tool help:`,
        )
        console.log(
            `"CA9B_NO.<n>_5G", password 12345678, then: sudo route -n add -net 10.21.31.0/24 10.21.41.1), then rerun.`,
        )
        return 1
    }
    console.log(`\nFound GOS through ${dog.how} (${describe(dog.gos)}); AOS: ${describe(dog.aos)}`)

    console.log("\n== Phase 1 (any way in): keys, docs, then the direct-cable fallback")
    const phase1 = [
        keyStep(dog.gos),
        keyStep(dog.aos),
        keyStep(dog.nos, true),
        docsStep(dog.gos),
        docsStep(dog.aos),
        usbEthernetStep(dog),
    ]
    for (const step of phase1) {
        if (!(await runStep(step, options.dryRun)) && !options.dryRun) {
            return 1
        }
    }

    const phase2: Step[] = [
        dogInternetStep(dog),
        aosInternetStep(dog),
        timeStep(dog.gos),
        aosTimeStep(dog),
        vendorStep(dog),
        networkSafetyStep(dog),
        firewallStep(dog),
        tailscaleStep(dog.gos, TAILSCALE_GOS),
        tailscaleStep(dog.aos, TAILSCALE_AOS),
        bandsStep(dog),
        ...(ssid ? [wifiStep(dog, ssid, password ?? "")] : []),
        gosUplinkStep(dog),
        selfInstallStep(dog.gos),
        selfInstallStep(dog.aos),
    ]
    console.log(`\n== Phase 2 (over the direct cable)${dog.wired ? "" : `: you're on ${dog.how}, so checks only`}`)
    let pending = 0
    for (const step of phase2) {
        if (!dog.wired && !options.dryRun) {
            const check = await step.check().catch((error) => ({ done: false, detail: (error as Error).message }))
            console.log(
                `${check.done ? "[done]" : "[todo]"} ${step.title}${check.detail ? `\n       ${check.detail}` : ""}`,
            )
            pending += check.done ? 0 : 1
            continue
        }
        if (!(await runStep(step, options.dryRun)) && !options.dryRun) {
            return 1
        }
    }
    if (!dog.wired && (pending || options.dryRun)) {
        console.log(`\n${pending ? `${pending} step(s) left. ` : ""}${CABLE_INSTRUCTIONS}`)
        if (pending) {
            return 0
        }
    }

    console.log("\n== For ~/.ssh/config")
    const ip = async (board: Board) => {
        const result = await run(board, "tailscale ip -4 2>/dev/null | head -1").catch(() => null)
        return result?.code === 0 && result.stdout ? result.stdout : undefined
    }
    console.log(sshConfigBlock(dog, { gos: await ip(dog.gos), aos: await ip(dog.aos) }))
    return 0
}
