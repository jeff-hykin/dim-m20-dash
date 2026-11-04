// The M20's own health, from the reports its basic_server (on AOS, UDP 10.21.31.103:30000) sends to any client that
// heartbeats: BasicStatus (1002/6: motion state, gait, charging, hard e-stop, usage mode, sleep), MotionStatus (1002/4,
// 10 Hz: attitude, height, speed), the device report (1002/5: both battery packs, every joint motor's and driver's
// temperature) and ErrorList (1002/3). This is the read-only half of what the `m20` CLI does: the ONLY frame ever sent
// is the heartbeat (Type 100, Command 100) every 0.5 s. Commands go out only through command() / usageMode(), which
// only direct.ts calls, and only from a request (a click, a held drive input): Robot itself never sends one
// (robot_test.ts checks). basic_server reports to several clients at once, so a running m20-nav keeps its own.
// With the fake boards a simulated robot fills the same state (motors that warm while it "walks").
// Needs Deno's --unstable-net (UDP); without it the state says why. The protocol itself is basic_server.ts (shared
// with m20tool/).
import { logLine } from "./applog.ts"
import {
    CHARGE,
    commandFrame,
    ERRORS,
    GAIT,
    HEADER_SIZE,
    heartbeatFrame,
    JOINTS,
    MOTION,
    parseReport,
    SLEEP,
    TCP_PORT,
    USAGE,
} from "./basic_server.ts"

export { CHARGE, commandFrame, ERRORS, GAIT, heartbeatFrame, JOINTS, MOTION, parseReport }

const HEARTBEAT_MS = 500
/** no report for this long: the link is down */
const STALE_MS = 3000
/** errors that mean the motors or their drivers are too hot */
export const OVERHEAT_ERRORS = new Set([0x8001, 0x8002, 0x8003, 0x8007, 0x8030])

export type Battery = { level: number; voltage: number; celsius: number; charging: boolean; present: boolean }
export type JointTemp = { joint: string; motor: number | null; driver: number | null }
export type RobotError = { code: number; hex: string; name: string; component: number; parts: string[] }

export type RobotState = {
    /** reachable: reports arriving; down: none for STALE_MS; off: not started; error: can't listen (why in `error`) */
    link: "connecting" | "up" | "down" | "off" | "error"
    host: string
    source: "udp" | "fake"
    error: string | null
    reportAt: number | null
    basic: {
        motion: number
        motionName: string
        gait: number
        gaitName: string
        charge: number
        chargeName: string
        hardEstop: boolean
        usage: string
        /** 0 regular (axis commands), 1 navigation (the blueprint's velocity), 2 assist */
        usageMode: number
        sleep: string
        singleBattery: boolean
        version: string | null
    } | null
    motion: {
        roll: number
        pitch: number
        yaw: number
        height: number
        vx: number
        vy: number
        wz: number
        remainKm: number
    } | null
    battery: { left: Battery; right: Battery } | null
    joints: JointTemp[]
    hottestMotor: { joint: string; celsius: number } | null
    hottestDriver: { joint: string; celsius: number } | null
    errors: RobotError[]
}

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)
const lower = (record: unknown) =>
    Object.fromEntries(Object.entries((record ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]))

function battery(raw: Record<string, unknown>, side: "left" | "right"): Battery {
    const level = num(raw[`batterylevel${side}`])
    const voltage = num(raw[`voltage${side}`])
    return {
        level,
        voltage,
        celsius: num(raw[`battery_temperature${side}`]),
        charging: !!raw[`charge${side}`],
        // an empty bay reports 0 V
        present: voltage > 0,
    }
}

function hottest(joints: JointTemp[], key: "motor" | "driver") {
    let best: { joint: string; celsius: number } | null = null
    for (const joint of joints) {
        const celsius = joint[key]
        if (celsius !== null && (!best || celsius > best.celsius)) {
            best = { joint: joint.joint, celsius }
        }
    }
    return best
}

