#!/usr/bin/env -S deno run --no-remote --cached-only --no-lock --no-config --no-prompt -A
// M20 network safety (runs on AOS): keeps either the factory hotspot or a Wi-Fi network up on wlan0, so there is
// always a way back in. See ../network_safety.md for the behaviour, the service, and how to change it.
// No imports on purpose: nothing here may need the network (or a lockfile) to start.
//
//   main.js status     anyone: the config and what wlan0 is doing now
//   main.js run        root: the service loop (systemd: network-safety.service)
//   main.js run --dry-run   the same loop on the real state, changing nothing: no hotspot start/stop, no join or
//                      disconnect, no rescan, no config write. It logs each change it WOULD make ("WOULD run: ...")
//                      and every input when it changes ("input ..."): the shadow next to the real service
//                      (m20-network-safety-shadow.service), to compare their decisions.
//   main.js dry-run    root or not: one pass of every check, changing nothing

// its folder (config.json): NETWORK_SAFETY_DIR (the compiled tool's unit sets it), else this file's
const configDir = Deno.env.get("NETWORK_SAFETY_DIR") ?? import.meta.dirname
const configPath = `${configDir}/config.json`
const modes = ["ap", "wifiInternet", "wifiNoInternet"]
const defaults = {
    // written on every entry to a Discovery state; boot resumes that Discovery
    savedMode: "ap",
    iface: "wlan0",
    apConnection: "myap50G",
    apStartCommand: ["/opt/robot/scripts/board_resources/wifi/ap_start.sh", "start", "5G"],
    // only sessions that arrive over these count as "someone connected": the boards (internal switch) and any
    // direct Ethernet cable come in on wired interfaces and never count
    countedInterfaces: ["wlan0", "tailscale0"],
    apCheckMinutes: 15,
    // how long each Discovery gets; the clock keeps running through Soft until Hard (or the next mode down)
    discoveryMinutes: 15,
    // Wi-Fi No Internet with no inbound session (ssh, ...) over wlan0 for this long -> AP
    noInternetIdleMinutes: 15,
    // trouble-free time on one network before Soft becomes Hard
    softToHardMinutes: 30,
    joinTimeoutSeconds: 30,
    joinHoldSeconds: 60,
    onlineWaitSeconds: 45,
    // after the check right after joining, internet is only re-checked this often
    onlineCheckSeconds: 900,
    allowOpenNetworks: true,
    // tailscale peers to ping; empty means "tailscale reports itself online"
    tailscalePingPeers: [],
    pollSeconds: 5,
    // a hotspot that fails this many starts in a row is broken: try Wi-Fi instead of retrying forever
    apAttemptsBeforeWifi: 3,
}

// ---------------------------------------------------------------------------- helpers

/** run --dry-run: decide on the real state, change nothing (see the top) */
const shadow = Deno.args[0] == "run" && Deno.args.includes("--dry-run")
const nowS = () => performance.now() / 1000
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

/** Runs a command, never throws: {code, out}. code -1 = could not run or timed out. */
async function run(argv, { timeoutSeconds = 30 } = {}) {
    try {
        const output = await new Deno.Command(argv[0], {
            args: argv.slice(1),
            stdout: "piped",
            stderr: "piped",
            signal: AbortSignal.timeout(timeoutSeconds * 1000),
        }).output()
        const decode = (bytes) => new TextDecoder().decode(bytes)
        return { code: output.code, out: decode(output.stdout) + decode(output.stderr) }
    } catch (error) {
        return { code: -1, out: String(error) }
    }
}

/** A command that changes something (the radio, a connection): in a shadow run only logged, and taken as done. */
async function change(argv, options) {
    if (shadow) {
        log(`WOULD run: ${argv.join(" ")}`)
        return { code: 0, out: "" }
    }
    return await run(argv, options)
}

/** A shadow run logs every input when it changes, so each decision can be read against what it saw. */
const lastInputs = new Map()
function noteInput(name, value) {
    const text = JSON.stringify(value)
    if (shadow && lastInputs.get(name) != text) {
        lastInputs.set(name, text)
        log(`input ${name}: ${text}`)
    }
    return value
}

// ---------------------------------------------------------------------------- config

