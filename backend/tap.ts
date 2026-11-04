// Runs zenoh_tap.py (with DIMOS_APP's dimosPython, connected to DIMOS_APP's zenohConnect) for a recording and parses
// what it prints: every sample (key, receive time, raw payload) and once a second its per-topic counts. Only while a
// recording runs that asked for live topics; stopping closes its stdin and it exits.
import { dimosApp } from "./dimos_app.ts"

export type TapCounts = Record<string, { received: number; skipped: number; dropped: number }>

export type TapState = { state: "off" | "starting" | "running" | "exited" | "unavailable"; error: string | null }

const TAP_SCRIPT = new URL("./zenoh_tap.py", import.meta.url).pathname

/** The python and zenoh endpoint the tap needs, or why it can't run (outside Desktop, an old Desktop). */
export function tapNeeds(): { python: string; connect: string } | { missing: string } {
    const app = dimosApp() as Record<string, unknown>
    const python = Deno.env.get("M20_DASH_PYTHON") ?? (typeof app.dimosPython === "string" ? app.dimosPython : null)
    const connect = Deno.env.get("M20_DASH_ZENOH_CONNECT") ??
        (typeof app.zenohConnect === "string" ? app.zenohConnect : null)
    if (!python) {
        return {
            missing: "no dimos python (DIMOS_APP.dimosPython): run M20 Ctrl under DimOS Desktop with dimos installed",
        }
    }
    if (!connect) {
        return { missing: "no zenoh endpoint (DIMOS_APP.zenohConnect): this Desktop doesn't give apps one" }
    }
    return { python, connect }
}

export class Tap {
    state: TapState = { state: "off", error: null }
    counts: TapCounts = {}
    #process: Deno.ChildProcess | null = null
    #stderr = ""

    constructor(
        readonly onSample: (key: string, timeNs: bigint, payload: Uint8Array) => void,
        readonly command: (topics: { key: string; maxHz: number | null }[]) => { python: string; args: string[] } | {
            missing: string
        } = (topics) => {
            const needs = tapNeeds()
            if ("missing" in needs) {
                return needs
            }
            return { python: needs.python, args: [TAP_SCRIPT, JSON.stringify({ connect: needs.connect, topics })] }
        },
    ) {}

    start(topics: { key: string; maxHz: number | null }[]) {
        this.stop()
        this.counts = {}
        if (!topics.length) {
            return
        }
        const command = this.command(topics)
        if ("missing" in command) {
            this.state = { state: "unavailable", error: command.missing }
            return
        }
        this.state = { state: "starting", error: null }
        this.#stderr = ""
        let process: Deno.ChildProcess
        try {
            process = new Deno.Command(command.python, {
                args: command.args,
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            }).spawn()
        } catch (error) {
            this.state = {
                state: "unavailable",
                error: `couldn't start ${command.python}: ${(error as Error).message}`,
            }
            return
        }
        this.#process = process
        this.#read(process)
        ;(async () => {
            const decoder = new TextDecoder()
            for await (const chunk of process.stderr) {
                this.#stderr = (this.#stderr + decoder.decode(chunk)).slice(-2000)
            }
        })().catch(() => {})
        process.status.then((status) => {
            if (this.#process === process) {
                this.#process = null
                const why = this.#stderr.trim().split("\n").slice(-3).join(" ")
                this.state = { state: "exited", error: `the zenoh tap exited (${status.code})${why ? `: ${why}` : ""}` }
            }
        })
    }

    async #read(process: Deno.ChildProcess) {
        let buffer = new Uint8Array(0)
        const decoder = new TextDecoder()
        try {
            for await (const chunk of process.stdout) {
                const joined = new Uint8Array(buffer.length + chunk.length)
                joined.set(buffer)
                joined.set(chunk, buffer.length)
                buffer = joined
                let at = 0
                for (;;) {
                    const view = new DataView(buffer.buffer, buffer.byteOffset + at)
                    if (buffer.length - at < 5) {
                        break
                    }
                    const kind = buffer[at]
                    if (kind === 1) {
                        if (buffer.length - at < 3) {
                            break
                        }
                        const keyLength = view.getUint16(1, true)
                        const head = 3 + keyLength + 12
                        if (buffer.length - at < head) {
                            break
                        }
                        const length = view.getUint32(3 + keyLength + 8, true)
                        if (buffer.length - at < head + length) {
                            break
                        }
                        const key = decoder.decode(buffer.subarray(at + 3, at + 3 + keyLength))
                        const timeNs = view.getBigUint64(3 + keyLength, true)
                        this.onSample(key, timeNs, buffer.slice(at + head, at + head + length))
                        at += head + length
                        if (this.state.state === "starting") {
                            this.state = { state: "running", error: null }
                        }
                    } else if (kind === 2) {
                        const length = view.getUint32(1, true)
                        if (buffer.length - at < 5 + length) {
                            break
                        }
                        this.counts = JSON.parse(decoder.decode(buffer.subarray(at + 5, at + 5 + length)))
                        if (this.state.state === "starting") {
                            this.state = { state: "running", error: null }
                        }
                        at += 5 + length
                    } else {
                        throw new Error(`the zenoh tap printed a frame of kind ${kind}`)
                    }
                }
                buffer = buffer.slice(at)
            }
        } catch (error) {
            this.state = { state: "exited", error: (error as Error).message }
        }
    }

    stop() {
        const process = this.#process
        this.#process = null
        if (process) {
            process.stdin.close().catch(() => {})
            setTimeout(() => {
                try {
                    process.kill("SIGTERM")
                } catch {
                    // already gone
                }
            }, 2000)
        }
        if (this.state.state !== "unavailable") {
            this.state = { state: "off", error: null }
        }
    }
}
