// The recording's system logs (Go2 Ctrl's health.rs, for each of the M20's boards): while a recording runs with
// "System logs" on, one more ssh per board runs LOGS_SCRIPT, which only reads:
//   every HEALTH_PERIOD_S  the Wi-Fi link (`iw dev <wl*> link`: SSID, signal, bitrate, frequency), the default routes,
//                          power supplies; merged with the board's latest stats sample (CPU, load, memory, temperatures)
//                          into a {"type":"health"} message on /logs
//   as they come           new journal lines at warning or worse (kernel messages included: the journal has dmesg),
//                          new network-safety lines (AOS's Wi-Fi guard, every priority), new lines of the vendor
//                          basic_server log on AOS (/var/opt/robot/log/<date>/Basic_server.<date>.log: mode, gait,
//                          motion and charging changes), each a typed message on /logs, at most LINES_PER_WINDOW per
//                          board and source every WINDOW_MS (the rest counted in a {"type":"log_dropped"})
// When something looks wrong (`conditions`: Wi-Fi gone or weak, the board unreachable, CPU pegged, a network-safety
// line) the board's last 2 minutes of health samples go on /logs as {"type":"health_dump", reason, samples}, at most once
// per DUMP_EVERY_MS. The followers are `journalctl -f` and `tail -F` (idle until a line comes) and a sleep loop, so AOS's
// real-time walking controller isn't disturbed; nothing runs when no recording asks for it.
import { logLine } from "./applog.ts"
import { sshArgs, sshBinary } from "./boards.ts"

export const HEALTH_PERIOD_S = 2
const BUFFER = 60 // samples: 2 minutes
const WINDOW_MS = 2000
const LINES_PER_WINDOW = 30
const DUMP_EVERY_MS = 30_000
const WEAK_SIGNAL_DBM = -80
const CPU_PEGGED = 95
const RESTART_MS = 5000
/** journal lines that are routine on the M20 and would drown the rest: phc2sys stepping the clock twice a second (the
 * kernel logs it as a warning), PTP's time_diff, and the sshd noise of M20 Ctrl's own port-22 probe. Counted, not kept. */
const NOISE = [
    /change wall clock \(adjtimex\) by pid/,
    /kernel: recv time_diff:/,
    /kex_exchange_identification: Connection closed/,
]

/** Read-only: journal / network-safety / basic_server followers and a health loop; everything dies with the link. */
export function logsScript(periodS = HEALTH_PERIOD_S): string {
    return `
trap 'trap - EXIT; kill 0 2>/dev/null; exit 0' EXIT INT TERM HUP PIPE
if command -v journalctl >/dev/null 2>&1; then
  journalctl -f -n 0 -p warning -o short-iso --no-pager 2>/dev/null | sed -u 's/^/J /' &
  if systemctl cat network-safety >/dev/null 2>&1; then
    journalctl -f -n 0 -u network-safety -o short-iso --no-pager 2>/dev/null | sed -u 's/^/N /' &
  fi
fi
D=$(date +%Y_%m%d)
B=/var/opt/robot/log/$D/Basic_server.$D.log
if [ -r "$B" ]; then tail -n 0 -F "$B" 2>/dev/null | sed -u 's/^/B /' & fi
W=$(ls /sys/class/net 2>/dev/null | grep '^wl' | head -1)
while :; do
  printf 'H %s\\n' "$(date +%s%3N)"
  if [ -n "$W" ]; then printf 'W %s|' "$W"; iw dev "$W" link 2>/dev/null | tr '\\n\\t' '| '; echo; fi
  printf 'R '; ip route show default 2>/dev/null | tr '\\n' '|'; echo
  for s in /sys/class/power_supply/*; do
    [ -r "$s/capacity" ] && printf 'P %s %s %s\\n' "\${s##*/}" "$(cat "$s/capacity")" "$(cat "$s/status" 2>/dev/null)"
  done
  echo E
  sleep ${periodS} || exit 0
done
`
}

export type Wifi = {
    iface: string
    connected: boolean
    ssid?: string
    signalDbm?: number
    bitrateMbps?: number
    freqMhz?: number
}
export type HealthSample = {
    t: number
    board: string
    wifi?: Wifi
    routes?: string[]
    power?: { name: string; capacity: number; status: string }[]
    /** the board's latest stats (stats.ts): CPU total, load, memory, hottest temperature */
    stats?: unknown
    reachable?: boolean | null
    /** routine journal lines (NOISE) since the last sample, counted only */
    routineJournalLines?: number
}

