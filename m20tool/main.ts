// m20tool: set up and operate a Deep Robotics M20. `m20tool help` says how to reach the dog; README.md has the rest.
import { Command } from "@cliffy/command"
import { $ } from "dax"
import { DEFAULT_HOST, REPORT_BASIC } from "../backend/basic_server.ts"
import { DOCK_LOG, GOS_CABLE_IP, GOS_IP, HELP, TAILSCALE_GOS, USER, VERSION } from "./dog.ts"
import { type CommandName, COMMANDS, dock, Fail, Link } from "./robot.ts"
import { cleanupRunners, findDog, installSteps, prepare, runStep, setup } from "./setup.ts"
import { boardStep } from "./board_step.ts"
import { type Board, sshArgs, sshPortOpen } from "./remote.ts"
import { compiled } from "./install.ts"

const HOME = Deno.env.get("HOME") ?? "."
const onBoard = () => Deno.networkInterfaces().some((i) => i.address.startsWith("10.21.31."))

type RobotOptions = { dryRun?: boolean; host?: string; foreground?: boolean; watch?: boolean; log?: string }

/** this program, as a command line (the compiled binary, or deno running main.ts) */
function self(): string[] {
    return compiled()
        ? [Deno.execPath()]
        : [Deno.execPath(), "run", "-A", "--unstable-net", new URL(import.meta.url).pathname]
}

/** Starts `m20tool dock --watch` detached (its own session: Deno's `detached`), logging to ~/m20_dock.log. */
function watchDockInBackground(host: string): Promise<string> {
    const log = `${HOME}/${DOCK_LOG}`
    const args = [...self(), "dock", "--watch", "--log", log, "--host", host]
    const child = new Deno.Command(args[0], {
        args: args.slice(1),
        detached: true,
        stdin: "null",
        stdout: "null",
        stderr: "null",
    }).spawn()
    child.unref()
    return Promise.resolve(
        `docking: the robot took the command; watching it in the background (pid ${child.pid}), log ${log}`,
    )
}

/** On a laptop where basic_server doesn't answer: the same command on GOS over ssh. */
async function overSsh(name: string, options: RobotOptions): Promise<number> {
    let gos: Board | null = null
    for (
        const [target, shared] of [[`${USER}@${GOS_CABLE_IP}`, true], [`${USER}@${GOS_IP}`, true], [
            `${USER}@${TAILSCALE_GOS}`,
            false,
        ]] as const
    ) {
        if (await sshPortOpen(target.split("@")[1])) {
            gos = { name: "GOS", target, sharedAddress: shared }
            break
        }
    }
    if (!gos) {
        console.error(
            `basic_server (${DEFAULT_HOST}) doesn't answer from here and GOS isn't reachable (${GOS_CABLE_IP}, ${GOS_IP}, ${TAILSCALE_GOS}): see m20tool help`,
        )
        return 1
    }
    const remote = ["m20tool", name, ...(options.foreground ? ["--foreground"] : [])].join(" ")
    console.error(`(basic_server doesn't answer from here: running \`${remote}\` on GOS, ${gos.target})`)
    const result = await $`ssh ${sshArgs(gos, false)} ${remote}`.noThrow()
    if (result.code === 127) {
        console.error("m20tool isn't installed on GOS: m20tool install-on-dog")
    }
    return result.code
}

async function robotCommand(name: CommandName, options: RobotOptions): Promise<number> {
    const explicit = options.host ?? Deno.env.get("M20_HOST")
    const host = explicit ?? DEFAULT_HOST
    let logFile: Deno.FsFile | null = null
    let out = (line: string) => {
        try {
            console.log(line)
        } catch (error) {
            // the reader went away (`| head`): keep going quietly, the robot command isn't the output's
            if (!(error instanceof Deno.errors.BrokenPipe)) {
                throw error
            }
        }
    }
    if (options.log) {
        logFile = Deno.openSync(options.log, { append: true, create: true })
        out = (line: string) => logFile!.writeSync(new TextEncoder().encode(`${new Date().toISOString()} ${line}\n`))
    }
    let link: Link
    try {
        link = new Link(host, !!options.dryRun, out)
    } catch (error) {
        console.error(`can't open a UDP socket: ${(error as Error).message}`)
        return 1
    }
    try {
        if (!options.dryRun && !explicit && !onBoard()) {
            // a laptop: only straight to basic_server if it answers (on the hotspot); nothing but heartbeats so far
            if (!(await link.report(REPORT_BASIC, 0, 2))) {
                link.close()
                return await overSsh(name, options)
            }
        }
        if (name === "dock") {
            const mode = options.watch ? "only" : options.foreground ? "foreground" : "background"
            await dock(link, mode, () => watchDockInBackground(host))
        } else {
            await COMMANDS[name].run(link)
        }
        return 0
    } catch (error) {
        const message = error instanceof Fail ? error.message : `basic_server at ${host}: ${(error as Error).message}`
        out(message)
        if (!options.log) {
            console.error(message)
        }
        return 1
    } finally {
        link.close()
        logFile?.close()
    }
}

