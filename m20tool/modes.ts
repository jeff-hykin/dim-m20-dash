// Vendor mode vs rust mode: every vendor DrDDS service on, as shipped (vendor), or every one of them disabled, masked
// and stopped on all three boards (rust), so only dimos runs. Persistent across reboots (disable + mask, not just
// stop); our own services (network-safety, m20-camera, dimos hosts, Desktop, PTP time, Tailscale) are never touched.
// The units and why each is on the list: the SunnyVole inventory (vendor_services.md).
//
// rust_mode stops what commands the legs first (docking, obstacle handler, basic_server, rl_deploy), then the bridge
// and the SLAM it is bound to, then the drivers. vendor_mode starts them in exactly the reverse order, so the bridge
// (with localization, whose start waits for LIO output) is up before rl_deploy: a DDS reader joining while rl_deploy
// runs is what froze its state publishing on 11-20 (Fast-DDS data-sharing).
//
// What each unit was (enabled / disabled) before the first switch is saved on its board in VENDOR_STATE_FILE, so
// vendor_mode puts back that, not a guess.
import { CHARGE, CHARGE_CHARGING, CHARGE_ON_DOCK, MOTION } from "../backend/basic_server.ts"
import { AOS_IP, BOARD_PASSWORD, GOS_IP, NOS_IP, USER } from "./dog.ts"
import type { Board, RunResult } from "./remote.ts"
export type BoardName = Board["name"]

export type Mode = "rust" | "vendor"

export type VendorUnit = { board: BoardName; unit: string; what: string; mask: boolean }

/** Every vendor DrDDS unit, in rust mode's stop order (vendor mode starts them in reverse). `mask: false` = the unit
 * file lives in /etc/systemd/system, where `systemctl mask` can't put its /dev/null link: disabled only. */
export const VENDOR_UNITS: VendorUnit[] = [
    { board: "NOS", unit: "charge_manager.service", what: "autonomous docking (drives the robot)", mask: true },
    { board: "NOS", unit: "reflective_column.service", what: "dock reflector detection", mask: true },
    { board: "NOS", unit: "handler.service", what: "obstacle-avoidance steer handler", mask: false },
    { board: "AOS", unit: "basic_server.service", what: "command hub (UDP 30000 / TCP 30001)", mask: true },
    { board: "AOS", unit: "rl_deploy.service", what: "walking controller (the legs go limp)", mask: true },
    {
        board: "NOS",
        unit: "drdds-zenoh-bridge.service",
        what: "our DrDDS <-> zenoh bridge + router :7447",
        mask: false,
    },
    { board: "NOS", unit: "localization.service", what: "vendor LIO / SLAM", mask: true },
    { board: "NOS", unit: "rsdriver.service", what: "lidar driver", mask: true },
    { board: "NOS", unit: "yesense.service", what: "IMU driver", mask: true },
    { board: "NOS", unit: "cpunode.service", what: "CPU stats", mask: true },
    { board: "AOS", unit: "height_map_nav.service", what: "height map", mask: true },
    { board: "AOS", unit: "lio_perception.service", what: "perception LIO", mask: true },
    { board: "AOS", unit: "rsdriver.service", what: "lidar driver", mask: true },
    { board: "AOS", unit: "yesense.service", what: "IMU driver (/dev/ttyS9)", mask: true },
    { board: "AOS", unit: "gps_node.service", what: "GPS driver", mask: true },
    { board: "AOS", unit: "ctrlmcu.service", what: "control MCU: fans, LEDs, ext power (/dev/ttyS3)", mask: true },
    { board: "AOS", unit: "cpunode.service", what: "CPU stats", mask: true },
    { board: "GOS", unit: "cpunode.service", what: "CPU stats", mask: true },
    { board: "GOS", unit: "encryption_node.service", what: "vendor encryption node", mask: true },
]

export const BOARD_IPS: Record<BoardName, string> = { GOS: GOS_IP, AOS: AOS_IP, NOS: NOS_IP }
const BOARD_ORDER: BoardName[] = ["GOS", "AOS", "NOS"]

/** on each board, as `user`: each unit's enablement before the first switch to rust mode (`unit state` lines) */
export const VENDOR_STATE_FILE = "/home/user/.local/state/m20tool/vendor_units"

/** how a board runs a command: plain, or as root (sudo with the board password on its stdin) */
export type Exec = (board: BoardName, command: string, root: boolean) => Promise<RunResult>

/** one unit's state on its board: is-enabled ("" = no such unit there), is-active, and what was saved before */
export type UnitState = VendorUnit & { enabled: string; active: string; saved: string | null }

const unitsOn = (board: BoardName) => VENDOR_UNITS.filter((u) => u.board === board)

/** The read-only query of one board: `unit|is-enabled|is-active` per unit, then the saved file. */
export function queryCommand(board: BoardName): string {
    const units = unitsOn(board).map((u) => u.unit).join(" ")
    return `for u in ${units}; do echo "unit|$u|$(systemctl is-enabled $u 2>/dev/null)|$(systemctl is-active $u 2>/dev/null)"; done; cat ${VENDOR_STATE_FILE} 2>/dev/null || true`
}

