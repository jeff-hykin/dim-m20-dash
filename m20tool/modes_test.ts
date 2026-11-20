// rust_mode / vendor_mode against three fake boards: an in-memory systemd (is-enabled / is-active per unit) and home
// directory that run the exact commands modes.ts sends, logging each. Checks the order (nothing that drives the legs
// outlives rl_deploy's stop; the bridge is up before rl_deploy starts), persistence (disable + mask), idempotence,
// the saved vendor states, the robot check and dry runs.
import { assert, assertEquals } from "@std/assert"
import {
    boardExec,
    type BoardName,
    currentMode,
    type Exec,
    query,
    type RobotState,
    safeToStopLegs,
    switchMode,
    VENDOR_STATE_FILE,
    VENDOR_UNITS,
} from "./modes.ts"

type Unit = { enabled: string; active: string }
type Fake = {
    boards: Record<BoardName, Map<string, Unit>>
    files: Record<BoardName, Map<string, string>>
    log: string[]
    failOn?: string
}

/** the dog as shipped: every listed unit enabled and running, plus our own units that must never be touched */
function fakeDog(changes: (fake: Fake) => void = () => {}): Fake {
    const fake: Fake = {
        boards: { GOS: new Map(), AOS: new Map(), NOS: new Map() },
        files: { GOS: new Map(), AOS: new Map(), NOS: new Map() },
        log: [],
    }
    for (const u of VENDOR_UNITS) {
        fake.boards[u.board].set(u.unit, { enabled: "enabled", active: "active" })
    }
    fake.boards.AOS.set("m20-camera.service", { enabled: "enabled", active: "active" })
    fake.boards.AOS.set("network-safety.service", { enabled: "enabled", active: "active" })
    changes(fake)
    return fake
}

function fakeExec(fake: Fake): Exec {
    return (board, command, root) => {
        const units = fake.boards[board]
        const files = fake.files[board]
        const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" })
        if (command.startsWith("for u in ")) {
            const names = command.slice("for u in ".length, command.indexOf(";")).split(" ")
            const lines = names.map((n) =>
                `unit|${n}|${units.get(n)?.enabled ?? ""}|${units.get(n)?.active ?? "inactive"}`
            )
            const saved = files.get(VENDOR_STATE_FILE)
            return ok([...lines, ...(saved ? [saved.trimEnd()] : [])].join("\n"))
        }
        fake.log.push(`${board}${root ? "#" : "$"} ${command}`)
        if (command.startsWith("mkdir -p ")) {
            assert(!root, "the saved states are written as user")
            const body = command.match(/printf '(.*)\\n' >/)![1].replaceAll("\\n", "\n")
            if (files.has(VENDOR_STATE_FILE)) {
                files.set(`${VENDOR_STATE_FILE}.bak`, files.get(VENDOR_STATE_FILE)!)
            }
            files.set(VENDOR_STATE_FILE, `${body}\n`)
            return ok()
        }
        assert(root, `systemctl changes need root: ${command}`)
        for (const part of command.split(" && ")) {
            const [tool, verb, ...rest] = part.split(" ")
            const name = rest.filter((w) => w !== "-q")[0]
            const unit = units.get(name)
            assertEquals(tool, "systemctl")
            assert(unit, `${board} has no ${name}`)
            if (fake.failOn === `${board} ${part}`) {
                return Promise.resolve({ code: 1, stdout: "", stderr: `Job for ${name} failed` })
            }
            if (verb === "disable" && unit.enabled !== "masked") {
                unit.enabled = "disabled"
            } else if (verb === "enable") {
                assert(unit.enabled !== "masked", `enable of masked ${name}`)
                unit.enabled = "enabled"
            } else if (verb === "mask") {
                unit.enabled = "masked"
            } else if (verb === "unmask" && unit.enabled === "masked") {
                unit.enabled = "disabled"
            } else if (verb === "stop") {
                unit.active = "inactive"
            } else if (verb === "start") {
                assert(unit.enabled !== "masked", `start of masked ${name}`)
                unit.active = "active"
            }
        }
        return ok()
    }
}

const SITTING: RobotState = { motion: 4, charge: 0 }
const STANDING: RobotState = { motion: 17, charge: 0 }

async function switchTo(
    fake: Fake,
    mode: "rust" | "vendor",
    robot: RobotState = SITTING,
    options: { dryRun?: boolean; force?: boolean } = {},
) {
    const lines: string[] = []
    const code = await switchMode(
        mode,
        fakeExec(fake),
        () => Promise.resolve(robot),
        { dryRun: !!options.dryRun, force: !!options.force },
        (line) => lines.push(line),
    )
    return { code, lines }
}

