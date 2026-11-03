// A small MCAP writer (mcap.dev/spec): JSON messages on JSON-schema channels, unchunked, so every record is on disk
// within a second of arriving (flush). A clean close adds a summary (schemas, channels, statistics). A file a crash
// or a kill left without its footer is finished by recoverMcap on the next start: cut at the last whole record, then
// the data end, footer and magic. Readers (Foxglove, the mcap libraries) read either kind.

export const MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a])
const OP = { header: 0x01, footer: 0x02, schema: 0x03, channel: 0x04, message: 0x05, statistics: 0x0b, dataEnd: 0x0f }
const FLUSH_MS = 1000

const encoder = new TextEncoder()

/** Little-endian record content, appended field by field. */
class Bytes {
    parts: Uint8Array[] = []
    length = 0
    push(part: Uint8Array) {
        this.parts.push(part)
        this.length += part.length
        return this
    }
    #number(size: number, set: (view: DataView) => void) {
        const part = new Uint8Array(size)
        set(new DataView(part.buffer))
        return this.push(part)
    }
    u16 = (n: number) => this.#number(2, (v) => v.setUint16(0, n, true))
    u32 = (n: number) => this.#number(4, (v) => v.setUint32(0, n, true))
    u64 = (n: bigint) => this.#number(8, (v) => v.setBigUint64(0, n, true))
    string(text: string) {
        const bytes = encoder.encode(text)
        return this.u32(bytes.length).push(bytes)
    }
    map(entries: [string, string][]) {
        const inner = new Bytes()
        entries.forEach(([k, v]) => inner.string(k).string(v))
        return this.u32(inner.length).push(inner.join())
    }
    join() {
        const out = new Uint8Array(this.length)
        let at = 0
        for (const part of this.parts) {
            out.set(part, at)
            at += part.length
        }
        return out
    }
}

function record(op: number, content: Bytes): Uint8Array {
    return new Bytes().push(new Uint8Array([op])).u64(BigInt(content.length)).push(content.join()).join()
}

function footer(summaryStart: bigint): Uint8Array[] {
    return [
        record(OP.dataEnd, new Bytes().u32(0)),
        record(OP.footer, new Bytes().u64(summaryStart).u64(0n).u32(0)),
        MAGIC,
    ]
}

export type Channel = { id: number; topic: string; schemaId: number }

export class McapWriter {
    #file: Deno.FsFile
    #pending: Uint8Array[] = []
    #flushTimer: ReturnType<typeof setInterval>
    #schemas = new Map<string, { id: number; record: Uint8Array }>()
    #channels = new Map<string, Channel & { record: Uint8Array }>()
    #counts = new Map<number, number>()
    #sequence = 0
    #firstNs = 0n
    #lastNs = 0n
    bytes = 0
    messages = 0
    closed = false

    constructor(readonly path: string) {
        this.#file = Deno.openSync(path, { write: true, createNew: true })
        this.#append(MAGIC)
        this.#append(record(OP.header, new Bytes().string("").string("dim-m20-dash")))
        this.flush()
        this.#flushTimer = setInterval(() => this.flush(), FLUSH_MS)
    }

