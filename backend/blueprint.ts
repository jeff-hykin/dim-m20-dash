// Blueprint mode: the running dimos blueprint, through the dimos gateway (Desktop's /gateways/dimos/), never a robot
// connection of our own. Every POLL_MS: what runs (GET active), its streams (GET active/streams) and its
// M20Connection module (GET active/modules). Every PEEK_MS: the latest message of each watched stream
// (GET active/streams/{name}/peek), shown and, while recording, written to /blueprint/<stream>. Motion is
// M20Connection's own RPCs (POST active/modules/{id}/rpcs/{name}): the blueprint keeps the one link to the dog.
// The recording is sampled (one peek per stream per PEEK_MS), not every message.
import { logLine } from "./applog.ts"
import { dimosApp } from "./dimos_app.ts"
import { HttpError } from "./http.ts"

const POLL_MS = 2000
const PEEK_MS = 1000
const PEEK_TIMEOUT_S = 0.8
const REQUEST_TIMEOUT_MS = 5000
/** M20Connection's RPCs the panel offers (no arguments; move takes a Twist the gateway can't build from JSON). dock is
 * the self-charging skill (dimos andrew/feat/m20-self-charging): it walks onto the dock in front of the robot and
 * returns at once with what it's doing ("Docking. ..." or "Not docking: <why>."). */
export const MOTIONS: Record<string, { rpc: string; label: string; moves: boolean }> = {
    standup: { rpc: "standup", label: "Stand up", moves: true },
    liedown: { rpc: "liedown", label: "Lie down", moves: true },
    dock: { rpc: "dock", label: "Dock (self-charge)", moves: true },
    stop: { rpc: "stop_movement", label: "Stop (zero velocity)", moves: false },
}

/** where the dimos gateway is (tests point this at a fake one); null off Desktop */
let gatewayUrl: () => string | null = () => {
    const base = dimosApp().desktopUrl
    return base ? new URL("/gateways/dimos/", base).href : null
}

export function setGatewayUrl(url: string | null) {
    gatewayUrl = () => url
}

