// Reaching the boards from a laptop: `ssh` (the only way in; Deno has no ssh of its own). Once m20tool is on a board
// (installed, or a temporary copy uploaded to /tmp), every step runs inside it (`m20tool board-step ...`), its
// parameters on ssh's stdin. Before that, only two plain commands go over ssh: the upload of that copy
// (`umask 077; cat > /tmp/...; chmod 700 /tmp/...`) and `/usr/local/bin/m20tool --version`. Before our key is on a
// board, ssh gets the board password from a throwaway SSH_ASKPASS script.
import { $ } from "dax"
import { BOARD_BIN, BOARD_PASSWORD, VERSION } from "./dog.ts"
import { redact } from "./scripts.ts"
import { RESULT_PREFIX } from "./board_step.ts"
import type { Params } from "./board.ts"
import type { CheckResult } from "./steps.ts"

export type Board = {
    name: "GOS" | "AOS" | "NOS"
    /** user@host (or an ~/.ssh/config alias) */
    target: string
    /** reach it through this board (ssh ProxyCommand) */
    via?: Board
    /** a robot's fixed internal/cable address: every M20 has the same ones, so its host key isn't pinned */
    sharedAddress: boolean
    /** the m20tool to run steps with there (setup fills it in) */
    runner?: string
    /** our key isn't accepted yet: use the board password */
    password?: boolean
}

export const describe = (board: Board): string =>
    board.via ? `${board.target} via ${describe(board.via)}` : board.target

let askpassDir: string | null = null
/** a script that prints the board password, for SSH_ASKPASS (removed at exit) */
function askpass(): string {
    if (!askpassDir) {
        askpassDir = Deno.makeTempDirSync({ prefix: "m20tool-" })
        const path = `${askpassDir}/askpass`
        Deno.writeTextFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${BOARD_PASSWORD.replaceAll("'", "'\\''")}'\n`)
        Deno.chmodSync(path, 0o700)
        globalThis.addEventListener("unload", () => {
            try {
                Deno.removeSync(askpassDir!, { recursive: true })
            } catch {
                // gone
            }
        })
    }
    return `${askpassDir}/askpass`
}

function hostKeyOptions(board: Board): string[] {
    return board.sharedAddress
        ? ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]
        : ["-o", "StrictHostKeyChecking=accept-new"]
}

const quote = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/** ssh's arguments for `board` (everything before the remote command) */
export function sshArgs(board: Board, password = !!board.password, timeoutSeconds = 8): string[] {
    const args = [
        "-o",
        `ConnectTimeout=${timeoutSeconds}`,
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=3",
        ...hostKeyOptions(board),
        ...(password ? ["-o", "NumberOfPasswordPrompts=1"] : ["-o", "BatchMode=yes"]),
    ]
    if (board.via) {
        // ProxyCommand rather than -J: -J's own ssh ignores these -o options
        args.push("-o", `ProxyCommand=ssh ${sshArgs(board.via, false, timeoutSeconds).map(quote).join(" ")} -W %h:%p`)
    }
    args.push(board.target)
    return args
}

const passwordEnv = (password: boolean): Record<string, string> =>
    password ? { SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: Deno.env.get("DISPLAY") ?? ":0" } : {}

export type RunResult = { code: number; stdout: string; stderr: string }

/** Runs `command` (plain words) on `board`: captured output; code 255 = ssh itself failed. */
export async function run(
    board: Board,
    command: string,
    options: { stdinPath?: string; stdinText?: string; timeoutSeconds?: number; password?: boolean } = {},
): Promise<RunResult> {
    const password = options.password ?? !!board.password
    let c = $`ssh ${sshArgs(board, password)} ${command}`.env(passwordEnv(password)).noThrow().stdout("piped")
        .stderr("piped")
    c = options.stdinText !== undefined
        ? c.stdinText(options.stdinText)
        : options.stdinPath
        ? c.stdin($.path(options.stdinPath))
        : c.stdin("null")
    if (options.timeoutSeconds) {
        c = c.timeout(options.timeoutSeconds * 1000)
    }
    const result = await c
    return { code: result.code, stdout: redact(result.stdout.trim()), stderr: redact(result.stderr.trim()) }
}

