// `m20tool setup`: set a dog up from a laptop, in two phases, every step idempotent. Each step has a read-only check
// (all --dry-run runs, so a dry run against a set-up dog reports "done" everywhere) and an apply.
//   Phase 1 (any way in: the dog's hotspot, Tailscale, ...): ssh keys, m20tool itself on GOS and AOS (every later
//     step runs inside it, steps.ts), docs for people and agents, then the USB-Ethernet fallback on GOS. Then it stops
//     and asks for the direct cable.
//   Phase 2 (over the direct cable, so a Wi-Fi change can't cut us off): internet for the dog through the laptop,
//     the clock, the vendor's hotspot babysitter off, network-safety, the DDS firewall, Tailscale, both Wi-Fi bands,
//     joining the Wi-Fi asked for at the start, and GOS's uplink through AOS.
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
import {
    type Board,
    boardStep,
    cleanupRunners,
    describe,
    ensureRunner,
    keyWorks,
    run,
    sshPortOpen,
    tailscaleUp,
    upload,
} from "./remote.ts"
import { boardBinary, networkSafetyBinary } from "./install.ts"
import { denoForBoard, tailscaleForBoard } from "./downloads.ts"
import { redact, registerSecret } from "./scripts.ts"
import { planLines } from "./board_step.ts"
import type { Params } from "./board.ts"

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
export type Step = {
    title: string
    where: string
    check: () => Promise<Check>
    /** what apply does, for --dry-run */
    plan: () => string[]
    apply: () => Promise<void>
}

const HOME = Deno.env.get("HOME") ?? "."

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

/** A step that runs inside m20tool on `board` (steps.ts); `params` decided when it runs. */
function boardStepOf(
    board: Board,
    id: string,
    title: string,
    params: () => Params,
    extra: { before?: () => Promise<void>; after?: () => Promise<void>; planExtra?: () => string[] } = {},
): Step {
    // what the check found live (which guarded restarts/re-runs are needed), for the plan and the apply
    let live: Record<string, boolean> | undefined
    const withLive = () => ({ ...params(), live })
    return {
        title,
        where: board.name,
        check: async () => {
            const result = await boardStep(board, id, "check", params())
            live = (result.data as { live?: Record<string, boolean> } | undefined)?.live
            return { done: !result.todos.length, detail: result.todos.join("; ") }
        },
        plan: () => [
            ...(extra.planExtra?.() ?? []),
            `on ${board.name} (${describe(board)}), inside m20tool (board-step ${id} apply):`,
            ...planLines(id, withLive()).map((line) => `  | ${line}`),
        ],
        apply: async () => {
            await extra.before?.()
            await boardStep(board, id, "apply", withLive())
            await extra.after?.()
        },
    }
}

/** the first steps on a board: m20tool there (installed, else a temporary copy), then our key */
function keyStep(board: Board, pubkey: () => string, optional = false): Step {
    if (board.name === "NOS") {
        // NOS never gets m20tool: the key goes with plain shell (mkdir, grep, echo)
        const command = () =>
            `umask 077; mkdir -p ~/.ssh; grep -qxF '${pubkey()}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubkey()}' >> ~/.ssh/authorized_keys`
        return {
            title: "this computer's key on NOS (optional; NOS gets no m20tool, so plain shell)",
            where: "NOS",
            check: async () =>
                (await keyWorks(board)) ? { done: true, detail: "ssh with the key works" } : {
                    done: false,
                    detail: "key not accepted yet",
                },
            plan: () => [`ssh ${describe(board)} with the board password: ${command()}`],
            apply: async () => {
                const result = await run(board, command(), { password: true, timeoutSeconds: 60 })
                if (result.code !== 0 && !optional) {
                    throw new Error(`NOS: ${result.stderr || result.stdout}`)
                }
                if (result.code !== 0) {
                    console.log(`    skipped: ${result.stderr || result.stdout}`)
                }
            },
        }
    }
    const step = boardStepOf(
        board,
        `${board.name.toLowerCase()}/ssh-key`,
        `this computer's key on ${board.name}`,
        () => ({
            pubkey: pubkey(),
        }),
    )
    return {
        ...step,
        check: async () => {
            const works = await keyWorks(board)
            board.password = !works
            if (works) {
                return { done: true, detail: "ssh with the key works" }
            }
            await ensureRunner(board, boardBinary)
            return { done: false, detail: "key not accepted yet (installs it with the board password)" }
        },
        plan: () => [
            "(with the board password, through ssh's SSH_ASKPASS)",
            ...step.plan(),
        ],
        apply: async () => {
            await step.apply()
            board.password = !(await keyWorks(board))
        },
    }
}

