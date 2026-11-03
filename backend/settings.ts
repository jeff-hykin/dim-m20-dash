// The app's settings, kept in <data dir>/settings.json: the boards (and how to reach them), where their stats come
// from (ssh or the fake boards), blueprint or direct mode, the process patterns, and which blueprint streams to watch.
// M20_DASH_SOURCE=fake starts on the fake boards whatever the file says (demos, tests, no dog).
import { type BoardConfig, DEFAULT_BOARDS, type SourceKind } from "./boards.ts"
import { dataDir } from "./dimos_app.ts"
import { HttpError } from "./http.ts"
import { DEFAULT_PATTERNS, type Patterns } from "./stats.ts"

export type Mode = "blueprint" | "direct"

export type Settings = {
    boards: BoardConfig[]
    source: SourceKind
    mode: Mode
    patterns: Patterns
    /** the running blueprint's streams sampled (and recorded) in blueprint mode */
    blueprintStreams: string[]
}

export const DEFAULT_SETTINGS: Settings = {
    boards: DEFAULT_BOARDS,
    source: "ssh",
    mode: "blueprint",
    patterns: DEFAULT_PATTERNS,
    // M20Connection's small streams: its pose, the robot's motion/gait state, readiness, the velocity it sends
    blueprintStreams: ["odom", "motion_state", "gait_state", "command_ready", "cmd_vel"],
}

let current: Settings = structuredClone(DEFAULT_SETTINGS)
let file: string | null = null

export function settings(): Settings {
    return current
}

/** Reads the saved settings (main.ts); a missing or broken file leaves the defaults. */
export function loadSettings(path = `${dataDir()}/settings.json`): Settings {
    file = path
    try {
        current = validate({ ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(Deno.readTextFileSync(path)) })
    } catch {
        current = structuredClone(DEFAULT_SETTINGS)
    }
    current = withForcedSource(current)
    return current
}

/** M20_DASH_SOURCE's source, if set (so Defaults under `deno task fake` stays on the fake boards, not ssh) */
function withForcedSource(next: Settings): Settings {
    const forced = Deno.env.get("M20_DASH_SOURCE")
    if (forced === "fake" || forced === "ssh") {
        next.source = forced
    }
    return next
}

function validate(next: Settings): Settings {
    if (!Array.isArray(next.boards) || !next.boards.length) {
        throw new HttpError(400, "boards must be a non-empty list")
    }
    const names = new Set<string>()
    for (const board of next.boards) {
        if (!board || typeof board.name !== "string" || !/^[\w-]{1,32}$/.test(board.name)) {
            throw new HttpError(400, "each board needs a name (letters, digits, - or _)")
        }
        if (names.has(board.name)) {
            throw new HttpError(400, `two boards are named ${board.name}`)
        }
        names.add(board.name)
        if (
            !Array.isArray(board.hosts) || !board.hosts.length || board.hosts.some((h) => typeof h !== "string" || !h)
        ) {
            throw new HttpError(400, `board ${board.name} needs hosts: a list of ssh targets`)
        }
        board.label = typeof board.label === "string" && board.label ? board.label : board.name
    }
    if (next.source !== "ssh" && next.source !== "fake") {
        throw new HttpError(400, "source must be ssh or fake")
    }
    if (next.mode !== "blueprint" && next.mode !== "direct") {
        throw new HttpError(400, "mode must be blueprint or direct")
    }
    for (const key of ["lidar", "dimos"] as const) {
        try {
            new RegExp(next.patterns?.[key])
        } catch {
            throw new HttpError(400, `patterns.${key} isn't a regular expression`)
        }
    }
    if (!Array.isArray(next.patterns.lidarPorts) || next.patterns.lidarPorts.some((p) => !Number.isInteger(p))) {
        throw new HttpError(400, "patterns.lidarPorts must be a list of port numbers")
    }
    if (!Array.isArray(next.blueprintStreams) || next.blueprintStreams.some((s) => typeof s !== "string")) {
        throw new HttpError(400, "blueprintStreams must be a list of stream names")
    }
    return next
}

/** Applies a change (any subset; reset: true starts from the defaults), saves it and returns the new settings. */
export function updateSettings(change: Partial<Settings> & { reset?: boolean }): Settings {
    const { reset, ...rest } = change
    const base = reset ? withForcedSource(structuredClone(DEFAULT_SETTINGS)) : structuredClone(current)
    const merged = { ...base, ...rest, patterns: { ...base.patterns, ...(rest.patterns ?? {}) } }
    current = validate(merged)
    if (file) {
        try {
            Deno.mkdirSync(file.replace(/\/[^/]*$/, ""), { recursive: true })
            Deno.writeTextFileSync(file, JSON.stringify(current, null, 4) + "\n")
        } catch (error) {
            console.error(`m20_dash: couldn't save settings: ${(error as Error).message}`)
        }
    }
    return current
}