let exitCode = 0
const cli = new Command()
    .name("m20tool")
    .version(VERSION)
    .description("Set up and operate a Deep Robotics M20 robot dog. `m20tool help` for the dog's addresses and logins.")
    .action(() => console.log(HELP))
    .command("help", "How to connect to the M20: boards, addresses, passwords, the hotspot (AP mode), the commands")
    .action(() => console.log(HELP))
    .command("setup", "Set up a dog from this computer (asks for the Wi-Fi to join; idempotent)")
    .option("--dry-run", "Run only the read-only checks; print every step and command, change nothing")
    .option("--wifi-ssid <ssid:string>", 'The Wi-Fi network for the dog (skips the question; "" = leave Wi-Fi alone)')
    .option("--wifi-password <password:string>", "Its password (skips the question)")
    .option("--gos <target:string>", "ssh target for GOS (default: the cable, the internal address, then Tailscale)")
    .option("--aos <target:string>", "ssh target for AOS (default: 10.21.31.103, through GOS)")
    .option("--laptop-iface <iface:string>", "This computer's interface with the direct cable (default: found)")
    .action(async (options) => {
        exitCode = await setup({ ...options, dryRun: !!options.dryRun })
    })
    .command(
        "install-on-dog",
        "Install this m20tool on GOS and AOS (/usr/local/bin/m20tool, ~/.local/bin/m20) and their docs (~/readme, ~/AGENTS.md)",
    )
    .option("--dry-run", "Check and print, change nothing")
    .option("--gos <target:string>", "ssh target for GOS")
    .option("--aos <target:string>", "ssh target for AOS")
    .action(async (options) => {
        const dog = await findDog(options)
        if (!dog) {
            console.error("can't reach GOS: see m20tool help")
            exitCode = 1
            return
        }
        try {
            await prepare(dog)
            for (const step of installSteps(dog)) {
                if (!(await runStep(step, !!options.dryRun))) {
                    exitCode = 1
                }
            }
        } finally {
            await cleanupRunners()
        }
    })

for (const [name, info] of Object.entries(COMMANDS)) {
    let command = new Command()
        .description(info.about)
        .option("--dry-run", "Print every frame it would send (host, port, protocol, JSON, header) and send nothing")
        .option("--host <host:string>", `basic_server's address (default: M20_HOST, else ${DEFAULT_HOST})`)
    if (name === "dock") {
        command = command
            .option("--foreground", "Watch the docking here until it ends (up to 150 s) instead of in the background")
            .option("--watch", "Only watch a docking that's already started (the background part)", { hidden: true })
            .option("--log <path:string>", "Write to this file instead of stdout", { hidden: true })
    }
    cli.command(
        name,
        command.action(async (options: RobotOptions) => {
            exitCode = await robotCommand(name as CommandName, options)
        }),
    )
}

// the top-level --help is the dog's own help (addresses, logins, the hotspot); --version is plain for scripts
if (Deno.args[0] === "board-step") {
    // what setup runs on a board (board_step.ts); not for people
    Deno.exit(await boardStep(Deno.args.slice(1)))
} else if (Deno.args.length === 1 && ["--help", "-h"].includes(Deno.args[0])) {
    console.log(HELP)
} else if (Deno.args.length === 1 && ["--version", "-V"].includes(Deno.args[0])) {
    console.log(`m20tool ${VERSION}`)
} else {
    await cli.parse(Deno.args)
}
Deno.exit(exitCode)
