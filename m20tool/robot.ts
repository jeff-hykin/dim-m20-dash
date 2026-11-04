// The robot commands (stand, direct, lie_down, dock, undock, stop, status, battery), straight to the vendor's
// basic_server on AOS: a port of the Python `m20` CLI (~/m20_setup/board_files/m20), with the same sequences and
// checks. The frames themselves come from ../backend/basic_server.ts, which M20 Ctrl uses too.
//
// Gotchas it keeps: basic_server resets the usage mode to regular (and the gait to Basic) on every sit->stand and on
// undock, so the mode is set AFTER standing; the axis command's float fields always go out as floats (basic_server
// drops "X":0); dock watches for up to 150 s, so by default it hands the watching to a background copy of itself.
import {
    CHARGE,
    CHARGE_BUSY,
    CHARGE_CHARGING,
    CHARGE_ENTERING,
    CHARGE_ERROR,
    CHARGE_ERRORS,
    CHARGE_EXITING,
    CHARGE_IDLE,
    CHARGE_ON_DOCK,
    commandFrame,
    ERRORS,
    GAIT,
    GAIT_BASIC,
    GAIT_STAIRS_AGILE,
    HEADER_SIZE,
    headerHex,
    heartbeatFrame,
    messageIdOf,
    MOTION,
    MOTION_RL,
    MOTION_SIT,
    MOTION_STAND,
    parseReport,
    REPORT_BASIC,
    REPORT_DEVICE,
    REPORT_ERRORS,
    REPORT_MOTION,
    TCP_PORT,
    UDP_PORT,
    USAGE,
    USAGE_NAVIGATION,
    USAGE_REGULAR,
} from "../backend/basic_server.ts"

export class Fail extends Error {}

type Items = Record<string, unknown>
type Status = Record<string, unknown>

const now = () => performance.now() / 1000
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

/** One UDP socket that heartbeats at 2 Hz and keeps the latest report of each kind; in a dry run it only prints. */
export class Link {
    #socket: Deno.DatagramConn | null = null
    #messageId = Math.floor(Math.random() * 0x10000)
    #reports = new Map<number, { at: number; items: Items }>()
    #waiters = new Set<() => void>()
    #timer: number | undefined
    /** every frame sent (type, command, items), for tests */
    sent: { protocol: "UDP" | "TCP"; type: number; command: number; items: Items }[] = []

    constructor(
        readonly host: string,
        readonly dryRun: boolean,
        readonly out: (line: string) => void = console.log,
        readonly udpPort = UDP_PORT,
        readonly tcpPort = TCP_PORT,
    ) {
        if (dryRun) {
            out(
                "dry run: nothing is sent. Every frame is a 16-byte header [eb91eb90, payload length LE16, message id LE16, 01=JSON, 7 zero bytes] + the JSON.",
            )
            this.udp(
                100,
                100,
                {},
                "heartbeat, repeated every 0.5 s while this runs, so basic_server reports status to this socket",
            )
            return
        }
        this.#socket = Deno.listenDatagram({ transport: "udp", hostname: "0.0.0.0", port: 0 })
        const beat = () => {
            this.#messageId = (this.#messageId + 1) & 0xffff
            this.sent.push({ protocol: "UDP", type: 100, command: 100, items: {} })
            this.#socket?.send(heartbeatFrame(this.#messageId), this.#target()).catch(() => {})
        }
        beat()
        this.#timer = setInterval(beat, 500)
        this.#read()
    }

