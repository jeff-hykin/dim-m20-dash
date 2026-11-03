// The M20's computers ("boards"): one panel each. A board's stats come from a source: over ssh (one persistent ssh per
// board running the stats loop, stats.ts) or a fake board (fake.ts) — `source` in the settings picks, and anything that
// calls `frame`/`link`/`reachable` can stand in (makeSource). Reachability is a separate TCP probe of each host's port
// 22, so a board whose ssh login fails still shows as on the network.
import { logLine } from "./applog.ts"
import { FakeBoard } from "./fake.ts"
import { type Patterns, type Sample, StatsParser, statsScript } from "./stats.ts"

export type BoardConfig = {
    /** id: recording topics, api paths */
    name: string
    label: string
    /** ssh targets, tried in order (user@ip, a Tailscale name, an ~/.ssh/config Host) */
    hosts: string[]
    role?: string
    /** a missing lidar driver here is a fault (red), not just "none" */
    expectLidar?: boolean
    /** a missing dimos here is a fault (red), not just "none" */
    expectDimos?: boolean
}

export const DEFAULT_BOARDS: BoardConfig[] = [
    {
        name: "gos",
        label: "GOS",
        hosts: ["user@10.21.31.104", "user@m20-gos"],
        role: "runs dimos (navigation, cameras)",
        expectDimos: true,
    },
    { name: "aos", label: "AOS", hosts: ["user@10.21.31.103"], role: "motion control, the Wi-Fi hotspot" },
    {
        name: "nos",
        label: "NOS (.106)",
        hosts: ["user@10.21.31.106"],
        role: "lidar driver and LIO, PTP master",
        expectLidar: true,
    },
]

export type SourceKind = "ssh" | "fake"
export type LinkState = "connecting" | "up" | "down" | "off"

/** What a source reports; the monitor keeps the rest. */
export type SourceEvents = {
    frame(text: string): void
    link(state: LinkState, detail?: { host?: string; error?: string }): void
    reachable(value: boolean | null): void
}

export type BoardSource = { stop(): void }

/** a fake board per name, kept across restarts so PUT api/fake's overrides stick */
export const fakeBoards = new Map<string, FakeBoard>()

const SAMPLE_PERIOD_MS = 1000
const PROBE_MS = 3000
const PROBE_TIMEOUT_MS = 2000
const SSH_BACKOFF_MS = [2000, 4000, 8000, 10000]
/** a sample older than this is stale: the link shows "silent" and the indicators go grey */
export const STALE_MS = 5000
/** a lidar driver using at least this much CPU (% of a core) is taking packets */
export const LIDAR_BUSY_PERCENT = 2
const HISTORY = 120

/** the ssh binary: M20_DASH_SSH (a fake ssh, for the tests) or ssh on PATH */
export function sshBinary(): string {
    return Deno.env.get("M20_DASH_SSH") ?? "ssh"
}

export function sshArgs(host: string): string[] {
    return [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=2",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        host,
        "sh -s",
    ]
}

/** Calls `onFrame` with each "@@frame … @@end" block in a stream of text. */
export async function readFrames(stream: ReadableStream<Uint8Array>, onFrame: (text: string) => void) {
    let pending = ""
    let frame: string[] | null = null
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        pending += chunk
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
            if (line.startsWith("@@frame")) {
                frame = [line]
            } else if (frame) {
                frame.push(line)
                if (line.startsWith("@@end")) {
                    onFrame(frame.join("\n"))
                    frame = null
                }
            }
        }
    }
}