/** One gateway call: its JSON, or an HttpError with what the gateway said. */
export async function gateway(method: string, path: string, body?: unknown): Promise<unknown> {
    const base = gatewayUrl()
    if (!base) {
        throw new HttpError(503, "no dimos gateway: M20 Ctrl isn't running under DimOS Desktop")
    }
    const response = await fetch(new URL(path, base), {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let json: unknown = null
    try {
        json = text ? JSON.parse(text) : null
    } catch {
        json = { error: text.slice(0, 300) }
    }
    if (!response.ok) {
        const said = json as { detail?: unknown; error?: unknown } | null
        const message = typeof said?.detail === "string"
            ? said.detail
            : typeof said?.error === "string"
            ? said.error
            : `HTTP ${response.status}`
        throw new HttpError(response.status, `dimos gateway: ${method} ${path}: ${message}`)
    }
    return json
}

export type LiveStream = { name: string; type: string; direction: string | null; module: string }
export type Peeked = { type: string; value: unknown; ts: number | null; at: number }

export type BlueprintState = {
    running: boolean
    blueprint: string | null
    runId: string | null
    error: string | null
    streams: LiveStream[]
    /** the M20Connection instance's id (for its RPCs), null when the blueprint has none */
    connection: { id: string; rpcs: string[] } | null
    peeked: Record<string, Peeked>
    checkedAt: number | null
}

const empty = (): BlueprintState => ({
    running: false,
    blueprint: null,
    runId: null,
    error: null,
    streams: [],
    connection: null,
    peeked: {},
    checkedAt: null,
})

/** a stream that's worth showing as a lidar topic (listed only; its clouds are too big to peek) */
export const LIDAR_STREAM = /lidar|points|cloud/i

export class Blueprint {
    state: BlueprintState = empty()
    #timers: number[] = []
    #polling = false
    #peeking = false

    constructor(
        readonly watched: () => string[],
        readonly onPeek: (name: string, peeked: Peeked) => void = () => {},
        readonly onChange: (state: BlueprintState, why: string) => void = () => {},
    ) {}

    start() {
        if (this.#timers.length) {
            return
        }
        this.poll()
        this.#timers.push(setInterval(() => this.poll(), POLL_MS), setInterval(() => this.peek(), PEEK_MS))
    }

    stop() {
        this.#timers.forEach(clearInterval)
        this.#timers = []
        this.state = empty()
    }

    get active() {
        return this.#timers.length > 0
    }

    /** What runs, its streams and its M20Connection (on a new run). */
    async poll() {
        if (this.#polling) {
            return
        }
        this.#polling = true
        try {
            const active = await gateway("GET", "active") as {
                running: boolean
                blueprint: string | null
                runId: string | null
            }
            const newRun = active.runId !== this.state.runId || active.running !== this.state.running
            this.state.running = Boolean(active.running)
            this.state.blueprint = active.blueprint ?? null
            this.state.runId = active.runId ?? null
            this.state.error = null
            if (!active.running) {
                this.state.streams = []
                this.state.connection = null
                this.state.peeked = {}
            } else {
                const { streams } = await gateway("GET", "active/streams") as { streams: LiveStream[] }
                this.state.streams = streams.map(({ name, type, direction, module }) => ({
                    name,
                    type,
                    direction,
                    module,
                }))
                if (newRun || !this.state.connection) {
                    const { modules } = await gateway("GET", "active/modules") as {
                        modules: { id: string; class: string; rpcs?: { name: string }[] }[]
                    }
                    const found = modules.find((m) => /(^|\.)M20Connection$/.test(m.class))
                    this.state.connection = found
                        ? { id: found.id, rpcs: (found.rpcs ?? []).map((rpc) => rpc.name) }
                        : null
                }
            }
            if (newRun) {
                logLine(
                    `blueprint: ${active.running ? `${active.blueprint} running (${active.runId})` : "none running"}`,
                )
                this.onChange(this.state, active.running ? "blueprint_started" : "blueprint_stopped")
            }
        } catch (error) {
            const message = (error as Error).message
            if (this.state.error !== message) {
                logLine(`blueprint: ${message}`)
            }
            this.state.error = message
        } finally {
            this.state.checkedAt = Date.now()
            this.#polling = false
        }
    }

    /** The latest message of each watched stream that runs (all at once; a slow tick is skipped, not queued). */
    async peek() {
        if (this.#peeking || !this.state.running) {
            return
        }
        this.#peeking = true
        try {
            const live = new Set(this.state.streams.map((s) => s.name))
            const watched = new Set(this.watched())
            for (const name of Object.keys(this.state.peeked)) {
                if (!watched.has(name)) {
                    delete this.state.peeked[name] // unwatched: its last value would otherwise show (and stay ticked)
                }
            }
            const names = [...watched].filter((name) => live.has(name))
            await Promise.all(names.map(async (name) => {
                try {
                    const peeked = await gateway(
                        "GET",
                        `active/streams/${encodeURIComponent(name)}/peek?timeout=${PEEK_TIMEOUT_S}`,
                    ) as { type: string; value: unknown; ts: number | null }
                    const entry = { type: peeked.type, value: peeked.value, ts: peeked.ts ?? null, at: Date.now() }
                    this.state.peeked[name] = entry
                    this.onPeek(name, entry)
                } catch {
                    // nothing within the timeout (a 504) or the stream went away: keep the last value
                }
            }))
        } finally {
            this.#peeking = false
        }
    }

    /** Runs one of MOTIONS through the blueprint's M20Connection. Only ever from a request (a click, an agent). */
    async motion(action: string, dryRun = false) {
        const motion = MOTIONS[action]
        if (!motion) {
            throw new HttpError(400, `action must be one of: ${Object.keys(MOTIONS).join(", ")}`)
        }
        if (!this.state.running) {
            throw new HttpError(409, "no blueprint is running: launch one with M20Connection first")
        }
        const connection = this.state.connection
        if (!connection) {
            throw new HttpError(409, `the running blueprint (${this.state.blueprint}) has no M20Connection module`)
        }
        if (!connection.rpcs.includes(motion.rpc)) {
            throw new HttpError(
                409,
                `${connection.id} has no ${motion.rpc} RPC (its RPCs: ${connection.rpcs.join(", ") || "none"})` +
                    (action === "dock" ? ": docking needs a dimos with the M20 self-charging skill" : ""),
            )
        }
        const path = `active/modules/${encodeURIComponent(connection.id)}/rpcs/${motion.rpc}`
        if (dryRun) {
            return { dryRun: true, wouldCall: `POST ${path}`, module: connection.id, rpc: motion.rpc }
        }
        const result = await gateway("POST", path, { args: [], kwargs: {} }) as {
            ok: boolean
            result: unknown
            error: string | null
        }
        return { ok: result.ok, rpc: motion.rpc, module: connection.id, result: result.result, error: result.error }
    }
}