/** The joints an error's component bits name (batteries for 0x81xx: bit 0 right, bit 1 left). */
function parts(code: number, component: number): string[] {
    if (code >= 0x8100 && code < 0x8200) {
        return [component & 1 ? "right battery" : "", component & 2 ? "left battery" : ""].filter(Boolean)
    }
    if (code >= 0x8000 && code < 0x8100) {
        return JOINTS.filter((_, bit) => component & (1 << bit))
    }
    return []
}

/** Folds one report into the state. */
export function applyReport(
    state: RobotState,
    report: { type: number; command: number; items: Record<string, unknown> },
) {
    if (report.type !== 1002) {
        return
    }
    const items = report.items
    if (report.command === 6) {
        const b = (items.BasicStatus ?? {}) as Record<string, unknown>
        const motion = num(b.MotionState, -1)
        const gait = num(b.Gait, -1)
        const charge = num(b.Charge, -1)
        state.basic = {
            motion,
            motionName: MOTION[motion] ?? `unknown (${motion})`,
            gait,
            gaitName: GAIT[gait] ?? `unknown (0x${gait.toString(16)})`,
            charge,
            chargeName: CHARGE[charge] ?? `unknown (${charge})`,
            hardEstop: !!b.HES,
            usage: USAGE[num(b.ControlUsageMode, -1)] ?? String(b.ControlUsageMode),
            usageMode: num(b.ControlUsageMode, -1),
            sleep: SLEEP[num(b.Sleep, -1)] ?? String(b.Sleep),
            singleBattery: num(b.PowerManagement) === 1,
            version: typeof b.Version === "string" ? b.Version : null,
        }
    } else if (report.command === 4) {
        const m = (items.MotionStatus ?? {}) as Record<string, unknown>
        state.motion = {
            roll: num(m.Roll),
            pitch: num(m.Pitch),
            yaw: num(m.Yaw),
            height: num(m.Height),
            vx: num(m.LinearX),
            vy: num(m.LinearY),
            wz: num(m.OmegaZ),
            remainKm: num(m.RemainMile),
        }
    } else if (report.command === 5) {
        const raw = lower(items.BatteryStatus)
        state.battery = { left: battery(raw, "left"), right: battery(raw, "right") }
        const temps = (items.DeviceTemperature ?? {}) as Record<string, unknown>
        const value = (key: string) => (typeof temps[key] === "number" ? temps[key] as number : null)
        state.joints = JOINTS.map((joint) => ({
            joint,
            motor: value(`${joint}Motor`),
            driver: value(`${joint}Driver`),
        }))
        state.hottestMotor = hottest(state.joints, "motor")
        state.hottestDriver = hottest(state.joints, "driver")
    } else if (report.command === 3) {
        const list = Array.isArray(items.ErrorList) ? items.ErrorList as Record<string, unknown>[] : []
        state.errors = list.filter((e) => e && num(e.errorCode)).map((e) => {
            const code = num(e.errorCode)
            const component = num(e.component)
            return {
                code,
                hex: `0x${code.toString(16)}`,
                name: ERRORS[code] ?? "unknown error",
                component,
                parts: parts(code, component),
            }
        })
    } else {
        return
    }
    state.reportAt = Date.now()
    state.link = "up"
}

const empty = (host: string, source: "udp" | "fake"): RobotState => ({
    link: "off",
    host,
    source,
    error: null,
    reportAt: null,
    basic: null,
    motion: null,
    battery: null,
    joints: [],
    hottestMotor: null,
    hottestDriver: null,
    errors: [],
})

/** The simulated robot's state (the fake boards' mode): what direct.ts's commands change. */
export type FakeRobot = {
    motion: number
    usage: number
    gait: number
    charge: number
    hardEstop: boolean
    axes: number[]
}