/** Can we get in with our key (no password)? */
export async function keyWorks(board: Board): Promise<boolean> {
    return (await run(board, "true", { timeoutSeconds: 20, password: false })).code === 0
}

/** Is TCP port 22 open there (2 s)? Names that don't resolve count as no. */
export async function sshPortOpen(host: string, timeoutMs = 2000): Promise<boolean> {
    let timer: number | undefined
    try {
        const connection = await Promise.race([
            Deno.connect({ hostname: host, port: 22 }),
            new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), timeoutMs))),
        ])
        connection.close()
        return true
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

const random = () => crypto.randomUUID().slice(0, 8)
const temporaryRunners: Board[] = []

/** The m20tool to run steps with on `board`: the installed one when it's this version, else a copy uploaded to /tmp
 * (removed by cleanupRunners). `localBinary` gives the aarch64 Linux binary. */
export async function ensureRunner(board: Board, localBinary: () => Promise<string>): Promise<string> {
    if (board.runner) {
        return board.runner
    }
    const installed = await run(board, `${BOARD_BIN} --version`, { timeoutSeconds: 30 })
    if (installed.code === 255) {
        throw new Error(`can't reach ${board.name} (${describe(board)}): ${installed.stderr}`)
    }
    if (installed.stdout === `m20tool ${VERSION}`) {
        board.runner = BOARD_BIN
        return BOARD_BIN
    }
    const path = `/tmp/m20tool-run-${random()}`
    const result = await run(board, `umask 077; cat > ${path}; chmod 700 ${path}`, {
        stdinPath: await localBinary(),
        timeoutSeconds: 900,
    })
    if (result.code !== 0) {
        throw new Error(`upload of m20tool to ${board.name} failed: ${result.stderr || result.stdout}`)
    }
    board.runner = path
    temporaryRunners.push(board)
    return path
}

export async function cleanupRunners() {
    for (const board of temporaryRunners.splice(0)) {
        await run(board, `${board.runner} board-step cleanup`, { timeoutSeconds: 60 }).catch(() => {})
        board.runner = undefined
    }
}

/** Runs a board step's check or apply on `board` (its m20tool); the parameters go over stdin. */
export async function boardStep(
    board: Board,
    id: string,
    mode: "check" | "apply",
    params: Params,
): Promise<CheckResult> {
    const result = await run(board, `${board.runner} board-step ${id} ${mode}`, {
        stdinText: JSON.stringify(params),
        timeoutSeconds: mode === "apply" ? 900 : 120,
    })
    if (result.code === 255) {
        throw new Error(`can't reach ${board.name} (${describe(board)}): ${result.stderr}`)
    }
    if (mode === "apply" && result.stderr) {
        console.log(result.stderr.replace(/^/gm, "    "))
    }
    const line = result.stdout.split("\n").reverse().find((l) => l.startsWith(RESULT_PREFIX))
    if (!line) {
        throw new Error(
            `${board.name}: ${id} ${mode} gave no result (exit ${result.code}): ${result.stderr || result.stdout}`,
        )
    }
    const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
    if (parsed.error) {
        throw new Error(`${board.name}: ${parsed.error}`)
    }
    return parsed as CheckResult
}

/** Uploads a local file to /tmp on the board through its m20tool; the remote path. */
export async function upload(board: Board, localPath: string, name: string): Promise<string> {
    const remote = `/tmp/m20tool-upload-${name}-${random()}`
    const result = await run(board, `${board.runner} board-step receive ${remote}`, {
        stdinPath: localPath,
        timeoutSeconds: 900,
    })
    if (result.code !== 0) {
        throw new Error(`upload to ${describe(board)} failed: ${result.stderr || result.stdout}`)
    }
    return remote
}

/** `tailscale up` on the board with the terminal attached (its login link); its exit code. */
export async function tailscaleUp(board: Board): Promise<number> {
    return (await $`ssh -t ${sshArgs(board)} ${board.runner!} board-step tailscale-up ${board.name}`.noThrow()).code
}
