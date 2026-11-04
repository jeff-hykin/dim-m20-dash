// The board side of `m20tool setup`: `m20tool board-step <id> <check|apply|plan>` runs ON GOS/AOS (the m20tool
// installed there, or a temporary copy setup uploads first). File work, process lookups, internet checks and edits
// are done here in Deno; it spawns only real system tools (systemctl, ip, iptables, nmcli, iw, tailscale, udevadm,
// resolvectl, rmmod, ping, ssh-keygen, sudo, and the dog's own office-nat). Input (the step's parameters, the Wi-Fi
// password included) arrives on stdin as JSON, never on a command line.
import { UntarStream } from "@std/tar/untar-stream"
import { MASK } from "./scripts.ts"

export type Params = {
    /** this computer's ssh public key */
    pubkey?: string
    ssid?: string
    password?: string
    /** AOS's root public key (for GOS to trust) */
    aosRootKey?: string
    /** GOS is reached over the direct cable (don't restart the cable link under ourselves) */
    onCable?: boolean
    /** a file setup uploaded to /tmp for this step (tailscale tarball, deno) */
    upload?: string
    /** AOS has internet over wlan0 (GOS's uplink through it is safe) */
    aosWlanOnline?: boolean
}

export type Action =
    | { kind: "put"; path: string; content: string; mode: number; owner?: "user" }
    | { kind: "block"; path: string; body: string }
    | { kind: "exec"; argv: string[]; okCodes?: number[]; stdin?: string; shownStdin?: string }
    | { kind: "do"; text: string; run: () => Promise<void> | void }

const decoder = new TextDecoder()

/** A system tool: its exit code and output (never through a shell). */
export async function exec(argv: string[], stdin?: string) {
    try {
        const child = new Deno.Command(argv[0], {
            args: argv.slice(1),
            stdin: stdin === undefined ? "null" : "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn()
        if (stdin !== undefined) {
            const writer = child.stdin.getWriter()
            await writer.write(new TextEncoder().encode(stdin))
            await writer.close()
        }
        const out = await child.output()
        return { code: out.code, stdout: decoder.decode(out.stdout).trim(), stderr: decoder.decode(out.stderr).trim() }
    } catch (error) {
        return { code: 127, stdout: "", stderr: `${argv[0]}: ${(error as Error).message}` }
    }
}

export function readText(path: string): string | null {
    try {
        return Deno.readTextFileSync(path)
    } catch {
        return null
    }
}

export const exists = (path: string) => {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)

/** the login user's uid/gid (owner of /home/user) */
function user() {
    const info = Deno.statSync("/home/user")
    return { uid: info.uid!, gid: info.gid! }
}

/** Installs `content` at `path` (a different existing file is kept as <path>.bak-m20tool-<time>). */
export function put(path: string, content: string | Uint8Array, mode: number, owner?: "user") {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
    Deno.mkdirSync(path.replace(/\/[^/]*$/, "") || "/", { recursive: true })
    let old: Uint8Array | null = null
    try {
        old = Deno.readFileSync(path)
    } catch {
        // new
    }
    if (old && !sameBytes(old, bytes)) {
        Deno.copyFileSync(path, `${path}.bak-m20tool-${stamp()}`)
    }
    const temp = `${path}.m20tool-new`
    Deno.writeFileSync(temp, bytes)
    Deno.chmodSync(temp, mode)
    if (owner) {
        const { uid, gid } = user()
        Deno.chownSync(temp, uid, gid)
    }
    Deno.renameSync(temp, path)
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

export const sameFile = (path: string, content: string) => readText(path) === content

// ---------------------------------------------------------------------------------------------------- managed blocks

const BEGIN = "<!-- m20tool:begin (written by m20tool setup; it replaces only what is between these two lines) -->"
const END = "<!-- m20tool:end -->"
export const managedBlock = (body: string) => `${BEGIN}\n${body.trimEnd()}\n${END}\n`

/** the lines from the begin marker through the end marker, or null */
function currentBlock(text: string): string | null {
    const lines = text.split("\n")
    const start = lines.findIndex((l) => l.startsWith("<!-- m20tool:begin"))
    if (start < 0) {
        return null
    }
    const end = lines.findIndex((l, i) => i > start && l.startsWith("<!-- m20tool:end"))
    return lines.slice(start, end < 0 ? undefined : end + 1).join("\n")
}

export const blockCurrent = (path: string, body: string) =>
    currentBlock(readText(path) ?? "") === managedBlock(body).trimEnd()

/** The block goes in place of an existing one, else after the file's own text, else it is the whole new file. */
export function putBlock(path: string, body: string) {
    const block = managedBlock(body)
    const text = readText(path) ?? ""
    let next: string
    const lines = text.split("\n")
    const start = lines.findIndex((l) => l.startsWith("<!-- m20tool:begin"))
    if (start >= 0) {
        const end = lines.findIndex((l, i) => i > start && l.startsWith("<!-- m20tool:end"))
        next = [...lines.slice(0, start), block.trimEnd(), ...(end < 0 ? [] : lines.slice(end + 1))].join("\n")
    } else if (text.length) {
        next = `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}`
    } else {
        next = block
    }
    if (next !== text) {
        let mode = 0o644
        try {
            mode = Deno.statSync(path).mode! & 0o777
        } catch {
            // new
        }
        Deno.mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true })
        Deno.writeTextFileSync(`${path}.m20tool-new`, next)
        Deno.chmodSync(`${path}.m20tool-new`, mode)
        Deno.renameSync(`${path}.m20tool-new`, path)
    }
}

// ---------------------------------------------------------------------------------------------------- processes, services, internet

/** pids whose command line matches `pattern` (from /proc/<pid>/cmdline; never this process) */
export function processes(pattern: RegExp): number[] {
    const found: number[] = []
    for (const entry of Deno.readDirSync("/proc")) {
        if (!/^\d+$/.test(entry.name) || Number(entry.name) === Deno.pid) {
            continue
        }
        try {
            const cmdline = Deno.readTextFileSync(`/proc/${entry.name}/cmdline`).replaceAll("\0", " ")
            if (pattern.test(cmdline)) {
                found.push(Number(entry.name))
            }
        } catch {
            // gone
        }
    }
    return found
}

export function killAll(pattern: RegExp) {
    for (const pid of processes(pattern)) {
        try {
            Deno.kill(pid, "SIGTERM")
        } catch {
            // gone
        }
    }
}

export const enabled = async (unit: string) => (await exec(["systemctl", "is-enabled", unit])).stdout === "enabled"
export const active = async (unit: string) => (await exec(["systemctl", "is-active", "-q", unit])).code === 0

/** Can this board reach the internet (plain HTTP: a 2024 clock breaks TLS)? */
export async function online(): Promise<boolean> {
    for (const url of ["http://www.google.com", "http://1.1.1.1"]) {
        try {
            const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) })
            await response.body?.cancel()
            return true
        } catch {
            // next
        }
    }
    return false
}