/** index in the log of the first command on `board` that names `unit` with `verb` */
const at = (fake: Fake, board: BoardName, verb: string, unit: string) =>
    fake.log.findIndex((l) => l.startsWith(`${board}#`) && l.includes(`systemctl ${verb} ${unit}`))

Deno.test("rust_mode from vendor: every vendor unit disabled + masked (the /etc ones disabled) + stopped, ours untouched", async () => {
    const fake = fakeDog()
    const { code } = await switchTo(fake, "rust")
    assertEquals(code, 0)
    for (const u of VENDOR_UNITS) {
        assertEquals(fake.boards[u.board].get(u.unit), {
            enabled: u.mask ? "masked" : "disabled",
            active: "inactive",
        }, `${u.board} ${u.unit}`)
    }
    assertEquals(fake.boards.AOS.get("m20-camera.service"), { enabled: "enabled", active: "active" })
    assertEquals(fake.boards.AOS.get("network-safety.service"), { enabled: "enabled", active: "active" })
    assert(!fake.log.some((l) => l.includes("m20-camera") || l.includes("network-safety")))
    assertEquals(currentMode(await query(fakeExec(fake))).mode, "rust")
    // the saved states come before any change on that board
    for (const board of ["GOS", "AOS", "NOS"] as const) {
        assert(
            fake.log.findIndex((l) => l.startsWith(`${board}$ mkdir`)) <
                fake.log.findIndex((l) => l.startsWith(`${board}#`)),
        )
        assert(fake.files[board].get(VENDOR_STATE_FILE)!.includes("cpunode.service enabled"))
    }
})

Deno.test("rust_mode order: docking and commands stop first, rl_deploy before the bridge, drivers last", async () => {
    const fake = fakeDog()
    await switchTo(fake, "rust")
    const stop = (board: BoardName, unit: string) => at(fake, board, "stop", unit)
    assert(stop("NOS", "charge_manager.service") < stop("AOS", "rl_deploy.service"))
    assert(stop("AOS", "basic_server.service") < stop("AOS", "rl_deploy.service"))
    assert(stop("AOS", "rl_deploy.service") < stop("NOS", "drdds-zenoh-bridge.service"))
    assert(stop("NOS", "drdds-zenoh-bridge.service") < stop("NOS", "localization.service"))
    assert(stop("AOS", "rl_deploy.service") < stop("AOS", "yesense.service"))
    assert(stop("AOS", "rl_deploy.service") < stop("AOS", "ctrlmcu.service"))
})

Deno.test("vendor_mode puts back exactly the saved states, bridge + localization up before rl_deploy, basic_server after", async () => {
    // a dog whose gps_node was off in vendor mode: it stays disabled (but unmasked)
    const fake = fakeDog((f) => (f.boards.AOS.get("gps_node.service")!.enabled = "disabled"))
    fake.boards.AOS.get("gps_node.service")!.active = "inactive"
    assertEquals((await switchTo(fake, "rust")).code, 0)
    assert(fake.files.AOS.get(VENDOR_STATE_FILE)!.includes("gps_node.service disabled"))
    fake.log.length = 0
    const { code, lines } = await switchTo(fake, "vendor")
    assertEquals(code, 0, lines.join("\n"))
    for (const u of VENDOR_UNITS) {
        const want = u.unit === "gps_node.service" && u.board === "AOS"
            ? { enabled: "disabled", active: "inactive" }
            : { enabled: "enabled", active: "active" }
        assertEquals(fake.boards[u.board].get(u.unit), want, `${u.board} ${u.unit}`)
    }
    const start = (board: BoardName, unit: string) => at(fake, board, "start", unit)
    assert(start("NOS", "localization.service") < start("NOS", "drdds-zenoh-bridge.service"))
    assert(start("NOS", "drdds-zenoh-bridge.service") < start("AOS", "rl_deploy.service"))
    assert(start("AOS", "yesense.service") < start("AOS", "rl_deploy.service"))
    assert(start("AOS", "rl_deploy.service") < start("AOS", "basic_server.service"))
    assert(start("AOS", "basic_server.service") < start("NOS", "charge_manager.service"))
    assertEquals(currentMode(await query(fakeExec(fake))).mode, "vendor")
})

