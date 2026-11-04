// Whether the M20 can be driven right now, why not, and the one-tap fix; and Direct mode's own driving, through the
// robot's basic_server (the vendor protocol in its official software development guide, as the `m20` CLI uses it).
//
// The two ways to drive need the robot in different usage modes:
//   blueprint mode: the page publishes tele_cmd_vel; m20-nav's bridge hands it to the robot's navigation path, which the
//     robot follows only in NAVIGATION usage mode (1) and RL control (17). The fix is `m20 stand` (the CLI: stand, RL
//     control, navigation mode, agile stairs gait; it refuses on the dock).
//   direct mode: axis commands (2/21, X/Y/Yaw as -1..1 of the robot's top speed) at 20 Hz, which the robot follows only
//     in REGULAR usage mode (0), standing (1) or in RL control (17). The fix is `m20 direct` (stand, RL control,
//     regular mode, basic gait).
// The robot resets its usage mode to regular on every stand and undock, so the CLI sets the mode after standing.
// Direct driving has its own deadman: a move holds for at most MOVE_HOLD_MAX_MS unless renewed (the page renews it every
// 150 ms while a drive input is held); when it lapses, or on stop, zeros go out for a moment, then nothing.
// Everything here runs only from a request (a click, a held drive input, an agent call). With the fake boards it drives
// the simulated robot (robot.ts simulate()).
import { logLine } from "./applog.ts"
import { HttpError } from "./http.ts"
import { GAIT, type Robot } from "./robot.ts"

export type Mode = "blueprint" | "direct"
export type Readiness = {
    ok: boolean
    /** what's in the way (null when ok) */
    reason: string | null
    /** whether the Enable driving button (POST api/drive/enable) can fix it */
    fixable: boolean
    /** whether the robot's own status said so (false: unknown, e.g. no reports) */
    known: boolean
}

const MOTION_STAND = 1
const MOTION_RL = 17
const MOTION_SIT = 4
const USAGE_REGULAR = 0
const USAGE_NAVIGATION = 1
/** charging states the robot refuses to stand from (entering, charging, leaving, on the dock) */
const CHARGE_BUSY = new Set([1, 2, 3, 5])

/** the gait each mode's Enable driving ends in: Basic for direct, agile stairs for the blueprint (what `m20 stand` and
 * dimos use) */
export const GAIT_BASIC = 0x1001
export const GAIT_AGILE_STAIRS = 0x3003

const AXIS_HZ = 20
export const MOVE_HOLD_MAX_MS = 500
/** zeros after a stop or a lapsed move */
const STOP_FRAMES = 10