/** The config merged over defaults (unknown keys dropped); anything unreadable means the defaults (hotspot). */
function readConfig() {
    try {
        const parsed = JSON.parse(Deno.readTextFileSync(configPath))
        if (parsed && typeof parsed == "object" && !Array.isArray(parsed)) {
            const config = { ...defaults }
            for (const key of Object.keys(defaults)) {
                if (key in parsed) {
                    config[key] = parsed[key]
                }
            }
            if (!modes.includes(config.savedMode)) {
                config.savedMode = "ap"
            }
            return config
        }
        log("config: not an object, using defaults (AP)")
    } catch (error) {
        log(`config: unreadable (${error?.name}), using defaults (AP)`)
    }
    return { ...defaults }
}

/** Writes the config (temp file + rename); every failure is logged and swallowed. */
function writeConfig(config) {
    if (shadow) {
        log(`WOULD save config (saved mode ${config.savedMode})`)
        return true
    }
    try {
        Deno.mkdirSync(configDir, { recursive: true })
        const temp = `${configPath}.tmp`
        Deno.writeTextFileSync(temp, JSON.stringify(config, null, 4) + "\n")
        Deno.renameSync(temp, configPath)
        return true
    } catch (error) {
        log(`config: could not write ${configPath} (${error?.name}: ${error?.message})`)
        return false
    }
}

function saveMode(config, mode) {
    if (config.savedMode != mode) {
        config.savedMode = mode
        writeConfig(config)
    }
}

// ---------------------------------------------------------------------------- wlan0 state

async function wlanState(config) {
    const { out } = await run(["nmcli", "-g", "GENERAL.STATE,GENERAL.CONNECTION", "device", "show", config.iface])
    const [state = "", connection = ""] = out.trim().split("\n")
    return noteInput("wlan", { connected: state.startsWith("100"), connection: connection.trim() })
}

async function inAp(config) {
    const state = await wlanState(config)
    return state.connected && state.connection == config.apConnection
}

async function inClient(config) {
    const state = await wlanState(config)
    return state.connected && state.connection != "" && state.connection != config.apConnection
}

/** The local addresses that belong to the counted interfaces (the hotspot and Tailscale). */
function countedAddresses(config) {
    try {
        return new Set(Deno.networkInterfaces()
            .filter((entry) => config.countedInterfaces.includes(entry.name))
            .map((entry) => entry.address))
    } catch {
        return new Set()
    }
}

/** One row of /proc/net/tcp{,6} as {state, localPort, peer}; addresses are little-endian hex per 32-bit word. */
function tcpRows() {
    const rows = []
    for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
        let text = ""
        try {
            text = Deno.readTextFileSync(file)
        } catch {
            continue
        }
        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/)
            if (fields.length < 4) {
                continue
            }
            const [localHex, localPortHex] = fields[1].split(":")
            const [peerHex] = fields[2].split(":")
            rows.push({ state: fields[3], localPort: parseInt(localPortHex, 16), peer: hexAddress(peerHex, v6), local: hexAddress(localHex, v6) })
        }
    }
    return rows
}

function hexAddress(hex, v6) {
    const words = hex.match(/.{8}/g) ?? []
    const bytes = words.flatMap((word) => word.match(/../g).reverse().map((byte) => parseInt(byte, 16)))
    if (!v6) {
        return bytes.join(".")
    }
    // an IPv4-mapped IPv6 address (::ffff:a.b.c.d) reads as plain IPv4
    if (bytes.slice(0, 10).every((byte) => byte == 0) && bytes[10] == 255 && bytes[11] == 255) {
        return bytes.slice(12).join(".")
    }
    const groups = []
    for (let i = 0; i < 16; i += 2) {
        groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
    }
    return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::")
}

/**
 * Who is using the robot right now: stations on the hotspot (phones, the controller app, laptops) and inbound
 * TCP sessions that arrived over the hotspot or Tailscale. Wired sessions (the other boards, a direct Ethernet
 * cable) don't count. Errs towards "nobody".
 */
async function connectionsNow(config) {
    const stations = (await run(["iw", "dev", config.iface, "station", "dump"])).out
        .split("\n").filter((line) => line.startsWith("Station")).length
    const rows = tcpRows()
    // state 0A = LISTEN, 01 = ESTABLISHED; an established row on a listening port is an inbound session
    const listening = new Set(rows.filter((row) => row.state == "0A").map((row) => row.localPort))
    const counted = countedAddresses(config)
    const inbound = rows
        .filter((row) => row.state == "01" && listening.has(row.localPort) && counted.has(row.local))
        .map((row) => row.peer)
    return noteInput("connections", { stations, inbound: [...new Set(inbound)] })
}