    #target(): Deno.NetAddr {
        return { transport: "udp", hostname: this.host, port: this.udpPort }
    }

    async #read() {
        try {
            for await (const [bytes] of this.#socket!) {
                const report = parseReport(bytes)
                if (report && report.type === 1002) {
                    this.#reports.set(report.command, { at: now(), items: report.items })
                    this.#waiters.forEach((wake) => wake())
                }
            }
        } catch {
            // closed
        }
    }

    #frame(type: number, command: number, items: Items) {
        this.#messageId = (this.#messageId + 1) & 0xffff
        return { id: this.#messageId, frame: commandFrame(type, command, items, this.#messageId) }
    }

    #show(protocol: string, port: number, frame: Uint8Array, note: string) {
        this.out(
            `${protocol} ${this.host}:${port}  ${new TextDecoder().decode(frame.subarray(HEADER_SIZE))}  [header ${
                headerHex(frame)
            }]  # ${note}`,
        )
    }

    /** One UDP frame to basic_server. */
    async udp(type: number, command: number, items: Items, note: string) {
        const { frame } = this.#frame(type, command, items)
        this.sent.push({ protocol: "UDP", type, command, items })
        if (this.dryRun) {
            this.#show("UDP", this.udpPort, frame, note)
            return
        }
        await this.#socket!.send(frame, this.#target())
    }

    /** One TCP request (the usage mode switch), returning its reply's Items. */
    async tcp(type: number, command: number, items: Items, note: string): Promise<Items> {
        const { id, frame } = this.#frame(type, command, items)
        this.sent.push({ protocol: "TCP", type, command, items })
        if (this.dryRun) {
            this.#show("TCP", this.tcpPort, frame, `${note}; reads the reply`)
            return { ErrorCode: 0 }
        }
        const connection = await Deno.connect({ hostname: this.host, port: this.tcpPort })
        const timer = setTimeout(() => connection.close(), 3000)
        try {
            await connection.write(frame)
            const read = async (size: number) => {
                const buffer = new Uint8Array(size)
                let at = 0
                while (at < size) {
                    const n = await connection.read(buffer.subarray(at))
                    if (n === null) {
                        throw new Fail("basic_server closed the connection before replying")
                    }
                    at += n
                }
                return buffer
            }
            const header = await read(HEADER_SIZE)
            const length = new DataView(header.buffer).getUint16(4, true)
            const reply = new Uint8Array([...header, ...(await read(length))])
            const parsed = parseReport(reply)
            if (!parsed || messageIdOf(reply) !== id || reply[8] !== 1) {
                throw new Fail(`basic_server sent a malformed reply to ${type}/${command}`)
            }
            return parsed.items
        } finally {
            clearTimeout(timer)
            try {
                connection.close()
            } catch {
                // closed by the timer
            }
        }
    }

    done(text: string) {
        this.out(this.dryRun ? `  (on success prints: ${text})` : text)
    }

    note(text: string) {
        if (this.dryRun) {
            this.out(`  ${text}`)
        }
    }

    /** Resolves when a report arrives or `seconds` pass. */
    #nextReport(seconds: number) {
        return new Promise<void>((resolve) => {
            const wake = () => {
                clearTimeout(timer)
                this.#waiters.delete(wake)
                resolve()
            }
            const timer = setTimeout(wake, Math.max(0, seconds * 1000))
            this.#waiters.add(wake)
        })
    }

    /** The latest report of this kind received after `newerThan` (seconds, performance clock), waiting up to `timeout`; null in a dry run. */
    async report(command: number, newerThan = 0, timeout = 3): Promise<Items | null> {
        if (this.dryRun) {
            return null
        }
        const deadline = now() + timeout
        while (true) {
            const latest = this.#reports.get(command)
            if (latest && latest.at > newerThan) {
                return latest.items
            }
            const left = deadline - now()
            if (left <= 0) {
                return null
            }
            await this.#nextReport(left)
        }
    }

    /** BasicStatus (1002/6) newer than `newerThan`; throws when basic_server doesn't answer; null in a dry run. */
    async basic(newerThan = 0, timeout = 3): Promise<Status | null> {
        const items = await this.report(REPORT_BASIC, newerThan, timeout)
        if (items === null) {
            if (this.dryRun) {
                return null
            }
            throw new Fail(
                `no status from basic_server at ${this.host}:${this.udpPort} (is AOS up and basic_server running?)`,
            )
        }
        return (items.BasicStatus ?? {}) as Status
    }

    /** Waits until BasicStatus[field] == value; true if it got there. */
    async wait(field: string, value: number, timeout: number, label: string): Promise<boolean> {
        if (this.dryRun) {
            this.out(`  then wait up to ${timeout} s for BasicStatus.${field} == ${value} (${label})`)
            return true
        }
        const deadline = now() + timeout
        while (true) {
            const items = this.#reports.get(REPORT_BASIC)?.items
            if (((items?.BasicStatus ?? {}) as Status)[field] === value) {
                return true
            }
            const left = deadline - now()
            if (left <= 0) {
                return false
            }
            await this.#nextReport(left)
        }
    }

    close() {
        clearInterval(this.#timer)
        try {
            this.#socket?.close()
        } catch {
            // already closed
        }
        this.#socket = null
    }
}