/** Extracts a .tgz into `dir`, dropping the first path component; the written paths. */
export async function untgz(path: string, dir: string): Promise<string[]> {
    const written: string[] = []
    const file = await Deno.open(path)
    const entries = file.readable.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new UntarStream())
    for await (const entry of entries) {
        const relative = entry.path.split("/").slice(1).join("/")
        if (!relative || !entry.readable) {
            await entry.readable?.cancel()
            continue
        }
        const out = `${dir}/${relative}`
        Deno.mkdirSync(out.replace(/\/[^/]*$/, ""), { recursive: true })
        await Deno.writeFile(out, entry.readable)
        written.push(out)
    }
    return written
}

// ---------------------------------------------------------------------------------------------------- actions

/** How an action reads in a plan (secrets masked). */
export function describe(action: Action): string {
    if (action.kind === "put") {
        return `write ${action.path} (${new TextEncoder().encode(action.content).length} bytes, mode ${
            action.mode.toString(8)
        }${action.owner ? ", owner user" : ""}; a different existing file is kept as .bak-m20tool-<time>)`
    }
    if (action.kind === "block") {
        return `put a ${
            action.body.split("\n").length
        }-line block between <!-- m20tool:begin --> / <!-- m20tool:end --> lines in ${action.path} (the rest of the file is kept; a new file if missing)`
    }
    if (action.kind === "exec") {
        const words = action.argv.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w}'`)).join(" ")
        return action.stdin !== undefined ? `${words}   <<< ${JSON.stringify(action.shownStdin ?? MASK)}` : words
    }
    return action.text
}

export async function perform(actions: Action[], log: (line: string) => void) {
    for (const action of actions) {
        if (action.kind === "put") {
            put(action.path, action.content, action.mode, action.owner)
        } else if (action.kind === "block") {
            putBlock(action.path, action.body)
        } else if (action.kind === "exec") {
            const result = await exec(action.argv, action.stdin)
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
            if (!(action.okCodes ?? [0]).includes(result.code)) {
                throw new Error(`${describe(action)}: exit ${result.code}${output ? `: ${output}` : ""}`)
            }
            if (output) {
                log(output)
            }
        } else {
            await action.run()
        }
    }
}
