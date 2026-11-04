// Running things on the boards from a laptop: one `ssh` per call (the only way in; Deno has no ssh of its own).
// Scripts go as base64 inside the command line (no temp files, no stdin needed); big files go over stdin into /tmp
// and the script that installs them removes them. Root: `sudo -S` fed the board password (AOS asks for it, GOS
// doesn't). Before our key is on a board, ssh gets the password from a throwaway SSH_ASKPASS script.
import { $ } from "dax"
import { encodeBase64 } from "@std/encoding/base64"
import { BOARD_PASSWORD } from "./dog.ts"
import { redact } from "./scripts.ts"

export type Board = {
    name: "GOS" | "AOS" | "NOS"
    /** user@host (or an ~/.ssh/config alias) */
    target: string
    /** reach it through this board (ssh -W) */
    via?: Board
    /** a robot's fixed internal/cable address: every M20 has the same ones, so its host key isn't pinned */
    sharedAddress: boolean
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
export function sshArgs(board: Board, password: boolean, timeoutSeconds = 8): string[] {
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
        args.push(
            "-o",
            `ProxyCommand=ssh ${sshArgs(board.via, password, timeoutSeconds).map(quote).join(" ")} -W %h:%p`,
        )
    }
    args.push(board.target)
    return args
}

/** env for an ssh that may use the board password */
function passwordEnv(password: boolean): Record<string, string> {
    return password
        ? { SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: "force", DISPLAY: Deno.env.get("DISPLAY") ?? ":0" }
        : {}
}

/** A shell command line that runs `script` (as root with `root`), without temp files or stdin. With `secret`, the
 * secret arrives on stdin and goes into a 0600 temp file (never argv, so never in the process list); the script reads
 * it into $M20_SECRET and deletes the file first thing. */
export function wrap(script: string, root: boolean, secret = false): string {
    const body = secret ? `M20_SECRET=$(cat "$M20_SECRET_FILE"); rm -f "$M20_SECRET_FILE"\n${script}` : script
    const b64 = encodeBase64(new TextEncoder().encode(body))
    const decode = `"$(printf %s ${b64} | base64 -d)"`
    const env = secret ? `env M20_SECRET_FILE="$f" ` : ""
    // sudo -S reads the password (a single apostrophe, \047) from the pipe; on GOS (NOPASSWD) it's never read
    const command = root ? `printf '\\047\\n' | sudo -S -p '' ${env}sh -c ${decode}` : `${env}sh -c ${decode}`
    return secret
        ? `umask 077; f=$(mktemp /tmp/m20tool-secret.XXXXXX); cat > "$f"; ${command}; rc=$?; rm -f "$f"; exit $rc`
        : command
}

export type RunResult = { code: number; stdout: string; stderr: string }

/** Runs `script` on `board`: captured output; code 255 = ssh itself failed. */
export async function run(
    board: Board,
    script: string,
    options: { root?: boolean; password?: boolean; stdinPath?: string; timeoutSeconds?: number; secret?: string } = {},
): Promise<RunResult> {
    const secret = options.secret !== undefined
    let command = $`ssh ${sshArgs(board, !!options.password)} ${wrap(script, !!options.root, secret)}`
        .env(passwordEnv(!!options.password))
        .noThrow()
        .stdout("piped")
        .stderr("piped")
    command = secret
        ? command.stdinText(options.secret!)
        : options.stdinPath
        ? command.stdin($.path(options.stdinPath))
        : command.stdin("null")
    if (options.timeoutSeconds) {
        command = command.timeout(options.timeoutSeconds * 1000)
    }
    const result = await command
    return { code: result.code, stdout: redact(result.stdout.trim()), stderr: redact(result.stderr.trim()) }
}

/** Runs `script` on `board` with the terminal attached (for `tailscale up`'s login link); its exit code. */
export async function runInteractive(board: Board, script: string, root = false): Promise<number> {
    const result = await $`ssh -t ${sshArgs(board, false)} ${wrap(script, root)}`.noThrow()
    return result.code
}

/** Can we get in with our key (no password)? */
export async function keyWorks(board: Board): Promise<boolean> {
    return (await run(board, "true", { timeoutSeconds: 20 })).code === 0
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

/** Uploads a local file to /tmp on the board (as the login user); its remote path. */
export async function upload(board: Board, localPath: string, name: string): Promise<string> {
    const remote = `/tmp/m20tool-upload-${name}`
    const result = await run(board, `umask 077; cat > ${remote}`, { stdinPath: localPath, timeoutSeconds: 900 })
    if (result.code !== 0) {
        throw new Error(`upload to ${describe(board)} failed: ${result.stderr || result.stdout}`)
    }
    return remote
}
