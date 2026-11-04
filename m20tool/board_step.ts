// `m20tool board-step ...`: what setup runs on a board over ssh (hidden from --help).
//   board-step <id> check|apply      parameters as JSON on stdin; prints one result line "M20TOOL <json>" on stdout
//   board-step tailscale-up GOS|AOS  `tailscale up` with the terminal attached (its login link)
//   board-step receive <path>        stdin -> <path> (mode 600): how setup uploads files once m20tool is there
//   board-step cleanup               a temporary copy of m20tool (in /tmp) deletes itself
// A step that needs root re-runs itself under `sudo -S` (AOS asks for the board password, which it gets on sudo's
// stdin), its parameters in a 0600 temp file the root copy reads and deletes at once: never on a command line.
import { describe, type Params, perform } from "./board.ts"
import { BOARD_PASSWORD } from "./dog.ts"
import { type BoardName, stepById, tailscaleUpArgv } from "./steps.ts"

export const RESULT_PREFIX = "M20TOOL "

async function readStdin(): Promise<Uint8Array> {
    return new Uint8Array(await new Response(Deno.stdin.readable).arrayBuffer())
}

/** this program again, as root: the parameters through a 0600 temp file */
async function asRoot(args: string[], params?: Params): Promise<number> {
    let input: string | null = null
    if (params) {
        input = Deno.makeTempFileSync({ prefix: "m20tool-in-" })
        Deno.chmodSync(input, 0o600)
        Deno.writeTextFileSync(input, JSON.stringify(params))
    }
    try {
        const child = new Deno.Command("sudo", {
            args: ["-S", "-p", "", Deno.execPath(), "board-step", ...args, ...(input ? ["--input", input] : [])],
            stdin: "piped",
            stdout: "inherit",
            stderr: "inherit",
        }).spawn()
        const writer = child.stdin.getWriter()
        await writer.write(new TextEncoder().encode(`${BOARD_PASSWORD}\n`)).catch(() => {})
        await writer.close().catch(() => {})
        return (await child.status).code
    } finally {
        if (input) {
            try {
                Deno.removeSync(input)
            } catch {
                // the root copy already deleted it
            }
        }
    }
}

const isRoot = () => Deno.uid() === 0

export async function boardStep(args: string[]): Promise<number> {
    const flag = (name: string) => {
        const at = args.indexOf(name)
        return at >= 0 ? args.splice(at, 2)[1] : undefined
    }
    const inputFile = flag("--input")
    const [id, mode] = args
    if (id === "receive") {
        const data = await readStdin()
        Deno.writeFileSync(mode, data, { mode: 0o600 })
        return 0
    }
    if (id === "cleanup") {
        const self = Deno.execPath()
        if (self.startsWith("/tmp/")) {
            Deno.removeSync(self)
            // and the code cache deno compile keeps beside it in /tmp
            try {
                Deno.removeSync(`/tmp/deno-compile-${self.split("/").pop()}.cache`)
            } catch {
                // none
            }
        }
        return 0
    }
    if (id === "tailscale-up") {
        if (!isRoot()) {
            return await asRoot([id, mode])
        }
        const argv = tailscaleUpArgv(mode as BoardName)
        return (await new Deno.Command(argv[0], {
            args: argv.slice(1),
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        })
            .output()).code
    }
    const step = stepById(id)
    if (!step || !["check", "apply"].includes(mode)) {
        console.error(`board-step: unknown step or mode: ${id} ${mode}`)
        return 2
    }
    let params: Params
    if (inputFile) {
        params = JSON.parse(Deno.readTextFileSync(inputFile))
        Deno.removeSync(inputFile)
    } else {
        const text = new TextDecoder().decode(await readStdin()).trim()
        params = text ? JSON.parse(text) : {}
    }
    if (step.root && !isRoot()) {
        return await asRoot([id, mode], params)
    }
    const print = (result: unknown) => console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`)
    try {
        if (mode === "apply") {
            await perform(step.actions(params), (line) => console.error(line))
        }
        print(await step.check(params))
        return 0
    } catch (error) {
        print({ error: (error as Error).message })
        return 1
    }
}

/** a step's plan, as setup prints it (secrets masked) */
export const planLines = (id: string, params: Params) => stepById(id)!.actions(params).map(describe)