/** One persistent ssh per board: the stats loop on stdin, frames on stdout; on exit, the next host after a backoff. */
export function sshSource(board: BoardConfig, events: SourceEvents, patterns: Patterns): BoardSource {
    let stopped = false
    let child: Deno.ChildProcess | null = null
    let wake: (() => void) | null = null
    const run = async () => {
        let failures = 0
        for (let attempt = 0; !stopped; attempt++) {
            const host = board.hosts[attempt % board.hosts.length]
            events.link("connecting", { host })
            let gotFrame = false
            let error = ""
            try {
                child = new Deno.Command(sshBinary(), {
                    args: sshArgs(host),
                    stdin: "piped",
                    stdout: "piped",
                    stderr: "piped",
                }).spawn()
                const writer = child.stdin.getWriter()
                await writer.write(new TextEncoder().encode(statsScript(patterns, SAMPLE_PERIOD_MS / 1000)))
                await writer.close()
                const stderr = new Response(child.stderr).text()
                await readFrames(child.stdout, (text) => {
                    if (!gotFrame) {
                        gotFrame = true
                        failures = 0
                        events.link("up", { host })
                        logLine(`${board.name}: ssh ${host} up`)
                    }
                    events.frame(text)
                })
                const status = await child.status
                error = (await stderr).trim().split("\n").filter(Boolean).slice(-2).join("; ") ||
                    `ssh exited with ${status.code}`
            } catch (caught) {
                error = (caught as Error).message
            }
            child = null
            if (stopped) {
                break
            }
            failures++
            events.link("down", { host, error })
            logLine(`${board.name}: ssh ${host} down: ${error}`)
            const backoff = SSH_BACKOFF_MS[Math.min(failures - 1, SSH_BACKOFF_MS.length - 1)]
            await new Promise<void>((resolve) => {
                wake = resolve
                setTimeout(resolve, gotFrame ? SSH_BACKOFF_MS[0] : backoff)
            })
        }
    }
    run()
    const probe = tcpProbe(board, events)
    return {
        stop() {
            stopped = true
            probe.stop()
            try {
                child?.kill()
            } catch {
                // already gone
            }
            wake?.()
            events.link("off")
        },
    }
}

/** the host part of an ssh target (user@host → host) */
export function hostName(target: string): string {
    return target.split("@").pop() ?? target
}