const name = (table: Record<number, string>, value: unknown) =>
    `${table[value as number] ?? "unknown"} (${
        table === GAIT && typeof value === "number" ? `0x${value.toString(16)}` : value
    })`

async function refuseOnDock(link: Link, action: string) {
    link.note(`(refuses to ${action} if BasicStatus.Charge is not 0 = idle; run m20tool undock first)`)
    const status = await link.basic()
    if (status && CHARGE_BUSY.has(status.Charge as number)) {
        throw new Fail(`not going to ${action}: the robot is ${CHARGE[status.Charge as number]} (m20tool undock first)`)
    }
    return status
}

async function zeroVelocity(link: Link, frames: number) {
    for (let i = 0; i < frames; i++) {
        await link.udp(2, 21, { X: 0, Y: 0, Z: 0, Roll: 0, Pitch: 0, Yaw: 0 }, "axis command, all zero")
        if (link.dryRun) {
            if (frames > 1) {
                link.out(`  (sent ${frames} times at 20 Hz)`)
            }
            return
        }
        await sleep(0.05)
    }
}

async function setGait(link: Link, gait: number) {
    // The robot drops a gait command that arrives with its own reset to Basic, so it gets a second try (as in dimos).
    for (let attempt = 0; attempt < 2; attempt++) {
        await link.udp(2, 23, { GaitParam: gait }, `gait -> ${GAIT[gait]}`)
        if (
            await link.wait(
                "Gait",
                gait,
                5,
                GAIT[gait] + (link.dryRun ? "; on a miss it sends the gait once more" : ""),
            )
        ) {
            return
        }
    }
    throw new Fail(`the robot did not confirm the ${GAIT[gait]} gait`)
}

/**
 * Stand, RL Control, then the usage mode, then the gait, and confirm all three in a fresh report.
 * The order matters: basic_server resets the usage mode to regular (and the gait to Basic) when the robot stands up
 * from Sit and when it leaves the dock (its log: "VelControl 设置控制模式:0"), so a mode set before standing is lost.
 */
async function ready(link: Link, usage: number, gait: number, label: string) {
    await refuseOnDock(link, "stand")
    let status = await link.basic(now())
    const motion = status?.MotionState
    if (motion !== MOTION_RL) {
        link.note("(the stand steps are skipped if BasicStatus.MotionState is already 17 = RL control)")
        if (motion !== MOTION_STAND) {
            link.note("(the Stand step is skipped if BasicStatus.MotionState is already 1 = stand)")
            await link.udp(2, 22, { MotionParam: MOTION_STAND }, "motion state -> stand")
            if (!(await link.wait("MotionState", MOTION_STAND, 12, "stand"))) {
                throw new Fail("the robot did not confirm Stand within 12 s")
            }
        }
        await link.udp(2, 22, { MotionParam: MOTION_RL }, "motion state -> RL control")
        if (!(await link.wait("MotionState", MOTION_RL, 5, "RL control"))) {
            throw new Fail("the robot did not confirm RL Control within 5 s")
        }
    }
    const reply = await link.tcp(
        1101,
        5,
        { Mode: usage },
        `usage mode -> ${USAGE[usage]} (after standing: standing up resets it)`,
    )
    if (reply.ErrorCode !== 0) {
        throw new Fail(
            `basic_server refused ${USAGE[usage]} mode (ErrorCode ${reply.ErrorCode}): ${JSON.stringify(reply)}`,
        )
    }
    if (!(await link.wait("ControlUsageMode", usage, 3, `${USAGE[usage]} mode`))) {
        const now_ = await link.basic()
        throw new Fail(
            `basic_server accepted ${USAGE[usage]} mode but still reports ${USAGE[now_?.ControlUsageMode as number]}`,
        )
    }
    // A mode change makes basic_server switch to Basic itself; a gait sent during that reset is dropped, so confirm Basic first.
    await setGait(link, GAIT_BASIC)
    if (gait !== GAIT_BASIC) {
        await setGait(link, gait)
    }
    link.note("(then checks a report newer than the gait switch shows RL control, this usage mode and this gait)")
    status = await link.basic(now())
    if (status) {
        const got = [status.MotionState, status.ControlUsageMode, status.Gait] as number[]
        if (got[0] !== MOTION_RL || got[1] !== usage || got[2] !== gait) {
            throw new Fail(
                `not ready: the robot reports ${MOTION[got[0]] ?? got[0]}, ${USAGE[got[1]] ?? got[1]} mode, gait ${
                    GAIT[got[2]] ?? got[2]
                }`,
            )
        }
    }
    link.done(`standing in RL control, ${USAGE[usage]} mode, ${GAIT[gait]} gait: ${label}`)
}