    #append(bytes: Uint8Array) {
        this.#pending.push(bytes)
        this.bytes += bytes.length
    }

    /** A topic's channel, made on first use: `schemaName` with a JSON schema (`{type: "object"}` when free-form). */
    channel(topic: string, schemaName: string, schema: unknown = { type: "object" }): Channel {
        const known = this.#channels.get(topic)
        if (known) {
            return known
        }
        let found = this.#schemas.get(schemaName)
        if (!found) {
            const id = this.#schemas.size + 1
            const data = encoder.encode(JSON.stringify(schema))
            const content = new Bytes().u16(id).string(schemaName).string("jsonschema").u32(data.length).push(data)
            found = { id, record: record(OP.schema, content) }
            this.#schemas.set(schemaName, found)
            this.#append(found.record)
        }
        const id = this.#channels.size + 1
        const content = new Bytes().u16(id).u16(found.id).string(topic).string("json").map([])
        const channel = { id, topic, schemaId: found.id, record: record(OP.channel, content) }
        this.#channels.set(topic, channel)
        this.#append(channel.record)
        return channel
    }

    /** One message; `timeNs` is when it happened (log and publish time). */
    write(channel: Channel, timeNs: bigint, message: unknown) {
        if (this.closed) {
            return
        }
        const data = encoder.encode(JSON.stringify(message))
        const content = new Bytes().u16(channel.id).u32(this.#sequence++).u64(timeNs).u64(timeNs).push(data)
        this.#append(record(OP.message, content))
        this.messages++
        this.#counts.set(channel.id, (this.#counts.get(channel.id) ?? 0) + 1)
        this.#firstNs = this.#firstNs === 0n || timeNs < this.#firstNs ? timeNs : this.#firstNs
        this.#lastNs = timeNs > this.#lastNs ? timeNs : this.#lastNs
    }

    flush() {
        if (!this.#pending.length) {
            return
        }
        const out = new Bytes()
        this.#pending.forEach((part) => out.push(part))
        this.#pending = []
        try {
            const bytes = out.join()
            let at = 0
            while (at < bytes.length) {
                at += this.#file.writeSync(bytes.subarray(at))
            }
        } catch (error) {
            console.error(`m20_dash: recording write failed: ${(error as Error).message}`)
        }
    }

    /** Finishes the file: data end, a summary (schemas, channels, statistics), footer, magic. */
    close() {
        if (this.closed) {
            return
        }
        this.closed = true
        clearInterval(this.#flushTimer)
        const dataEnd = record(OP.dataEnd, new Bytes().u32(0))
        this.#append(dataEnd)
        const summaryStart = BigInt(this.bytes)
        for (const schema of this.#schemas.values()) {
            this.#append(schema.record)
        }
        for (const channel of this.#channels.values()) {
            this.#append(channel.record)
        }
        const counts = new Bytes()
        for (const [id, count] of this.#counts) {
            counts.u16(id).u64(BigInt(count))
        }
        const statistics = new Bytes().u64(BigInt(this.messages)).u16(this.#schemas.size).u32(this.#channels.size)
            .u32(0).u32(0).u32(0).u64(this.#firstNs).u64(this.#lastNs).u32(counts.length).push(counts.join())
        this.#append(record(OP.statistics, statistics))
        this.#append(record(OP.footer, new Bytes().u64(summaryStart).u64(0n).u32(0)))
        this.#append(MAGIC)
        this.flush()
        this.#file.close()
    }
}

/** Whether `path` ends in the MCAP magic (a finished file). */
export function isFinished(path: string): boolean {
    const file = Deno.openSync(path, { read: true })
    try {
        const size = file.statSync().size
        if (size < 16) {
            return false
        }
        const tail = new Uint8Array(8)
        file.seekSync(size - 8, Deno.SeekMode.Start)
        file.readSync(tail)
        return tail.every((b, i) => b === MAGIC[i])
    } finally {
        file.close()
    }
}

/** Finishes a file a crash left open: keeps every whole record, then data end + footer + magic. Returns the records
 * kept, or null when it wasn't an MCAP at all (left alone). */
export function recoverMcap(path: string): number | null {
    const file = Deno.openSync(path, { read: true, write: true })
    try {
        const size = file.statSync().size
        const head = new Uint8Array(8)
        if (size < 8 || file.readSync(head) !== 8 || !head.every((b, i) => b === MAGIC[i])) {
            return null
        }
        let at = 8
        let records = 0
        const header = new Uint8Array(9)
        while (at + 9 <= size) {
            file.seekSync(at, Deno.SeekMode.Start)
            if (file.readSync(header) !== 9) {
                break
            }
            const length = Number(new DataView(header.buffer).getBigUint64(1, true))
            if (header[0] === OP.dataEnd || header[0] === OP.footer || at + 9 + length > size) {
                break
            }
            at += 9 + length
            records++
        }
        file.truncateSync(at)
        file.seekSync(at, Deno.SeekMode.Start)
        for (const part of footer(0n)) {
            file.writeSync(part)
        }
        return records
    } finally {
        file.close()
    }
}

/** Reads a finished or recovered file back: [topic, message][] in order (the tests, and a quick look). */
export function readMcap(bytes: Uint8Array): { topic: string; logTimeNs: bigint; message: unknown }[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const decoder = new TextDecoder()
    const topics = new Map<number, string>()
    const out: { topic: string; logTimeNs: bigint; message: unknown }[] = []
    let at = 8
    while (at + 9 <= bytes.length) {
        const op = bytes[at]
        const length = Number(view.getBigUint64(at + 1, true))
        const start = at + 9
        if (op === OP.channel) {
            const id = view.getUint16(start, true)
            const topicLength = view.getUint32(start + 4, true)
            topics.set(id, decoder.decode(bytes.subarray(start + 8, start + 8 + topicLength)))
        } else if (op === OP.message) {
            const id = view.getUint16(start, true)
            out.push({
                topic: topics.get(id) ?? "?",
                logTimeNs: view.getBigUint64(start + 6, true),
                message: JSON.parse(decoder.decode(bytes.subarray(start + 22, start + length))),
            })
        } else if (op === OP.dataEnd) {
            break
        }
        at = start + length
    }
    return out
}