async function canConnect(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
    let timer: number | undefined
    const connecting = Deno.connect({ hostname, port })
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
        const conn = await Promise.race([connecting, timeout])
        if (conn) {
            conn.close()
            return true
        }
        connecting.then((late) => late.close(), () => {})
        return false
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

/** Every PROBE_MS: can any of the board's hosts be reached on port 22? */
export function tcpProbe(board: BoardConfig, events: SourceEvents): BoardSource {
    let stopped = false
    let busy = false
    const tick = async () => {
        if (busy || stopped) {
            return
        }
        busy = true
        try {
            const results = await Promise.all(
                board.hosts.map((target) => canConnect(hostName(target), 22, PROBE_TIMEOUT_MS)),
            )
            if (!stopped) {
                events.reachable(results.some(Boolean))
            }
        } finally {
            busy = false
        }
    }
    tick()
    const timer = setInterval(tick, PROBE_MS)
    return {
        stop() {
            stopped = true
            clearInterval(timer)
        },
    }
}

/** A fake board (fake.ts) on the same events: a frame a second while its script says it's reachable. */
export function fakeSource(board: BoardConfig, index: number, events: SourceEvents): BoardSource {
    let fake = fakeBoards.get(board.name)
    if (!fake) {
        fake = new FakeBoard(board.name, index)
        fakeBoards.set(board.name, fake)
    }
    const host = `${board.hosts[0] ?? board.name} (simulated)`
    let up = false
    const tick = () => {
        const condition = fake!.condition()
        events.reachable(condition.reachable)
        if (condition.reachable) {
            if (!up) {
                up = true
                events.link("up", { host })
            }
            events.frame(fake!.frame())
        } else {
            up = false
            events.link("down", { host, error: "no route to host (simulated)" })
        }
    }
    events.link("connecting", { host })
    tick()
    const timer = setInterval(tick, SAMPLE_PERIOD_MS)
    return {
        stop() {
            clearInterval(timer)
            events.link("off")
        },
    }
}

export function makeSource(
    kind: SourceKind,
    board: BoardConfig,
    index: number,
    events: SourceEvents,
    patterns: Patterns,
): BoardSource {
    return kind === "fake" ? fakeSource(board, index, events) : sshSource(board, events, patterns)
}

export type Level = "ok" | "warn" | "bad" | "off" | "unknown"
export type Indicator = { level: Level; text: string }

export type BoardState = {
    config: BoardConfig
    link: { state: LinkState; host: string | null; error: string | null; since: number }
    reachable: boolean | null
    latest: Sample | null
    /** when the latest sample arrived here (ms, this machine's clock) */
    receivedAt: number | null
    history: { t: number; total: number | null; cores: (number | null)[] }[]
}

const pids = (processes: { pid: number }[]) => processes.map((p) => p.pid).join(", ")

/** The panel's lights, worked out here so the page and the agent read the same thing. */
export function indicators(board: BoardState, now = Date.now()): Record<string, Indicator> {
    const fresh = board.receivedAt !== null && now - board.receivedAt < STALE_MS
    const sample = fresh ? board.latest : null
    const network: Indicator = board.reachable === true || (board.link.state === "up" && fresh)
        ? { level: "ok", text: "reachable" }
        : board.reachable === false
        ? { level: "bad", text: "unreachable" }
        : { level: "unknown", text: "checking" }
    let stats: Indicator
    if (board.link.state === "up" && fresh) {
        stats = { level: "ok", text: `streaming via ${board.link.host}` }
    } else if (board.link.state === "up") {
        const silentS = board.receivedAt ? Math.round((now - board.receivedAt) / 1000) : null
        stats = { level: "warn", text: silentS === null ? "connected, no stats yet" : `silent ${silentS} s` }
    } else if (board.link.state === "down") {
        stats = { level: "bad", text: board.link.error ?? "ssh down" }
    } else if (board.link.state === "connecting") {
        stats = { level: "unknown", text: `connecting to ${board.link.host ?? "?"}` }
    } else {
        stats = { level: "off", text: "off" }
    }
    let lidar: Indicator
    let dimos: Indicator
    if (!sample) {
        lidar = { level: "unknown", text: "no stats" }
        dimos = { level: "unknown", text: "no stats" }
    } else {
        const drivers = sample.lidar.processes
        const busiest = Math.max(...drivers.map((p) => p.cpu ?? 0), 0)
        const ports = sample.lidar.ports.length ? `, udp ${sample.lidar.ports.join("/")}` : ""
        if (!drivers.length) {
            lidar = { level: board.config.expectLidar ? "bad" : "off", text: "no lidar driver" }
        } else if (busiest >= LIDAR_BUSY_PERCENT) {
            lidar = { level: "ok", text: `publishing: driver at ${busiest}% CPU${ports}` }
        } else {
            lidar = { level: "warn", text: `driver running but idle (${busiest}% CPU)${ports}` }
        }
        const running = sample.dimos.processes
        dimos = running.length
            ? { level: "ok", text: `running (pid ${pids(running)})` }
            : { level: board.config.expectDimos ? "bad" : "off", text: "not running" }
    }
    return { network, stats, lidar, dimos }
}

/** The boards' monitor: a source each, their latest samples and short histories. */
export class Boards {
    states = new Map<string, BoardState>()
    #sources: BoardSource[] = []
    constructor(
        readonly onSample: (board: BoardState, sample: Sample) => void = () => {},
        readonly onLink: (board: BoardState) => void = () => {},
    ) {}

    start(configs: BoardConfig[], kind: SourceKind, patterns: Patterns) {
        this.stop()
        this.states = new Map()
        configs.forEach((config, index) => {
            const state: BoardState = {
                config,
                link: { state: "connecting", host: null, error: null, since: Date.now() },
                reachable: null,
                latest: null,
                receivedAt: null,
                history: [],
            }
            this.states.set(config.name, state)
            const parser = new StatsParser(patterns)
            this.#sources.push(makeSource(kind, config, index, {
                frame: (text) => {
                    const sample = parser.sample(text)
                    if (!sample) {
                        return
                    }
                    state.latest = sample
                    state.receivedAt = Date.now()
                    state.history.push({ t: state.receivedAt, total: sample.cpu.total, cores: sample.cpu.cores })
                    state.history.splice(0, state.history.length - HISTORY)
                    this.onSample(state, sample)
                },
                link: (linkState, detail = {}) => {
                    if (this.states.get(config.name) !== state) {
                        return // an old source, stopping
                    }
                    const changed = state.link.state !== linkState || state.link.host !== (detail.host ?? null)
                    state.link = {
                        state: linkState,
                        host: detail.host ?? state.link.host,
                        error: detail.error ?? null,
                        since: changed ? Date.now() : state.link.since,
                    }
                    if (changed) {
                        this.onLink(state)
                    }
                },
                reachable: (value) => {
                    if (state.reachable !== value) {
                        state.reachable = value
                        this.onLink(state)
                    }
                },
            }, patterns))
        })
    }

    stop() {
        const sources = this.#sources
        this.#sources = []
        this.states = new Map()
        sources.forEach((source) => source.stop())
    }

    /** every board, as the page and the agent see it */
    summary(now = Date.now()) {
        return [...this.states.values()].map((board) => ({
            name: board.config.name,
            label: board.config.label,
            role: board.config.role ?? null,
            hosts: board.config.hosts,
            link: board.link,
            reachable: board.reachable,
            indicators: indicators(board, now),
            stale: board.receivedAt === null || now - board.receivedAt >= STALE_MS,
            receivedAt: board.receivedAt,
            latest: board.latest,
            history: board.history,
        }))
    }
}