/** What dimos drives through (/NAV_CMD): navigation mode and the agile stairs gait, as M20Connection.standup(). */
export function stand(link: Link) {
    return ready(
        link,
        USAGE_NAVIGATION,
        GAIT_STAIRS_AGILE,
        "dimos velocity (M20 Ctrl blueprint mode, the Controller) drives it",
    )
}

/** What axis commands (2/21) drive: regular mode and the Basic gait (the vendor's manual-control gait). */
export function direct(link: Link) {
    return ready(link, USAGE_REGULAR, GAIT_BASIC, "axis commands (M20 Ctrl direct mode) drive it")
}

export async function lieDown(link: Link) {
    await refuseOnDock(link, "lie down")
    await zeroVelocity(link, 1)
    await link.udp(2, 22, { MotionParam: MOTION_SIT }, "motion state -> sit")
    if (await link.wait("MotionState", MOTION_SIT, 5, "sit")) {
        link.done("lying down")
    } else {
        console.error("sent Sit, but the robot did not report sit within 5 s")
    }
}

export async function stop(link: Link) {
    const status = await refuseOnDock(link, "stop")
    await zeroVelocity(link, 10)
    link.note("(prints a warning if BasicStatus.ControlUsageMode is 1 = navigation, where axis commands are ignored)")
    if (status?.ControlUsageMode === USAGE_NAVIGATION) {
        console.error(
            "sent zero velocity, but the robot is in navigation mode, where it follows /NAV_CMD (dimos) and ignores axis commands; m20tool lie_down halts it",
        )
    } else {
        link.done("sent zero velocity")
    }
}

async function chargeErrors(link: Link, since: number) {
    const items = (await link.report(REPORT_ERRORS, since, 0)) ?? {}
    const list = Array.isArray(items.ErrorList) ? items.ErrorList as Record<string, unknown>[] : []
    return list.map((e) => e?.errorCode as number).filter((code) => CHARGE_ERRORS.has(code))
}

/**
 * Start autonomous charging, then watch it. `watch`: "background" (default) confirms the robot took the command, then
 * hands the watching to a detached copy of this program (`dock --watch`, logging to `log`), so the caller returns at
 * once; "foreground" watches here; "only" is that detached copy (sends nothing but the abort on a failure).
 */