Deno.test("idempotent: a second switch does nothing; a half-done switch finishes on a rerun and keeps the saved states", async () => {
    const fake = fakeDog()
    await switchTo(fake, "rust")
    fake.log.length = 0
    const again = await switchTo(fake, "rust")
    assertEquals(again.code, 0)
    assert(again.lines.some((l) => l === "already in rust mode"))
    assertEquals(fake.log, [])

    const half = fakeDog()
    half.failOn = "NOS systemctl stop localization.service"
    const failed = await switchTo(half, "rust")
    assertEquals(failed.code, 1)
    assertEquals(currentMode(await query(fakeExec(half))).mode, "mixed")
    assertEquals(half.boards.NOS.get("handler.service")!.enabled, "disabled")
    half.failOn = undefined
    assertEquals((await switchTo(half, "rust")).code, 0)
    // handler (disabled, not masked, by the first try) is still saved as vendor mode's "enabled"
    assert(half.files.NOS.get(VENDOR_STATE_FILE)!.includes("handler.service enabled"))
    assert(half.files.NOS.has(`${VENDOR_STATE_FILE}.bak`))
    assertEquals((await switchTo(half, "vendor")).code, 0)
    assertEquals(half.boards.NOS.get("handler.service"), { enabled: "enabled", active: "active" })
})

Deno.test("rust_mode refuses while the robot stands or moves on/off the dock, unless --force", async () => {
    for (const robot of [STANDING, { motion: 1, charge: 0 }, { motion: 4, charge: 1 }, { motion: 4, charge: 3 }]) {
        const fake = fakeDog()
        const { code, lines } = await switchTo(fake, "rust", robot)
        assertEquals(code, 1)
        assert(lines[0].startsWith("not switching to rust mode"))
        assertEquals(fake.log, [])
    }
    const forced = fakeDog()
    assertEquals((await switchTo(forced, "rust", STANDING, { force: true })).code, 0)
    // on the dock (charging, or docked and not charging) is fine
    assert(safeToStopLegs({ motion: 4, charge: 2 }, []).ok)
    assert(safeToStopLegs({ motion: 0, charge: 5 }, []).ok)
})

Deno.test("no answer from basic_server: refuses while rl_deploy runs, fine once it doesn't", async () => {
    const running = fakeDog((f) => f.boards.AOS.get("basic_server.service")!.active = "inactive")
    assertEquals((await switchTo(running, "rust", null)).code, 1)
    const stopped = fakeDog((f) => {
        f.boards.AOS.get("basic_server.service")!.active = "inactive"
        f.boards.AOS.get("rl_deploy.service")!.active = "inactive"
    })
    assertEquals((await switchTo(stopped, "rust", null)).code, 0)
})

Deno.test("a dry run reads the state and prints every command, changes nothing", async () => {
    const fake = fakeDog()
    const { code, lines } = await switchTo(fake, "rust", SITTING, { dryRun: true })
    assertEquals(code, 0)
    assertEquals(fake.log, [])
    assert(lines.some((l) => l.includes("AOS 10.21.31.103 (root): systemctl disable -q rl_deploy.service")))
    assert(
        lines.some((l) =>
            l.includes("NOS 10.21.31.106 (root): systemctl disable -q drdds-zenoh-bridge.service && systemctl stop")
        ),
    )
    assertEquals(currentMode(await query(fakeExec(fake))).mode, "vendor")
})

Deno.test("a unit a board doesn't have is skipped (not on this board)", async () => {
    const fake = fakeDog((f) => f.boards.GOS.delete("encryption_node.service"))
    assertEquals((await switchTo(fake, "rust")).code, 0)
    assert(!fake.log.some((l) => l.includes("encryption_node")))
    assertEquals((await switchTo(fake, "vendor")).code, 0)
})

Deno.test("boardExec: this board runs locally, the others over ssh as user; root = sudo -S with the password on stdin", async () => {
    const calls: string[] = []
    const exec = boardExec(
        "GOS",
        (target, command, stdin) => {
            calls.push(`ssh ${target} ${command} <${JSON.stringify(stdin)}`)
            return Promise.resolve({ code: 0, stdout: "", stderr: "" })
        },
        (command, stdin) => {
            calls.push(`local ${command} <${JSON.stringify(stdin)}`)
            return Promise.resolve({ code: 0, stdout: "", stderr: "" })
        },
    )
    await exec("GOS", "systemctl stop cpunode.service", true)
    await exec("NOS", "echo 'x'", true)
    await exec("AOS", "true", false)
    assertEquals(calls, [
        `local sudo -S -p '' sh -c 'systemctl stop cpunode.service' <"'\\n"`,
        `ssh user@10.21.31.106 sudo -S -p '' sh -c 'echo '\\''x'\\''' <"'\\n"`,
        `ssh user@10.21.31.103 true <undefined`,
    ])
})
