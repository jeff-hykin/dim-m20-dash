// The app log: every notice, board sample, button press, motion request and recording event, timestamped,
// appended to <data dir>/m20-ctrl.log (and stderr). Rotated to m20-ctrl.log.1 past LOG_LIMIT. While a recording runs,
// the structured events also go to its /logs (recording.ts); this file is the one that survives without one.
import { dataDir } from "./dimos_app.ts"

export const LOG_FILE = "m20-ctrl.log"
const LOG_LIMIT = 20 * 1024 * 1024
const MAX_LINE = 4000

let path: string | null = null

/** Opens the log in the data dir (main.ts); before this nothing is written (the tests). */
export function initLog(dir = dataDir()) {
    try {
        Deno.mkdirSync(dir, { recursive: true })
        path = `${dir}/${LOG_FILE}`
    } catch (error) {
        console.error(`m20_dash: no log file in ${dir}: ${(error as Error).message}`)
    }
    logLine(`=== m20 ctrl started (pid ${Deno.pid})`)
}

export function logPath() {
    return path
}

export function logLine(text: string) {
    const clipped = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}… (${text.length} chars)` : text
    const stamped = `${new Date().toISOString()} ${clipped}`
    if (!path) {
        return
    }
    console.error(`m20_dash: ${stamped}`)
    try {
        if ((Deno.statSync(path).size ?? 0) > LOG_LIMIT) {
            Deno.renameSync(path, `${path}.1`)
        }
    } catch {
        // not there yet
    }
    try {
        Deno.writeTextFileSync(path, stamped + "\n", { append: true })
    } catch {
        // a full disk must not take the board links down with it
    }
}
