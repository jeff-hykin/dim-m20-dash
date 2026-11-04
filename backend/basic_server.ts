// The M20 vendor basic_server protocol (on AOS, 10.21.31.103: UDP 30000 for the heartbeat, commands and status reports,
// TCP 30001 for the usage-mode switch), per the M20 Software Development Guide section 1: a 16-byte header
// [eb 91 eb 90, payload length LE16, message id LE16, 01 = JSON, 7 zero bytes] + the JSON {"PatrolDevice": {...}}.
// Shared by robot.ts (M20 Ctrl) and m20tool/ (the CLI). No imports and no I/O here: frames and tables only.

export const HEADER_SIZE = 16
export const MAGIC = [0xeb, 0x91, 0xeb, 0x90]
export const DEFAULT_HOST = "10.21.31.103"
export const UDP_PORT = 30000
/** basic_server's TCP port (the usage mode switch answers there) */
export const TCP_PORT = 30001

export const MOTION_STAND = 1
export const MOTION_SIT = 4
export const MOTION_RL = 17
export const MOTION: Record<number, string> = {
    0: "idle",
    1: "standing",
    2: "soft e-stop",
    3: "power-on damping",
    4: "sitting",
    17: "RL control",
}
export const GAIT_BASIC = 0x1001
export const GAIT_STAIRS_AGILE = 0x3003
export const GAIT: Record<number, string> = {
    0x1001: "basic",
    0x1002: "high obstacles",
    0x1003: "stairs (standard)",
    0x3002: "flat (agile)",
    0x3003: "stairs (agile)",
    0x3004: "off-road (agile)",
}
export const CHARGE_IDLE = 0
export const CHARGE_ENTERING = 1
export const CHARGE_CHARGING = 2
export const CHARGE_EXITING = 3
export const CHARGE_ERROR = 4
export const CHARGE_ON_DOCK = 5
export const CHARGE: Record<number, string> = {
    0: "not charging",
    1: "entering the dock",
    2: "charging",
    3: "leaving the dock",
    4: "charging error",
    5: "on the dock, not charging",
}
/** the charge states that mean it is on (or getting on/off) the dock */
export const CHARGE_BUSY = new Set([CHARGE_ENTERING, CHARGE_CHARGING, CHARGE_EXITING, CHARGE_ON_DOCK])
export const USAGE_REGULAR = 0
export const USAGE_NAVIGATION = 1
export const USAGE: Record<number, string> = { 0: "regular", 1: "navigation", 2: "assist" }
export const SLEEP: Record<number, string> = { 0: "awake", 1: "asleep", 2: "going to sleep" }
/** report commands (Type 1002) */
export const REPORT_ERRORS = 3
export const REPORT_MOTION = 4
export const REPORT_DEVICE = 5
export const REPORT_BASIC = 6
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
/** the docking errors (0x85xx) */
export const CHARGE_ERRORS = new Set([0x8501, 0x8502, 0x8503, 0x8506, 0x8509, 0x8510])
/** the joints in the vendor's order (the error report's component bits follow it) */
export const JOINTS = ["LeftFront", "RightFront", "LeftBack", "RightBack"].flatMap((leg) =>
    ["HipX", "HipY", "Knee", "Wheel"].map((joint) => `${leg}${joint}`)
)

/** basic_server's "Time" field: local time, YYYY-MM-DD HH:MM:SS */
export function timeString(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${
        pad(now.getMinutes())
    }:${pad(now.getSeconds())}`
}

/** the vendor guide's float fields (the axis command's), when JSON.stringify wrote them as integers */
const FLOAT_FIELD_INTEGER = /("(?:X|Y|Z|Roll|Pitch|Yaw)":)(-?\d+)(?=[,}])/g

/** The JSON a frame carries (the axis command's float fields always with a decimal point). */
export function framePayload(type: number, command: number, items: Record<string, unknown>, now = new Date()) {
    const json = JSON.stringify({ PatrolDevice: { Type: type, Command: command, Time: timeString(now), Items: items } })
    // basic_server ignores an axis command whose numbers are JSON integers ("X":0 rather than 0.0; seen live: a
    // turn-only frame, all integers but Yaw, didn't turn): the float fields always go out with a decimal point
    return json.replace(FLOAT_FIELD_INTEGER, "$1$2.0")
}

/** A frame (Type/Command/Items), the shape basic_server takes on UDP 30000 and TCP 30001. */
export function commandFrame(
    type: number,
    command: number,
    items: Record<string, unknown>,
    messageId: number,
    now = new Date(),
): Uint8Array {
    const payload = new TextEncoder().encode(framePayload(type, command, items, now))
    const frame = new Uint8Array(HEADER_SIZE + payload.length)
    const view = new DataView(frame.buffer)
    frame.set(MAGIC, 0)
    view.setUint16(4, payload.length, true)
    view.setUint16(6, messageId & 0xffff, true)
    frame[8] = 1 // JSON
    frame.set(payload, HEADER_SIZE)
    return frame
}

/** basic_server's heartbeat (Type 100, Command 100, no items): it reports status to whoever sends it. */
export function heartbeatFrame(messageId: number, now = new Date()): Uint8Array {
    return commandFrame(100, 100, {}, messageId, now)
}

/** A frame's PatrolDevice, or null for anything else. */
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

/** The header's message id (for matching a TCP reply). */
export function messageIdOf(bytes: Uint8Array): number {
    return new DataView(bytes.buffer, bytes.byteOffset).getUint16(6, true)
}

/** "the hex string" of a frame's header, for printing. */
export function headerHex(frame: Uint8Array): string {
    return [...frame.subarray(0, HEADER_SIZE)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
