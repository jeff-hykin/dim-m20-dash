// The app's live parts, wired together: the boards' monitor, the blueprint watcher (in blueprint mode) and the
// recording they both write to. applySettings() (re)starts whatever a settings change touched.
import { logLine } from "./applog.ts"
import { Blueprint } from "./blueprint.ts"
import { Boards } from "./boards.ts"
import { record, recordLog } from "./recording.ts"
import { Robot } from "./robot.ts"
import { type Settings, settings } from "./settings.ts"

export const boards = new Boards(
    (board, sample) => record(`/boards/${board.config.name}/stats`, sample),
    (board) => {
        const { state, host, error } = board.link
        record(`/boards/${board.config.name}/link`, { reachable: board.reachable, link: state, host, error })
    },
)

export const blueprint = new Blueprint(
    () => settings().blueprintStreams,
    (name, peeked) => record(`/blueprint/${name}`, peeked, peeked.at),
    (state, why) => recordLog({ type: why, blueprint: state.blueprint, runId: state.runId }),
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
    }
    if (next.mode === "blueprint") {
        blueprint.start()
    } else {
        blueprint.stop()
    }
    applied = structuredClone(next)
}

export function stopApp() {
    boards.stop()
    blueprint.stop()
    robot.stop()
    applied = null
}