/** Whether `mode`'s driving would move the robot now, from basic_server's last reports. */
export function readiness(robot: Robot, mode: Mode): Readiness {
    const state = robot.state
    const b = state.basic
    if (state.link !== "up" || !b) {
        // unknown: the blueprint's path may still work; direct driving needs basic_server
        return mode === "direct"
            ? { ok: false, reason: "no status from the robot's basic_server (AOS)", fixable: false, known: false }
            : { ok: true, reason: null, fixable: false, known: false }
    }
    const no = (reason: string, fixable: boolean): Readiness => ({ ok: false, reason, fixable, known: true })
    if (b.hardEstop) {
        return no("the hard e-stop is pressed: release it on the robot", false)
    }
    if (b.motion === 2) {
        return no("the robot is in soft e-stop", true)
    }
    if (CHARGE_BUSY.has(b.charge)) {
        return no(`the robot is ${b.chargeName}: undock it first`, false)
    }
    if (mode === "blueprint") {
        if (b.usageMode !== USAGE_NAVIGATION) {
            return no(`the robot is in ${b.usage} control mode, which ignores the blueprint's velocity`, true)
        }
        if (b.motion !== MOTION_RL) {
            return no(`the robot is ${b.motionName}, not in RL control`, true)
        }
    } else {
        if (b.usageMode !== USAGE_REGULAR) {
            return no(`the robot is in ${b.usage} control mode, which ignores direct (axis) commands`, true)
        }
        if (b.motion !== MOTION_STAND && b.motion !== MOTION_RL) {
            return no(`the robot is ${b.motionName}, not standing`, true)
        }
    }
    return { ok: true, reason: null, fixable: false, known: true }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Direct {
    /** the last move's axes (-1..1) and until when it holds */
    #axes = [0, 0, 0]
    #until = 0
    #stopFrames = 0
    #timer: number | null = null
    #busy: string | null = null
    /** the simulated robot's dock: entering, then charging a moment later */
    #fakeDocking: number | undefined

    constructor(readonly robot: Robot, readonly cli: () => string) {}

    /** What the axis loop is sending (for api/state). */
    get status() {
        return { moving: Date.now() < this.#until, axes: this.#axes, busy: this.#busy }
    }

    /** Holds the axes for `durationMs` (≤ MOVE_HOLD_MAX_MS); the page renews it while a drive input is held. */
    move(x: number, y: number, yaw: number, durationMs: number) {
        const ready = readiness(this.robot, "direct")
        if (!ready.ok) {
            throw new HttpError(409, `can't drive: ${ready.reason}`)
        }
        for (const [name, value] of [["x", x], ["y", y], ["yaw", yaw]] as const) {
            if (!Number.isFinite(value) || value < -1 || value > 1) {
                throw new HttpError(400, `${name} must be between -1 and 1 (a share of the robot's top speed)`)
            }
        }
        this.#axes = [x, y, yaw]
        this.#until = Date.now() + Math.max(0, Math.min(MOVE_HOLD_MAX_MS, durationMs))
        this.#stopFrames = STOP_FRAMES
        this.#loop()
        return this.status
    }

    /** Zeros now, and for a moment after (so the stop is heard). */
    stop() {
        this.#axes = [0, 0, 0]
        this.#until = 0
        this.#stopFrames = STOP_FRAMES
        this.#loop()
    }

    #loop() {
        if (this.#timer !== null) {
            return
        }
        const tick = () => {
            const moving = Date.now() < this.#until
            if (!moving) {
                this.#axes = [0, 0, 0]
                if (this.#stopFrames <= 0) {
                    clearInterval(this.#timer!)
                    this.#timer = null
                    return
                }
                this.#stopFrames--
            }
            const [X, Y, Yaw] = this.#axes
            this.robot.command(2, 21, { X, Y, Z: 0, Roll: 0, Pitch: 0, Yaw }).catch((error) =>
                logLine(`direct: axis command: ${error.message}`)
            )
        }
        tick()
        this.#timer = setInterval(tick, 1000 / AXIS_HZ)
    }

    async #wait(check: () => boolean, ms: number) {
        for (const end = Date.now() + ms; Date.now() < end;) {
            if (check()) {
                return true
            }
            await sleep(100)
        }
        return check()
    }

    /** One sequence at a time (stand, lie down, enable); `dryRun` only says what it would do. */
    async #run<T>(name: string, dryRun: boolean, plan: string[], steps: () => Promise<T>) {
        if (dryRun) {
            return { dryRun: true, wouldDo: plan }
        }
        if (this.#busy) {
            throw new HttpError(409, `busy: ${this.#busy}`)
        }
        this.#busy = name
        logLine(`direct: ${name}: ${plan.join("; ")}`)
        try {
            return { ok: true, result: await steps() }
        } catch (error) {
            const message = (error as Error).message
            logLine(`direct: ${name} failed: ${message}`)
            return { ok: false, error: message }
        } finally {
            this.#busy = null
        }
    }

    /** 2/23, then the gait report confirming it (5 s, one more try: the robot drops a gait command that arrives with
     * its own reset to Basic), as the CLI's set_gait does. */
    async #setGait(gait: number) {
        for (let attempt = 0; attempt < 2; attempt++) {
            await this.robot.command(2, 23, { GaitParam: gait })
            if (await this.#wait(() => this.robot.state.basic?.gait === gait, 5000)) {
                return
            }
        }
        throw new Error(`the robot did not confirm the ${GAIT[gait]} gait`)
    }

    /** Changes the gait (2/23), confirmed by the robot's report (MOVES THE ROBOT: its stance changes). */
    setGait(gait: number, dryRun = false) {
        if (!GAIT[gait]) {
            throw new HttpError(
                400,
                `gait must be one of ${
                    Object.entries(GAIT).map(([v, n]) => `0x${Number(v).toString(16)} (${n})`).join(", ")
                }`,
            )
        }
        const plan = [
            `gait → ${GAIT[gait]} (2/23 GaitParam 0x${gait.toString(16)})`,
            "wait for the gait report (5 s, one retry)",
        ]
        return this.#run("gait", dryRun, plan, async () => {
            if (this.robot.state.link !== "up") {
                throw new Error("no status from the robot's basic_server")
            }
            await this.#setGait(gait)
            return `gait: ${GAIT[gait]}`
        })
    }

    /** Lie down: zeros, then Sit (2/22 4) (MOVES THE ROBOT). */
    lieDown(dryRun = false) {
        return this.#run("lie down", dryRun, ["zero axes", "sit (2/22 4)"], async () => {
            this.stop()
            await this.robot.command(2, 22, { MotionParam: MOTION_SIT })
            return (await this.#wait(() => this.robot.state.basic?.motion === MOTION_SIT, 5000))
                ? "lying down"
                : "sent Sit; the robot hasn't reported sitting yet"
        })
    }

    /** The `m20` CLI on GOS: stand (Stand, RL control, THEN navigation mode, agile stairs gait: the robot resets its
     * usage mode to regular on every stand and undock, so the mode has to come after), direct (the same with regular
     * mode and the Basic gait), dock, undock (leave the dock, then stand). It checks the robot reports each step. */
    runCli(action: "stand" | "direct" | "dock" | "undock", dryRun = false) {
        const cli = this.cli()
        const plan = [`${cli} ${action}${dryRun ? " --dry-run" : ""}`]
        if (this.robot.state.source === "fake") {
            // the simulated robot: what `m20 stand` / `m20 dock` would end in
            return this.#run(`m20 ${action}`, dryRun, plan, async () => {
                const fake = this.robot.fake!
                if (action === "dock") {
                    fake.charge = 1
                    this.#fakeDocking = setTimeout(() => (fake.charge = 2), 3000)
                    return "Docking. (simulated)"
                }
                if (action === "undock") {
                    if (fake.charge === 0) {
                        throw new Error("not undocking: the robot is not on the dock")
                    }
                    clearTimeout(this.#fakeDocking)
                    fake.charge = 3
                    await sleep(1500)
                    fake.charge = 0
                    fake.usage = USAGE_REGULAR // the robot resets it on undock
                } else if (CHARGE_BUSY.has(fake.charge)) {
                    throw new Error("not going to stand: the robot is on the dock (m20 undock first)")
                }
                // stand and RL control first: the robot resets the usage mode to regular when it stands
                await this.robot.command(2, 22, { MotionParam: MOTION_STAND })
                await this.#wait(() => this.robot.state.basic?.motion === MOTION_STAND, 5000)
                fake.usage = USAGE_REGULAR
                await this.robot.command(2, 22, { MotionParam: MOTION_RL })
                await this.#wait(() => this.robot.state.basic?.motion === MOTION_RL, 5000)
                const direct = action === "direct"
                await this.robot.usageMode(direct ? USAGE_REGULAR : USAGE_NAVIGATION)
                await this.#setGait(GAIT_BASIC)
                if (!direct) {
                    await this.#setGait(GAIT_AGILE_STAIRS)
                }
                return direct
                    ? "standing in RL control, regular mode, basic gait (simulated)"
                    : "standing in RL control, navigation mode, agile stairs gait (simulated)"
            })
        }
        return this.#run(`m20 ${action}`, dryRun, plan, async () => {
            const { code, stdout, stderr } = await new Deno.Command(cli, {
                args: [action],
                stdout: "piped",
                stderr: "piped",
                env: { M20_HOST: this.robot.state.host.split(":")[0] },
                signal: AbortSignal.timeout(60_000),
            }).output()
            const text = (new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr)).trim()
            if (code !== 0) {
                throw new Error(text || `${cli} ${action} exited ${code}`)
            }
            return text
        })
    }
}