export function parseQuery(board: BoardName, stdout: string): UnitState[] {
    const found = new Map<string, { enabled: string; active: string }>()
    const saved = new Map<string, string>()
    for (const line of stdout.split("\n")) {
        const parts = line.trim().split("|")
        if (parts[0] === "unit" && parts.length === 4) {
            found.set(parts[1], { enabled: parts[2], active: parts[3] })
        } else if (/^\S+\.service \S+$/.test(line.trim())) {
            const [unit, state] = line.trim().split(" ")
            saved.set(unit, state)
        }
    }
    return unitsOn(board).map((u) => ({
        ...u,
        enabled: found.get(u.unit)?.enabled ?? "",
        active: found.get(u.unit)?.active ?? "unknown",
        saved: saved.get(u.unit) ?? null,
    }))
}

export async function query(exec: Exec): Promise<UnitState[]> {
    const states: UnitState[] = []
    for (const board of BOARD_ORDER) {
        const result = await exec(board, queryCommand(board), false)
        if (result.code !== 0) {
            throw new Error(
                `can't read the vendor units on ${board} (${BOARD_IPS[board]}): ${result.stderr || result.stdout}`,
            )
        }
        states.push(...parseQuery(board, result.stdout))
    }
    // back in rust mode's order
    return VENDOR_UNITS.map((u) => states.find((s) => s.board === u.board && s.unit === u.unit)!)
}

const present = (s: UnitState) => s.enabled !== ""
/** what vendor mode means for this unit: its saved state, else enabled (every unit on the list ships enabled) */
const vendorWants = (s: UnitState) => s.saved === "disabled" ? "disabled" : "enabled"
const isOff = (s: UnitState) => (s.enabled === "masked" || s.enabled === "disabled") && s.active !== "active"
const isVendor = (s: UnitState) =>
    vendorWants(s) === "enabled" ? s.enabled === "enabled" && s.active === "active" : s.enabled === "disabled"

/** "rust", "vendor", or "mixed" with the units that are neither */
export function currentMode(states: UnitState[]): { mode: Mode | "mixed"; odd: UnitState[] } {
    const here = states.filter(present)
    if (here.every(isOff)) {
        return { mode: "rust", odd: [] }
    }
    if (here.every(isVendor)) {
        return { mode: "vendor", odd: [] }
    }
    return { mode: "mixed", odd: here.filter((s) => !isOff(s) && !isVendor(s)) }
}

export function describeStates(states: UnitState[]): string[] {
    const { mode, odd } = currentMode(states)
    const lines = [`mode: ${mode}${mode === "mixed" ? ` (${odd.length} unit(s) neither on nor off)` : ""}`]
    for (const s of states) {
        const state = present(s) ? `${s.enabled}, ${s.active}` : "not on this board"
        const mark = odd.includes(s) ? "  <- " : "     "
        lines.push(
            `${mark}${s.board} ${s.unit.padEnd(27)} ${state.padEnd(20)} ${s.what}${
                s.saved ? ` (vendor: ${s.saved})` : ""
            }`,
        )
    }
    return lines
}

/** What to save for vendor mode: enabled when it is enabled now; else what was saved before (a half-done switch
 * leaves units disabled or masked that vendor mode had enabled); else masked = ours (enabled), disabled = vendor's. */
function savedState(s: UnitState): string {
    if (s.enabled === "enabled") {
        return "enabled"
    }
    return s.saved ?? (s.enabled === "masked" ? "enabled" : s.enabled)
}

export type Step = { board: BoardName; root: boolean; command: string; note: string }

/** The commands that switch to `mode`, in order: idempotent (each one is a no-op on a unit already there). */
export function plan(mode: Mode, states: UnitState[]): Step[] {
    const steps: Step[] = []
    const here = states.filter(present)
    if (mode === "rust") {
        // remember vendor mode first, per board; a unit already masked keeps what was saved for it
        for (const board of BOARD_ORDER) {
            const mine = here.filter((s) => s.board === board)
            if (!mine.length) {
                continue
            }
            const lines = mine.map((s) => `${s.unit} ${savedState(s)}`)
            const file = VENDOR_STATE_FILE
            const dir = file.slice(0, file.lastIndexOf("/"))
            const body = lines.join("\\n")
            const write =
                `mkdir -p ${dir} && { [ ! -f ${file} ] || cp -p ${file} ${file}.bak; } && printf '${body}\\n' > ${file}`
            steps.push({ board, root: false, command: write, note: `save vendor mode's unit states (${file})` })
        }
        for (const s of here) {
            const commands = [`systemctl disable -q ${s.unit}`]
            if (s.mask) {
                commands.push(`systemctl mask -q ${s.unit}`)
            }
            commands.push(`systemctl stop ${s.unit}`)
            steps.push({ board: s.board, root: true, command: commands.join(" && "), note: `${s.unit}: ${s.what}` })
        }
    } else {
        for (const s of [...here].reverse()) {
            const commands = s.mask ? [`systemctl unmask -q ${s.unit}`] : []
            if (vendorWants(s) === "enabled") {
                commands.push(`systemctl enable -q ${s.unit}`, `systemctl start ${s.unit}`)
            } else if (!s.mask) {
                continue
            }
            steps.push({
                board: s.board,
                root: true,
                command: commands.join(" && "),
                note: `${s.unit}: ${s.what}${vendorWants(s) === "disabled" ? " (was disabled in vendor mode)" : ""}`,
            })
        }
    }
    return steps
}