export async function dock(
    link: Link,
    watch: "background" | "foreground" | "only" = "background",
    startBackground: () => Promise<string> = () => Promise.resolve(""),
) {
    if (watch !== "only") {
        link.note(
            "(refuses unless BasicStatus.Charge is 0 = idle and BasicStatus.MotionState is 17 = RL control, i.e. after m20tool stand)",
        )
        const status = await link.basic()
        if (status) {
            if (status.Charge !== CHARGE_IDLE) {
                throw new Fail(`not docking: the robot is ${CHARGE[status.Charge as number] ?? status.Charge}`)
            }
            if (status.MotionState !== MOTION_RL) {
                throw new Fail("not docking: the robot is not standing ready to walk (m20tool stand first)")
            }
        }
        await link.udp(2, 24, { Charge: 1 }, "autonomous charging -> start (dock)")
    }
    if (link.dryRun) {
        if (watch === "background") {
            link.out(
                "  then waits up to 5 s for BasicStatus.Charge to leave 0 = idle (else fails: the robot did not accept the dock command),",
            )
            link.out("  then starts `m20tool dock --watch` in the background (log ~/m20_dock.log), which:")
        }
        link.out(
            "  watches BasicStatus.Charge for up to 150 s: 2 = charging is success; 4 = error, 3 = backing off, or back to 0 = idle is failure,",
        )
        link.out("  and on a failure while 1 = entering or 5 = on the dock not charging it sends:")
        await link.udp(2, 24, { Charge: 0 }, "autonomous charging -> stop")
        return
    }
    const started = now()
    let entered = watch === "only"
    let reported: unknown = undefined
    while (true) {
        const status = (await link.basic(now()))!
        const charge = status.Charge as number
        const elapsed = now() - started
        entered = entered || charge !== CHARGE_IDLE
        if (charge !== reported) {
            link.out(`charge: ${CHARGE[charge] ?? charge}`)
            reported = charge
        }
        if (charge === CHARGE_CHARGING) {
            link.out("docked and charging")
            return
        }
        if (watch === "background" && entered) {
            link.out(await startBackground())
            return
        }
        let failure = ""
        if (charge === CHARGE_ERROR) {
            failure = "the robot reported a charging error"
        } else if (charge === CHARGE_EXITING) {
            failure = "the robot gave up and is backing off the dock"
        } else if (charge === CHARGE_IDLE && entered) {
            failure = "the robot stopped docking and returned to idle"
        } else if (charge === CHARGE_IDLE && elapsed >= 5) {
            failure = "the robot did not accept the dock command"
        } else if (elapsed >= 150) {
            failure = charge === CHARGE_ON_DOCK ? "the robot is on the dock but not charging" : "timed out after 150 s"
        }
        if (failure) {
            if (charge === CHARGE_ENTERING || charge === CHARGE_ON_DOCK) {
                await link.udp(2, 24, { Charge: 0 }, "autonomous charging -> stop")
            }
            const errors = (await chargeErrors(link, started)).map((c) => `0x${c.toString(16)} ${ERRORS[c]}`).join(", ")
            throw new Fail(
                `docking failed: ${failure}${
                    errors ? ` (${errors})` : ""
                }; m20tool status, then m20tool stand to walk again`,
            )
        }
    }
}

export async function undock(link: Link) {
    link.note("(refuses if BasicStatus.Charge is 0 = idle: not on the dock)")
    let status = await link.basic()
    if (status && status.Charge === CHARGE_IDLE) {
        throw new Fail("not undocking: the robot is not on the dock")
    }
    if (!status || status.Charge !== CHARGE_EXITING) {
        link.note("(skipped if BasicStatus.Charge is already 3 = exiting the dock)")
        await link.udp(2, 24, { Charge: 0 }, "autonomous charging -> stop (undock)")
    }
    const started = now()
    if (link.dryRun) {
        link.out(
            "  then wait up to 45 s for BasicStatus.Charge == 0 (idle), failing on a charging error code, then stands:",
        )
    } else {
        while (true) {
            status = (await link.basic(now()))!
            const elapsed = now() - started
            if (elapsed >= 1) {
                const errors = await chargeErrors(link, started + 1)
                if (errors.length) {
                    throw new Fail(`undocking failed: 0x${errors[0].toString(16)} ${ERRORS[errors[0]]}`)
                }
                if (status.Charge === CHARGE_IDLE) {
                    break
                }
            }
            if (elapsed >= 45) {
                throw new Fail(
                    `undocking failed: not off the dock after 45 s (charge: ${CHARGE[status.Charge as number]})`,
                )
            }
        }
        link.done("off the dock")
    }
    // Leaving the dock (Charge -> idle) resets the usage mode to regular, so this stands after that, never before.
    await stand(link)
}

