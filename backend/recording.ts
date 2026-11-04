// The Record button's writer: one .mcap per recording in Desktop's recordings folder under m20/
// (<local date>_<time>_m20_<host>.mcap), JSON messages on these topics:
//   /boards/<board>/stats   each board's sample, 1 Hz: CPU (total + per core), load, memory, temperatures, lidar and
//                           dimos processes (with their CPU use), uptime
//   /boards/<board>/link    the board's network reachability and ssh link, on every change
//   /blueprint/<stream>     blueprint mode: each watched stream of the running blueprint, sampled (one peek a second)
//   /robot_action           every motion request (standup, liedown, stop) and what the blueprint answered
//   /logs                   everything else as typed JSON: recording start/stop, mode changes, blueprint start/stop
//   /robot/{basic,motion,devices,errors}  basic_server's status reports, as they come
// and the live topics the Record options pick, raw as they are on zenoh (dimos' mcap layout: one channel per stream
// named like it, "lcm" as the encoding, dimos.* metadata), through zenoh_tap.py (tap.ts), each with its own rate cap.
// The options (record_streams.ts) also pick the JSON groups, a label for the file name, a folder inside m20/, and
// splitting into …_part2.mcap after so many minutes or megabytes.
// Started only by a person or an agent (api/record/start); never on its own. It runs until api/record/stop or the app
// quits; a file a quit or crash left unfinished is finished on the next start (recoverRecordings).
import { logLine } from "./applog.ts"
import { recordingsDir } from "./dimos_app.ts"
import { type Channel, isFinished, McapWriter, recoverMcap } from "./mcap.ts"
import {
    DEFAULT_RECORD_OPTIONS,
    groupOfTopic,
    GROUPS,
    payloadType,
    type RecordOptions,
    streamName,
} from "./record_streams.ts"
import { Tap } from "./tap.ts"

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
    /** the current part's name, relative to m20/ (folder/…mcap) */
    file: string
    /** every part so far, relative to m20/ */
    files: string[]
    dir: string
    base: string
    startedAt: number
    partStartedAt: number
    /** what the finished parts held */
    doneBytes: number
    doneMessages: number
    channels: Map<string, Channel>
    options: RecordOptions
    /** per group: messages written */
    written: Record<string, number>
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
    const group = groupOfTopic(topic)
    if (group && !active.options.streams[group].on) {
        return
    }
    if (group) {
        active.written[group] = (active.written[group] ?? 0) + 1
    }
    splitIfDue()
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

/** the group each live key belongs to */
const GROUP_OF_KEY = new Map(GROUPS.flatMap((g) => g.keys.map((key) => [key, g.id] as const)))

/** The tap's samples: raw, on the stream's own channel. */
const tap = new Tap((key, timeNs, payload) => {
    if (!active) {
        return
    }
    splitIfDue()
    const topic = streamName(key)
    let channel = active.channels.get(topic)
    if (!channel) {
        channel = active.writer.rawChannel(topic, "lcm", {
            "dimos.payload_type": payloadType(key),
            "dimos.stream_name": topic,
            "dimos.zenoh_key": key,
            "dimos.observation_time": "receive_time",
        })
        active.channels.set(topic, channel)
    }
    active.writer.writeBytes(channel, timeNs, payload)
    const group = GROUP_OF_KEY.get(key)
    if (group) {
        active.written[group] = (active.written[group] ?? 0) + 1
    }
})

/** a recording stops itself when its disk gets down to this (bytes free) */
const MIN_FREE_BYTES = 1e9
const DISK_CHECK_MS = 5000
let freeBytes: number | null = null

/** Free space on `dir`'s disk (df -Pk), or null when df can't say. */
async function diskFree(dir: string): Promise<number | null> {
    try {
        const { stdout, success } = await new Deno.Command("df", {
            args: ["-Pk", dir],
            stdout: "piped",
            stderr: "null",
        }).output()
        const fields = new TextDecoder().decode(stdout).trim().split("\n").pop()?.split(/\s+/) ?? []
        return success && fields[3] ? Number(fields[3]) * 1024 : null
    } catch {
        return null
    }
}

/** While recording: the disk's free space, and a stop before the recording fills it. */
function watchDisk(started: Active) {
    const check = async () => {
        if (active !== started) {
            return
        }
        freeBytes = await diskFree(started.dir)
        if (active === started && freeBytes !== null && freeBytes < MIN_FREE_BYTES) {
            logLine(`recording: stopped, the disk is down to ${(freeBytes / 1e9).toFixed(2)} GB free`)
            recordLog({ type: "recording_disk_full", freeBytes })
            stopRecording()
            return
        }
        setTimeout(check, DISK_CHECK_MS)
    }
    check()
}

/** A new part once the current one is past the options' minutes or megabytes. */
function splitIfDue() {
    const current = active
    if (!current) {
        return
    }
    const { splitMinutes, splitMb } = current.options
    const overTime = splitMinutes !== null && Date.now() - current.partStartedAt >= splitMinutes * 60_000
    const overSize = splitMb !== null && current.writer.bytes >= splitMb * 1e6
    if (!overTime && !overSize) {
        return
    }
    current.doneBytes += current.writer.bytes
    current.doneMessages += current.writer.messages
    current.writer.close()
    logLine(`recording: ${current.file} reached its ${overSize ? `${splitMb} MB` : `${splitMinutes} min`}: next part`)
    const part = current.files.length + 1
    const name = current.base.replace(/\.mcap$/, `_part${part}.mcap`)
    current.writer = new McapWriter(`${current.dir}/${name}`)
    current.file = (current.options.folder ? `${current.options.folder}/` : "") + name
    current.files.push(current.file)
    current.partStartedAt = Date.now()
    current.channels = new Map()
    recordLog({ type: "recording_part", part, file: current.file })
}