export class Robot {
    state: RobotState = empty("", "udp")
    /** the simulated robot, with the fake boards */
    fake: FakeRobot | null = null
    #host = ""
    #port = 0
    #socket: Deno.DatagramConn | null = null
    #timers: number[] = []
    #messageId = Math.floor(Math.random() * 0x10000)

    constructor(
        readonly onReport: (state: RobotState, command: number, items: Record<string, unknown>) => void = () => {},
    ) {}

    /** Heartbeats `host:port` and reads its reports (`fake`: a simulated robot instead). */
    start(host: string, port: number, fake: boolean) {
        this.stop()
        this.state = empty(fake ? "simulated" : `${host}:${port}`, fake ? "fake" : "udp")
        this.#host = host
        this.#port = port
        this.fake = null
        if (fake) {
            this.#startFake()
            return
        }
        try {
            if (typeof Deno.listenDatagram !== "function") {
                throw new Error("this Deno runs without --unstable-net (UDP)")
            }
            this.#socket = Deno.listenDatagram({ transport: "udp", hostname: "0.0.0.0", port: 0 })
        } catch (error) {
            this.state.link = "error"
            this.state.error = `can't open a UDP socket: ${(error as Error).message}`
            logLine(`robot: ${this.state.error}`)
            return
        }
        this.state.link = "connecting"
        const socket = this.#socket
        const target: Deno.NetAddr = { transport: "udp", hostname: host, port }
        const startedAt = Date.now()
        const beat = () => {
            this.#messageId = (this.#messageId + 1) & 0xffff
            socket.send(heartbeatFrame(this.#messageId), target).catch((error) => {
                if (this.state.error !== error.message) {
                    this.state.error = `heartbeat: ${error.message}`
                }
            })
            const since = Date.now() - (this.state.reportAt ?? startedAt)
            if (since > STALE_MS) {
                this.state.link = "down"
            }
        }
        beat()
        this.#timers.push(setInterval(beat, HEARTBEAT_MS))
        ;(async () => {
            try {
                for await (const [bytes] of socket) {
                    const report = parseReport(bytes)
                    if (report) {
                        applyReport(this.state, report)
                        this.state.error = null
                        this.onReport(this.state, report.command, report.items)
                    }
                }
            } catch {
                // closed
            }
        })()
        logLine(`robot: heartbeating ${host}:${port} for basic_server's status reports (heartbeats only, no commands)`)
    }