/** "W wlan0|Connected to … (on wlan0)| SSID: x| freq: 5500| signal: -70 dBm| tx bitrate: 434.0 MBit/s|…" */
export function parseWifi(line: string): Wifi {
    const [iface, ...rest] = line.slice(2).split("|")
    const text = rest.join("|")
    const number = (pattern: RegExp) => {
        const found = text.match(pattern)?.[1]
        return found === undefined ? undefined : Number(found)
    }
    return {
        iface: iface.trim(),
        connected: /Connected to/.test(text),
        ssid: text.match(/SSID: ([^|]+)/)?.[1]?.trim(),
        signalDbm: number(/signal: (-?\d+(?:\.\d+)?) dBm/),
        bitrateMbps: number(/tx bitrate: ([\d.]+)/),
        freqMhz: number(/freq: ([\d.]+)/),
    }
}

/** What looks wrong in a sample (key → why). */
export function conditions(sample: HealthSample): Record<string, string> {
    const wrong: Record<string, string> = {}
    if (sample.wifi && !sample.wifi.connected) {
        wrong.wifi = `${sample.wifi.iface} not connected`
    } else if (sample.wifi?.signalDbm !== undefined && sample.wifi.signalDbm < WEAK_SIGNAL_DBM) {
        wrong.wifi = `${sample.wifi.iface} signal ${sample.wifi.signalDbm} dBm`
    }
    if (sample.reachable === false) {
        wrong.link = "unreachable"
    }
    const cpu = (sample.stats as { cpu?: { total?: number | null } } | undefined)?.cpu?.total
    if (typeof cpu === "number" && cpu >= CPU_PEGGED) {
        wrong.cpu = `CPU ${Math.round(cpu)}%`
    }
    return wrong
}

type Board = { name: string; host: string }
type Emit = (message: Record<string, unknown>) => void
/** the board's latest stats and reachability (boards.ts's summary) */
type Stats = (board: string) => { stats: unknown; reachable: boolean | null } | null

/** One board's follower: parses LOGS_SCRIPT's output into messages; rate-limits the line sources. */
export class BoardLogs {
    samples: HealthSample[] = []
    #sample: HealthSample | null = null
    #window = { at: 0, counts: {} as Record<string, number>, dropped: {} as Record<string, number> }
    #lastDump = 0
    #wrong = new Set<string>()
    #noise = 0

    constructor(readonly board: string, readonly emit: Emit, readonly stats: Stats) {}

