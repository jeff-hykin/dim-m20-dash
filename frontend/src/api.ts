// The app's own API (backend/routes.ts): every action the page takes is one of its endpoints, which Desktop's agent can
// call too. JSON in, JSON out; an error is thrown with the message the backend gave.

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(json.error ?? `HTTP ${response.status}`)
    }
    return json as T
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type Level = "ok" | "warn" | "bad" | "off" | "unknown"
export type Indicator = { level: Level; text: string }

export type Sample = {
    t: number
    cpu: { total: number | null; cores: (number | null)[] }
    load: number[] | null
    uptimeS: number | null
    mem: { totalMb: number; usedMb: number; percent: number } | null
    temps: { name: string; celsius: number }[]
}

export type Board = {
    name: string
    label: string
    role: string | null
    hosts: string[]
    link: { state: string; host: string | null; error: string | null }
    reachable: boolean | null
    indicators: Record<"network" | "stats" | "lidar" | "dimos", Indicator>
    stale: boolean
    latest: Sample | null
    history?: { t: number; total: number | null; cores: (number | null)[] }[]
}

export type LiveStream = {
    name: string
    type: string
    direction: string | null
    module: string
    channel: string | null
}

export type Blueprint = {
    running: boolean
    blueprint: string | null
    runId: string | null
    error: string | null
    streams: LiveStream[]
    connection: { id: string; rpcs: string[] } | null
    peeked: Record<string, { type: string; value: unknown; ts: number | null; at: number }>
}

export type StreamCounts = { written: number; received: number; skipped: number; dropped: number }

/** how long the recordings' disk lasts (backend/record_space.ts) */
export type RecordSpace = {
    freeBytes: number | null
    /** a recording stops itself when the disk is down to this */
    reserveBytes: number
    bytesPerSecond: number | null
    /** measured: this recording's own rate (smoothed); last_recording / options: an estimate for the next one */
    rateSource: "measured" | "last_recording" | "options" | null
    estimate: boolean
    /** seconds until a recording would stop itself (null: unknown) */
    secondsLeft: number | null
    /** under 5 minutes */
    low: boolean
}

export type RecordState =
    | { active: false; space?: RecordSpace }
    | {
        active: true
        space?: RecordSpace
        file: string
        files: string[]
        startedAt: number
        seconds: number
        bytes: number
        partBytes: number
        messages: number
        dropped: number
        /** the recording disk's free space (null until checked); a recording stops itself under 1 GB */
        freeBytes: number | null
        streams: Record<string, StreamCounts>
        tap: { state: "off" | "starting" | "running" | "exited" | "unavailable"; error: string | null }
    }

export type StreamChoice = { on: boolean; maxHz: number | null }
export type RecordOptions = {
    streams: Record<string, StreamChoice>
    label: string
    folder: string
    splitMinutes: number | null
    splitMb: number | null
}
export type RecordGroup = { id: string; label: string; about: string; keys: string[]; fullRate: string }
export type RecordingFile = { file: string; bytes: number; modified: string | null; recording: boolean }

export type Battery = { level: number; voltage: number; celsius: number; charging: boolean; present: boolean }
/** the M20's own status (backend/robot.ts: basic_server's reports, heartbeats only) */
export type Robot = {
    link: "connecting" | "up" | "down" | "off" | "error"
    host: string
    source: "udp" | "fake"
    error: string | null
    reportAt: number | null
    basic: {
        motion: number
        motionName: string
        gait: number
        gaitName: string
        charge: number
        chargeName: string
        hardEstop: boolean
        usage: string
        usageMode: number
        sleep: string
        singleBattery: boolean
        version: string | null
    } | null
    motion: {
        roll: number
        pitch: number
        yaw: number
        height: number
        vx: number
        vy: number
        wz: number
        remainKm: number
    } | null
    battery: { left: Battery; right: Battery } | null
    joints: { joint: string; motor: number | null; driver: number | null }[]
    hottestMotor: { joint: string; celsius: number } | null
    hottestDriver: { joint: string; celsius: number } | null
    errors: { code: number; hex: string; name: string; component: number; parts: string[] }[]
}

export type AppState = {
    mode: "blueprint" | "direct"
    source: "ssh" | "fake"
    boards: Board[]
    blueprint: Blueprint | null
    directMotion: string | null
    /** whether the current mode's driving would move the robot, why not, and whether Enable driving fixes it */
    driving: { ok: boolean; reason: string | null; fixable: boolean; known: boolean }
    direct: { moving: boolean; axes: number[]; busy: string | null }
    record: RecordState
    robot: Robot
    now: number
}

export type Settings = {
    boards: { name: string; label: string; hosts: string[]; role?: string }[]
    source: "ssh" | "fake"
    mode: "blueprint" | "direct"
    blueprintStreams: string[]
}
