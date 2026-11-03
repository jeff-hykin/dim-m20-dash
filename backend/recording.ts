// The Record button's writer: one .mcap per recording in Desktop's recordings folder under m20/
// (<local date>_<time>_m20_<host>.mcap), JSON messages on these topics:
//   /boards/<board>/stats   each board's sample, 1 Hz: CPU (total + per core), load, memory, temperatures, lidar and
//                           dimos processes (with their CPU use), uptime
//   /boards/<board>/link    the board's network reachability and ssh link, on every change
//   /blueprint/<stream>     blueprint mode: each watched stream of the running blueprint, sampled (one peek a second)
//   /robot_action           every motion request (standup, liedown, stop) and what the blueprint answered
//   /logs                   everything else as typed JSON: recording start/stop, mode changes, blueprint start/stop
// Started only by a person or an agent (api/record/start); never on its own. It runs until api/record/stop or the app
// quits; a file a quit or crash left unfinished is finished on the next start (recoverRecordings).
import { logLine } from "./applog.ts"
import { recordingsDir } from "./dimos_app.ts"
import { type Channel, isFinished, McapWriter, recoverMcap } from "./mcap.ts"

// deno-lint-ignore no-explicit-any -- recorded messages are free-form JSON
type Json = Record<string, any>

/** a topic's schema name, by the start of its topic */
function schemaName(topic: string): string {
    if (/^\/boards\/[^/]+\/stats$/.test(topic)) {
        return "m20.BoardStats"
    }
    if (/^\/boards\/[^/]+\/link$/.test(topic)) {
        return "m20.BoardLink"
    }
    if (topic.startsWith("/blueprint/")) {
        return "m20.BlueprintSample"
    }
    return { "/robot_action": "m20.Action", "/logs": "m20.Log" }[topic] ?? "m20.Unknown"
}

type Active = {
    writer: McapWriter
    file: string
    startedAt: number
    channels: Map<string, Channel>
}

let active: Active | null = null

export function recording(): boolean {
    return active !== null
}

/** Writes `message` on `topic` when a recording runs (otherwise nothing). `atMs`: when it happened. */
export function record(topic: string, message: unknown, atMs = Date.now()) {
    if (!active) {
        return
    }
    let channel = active.channels.get(topic)
    if (!channel) {
        channel = active.writer.channel(topic, schemaName(topic), { type: "object" })
        active.channels.set(topic, channel)
    }
    active.writer.write(channel, BigInt(Math.round(atMs * 1e6)), message)
}

/** A typed event on /logs (it also needs to be in the app log: callers do that, in their own words). */
export function recordLog(event: Json) {
    record("/logs", { t: Date.now(), ...event })
}

function exists(path: string) {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

function fileName(now = new Date()) {
    const two = (n: number) => String(n).padStart(2, "0")
    const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
    const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
    const host = (Deno.hostname?.() ?? "host").replace(/[^\w.-]+/g, "-")
    return `${date}_${time}_m20_${host}.mcap`
}

export function recordingStatus() {
    if (!active) {
        return { active: false }
    }
    return {
        active: true,
        file: active.file,
        path: active.writer.path,
        startedAt: active.startedAt,
        seconds: Math.round((Date.now() - active.startedAt) / 1000),
        bytes: active.writer.bytes,
        messages: active.writer.messages,
        topics: [...active.channels.keys()].sort(),
    }
}

/** Starts a recording; a running one is left as it is. `context` goes on /logs first (mode, boards, blueprint). */
export function startRecording(dir = recordingsDir(), context: Json = {}) {
    if (active) {
        return recordingStatus()
    }
    Deno.mkdirSync(dir, { recursive: true })
    // two in the same second (stop, Record again): the second gets _2
    const base = fileName()
    let file = base
    for (let n = 2; exists(`${dir}/${file}`); n++) {
        file = base.replace(/\.mcap$/, `_${n}.mcap`)
    }
    const writer = new McapWriter(`${dir}/${file}`)
    active = { writer, file, startedAt: Date.now(), channels: new Map() }
    logLine(`recording started: ${writer.path}`)
    recordLog({ type: "recording_started", file, ...context })
    return recordingStatus()
}

export function stopRecording() {
    const ending = active
    if (!ending) {
        return { active: false, stopped: false }
    }
    recordLog({ type: "recording_stopped" })
    active = null
    ending.writer.close()
    logLine(
        `recording stopped: ${ending.writer.path} (${ending.writer.messages} messages, ${ending.writer.bytes} bytes)`,
    )
    return {
        active: false,
        stopped: true,
        file: ending.file,
        path: ending.writer.path,
        bytes: ending.writer.bytes,
        messages: ending.writer.messages,
    }
}

/** This app's recordings, newest first. */
export function listRecordings(dir = recordingsDir()) {
    const files: { file: string; bytes: number; modified: string | null; recording: boolean }[] = []
    try {
        for (const entry of Deno.readDirSync(dir)) {
            if (!entry.isFile || !entry.name.endsWith(".mcap")) {
                continue
            }
            const info = Deno.statSync(`${dir}/${entry.name}`)
            files.push({
                file: entry.name,
                bytes: info.size,
                modified: info.mtime?.toISOString() ?? null,
                recording: active?.file === entry.name,
            })
        }
    } catch {
        // no folder yet
    }
    return { directory: dir, recordings: files.sort((a, b) => b.file.localeCompare(a.file)) }
}

/** At start: finish every recording a quit or crash left without its footer, so each one opens. */
export function recoverRecordings(dir = recordingsDir()): string[] {
    const finished: string[] = []
    for (const { file } of listRecordings(dir).recordings) {
        const path = `${dir}/${file}`
        try {
            if (isFinished(path)) {
                continue
            }
            const records = recoverMcap(path)
            if (records !== null) {
                finished.push(file)
                logLine(
                    `recording ${file} was left unfinished (a quit or crash): finished it (${records} records kept)`,
                )
            }
        } catch (error) {
            logLine(`recording ${file}: couldn't finish it: ${(error as Error).message}`)
        }
    }
    return finished
}