    line(line: string) {
        const kind = line[0]
        if (kind === "H") {
            this.#sample = { t: Number(line.slice(2)) || Date.now(), board: this.board }
        } else if (kind === "W" && this.#sample) {
            this.#sample.wifi = parseWifi(line)
        } else if (kind === "R" && this.#sample) {
            this.#sample.routes = line.slice(2).split("|").map((r) => r.trim()).filter(Boolean)
        } else if (kind === "P" && this.#sample) {
            const [name, capacity, ...status] = line.slice(2).split(" ")
            ;(this.#sample.power ??= []).push({ name, capacity: Number(capacity), status: status.join(" ") })
        } else if (kind === "E" && this.#sample) {
            this.health(this.#sample)
            this.#sample = null
        } else if (kind === "J" || kind === "N" || kind === "B") {
            if (line.startsWith("-- ", 2)) {
                return // journalctl's "-- Logs begin at …" header
            }
            if (kind === "J" && NOISE.some((pattern) => pattern.test(line))) {
                this.#noise++
                return
            }
            const source = kind === "J" ? "journal" : kind === "N" ? "network_safety" : "basic_server"
            if (this.#allow(source)) {
                this.emit({ type: source, board: this.board, t: Date.now(), line: line.slice(2) })
            }
            if (source === "network_safety") {
                this.#dump(`network-safety: ${line.slice(2).slice(0, 200)}`)
            }
        }
    }

    health(sample: HealthSample) {
        const known = this.stats(this.board)
        if (known) {
            sample.stats = known.stats
            sample.reachable = known.reachable
        }
        if (this.#noise) {
            sample.routineJournalLines = this.#noise
            this.#noise = 0
        }
        this.samples.push(sample)
        if (this.samples.length > BUFFER) {
            this.samples.shift()
        }
        this.emit({ type: "health", ...sample })
        this.#flushDropped()
        const wrong = conditions(sample)
        const fresh = Object.keys(wrong).filter((key) => !this.#wrong.has(key))
        this.#wrong = new Set(Object.keys(wrong))
        if (fresh.length) {
            this.#dump(fresh.map((key) => wrong[key]).join("; "))
        }
    }

    #dump(reason: string) {
        if (Date.now() - this.#lastDump < DUMP_EVERY_MS) {
            return
        }
        this.#lastDump = Date.now()
        logLine(`${this.board}: health dump: ${reason}`)
        this.emit({ type: "health_dump", board: this.board, t: Date.now(), reason, samples: [...this.samples] })
    }

    #allow(source: string): boolean {
        const now = Date.now()
        if (now - this.#window.at >= WINDOW_MS) {
            this.#flushDropped()
            this.#window = { at: now, counts: {}, dropped: {} }
        }
        const count = (this.#window.counts[source] ?? 0) + 1
        this.#window.counts[source] = count
        if (count > LINES_PER_WINDOW) {
            this.#window.dropped[source] = (this.#window.dropped[source] ?? 0) + 1
            return false
        }
        return true
    }

    #flushDropped() {
        for (const [source, count] of Object.entries(this.#window.dropped)) {
            this.emit({ type: "log_dropped", board: this.board, t: Date.now(), source, count })
        }
        this.#window.dropped = {}
    }
}

/** Every board's follower, over ssh (or simulated with the fake boards). */
export class SystemLogs {
    #stops: (() => void)[] = []
    boards = new Map<string, BoardLogs>()

    constructor(readonly emit: Emit, readonly stats: Stats) {}

    start(boards: Board[], fake: boolean) {
        this.stop()
        for (const board of boards) {
            const logs = new BoardLogs(board.name, this.emit, this.stats)
            this.boards.set(board.name, logs)
            this.#stops.push(fake ? fakeFollower(board, logs) : sshFollower(board, logs))
        }
    }

    stop() {
        this.#stops.forEach((stop) => stop())
        this.#stops = []
        this.boards.clear()
    }
}

function sshFollower(board: Board, logs: BoardLogs): () => void {
    let stopped = false
    let child: Deno.ChildProcess | null = null
    const run = async () => {
        while (!stopped) {
            try {
                child = new Deno.Command(sshBinary(), {
                    args: sshArgs(board.host),
                    stdin: "piped",
                    stdout: "piped",
                    stderr: "null",
                }).spawn()
                const writer = child.stdin.getWriter()
                await writer.write(new TextEncoder().encode(logsScript()))
                await writer.close()
                let pending = ""
                for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
                    pending += chunk
                    const lines = pending.split("\n")
                    pending = lines.pop() ?? ""
                    lines.forEach((line) => line && logs.line(line))
                }
                await child.status
            } catch (error) {
                logLine(`${board.name}: system logs: ${(error as Error).message}`)
            }
            child = null
            if (!stopped) {
                await new Promise((resolve) => setTimeout(resolve, RESTART_MS))
            }
        }
    }
    run()
    return () => {
        stopped = true
        try {
            child?.kill()
        } catch {
            // already gone
        }
    }
}

/** The fake boards' logs: health with a Wi-Fi link on AOS that drifts, and now and then a basic_server line. */
function fakeFollower(board: Board, logs: BoardLogs): () => void {
    let n = 0
    const timer = setInterval(() => {
        n++
        logs.line(`H ${Date.now()}`)
        if (board.name === "aos") {
            const signal = -60 - Math.round(25 * Math.abs(Math.sin(n / 15)))
            logs.line(
                `W wlan0|Connected to 9e:30:66:58:cc:ee (on wlan0)| SSID: simulated| freq: 5500| signal: ${signal} dBm| tx bitrate: 434.0 MBit/s|`,
            )
            if (n % 5 === 0) {
                logs.line(
                    `B [${
                        new Date().toISOString()
                    }] [INFO  ] [DDSWorker] motion state: 17 -> 17, gait: 0x3003 -> 0x3003 (simulated)`,
                )
            }
        }
        logs.line("R default via 10.21.31.103 dev eth0 metric 600|")
        logs.line("E")
    }, HEALTH_PERIOD_S * 1000)
    return () => clearInterval(timer)
}