function batteryLines(device: Items): string[] {
    const battery = Object.fromEntries(
        Object.entries((device.BatteryStatus ?? {}) as Items).map(([key, value]) => [key.toLowerCase(), value]),
    )
    if (!Object.keys(battery).length) {
        return []
    }
    const side = (s: string) => {
        const voltage = battery[`voltage${s}`]
        if (voltage === 0) {
            return `${s}: empty bay`
        }
        const temp = battery[`battery_temperature${s}`]
        return `${s}: ${battery[`batterylevel${s}`] ?? "?"}% ${voltage ?? "?"} V${
            typeof temp === "number" ? ` ${Math.round(temp * 10) / 10} C` : ""
        }${battery[`charge${s}`] ? " charging" : ""}`
    }
    return [`battery: ${side("left")}, ${side("right")}`]
}

/** Motion state, gait, usage mode, charge, battery, errors (heartbeats only: sends no command). */
export async function status(link: Link) {
    const started = now()
    const basic = await link.basic()
    const device = (await link.report(REPORT_DEVICE, 0, Math.max(0, 3 - (now() - started)))) ?? {}
    const motion = (await link.report(REPORT_MOTION, 0, 0)) ?? {}
    const errors = (await link.report(REPORT_ERRORS, 0, 0.6)) ?? {}
    if (link.dryRun || !basic) {
        link.out(
            "  then prints the BasicStatus (1002/6), MotionStatus (1002/4), device (1002/5) and ErrorList (1002/3) reports it receives",
        )
        return
    }
    link.out(
        `motion: ${name(MOTION, basic.MotionState)}   gait: ${name(GAIT, basic.Gait)}   usage mode: ${
            name(USAGE, basic.ControlUsageMode)
        }`,
    )
    link.out(
        `charge: ${name(CHARGE, basic.Charge)}   hard e-stop: ${
            basic.HES ? "TRIGGERED" : "no"
        }   sleep: ${basic.Sleep}   version: ${basic.Version}`,
    )
    batteryLines(device).forEach((line) => link.out(line))
    const m = (motion.MotionStatus ?? {}) as Record<string, number>
    if (Object.keys(m).length) {
        const f = (v: number | undefined) => (v ?? 0).toFixed(2)
        link.out(
            `height: ${f(m.Height)} m   speed: x ${f(m.LinearX)} y ${f(m.LinearY)} m/s, yaw ${f(m.OmegaZ)} rad/s`,
        )
    }
    const list = (Array.isArray(errors.ErrorList) ? errors.ErrorList : []) as Record<string, number>[]
    const real = list.filter((e) => e && e.errorCode)
    link.out(
        "errors: " +
            (real.map((e) =>
                `0x${e.errorCode.toString(16)} ${ERRORS[e.errorCode] ?? "unknown error"} (component ${e.component})`
            ).join(", ") || "none"),
    )
}

/** Both battery packs and the charge state (heartbeats only: sends no command). */
export async function battery(link: Link) {
    const basic = await link.basic()
    const device = await link.report(REPORT_DEVICE, 0, 3)
    if (link.dryRun) {
        link.out("  then prints the battery packs from the device report (1002/5) and BasicStatus.Charge")
        return
    }
    const lines = batteryLines(device ?? {})
    if (!lines.length) {
        throw new Fail("no battery report from basic_server within 3 s")
    }
    lines.forEach((line) => link.out(line))
    link.out(`charge: ${name(CHARGE, basic?.Charge)}`)
}

export const COMMANDS = {
    stand: {
        run: stand,
        actuates: true,
        about: "ready for dimos: Stand, RL Control, navigation mode, agile stairs gait",
    },
    direct: {
        run: direct,
        actuates: true,
        about: "ready for axis driving: Stand, RL Control, regular mode, Basic gait",
    },
    lie_down: { run: lieDown, actuates: true, about: "zero velocity, then Sit" },
    dock: {
        run: dock,
        actuates: true,
        about:
            "start autonomous charging (stand ~2 m in front of the dock, facing both reflectors); watched in the background",
    },
    undock: { run: undock, actuates: true, about: "leave the dock, then stand (as m20tool stand)" },
    stop: { run: stop, actuates: true, about: "zero velocity (regular mode only; in navigation mode use lie_down)" },
    status: {
        run: status,
        actuates: false,
        about: "motion state, gait, usage mode, charge, battery, errors (read-only)",
    },
    battery: { run: battery, actuates: false, about: "both battery packs and the charge state (read-only)" },
} as const
export type CommandName = keyof typeof COMMANDS