/** what basic_server's BasicStatus says, or null when it doesn't answer */
export type RobotState = { motion: number; charge: number } | null

/** Rust mode stops the walking controller: only while the robot is down (sitting, lying, damping) or on the dock. */
export function safeToStopLegs(robot: RobotState, states: UnitState[]): { ok: boolean; why: string } {
    if (robot === null) {
        const rl = states.find((s) => s.board === "AOS" && s.unit === "rl_deploy.service")
        if (rl && rl.active === "active") {
            return { ok: false, why: "basic_server doesn't answer, but rl_deploy is running: can't tell if it stands" }
        }
        return { ok: true, why: "basic_server doesn't answer and rl_deploy isn't running: nothing drives the legs" }
    }
    const motion = `${MOTION[robot.motion] ?? robot.motion}, ${CHARGE[robot.charge] ?? robot.charge}`
    if (robot.charge === CHARGE_CHARGING || robot.charge === CHARGE_ON_DOCK) {
        return { ok: true, why: `${motion} (on the dock; it won't charge in rust mode)` }
    }
    // idle, power-on damping, sitting; never while entering or leaving the dock
    if ([0, 3, 4].includes(robot.motion) && [0, 4].includes(robot.charge)) {
        return { ok: true, why: motion }
    }
    return { ok: false, why: motion }
}

/** Runs the plan (or prints it in a dry run). Stops at the first failing step. */
export async function switchMode(
    mode: Mode,
    exec: Exec,
    robot: () => Promise<RobotState>,
    options: { dryRun: boolean; force: boolean },
    out: (line: string) => void,
): Promise<number> {
    const before = await query(exec)
    const { mode: now } = currentMode(before)
    if (mode === "rust") {
        const robotNow = await robot()
        const safe = safeToStopLegs(robotNow, before)
        if (!safe.ok && !options.force) {
            out(`not switching to rust mode: the robot isn't down or docked (${safe.why}); sit it or dock it, or --force`)
            return 1
        }
        out(`robot: ${safe.why}${safe.ok ? "" : " (--force)"}`)
    }
    if (now === mode) {
        out(`already in ${mode} mode`)
        describeStates(before).slice(1).forEach((line) => out(line))
        return 0
    }
    const steps = plan(mode, before)
    out(`${options.dryRun ? "dry run: would switch" : "switching"} from ${now} to ${mode} mode (${steps.length} steps)`)
    for (const step of steps) {
        const line = `${step.board} ${BOARD_IPS[step.board]}${
            step.root ? " (root)" : ""
        }: ${step.command}   # ${step.note}`
        out(options.dryRun ? `  ${line}` : line)
        if (options.dryRun) {
            continue
        }
        const result = await exec(step.board, step.command, step.root)
        if (result.code !== 0) {
            out(`FAILED (${result.code}): ${result.stderr || result.stdout}`)
            out(`stopped there; rerun m20tool ${mode}_mode (each step is idempotent), or m20tool mode to see where it is`)
            return 1
        }
    }
    if (options.dryRun) {
        return 0
    }
    const after = await query(exec)
    const reached = currentMode(after).mode
    out(`now: ${reached} mode`)
    if (reached !== mode) {
        describeStates(after).forEach((line) => out(line))
        return 1
    }
    return 0
}

/** On the boards: the board itself runs locally, the others over ssh as `user` (the boards' keys to each other). */
export function boardExec(
    here: BoardName | null,
    run: (target: string, command: string, stdin?: string) => Promise<RunResult>,
    local: (command: string, stdin?: string) => Promise<RunResult>,
): Exec {
    return (board, command, root) => {
        const wrapped = root ? `sudo -S -p '' sh -c '${command.replaceAll("'", "'\\''")}'` : command
        const stdin = root ? `${BOARD_PASSWORD}\n` : undefined
        return board === here ? local(wrapped, stdin) : run(`${USER}@${BOARD_IPS[board]}`, wrapped, stdin)
    }
}

/** which board this is, by its 10.21.31.x address */
export function thisBoard(addresses: string[]): BoardName | null {
    return BOARD_ORDER.find((b) => addresses.includes(BOARD_IPS[b])) ?? null
}
