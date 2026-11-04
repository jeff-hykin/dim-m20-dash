// The app's live parts, wired together: the boards' monitor, the blueprint watcher (always: it also decides the mode,
// below; its streams are sampled only in blueprint mode), the robot's status, direct driving, and the recording they
// all write to. applySettings() (re)starts whatever a settings change touched.
// Blueprint mode is the sticky default while a blueprint runs: at start, and whenever a new run starts, a direct mode
// left over from before goes back to blueprint (choosing direct during a run keeps it for that run).
import { logLine, setLogSink } from "./applog.ts"
import { Blueprint } from "./blueprint.ts"
import { Boards } from "./boards.ts"
import { Direct } from "./direct.ts"
import { onRecording, record, recordLog } from "./recording.ts"
import { SystemLogs } from "./syslogs.ts"
import { Robot } from "./robot.ts"
import { type Settings, settings, updateSettings } from "./settings.ts"

export const boards = new Boards(
    (board, sample) => record(`/boards/${board.config.name}/stats`, sample),
    (board) => {
        const { state, host, error } = board.link
        record(`/boards/${board.config.name}/link`, { reachable: board.reachable, link: state, host, error })
    },
)

/** the run during which someone chose direct mode (so that run keeps it) */
let directChosenFor: string | null = null

/** Direct mode chosen by a person or an agent: it holds for the blueprint run going on now. */
export function directChosen() {
    directChosenFor = blueprint.state.runId
}

export const blueprint = new Blueprint(
    () => (settings().mode === "blueprint" ? settings().blueprintStreams : []),
    (name, peeked) => record(`/blueprint/${name}`, peeked, peeked.at),
    (state, why) => {
        recordLog({ type: why, blueprint: state.blueprint, runId: state.runId })
        if (why === "blueprint_started" && settings().mode === "direct" && state.runId !== directChosenFor) {
            logLine(`mode: blueprint (${state.blueprint} is running; direct mode was left over from before it)`)
            applySettings(updateSettings({ mode: "blueprint" }))
        }
    },
)

/** basic_server's status reports (heartbeats only), each kind recorded as it comes */
const REPORT_TOPICS: Record<number, string> = {
    3: "/robot/errors",
    4: "/robot/motion",
    5: "/robot/devices",
    6: "/robot/basic",
}
export const robot = new Robot((_, command, items) => {
    if (REPORT_TOPICS[command]) {
        record(REPORT_TOPICS[command], items)
    }
})

/** the `m20` CLI (`m20 stand` / `m20 dock`): M20_DASH_CLI, else ~/.local/bin/m20 (where the M20 setup installs it) */
export const direct = new Direct(
    robot,
    () => Deno.env.get("M20_DASH_CLI") ?? `${Deno.env.get("HOME") ?? "/home/user"}/.local/bin/m20`,
)

/** the recording's system logs (syslogs.ts), on /logs, while a recording with "System logs" on runs */
export const systemLogs = new SystemLogs(
    (message) => record("/logs", message, typeof message.t === "number" ? message.t : Date.now()),
    (name) => {
        const board = boards.summary().find((b) => b.name === name)
        return board ? { stats: board.latest, reachable: board.reachable } : null
    },
)
onRecording((options) => {
    if (options?.streams.system_logs?.on) {
        const targets = boards.summary().map((b) => ({
            name: b.name,
            // the ssh target the stats link uses now, else its first
            host: b.link.state === "up" && b.link.host && !b.link.host.includes(" ") ? b.link.host : b.hosts[0],
        }))
        systemLogs.start(targets, settings().source === "fake")
        setLogSink((line) => record("/logs", { type: "app_log", t: Date.now(), line }))
    } else {
        systemLogs.stop()
        setLogSink(null)
    }
})

let applied: Settings | null = null

/** Starts what the settings ask for, restarting only what changed. */
export function applySettings(next = settings()) {
    const boardsChanged = !applied || JSON.stringify([applied.boards, applied.source, applied.patterns]) !==
            JSON.stringify([next.boards, next.source, next.patterns])
    if (boardsChanged) {
        logLine(`boards: ${next.boards.map((b) => b.name).join(", ")} via ${next.source}`)
        boards.start(next.boards, next.source, next.patterns)
    }
    const robotChanged = !applied || JSON.stringify([applied.robotStatus, applied.source]) !==
            JSON.stringify([next.robotStatus, next.source])
    if (robotChanged) {
        robot.start(next.robotStatus.host, next.robotStatus.port, next.source === "fake")
    }
    if (applied && applied.mode !== next.mode) {
        logLine(`mode: ${next.mode}`)
        recordLog({ type: "mode", mode: next.mode })
        if (next.mode === "blueprint") {
            direct.stop()
        }
    }
    blueprint.start()
    applied = structuredClone(next)
}

export function stopApp() {
    boards.stop()
    blueprint.stop()
    robot.stop()
    systemLogs.stop()
    setLogSink(null)
    applied = null
}
