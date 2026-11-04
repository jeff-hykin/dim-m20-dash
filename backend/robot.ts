// The M20's own health, from the reports its basic_server (on AOS, UDP 10.21.31.103:30000) sends to any client that
// heartbeats: BasicStatus (1002/6: motion state, gait, charging, hard e-stop, usage mode, sleep), MotionStatus (1002/4,
// 10 Hz: attitude, height, speed), the device report (1002/5: both battery packs, every joint motor's and driver's
// temperature) and ErrorList (1002/3). This is the read-only half of what the `m20` CLI does: the ONLY frame ever sent
// is the heartbeat (Type 100, Command 100) every 0.5 s; never a command (heartbeatFrame() is the one frame builder, and
// robot_test.ts checks it). basic_server reports to several clients at once, so a running m20-nav keeps its own.
// With the fake boards a simulated robot fills the same state (motors that warm while it "walks").
// Needs Deno's --unstable-net (UDP); without it the state says why.
import { logLine } from "./applog.ts"

const HEADER_SIZE = 16
const MAGIC = [0xeb, 0x91, 0xeb, 0x90]
const HEARTBEAT_MS = 500
/** no report for this long: the link is down */
const STALE_MS = 3000

export const MOTION: Record<number, string> = {
    0: "idle",
    1: "standing",
    2: "soft e-stop",
    3: "power-on damping",
    4: "sitting",
    17: "RL control",
}
export const GAIT: Record<number, string> = {
    0x1001: "basic",
    0x1002: "high obstacles",
    0x1003: "stairs (standard)",
    0x3002: "flat (agile)",
    0x3003: "stairs (agile)",
    0x3004: "off-road (agile)",
}
export const CHARGE: Record<number, string> = {
    0: "not charging",
    1: "entering the dock",
    2: "charging",
    3: "leaving the dock",
    4: "charging error",
    5: "on the dock, not charging",
}
const USAGE: Record<number, string> = { 0: "regular", 1: "navigation", 2: "assist" }
const SLEEP: Record<number, string> = { 0: "awake", 1: "asleep", 2: "going to sleep" }
/** the vendor's error codes (the M20 software development guide, 1.3.2) */
export const ERRORS: Record<number, string> = {
    0x8001: "motor temperature warning",
    0x8002: "motor over-temperature protection",
    0x8003: "motor temperature critical shutdown",
    0x8007: "joint driver over-temperature",
    0x8008: "driver undervoltage protection",
    0x8009: "driver overvoltage protection",
    0x8012: "joint driver communication timeout",
    0x8016: "no encoder value",
    0x8020: "driver overcurrent protection",
    0x8021: "temperature sensor disconnected",
    0x8022: "joint angle limit exceeded",
    0x8024: "joint data is NaN",
    0x8025: "joint data update error",
    0x8027: "body attitude error",
    0x8028: "driver status error",
    0x8029: "motion attitude error",
    0x8030: "joint driver over-temperature warning",
    0x8102: "low battery warning",
    0x8103: "protected battery level",
    0x8106: "battery output minimum voltage protection",
    0x8107: "battery discharge over-temperature protection",
    0x8108: "battery cell undervoltage protection",
    0x8112: "battery discharge low-temperature protection",
    0x8115: "battery charging over-temperature protection",
    0x8116: "battery charge low-temperature protection",
    0x8117: "battery cell overvoltage protection",
    0x8118: "battery pack overvoltage protection",
    0x8119: "battery pack undervoltage protection",
    0x8120: "battery charging overcurrent protection",
    0x8121: "battery discharge overcurrent protection",
    0x8122: "short circuit protection",
    0x8123: "battery front-end detection IC error",
    0x8124: "battery software MOS lock",
    0x8125: "battery discharge over-temperature warning",
    0x8126: "battery discharge low-temperature warning",
    0x8127: "battery charging over-temperature warning",
    0x8128: "battery charging low-temperature warning",
    0x8129: "battery output minimum voltage warning",
    0x8201: "CPU usage overload warning",
    0x8202: "CPU temperature overheat warning",
    0x8211: "CPU usage overload protection",
    0x8212: "CPU temperature overheat protection",
    0x8501: "charging: positioning data timeout",
    0x8502: "charging: reflector localization failed to start",
    0x8503: "charging: no position (reflectors not found)",
    0x8506: "charging: no current from the dock",
    0x8509: "charging: dock entry timeout",
    0x8510: "charging: dock exit timeout",
}
/** errors that mean the motors or their drivers are too hot */
export const OVERHEAT_ERRORS = new Set([0x8001, 0x8002, 0x8003, 0x8007, 0x8030])
/** the joints in the vendor's order (the error report's component bits follow it) */
export const JOINTS = ["LeftFront", "RightFront", "LeftBack", "RightBack"].flatMap((leg) =>
    ["HipX", "HipY", "Knee", "Wheel"].map((joint) => `${leg}${joint}`)
)

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

/** The one frame this module sends: basic_server's heartbeat (Type 100, Command 100, no items). */
export function heartbeatFrame(messageId: number, now = new Date()): Uint8Array {
    const pad = (n: number) => String(n).padStart(2, "0")
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${
        pad(now.getMinutes())
    }:${pad(now.getSeconds())}`
    const payload = new TextEncoder().encode(
        JSON.stringify({ PatrolDevice: { Type: 100, Command: 100, Time: time, Items: {} } }),
    )
    const frame = new Uint8Array(HEADER_SIZE + payload.length)
    const view = new DataView(frame.buffer)
    frame.set(MAGIC, 0)
    view.setUint16(4, payload.length, true)
    view.setUint16(6, messageId & 0xffff, true)
    frame[8] = 1 // JSON
    frame.set(payload, HEADER_SIZE)
    return frame
}

/** A report frame's PatrolDevice, or null for anything else. */
export function parseReport(
    bytes: Uint8Array,
): { type: number; command: number; items: Record<string, unknown> } | null {
    if (bytes.length < HEADER_SIZE || MAGIC.some((b, i) => bytes[i] !== b)) {
        return null
    }
    try {
        const device = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_SIZE))).PatrolDevice
        if (device && typeof device.Type === "number" && device.Items && typeof device.Items === "object") {
            return { type: device.Type, command: device.Command, items: device.Items }
        }
    } catch {
        // not JSON
    }
    return null
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

export class Robot {
    state: RobotState = empty("", "udp")
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

    #startFake() {
        const started = Date.now()
        const tick = () => {
            const t = (Date.now() - started) / 1000
            const warm = 34 + 30 * (0.5 + 0.5 * Math.sin(t / 40))
            const items = (command: number): Record<string, unknown> => {
                if (command === 6) {
                    return {
                        BasicStatus: {
                            MotionState: 1,
                            Gait: 0x3002,
                            Charge: 0,
                            HES: 0,
                            ControlUsageMode: 1,
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
                            LinearX: 0,
                            LinearY: 0,
                            OmegaZ: 0,
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
        this.#timers.push(setInterval(tick, 1000))
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