async function online(config) {
    return noteInput("online", await onlineNow(config))
}

async function onlineNow(config) {
    for (const peer of config.tailscalePingPeers) {
        const { code } = await run(["tailscale", "ping", "--c", "1", "--timeout", "5s", peer], { timeoutSeconds: 10 })
        if (code == 0) {
            return true
        }
    }
    const { code, out } = await run(["tailscale", "status", "--json"], { timeoutSeconds: 10 })
    if (code != 0) {
        return false
    }
    try {
        const status = JSON.parse(out)
        return status.BackendState == "Running" && status.Self?.Online == true
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------- mode changes

async function startAp(config) {
    const result = await change(config.apStartCommand, { timeoutSeconds: 60 })
    log(`ap_start exited ${result.code}`)
    for (let i = 0; i < 12; i++) {
        if (await inAp(config)) {
            log("AP is up")
            return true
        }
        await sleep(config.pollSeconds)
    }
    log("AP did not come up")
    return false
}

/** Saved profiles in range, then open networks, strongest first; both bands; none in `bad`. */
async function candidates(config, bad) {
    const listing = await run(
        ["nmcli", "-t", "-e", "no", "-f", "SIGNAL,FREQ,SECURITY,SSID", "device", "wifi", "list", "ifname", config.iface, "--rescan", shadow ? "no" : "yes"],
        { timeoutSeconds: 40 },
    )
    const visible = listing.out.split("\n").map((line) => {
        const [signal, freq, security, ...ssid] = line.split(":")
        return { signal: Number(signal) || 0, freq, open: security == "" || security == "--", ssid: ssid.join(":") }
    }).filter((network) => network.ssid != "")
    const strongest = new Map()
    for (const network of visible.sort((a, b) => b.signal - a.signal)) {
        if (!strongest.has(network.ssid)) {
            strongest.set(network.ssid, network)
        }
    }
    const saved = []
    const profiles = (await run(["nmcli", "-t", "-e", "no", "-f", "NAME,TYPE", "connection", "show"])).out.split("\n")
        .map((line) => line.split(":")).filter(([name, type]) => type == "802-11-wireless" && name != config.apConnection)
        .map(([name]) => name)
    for (const name of profiles) {
        const ssid = (await run(["nmcli", "-g", "802-11-wireless.ssid", "connection", "show", name])).out.trim()
        if (strongest.has(ssid)) {
            saved.push({ ...strongest.get(ssid), profile: name })
            strongest.delete(ssid)
        }
    }
    const open = config.allowOpenNetworks ? [...strongest.values()].filter((network) => network.open) : []
    return noteInput(
        "candidates",
        [...saved.sort((a, b) => b.signal - a.signal), ...open].filter((network) => !bad.has(network.ssid)),
    )
}

async function join(config, network) {
    log(`joining ${network.ssid} (${network.profile ? `saved ${network.profile}` : "open"}, ${network.freq}, signal ${network.signal})`)
    const argv = network.profile
        ? ["nmcli", "connection", "up", network.profile, "ifname", config.iface]
        : ["nmcli", "device", "wifi", "connect", network.ssid, "ifname", config.iface]
    await change(argv, { timeoutSeconds: config.joinTimeoutSeconds })
    const until = nowS() + config.joinHoldSeconds
    while (nowS() < until) {
        if (!(await inClient(config))) {
            log(`${network.ssid} did not hold ${config.joinHoldSeconds}s`)
            return false
        }
        await sleep(config.pollSeconds)
    }
    return true
}

async function waitOnline(config) {
    const until = nowS() + config.onlineWaitSeconds
    while (nowS() < until) {
        if (await online(config)) {
            return true
        }
        await sleep(config.pollSeconds)
    }
    return false
}

/** Joins `network`; for the internet kind it must also reach the internet. */
async function joinFor(config, kind, network) {
    if (!(await join(config, network))) {
        return false
    }
    if (kind == "wifiInternet" && !(await waitOnline(config))) {
        log(`${network.ssid} has no internet`)
        return false
    }
    return true
}

// ---------------------------------------------------------------------------- the loop

/** Tells systemd the loop is alive (WatchdogSec); a no-op outside systemd. */
async function watchdogPing() {
    if (Deno.env.get("NOTIFY_SOCKET")) {
        await run(["systemd-notify", `--pid=${Deno.pid}`, "WATCHDOG=1"], { timeoutSeconds: 10 })
    }
}

// State names match the diagram in ../network_safety.md: AP Discovery / AP Up, then for each Wi-Fi kind
// (wifiInternet, wifiNoInternet) Discovery -> Soft -> Hard, with Soft -> Bumps on trouble.
async function serve(config) {
    // the Wi-Fi kind each Discovery falls through to when its 15 min run out or it has no good candidates
    const nextAfterDiscovery = { wifiInternet: "wifiNoInternet", wifiNoInternet: "ap" }
    let state = "APDiscovery"
    let kind = null
    let network = null
    // per Discovery: the networks that failed and when its 15 min end; kept across a failed Bumps
    let bad = new Set()
    let discoveryEnds = 0
    let softSince = 0
    let lastOnlineCheck = 0
    // Wi-Fi No Internet: when someone was last connected
    let lastUsed = 0
    // failed starts plus drops in this AP stretch; only a stable 15 min (or leaving AP) clears it, so a flapping
    // hotspot can't loop forever
    let apFailures = 0
    const apFailed = (why) => {
        if (++apFailures >= config.apAttemptsBeforeWifi) {
            log(`hotspot failed ${apFailures} times (${why}), trying Wi-Fi`)
            apFailures = 0
            apSince = null
            enterDiscovery("wifiInternet", { fresh: true })
        } else {
            enterAp()
        }
    }
    // when the current stretch in AP began; a hotspot flap keeps it
    let apSince = null

    const enterAp = () => {
        state = "APDiscovery"
        saveMode(config, "ap")
    }
    const enterDiscovery = (newKind, { fresh }) => {
        kind = newKind
        state = "Discovery"
        saveMode(config, kind)
        if (fresh) {
            bad = new Set()
            discoveryEnds = nowS() + config.discoveryMinutes * 60
        }
    }
    const enterSoft = (newKind, newNetwork) => {
        kind = newKind
        network = newNetwork
        state = "Soft"
        softSince = nowS()
        lastOnlineCheck = nowS()
        lastUsed = nowS()
    }

    if (await inClient(config)) {
        // already on a network (e.g. the service restarted): keep it rather than cutting the link
        const connection = (await wlanState(config)).connection
        enterSoft((await online(config)) ? "wifiInternet" : "wifiNoInternet", { ssid: connection, profile: connection })
        saveMode(config, kind)
        discoveryEnds = nowS() + config.discoveryMinutes * 60
    } else if (config.savedMode == "ap") {
        enterAp()
    } else {
        enterDiscovery(config.savedMode, { fresh: true })
    }
    log(`start: saved mode ${config.savedMode}`)

    let loggedState = null
    while (true) {
        await watchdogPing()
        const label = state.startsWith("AP") ? state : `${kind}.${state}${network && state != "Discovery" ? ` (${network.ssid})` : ""}`
        if (label != loggedState) {
            log(`state: ${loggedState ?? "Boot"} -> ${label}`)
            loggedState = label
        }
        try {
            if (state == "APDiscovery") {
                if (await startAp(config)) {
                    apSince ??= nowS()
                    state = "APUp"
                } else {
                    apFailed("start failed")
                }
            } else if (state == "APUp") {
                if (!(await inAp(config))) {
                    log("hotspot went down")
                    apFailed("went down")
                } else if (nowS() - apSince >= config.apCheckMinutes * 60) {
                    const who = await connectionsNow(config)
                    if (who.stations > 0 || who.inbound.length > 0) {
                        log(`someone connected (${who.stations} stations, inbound ${who.inbound.join(", ") || "none"}), waiting again`)
                        apSince = nowS()
                        apFailures = 0
                    } else {
                        apFailures = 0
                        log("nobody connected")
                        apSince = null
                        enterDiscovery("wifiInternet", { fresh: true })
                    }
                }
            } else if (state == "Discovery") {
                if (await inAp(config)) {
                    await change(["nmcli", "connection", "down", config.apConnection])
                }
                const found = nowS() < discoveryEnds ? await candidates(config, bad) : []
                if (found.length == 0) {
                    log(nowS() < discoveryEnds ? "no good candidates" : `${config.discoveryMinutes} min used up`)
                    const next = nextAfterDiscovery[kind]
                    next == "ap" ? enterAp() : enterDiscovery(next, { fresh: true })
                } else if (await joinFor(config, kind, found[0])) {
                    enterSoft(kind, found[0])
                } else {
                    log(`${found[0].ssid} marked bad`)
                    bad.add(found[0].ssid)
                    await change(["nmcli", "device", "disconnect", config.iface])
                }
            } else if (state == "Soft" || state == "Hard") {
                let trouble = !(await inClient(config)) ? "link lost" : null
                if (!trouble && nowS() - lastOnlineCheck >= config.onlineCheckSeconds) {
                    lastOnlineCheck = nowS()
                    const isOnline = await online(config)
                    if (kind == "wifiInternet" && !isOnline) {
                        trouble = "internet lost"
                    } else if (kind == "wifiNoInternet" && isOnline) {
                        log(`${network.ssid} has internet now`)
                        enterSoft("wifiInternet", network)
                        discoveryEnds = nowS() + config.discoveryMinutes * 60
                        continue
                    }
                }
                if (!trouble && kind == "wifiNoInternet") {
                    // client mode: iw lists the access point as a station, so only inbound sessions count
                    if ((await connectionsNow(config)).inbound.length > 0) {
                        lastUsed = nowS()
                    } else if (nowS() - lastUsed >= config.noInternetIdleMinutes * 60) {
                        log(`nobody connected for ${config.noInternetIdleMinutes} min`)
                        enterAp()
                        continue
                    }
                }
                if (trouble) {
                    log(`${network.ssid}: ${trouble}`)
                    if (state == "Hard") {
                        enterDiscovery("wifiInternet", { fresh: true })
                    } else {
                        state = "Bumps"
                    }
                } else if (state == "Soft" && nowS() - softSince >= config.softToHardMinutes * 60) {
                    state = "Hard"
                }
            } else if (state == "Bumps") {
                if (nowS() >= discoveryEnds) {
                    // Soft still burns its Discovery's clock: out of time means the next mode down
                    log(`${network.ssid}: ${config.discoveryMinutes} min Discovery used up, no rejoin`)
                    enterDiscovery(kind, { fresh: false })
                } else if (network.ssid && (network.profile || network.open) && (await joinFor(config, kind, network))) {
                    enterSoft(kind, network)
                } else {
                    log(`${network.ssid} rejoin failed, marked bad`)
                    bad.add(network.ssid)
                    enterDiscovery(kind, { fresh: false })
                }
            }
        } catch (error) {
            log(`unexpected error, falling back to AP: ${error?.stack ?? error}`)
            state.startsWith("AP") ? apFailed("error") : enterAp()
        }
        await sleep(config.pollSeconds)
    }
}

async function dryRun(config) {
    log(`config (${configPath}):`, JSON.stringify(config))
    log("wlan0:", JSON.stringify(await wlanState(config)), "inAp", await inAp(config), "inClient", await inClient(config))
    log("connections:", JSON.stringify(await connectionsNow(config)))
    log("online:", await online(config))
    // only lists what is visible; a rescan while hosting the hotspot is harmless
    const listing = await run(["nmcli", "-t", "-e", "no", "-f", "SIGNAL,FREQ,SECURITY,SSID", "device", "wifi", "list", "ifname", config.iface])
    log("visible networks:\n" + listing.out.trim())
}

const command = Deno.args[0] ?? "status"
const config = readConfig()
if (command == "run") {
    if (Deno.uid() != 0 && !shadow && !Deno.env.get("NETWORK_SAFETY_TEST")) {
        console.error("run needs root (it changes wlan0); try: main.js status")
        Deno.exit(1)
    }
    if (!writeConfig(config)) {
        log("continuing without a writable config")
    }
    await serve(config)
} else if (command == "dry-run") {
    await dryRun(config)
} else {
    console.log(JSON.stringify({ configPath, config, wlan0: await wlanState(config) }, null, 4))
}