function exists(path: string) {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

function fileName(label: string, now = new Date()) {
    const two = (n: number) => String(n).padStart(2, "0")
    const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
    const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
    const host = (Deno.hostname?.() ?? "host").replace(/[^\w.-]+/g, "-")
    return `${date}_${time}_m20_${host}${label ? `_${label}` : ""}.mcap`
}

export function recordingStatus() {
    if (!active) {
        return { active: false }
    }
    const streams: Record<string, { written: number; received: number; skipped: number; dropped: number }> = {}
    for (const group of GROUPS) {
        if (!active.options.streams[group.id].on) {
            continue
        }
        const counts = group.keys.map((key) => tap.counts[key]).filter(Boolean)
        streams[group.id] = {
            written: active.written[group.id] ?? 0,
            received: counts.reduce((sum, c) => sum + c.received, 0),
            skipped: counts.reduce((sum, c) => sum + c.skipped, 0),
            dropped: counts.reduce((sum, c) => sum + c.dropped, 0),
        }
    }
    return {
        active: true,
        file: active.file,
        files: active.files,
        path: active.writer.path,
        startedAt: active.startedAt,
        seconds: Math.round((Date.now() - active.startedAt) / 1000),
        bytes: active.doneBytes + active.writer.bytes,
        partBytes: active.writer.bytes,
        messages: active.doneMessages + active.writer.messages,
        dropped: Object.values(streams).reduce((sum, s) => sum + s.dropped, 0),
        freeBytes,
        topics: [...active.channels.keys()].sort(),
        streams,
        tap: tap.state,
        options: active.options,
    }
}

/** Starts a recording; a running one is left as it is. `context` goes on /logs first (mode, boards, blueprint). */
export function startRecording(root = recordingsDir(), context: Json = {}, options = DEFAULT_RECORD_OPTIONS) {
    if (active) {
        return recordingStatus()
    }
    const dir = options.folder ? `${root}/${options.folder}` : root
    Deno.mkdirSync(dir, { recursive: true })
    // two in the same second (stop, Record again): the second gets _2
    const first = fileName(options.label)
    let base = first
    for (let n = 2; exists(`${dir}/${base}`); n++) {
        base = first.replace(/\.mcap$/, `_${n}.mcap`)
    }
    const writer = new McapWriter(`${dir}/${base}`)
    const file = (options.folder ? `${options.folder}/` : "") + base
    const now = Date.now()
    active = {
        writer,
        file,
        files: [file],
        dir,
        base,
        startedAt: now,
        partStartedAt: now,
        doneBytes: 0,
        doneMessages: 0,
        channels: new Map(),
        options,
        written: {},
    }
    logLine(`recording started: ${writer.path}`)
    freeBytes = null
    watchDisk(active)
    recordLog({ type: "recording_started", file, options, ...context })
    tap.start(
        GROUPS.filter((g) => options.streams[g.id].on).flatMap((g) =>
            g.keys.map((key) => ({ key, maxHz: options.streams[g.id].maxHz }))
        ),
    )
    if (tap.state.state === "unavailable") {
        logLine(`recording: no live topics: ${tap.state.error}`)
        recordLog({ type: "live_topics_unavailable", why: tap.state.error })
    }
    return recordingStatus()
}

export function stopRecording() {
    const ending = active
    if (!ending) {
        return { active: false, stopped: false }
    }
    recordLog({ type: "recording_stopped", streams: recordingStatus().streams })
    tap.stop()
    active = null
    ending.writer.close()
    logLine(
        `recording stopped: ${ending.writer.path} (${ending.writer.messages} messages, ${ending.writer.bytes} bytes)`,
    )
    return {
        active: false,
        stopped: true,
        file: ending.file,
        files: ending.files,
        path: ending.writer.path,
        bytes: ending.doneBytes + ending.writer.bytes,
        messages: ending.doneMessages + ending.writer.messages,
    }
}

/** This app's recordings, newest first. */
export function listRecordings(dir = recordingsDir()) {
    const files: { file: string; bytes: number; modified: string | null; recording: boolean }[] = []
    // m20/ and the folders inside it (the Record options' folder), one level deep
    const scan = (folder: string) => {
        try {
            for (const entry of Deno.readDirSync(folder ? `${dir}/${folder}` : dir)) {
                const name = folder ? `${folder}/${entry.name}` : entry.name
                if (entry.isDirectory && !folder) {
                    scan(entry.name)
                } else if (entry.isFile && entry.name.endsWith(".mcap")) {
                    const info = Deno.statSync(`${dir}/${name}`)
                    files.push({
                        file: name,
                        bytes: info.size,
                        modified: info.mtime?.toISOString() ?? null,
                        recording: active?.file === name,
                    })
                }
            }
        } catch {
            // no folder yet
        }
    }
    scan("")
    const newest = (f: { file: string; modified: string | null }) => f.modified ?? ""
    return { directory: dir, recordings: files.sort((a, b) => newest(b).localeCompare(newest(a))) }
}

/** One recording's file, for download (only a name listRecordings gives: nothing outside m20/). */
export async function recordingFile(file: string, dir = recordingsDir()): Promise<Response> {
    if (!listRecordings(dir).recordings.some((r) => r.file === file)) {
        return Response.json({ error: `no recording named ${file}` }, { status: 404 })
    }
    const handle = await Deno.open(`${dir}/${file}`, { read: true })
    const size = (await handle.stat()).size
    return new Response(handle.readable, {
        headers: {
            "content-type": "application/octet-stream",
            "content-length": String(size),
            "content-disposition": `attachment; filename="${file.split("/").pop()}"`,
        },
    })
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