    /** One UDP command to basic_server (direct.ts only, from a request). With the fake boards it moves the simulation. */
    async command(type: number, command: number, items: Record<string, unknown>) {
        if (this.fake) {
            simulate(this.fake, type, command, items)
            return
        }
        if (!this.#socket) {
            throw new Error(this.state.error ?? "no UDP socket to basic_server")
        }
        this.#messageId = (this.#messageId + 1) & 0xffff
        await this.#socket.send(commandFrame(type, command, items, this.#messageId), {
            transport: "udp",
            hostname: this.#host,
            port: this.#port,
        })
    }

    /** The usage mode switch (1101/5 over TCP 30001): its ErrorCode (0 = done). direct.ts only, from a request. */
    async usageMode(mode: number): Promise<number> {
        if (this.fake) {
            simulate(this.fake, 1101, 5, { Mode: mode })
            return 0
        }
        this.#messageId = (this.#messageId + 1) & 0xffff
        const id = this.#messageId
        const connection = await Deno.connect({ hostname: this.#host, port: TCP_PORT })
        try {
            const timer = setTimeout(() => connection.close(), 3000)
            await connection.write(commandFrame(1101, 5, { Mode: mode }, id))
            const read = async (size: number) => {
                const out = new Uint8Array(size)
                let at = 0
                while (at < size) {
                    const n = await connection.read(out.subarray(at))
                    if (n === null) {
                        throw new Error("basic_server closed the connection")
                    }
                    at += n
                }
                return out
            }
            const header = await read(HEADER_SIZE)
            const length = new DataView(header.buffer).getUint16(4, true)
            const reply = parseReport(new Uint8Array([...header, ...(await read(length))]))
            clearTimeout(timer)
            return num((reply?.items as Record<string, unknown> | undefined)?.ErrorCode, -1)
        } finally {
            try {
                connection.close()
            } catch {
                // closed by the timer
            }
        }
    }

    #startFake() {
        const fake: FakeRobot = { motion: 4, usage: 0, gait: 0x1001, charge: 0, hardEstop: false, axes: [0, 0, 0] }
        this.fake = fake
        const started = Date.now()
        const tick = () => {
            const t = (Date.now() - started) / 1000
            const warm = 34 + 30 * (0.5 + 0.5 * Math.sin(t / 40))
            const items = (command: number): Record<string, unknown> => {
                if (command === 6) {
                    return {
                        BasicStatus: {
                            MotionState: fake.motion,
                            Gait: fake.gait,
                            Charge: fake.charge,
                            HES: fake.hardEstop ? 1 : 0,
                            ControlUsageMode: fake.usage,
                            Sleep: 0,
                            PowerManagement: 0,
                            Version: "PRO",
                        },
                    }
                }
                if (command === 4) {
                    return {
                        MotionStatus: {
                            Roll: 0.01,
                            Pitch: -0.02,
                            Yaw: (t / 10) % Math.PI,
                            Height: 0.42,
                            LinearX: fake.axes[0],
                            LinearY: fake.axes[1],
                            OmegaZ: fake.axes[2],
                            RemainMile: 6.6,
                        },
                    }
                }
                if (command === 5) {
                    const level = Math.max(5, 92 - t / 30)
                    return {
                        BatteryStatus: {
                            VoltageLeft: 82,
                            VoltageRight: 83,
                            BatteryLevelLeft: Math.round(level),
                            BatteryLevelRight: Math.round(level + 3),
                            battery_temperatureLeft: 31,
                            battery_temperatureRight: 32,
                            chargeLeft: false,
                            chargeRight: false,
                        },
                        DeviceTemperature: Object.fromEntries(JOINTS.flatMap((joint, i) => [
                            [`${joint}Motor`, Math.round((warm + (i % 4 === 2 ? 8 : 0) + i * 0.3) * 10) / 10],
                            [`${joint}Driver`, Math.round((warm + 10 + i * 0.2) * 10) / 10],
                        ])),
                    }
                }
                return {
                    ErrorList: warm + 8 > 70
                        ? [{ errorCode: 0x8001, component: 0b0100 }]
                        : [{ errorCode: 0, component: 0 }],
                }
            }
            for (const command of [6, 4, 5, 3]) {
                const report = { type: 1002, command, items: items(command) }
                applyReport(this.state, report)
                this.onReport(this.state, command, report.items)
            }
        }
        tick()
        this.#timers.push(setInterval(tick, 250))
    }

    stop() {
        this.#timers.forEach(clearInterval)
        this.#timers = []
        try {
            this.#socket?.close()
        } catch {
            // already closed
        }
        this.#socket = null
        this.state.link = "off"
    }
}

/** What a command does to the simulated robot (as basic_server would: axis commands only in regular mode, standing). */
function simulate(fake: FakeRobot, type: number, command: number, items: Record<string, unknown>) {
    if (type === 1101 && command === 5) {
        fake.usage = num(items.Mode, fake.usage)
    } else if (type === 2 && command === 22) {
        const want = num(items.MotionParam, fake.motion)
        // RL control only from a stand (the transition diagram)
        if (want !== 17 || fake.motion === 1 || fake.motion === 17) {
            setTimeout(() => (fake.motion = want), 600)
        }
    } else if (type === 2 && command === 23) {
        fake.gait = num(items.GaitParam, fake.gait)
    } else if (type === 2 && command === 21) {
        const moving = fake.usage === 0 && (fake.motion === 1 || fake.motion === 17)
        fake.axes = moving ? [num(items.X), num(items.Y), num(items.Yaw)] : [0, 0, 0]
    }
}