const onCable = (board: Board) => board.target.endsWith(`@${GOS_CABLE_IP}`)

function dogInternetStep(dog: Dog): Step {
    let plan: { commands: string[]; stdin?: string }[] = []
    const gosOnline = async () => !(await boardStep(dog.gos, "gos/online", "check", {})).todos.length
    return {
        title: "internet for the dog (this computer's, shared over the cable; until it reboots)",
        where: "laptop",
        check: async () => {
            plan = await laptopNatCommands()
            return (await gosOnline())
                ? { done: true, detail: "GOS already has internet" }
                : { done: false, detail: "GOS has no internet" }
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
                if (await gosOnline()) {
                    return
                }
                await $.sleep(2000)
            }
            throw new Error("GOS still has no internet through this computer (is this computer online?)")
        },
    }
}

function needsUpload(board: Board, id: string, todo: string, label: string, local: () => Promise<string>) {
    let missing = false
    let remote: string | undefined
    return {
        checked: (detail: string) => (missing = detail.includes(todo)),
        planExtra: () =>
            missing ? [`downloads ${label} here, uploads it to ${board.name} /tmp (board-step receive), then:`] : [
                `(${label}: already there, nothing uploaded)`,
            ],
        before: async () => {
            if (missing) {
                remote = await upload(board, await local(), id.replace(/\W/g, "-"))
            }
        },
        upload: () => remote,
    }
}

/** wraps a step so its check notes what's missing (for uploads) */
function withCheck(step: Step, checked: (detail: string) => void): Step {
    return {
        ...step,
        check: async () => {
            const result = await step.check()
            checked(result.detail)
            return result
        },
    }
}

function tailscaleStep(board: Board): Step {
    const id = `${board.name.toLowerCase()}/tailscale`
    let loggedIn = true
    const tarball = needsUpload(
        board,
        id,
        "not installed",
        "the latest tailscale arm64 tarball (pkgs.tailscale.com)",
        tailscaleForBoard,
    )
    const step = boardStepOf(
        board,
        id,
        `${board.name}: Tailscale (as m20-${board.name.toLowerCase()}; the first time it prints a login link)`,
        () => ({
            upload: tarball.upload(),
        }),
        {
            before: tarball.before,
            planExtra: tarball.planExtra,
            after: async () => {
                if (!loggedIn) {
                    console.log(
                        `    log ${board.name} into Tailscale with the link below (the dimensionalos.com account):`,
                    )
                    const code = await tailscaleUp(board)
                    if (code !== 0) {
                        throw new Error(`${board.name}: tailscale up exited ${code}`)
                    }
                }
            },
        },
    )
    return withCheck(step, (detail) => {
        tarball.checked(detail)
        loggedIn = !detail.includes("not logged in")
    })
}

function denoStep(board: Board): Step {
    const id = `${board.name.toLowerCase()}/deno`
    const deno = needsUpload(
        board,
        id,
        "no working",
        "deno 2.9.8 aarch64 (github.com/denoland/deno releases)",
        denoForBoard,
    )
    const step = boardStepOf(
        board,
        id,
        `${board.name}: Deno at /usr/local/bin/deno (what our board services run on; one that's already there is kept)`,
        () => ({ upload: deno.upload() }),
        { before: deno.before, planExtra: deno.planExtra },
    )
    return withCheck(step, deno.checked)
}

function networkSafetyStep(dog: Dog): Step {
    const id = "aos/network-safety"
    let hash = ""
    const binary = needsUpload(
        dog.aos,
        id,
        "not this build",
        "the compiled network-safety (aarch64, this release)",
        networkSafetyBinary,
    )
    const step = boardStepOf(
        dog.aos,
        id,
        "AOS: network-safety, compiled at /usr/local/libexec/m20-network-safety (hotspot or Wi-Fi on wlan0, always falling back to the hotspot; ~/readme/network_safety.md)",
        () => ({ upload: binary.upload(), networkSafetySha256: hash }),
        { before: binary.before, planExtra: binary.planExtra },
    )
    const wrapped = withCheck(step, binary.checked)
    return {
        ...wrapped,
        check: async () => {
            hash = await sha256File(await networkSafetyBinary())
            return await wrapped.check()
        },
    }
}

async function sha256File(path: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function aosTimeStep(dog: Dog): Step {
    return boardStepOf(
        dog.aos,
        "aos/time",
        "AOS: real time (asks GOS for the offset over ssh as root, so it gets a root ssh key)",
        () => ({}),
    )
}

function wifiSteps(dog: Dog, ssid: string, password: string): Step[] {
    const params = () => ({ ssid, password })
    const join = boardStepOf(
        dog.aos,
        "aos/wifi",
        `AOS: join Wi-Fi "${ssid}" (saved for network-safety, which joins it) and verify it`,
        params,
        {
            after: async () => {
                for (let waited = 0; waited < 360; waited += 10) {
                    if (!(await boardStep(dog.aos, "aos/wifi-joined", "check", { ssid })).todos.length) {
                        const online = !(await boardStep(dog.aos, "aos/wlan-online", "check", {})).todos.length
                        console.log(
                            online
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
        },
    )
    return [{
        ...join,
        plan: () => [
            ...join.plan(),
            "then waits up to 6 min (network-safety: hotspot down, scan both bands, join, hold 60 s) for wlan0 to be on it, and pings 1.1.1.1 over wlan0",
        ],
    }]
}

function gosUplinkSteps(dog: Dog): Step[] {
    let aosWlanOnline = false
    const wlanOnline = async () => !(await boardStep(dog.aos, "aos/wlan-online", "check", {})).todos.length
    const uplink = boardStepOf(
        dog.gos,
        "gos/aos-uplink",
        "GOS: internet through AOS's Wi-Fi (aos-uplink), once AOS has internet over wlan0",
        () => ({ aosWlanOnline }),
        {
            before: async () => {
                aosWlanOnline = await wlanOnline()
            },
        },
    )
    return [
        {
            ...uplink,
            // the plan needs it too: whether AOS has internet over wlan0 decides what the step does
            check: async () => {
                aosWlanOnline = await wlanOnline()
                return await uplink.check()
            },
        },
        boardStepOf(
            dog.aos,
            "aos/drop-route",
            "AOS: the setup-time route via GOS removed (once GOS uses AOS's Wi-Fi)",
            () => ({}),
        ),
    ]
}

// ---------------------------------------------------------------------------------------------------- running it

export async function runStep(step: Step, dryRun: boolean): Promise<boolean> {
    let check: Check
    try {
        check = await step.check()
    } catch (error) {
        console.log(redact(`[????] ${step.title}\n       can't check: ${(error as Error).message}`))
        return false
    }
    const tag = check.skip ? "[skip]" : check.done ? "[done]" : "[todo]"
    console.log(redact(`${tag} ${step.title}${check.detail ? `\n       ${check.detail}` : ""}`))
    if (dryRun) {
        const plan = step.plan()
        if (plan.length) {
            console.log(
                `       ${check.done ? "already done: runs nothing. If it weren't, it would run" : "would run"}:`,
            )
            plan.forEach((line) => console.log(redact(`         ${line}`)))
        }
        return true
    }
    if (check.done) {
        return true
    }
    try {
        await step.apply()
    } catch (error) {
        console.log(redact(`       FAILED: ${(error as Error).message}`))
        return false
    }
    const after = await step.check().catch((error) => ({ done: false, detail: (error as Error).message }))
    console.log(redact(after.done ? "       now done" : `       still not done: ${after.detail}`))
    return true
}

/** m20tool + docs on GOS and AOS (install-on-dog) */
export function installSteps(dog: Dog): Step[] {
    return [dog.gos, dog.aos].flatMap((board) => {
        const name = board.name.toLowerCase()
        return [
            boardStepOf(
                board,
                `${name}/self-install`,
                `${board.name}: m20tool (/usr/local/bin/m20tool; ~/.local/bin/m20 runs it, for M20 Ctrl and the Controller)`,
                () => ({}),
            ),
            boardStepOf(
                board,
                `${name}/docs`,
                `${board.name}: docs for people and agents (~/readme/README.md, ~/AGENTS.md, ~/CLAUDE.local.md)`,
                () => ({}),
            ),
        ]
    })
}

/** what every board step needs first: m20tool there (installed at this version, else a temporary copy in /tmp) */
export async function prepare(dog: Dog) {
    for (const board of [dog.gos, dog.aos]) {
        board.password = !(await keyWorks(board))
        await ensureRunner(board, boardBinary)
    }
}

export { cleanupRunners }

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
    registerSecret(password)
    if (options.dryRun) {
        console.log("DRY RUN: only read-only checks run; every change is printed, none is made.\n")
    }
    try {
        return await stages(options, ssid, password ?? "")
    } finally {
        await cleanupRunners()
    }
}

async function stages(options: SetupOptions, ssid: string, password: string) {
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
    const pubkey = () => Deno.readTextFileSync(publicKeyPath()!).trim()
    try {
        await prepare(dog)
    } catch (error) {
        console.log(`can't run m20tool on the boards: ${(error as Error).message}`)
        return 1
    }
    const temporary = [dog.gos, dog.aos].filter((b) => b.runner?.startsWith("/tmp/"))
    if (temporary.length) {
        console.log(
            `(m20tool ${
                temporary.map((b) => b.name).join(" and ")
            } isn't this version yet: the steps run in a copy uploaded to /tmp, removed at the end)`,
        )
    }

    console.log("\n== Phase 1 (any way in): keys, m20tool, docs, then the direct-cable fallback")
    const phase1 = [
        keyStep(dog.gos, pubkey),
        keyStep(dog.aos, pubkey),
        keyStep(dog.nos, pubkey, true),
        ...installSteps(dog),
        denoStep(dog.gos),
        denoStep(dog.aos),
        boardStepOf(
            dog.gos,
            "gos/usb-ethernet",
            "GOS: USB-Ethernet fallback (any RTL8153 USB-C adapter -> GOS 192.168.3.2, shares its internet with the other boards)",
            () => ({ onCable: onCable(dog.gos) }),
        ),
    ]
    for (const step of phase1) {
        if (!(await runStep(step, options.dryRun)) && !options.dryRun) {
            return 1
        }
    }

    let rootKey: string | undefined
    const aosTime = aosTimeStep(dog)
    const phase2: Step[] = [
        dogInternetStep(dog),
        boardStepOf(
            dog.aos,
            "aos/route",
            "internet for AOS through GOS while setting up (a route until reboot; removed at the end)",
            () => ({}),
        ),
        boardStepOf(
            dog.gos,
            "gos/time",
            "GOS: real time (the robot's PTP time base stays as is; phc2sys gets an offset)",
            () => ({}),
        ),
        {
            ...aosTime,
            check: async () => {
                const result = await aosTime.check()
                rootKey = ((await boardStep(dog.aos, "aos/time", "check", {})).data as { rootKey?: string } | undefined)
                    ?.rootKey
                return result
            },
            apply: async () => {
                await aosTime.apply()
                rootKey = ((await boardStep(dog.aos, "aos/time", "check", {})).data as { rootKey?: string } | undefined)
                    ?.rootKey
            },
        },
        boardStepOf(
            dog.gos,
            "gos/trust-aos",
            "GOS trusts AOS's root key (AOS's clock asks GOS)",
            () => ({ aosRootKey: rootKey }),
        ),
        boardStepOf(dog.aos, "aos/time-start", "AOS: clock on real time (offset fetched from GOS)", () => ({})),
        boardStepOf(
            dog.aos,
            "aos/vendor",
            "AOS: the vendor's hotspot babysitter off (comments out loop_start_ap.sh in host_start.sh, after a backup; start.service stays: it also starts PTP and eth2)",
            () => ({}),
        ),
        networkSafetyStep(dog),
        boardStepOf(
            dog.aos,
            "aos/firewall",
            "AOS: DDS-flood firewall (UDP 7400-7700 dropped on wlan0) + sharing AOS's Wi-Fi with GOS/NOS (office-nat)",
            () => ({}),
        ),
        tailscaleStep(dog.gos),
        tailscaleStep(dog.aos),
        boardStepOf(
            dog.aos,
            "aos/bands",
            "AOS: Wi-Fi on both 2.4 GHz and 5 GHz (radio on; no saved network pinned to one band)",
            () => ({}),
        ),
        ...(ssid ? wifiSteps(dog, ssid, password) : []),
        ...gosUplinkSteps(dog),
    ]
    console.log(`\n== Phase 2 (over the direct cable)${dog.wired ? "" : `: you're on ${dog.how}, so checks only`}`)
    let pending = 0
    for (const step of phase2) {
        if (!dog.wired && !options.dryRun) {
            const check = await step.check().catch((error) => ({ done: false, detail: (error as Error).message }))
            console.log(
                redact(
                    `${check.done ? "[done]" : "[todo]"} ${step.title}${
                        check.detail ? `\n       ${check.detail}` : ""
                    }`,
                ),
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
    const ip = async (board: Board, id: string) => {
        try {
            return ((await boardStep(board, id, "check", {})).data as string) || undefined
        } catch {
            return undefined
        }
    }
    console.log(
        sshConfigBlock(dog, { gos: await ip(dog.gos, "gos/tailscale-ip"), aos: await ip(dog.aos, "aos/tailscale-ip") }),
    )
    return 0
}
