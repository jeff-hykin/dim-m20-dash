// One board's stats, as the stats loop prints them (STATS_SCRIPT, run over ssh) and parsed here. Every frame is a
// block of sections between "@@frame <ms>" and "@@end"; CPU % and process CPU need two frames, so StatsParser keeps
// the last one. The fake boards (fake.ts) print the same text, so both go through this one parser.

/** a process the stats loop matched: pid, its CPU ticks (utime + stime), its command line */
export type MatchedProcess = { pid: number; ticks: number | null; args: string }

export type Sample = {
    /** when the board read it (ms since epoch, the board's clock) */
    t: number
    cpu: { total: number | null; cores: (number | null)[] }
    load: number[] | null
    uptimeS: number | null
    mem: { totalMb: number; usedMb: number; percent: number } | null
    temps: { name: string; celsius: number }[]
    lidar: { processes: ProcessUse[]; ports: number[] }
    dimos: { processes: ProcessUse[] }
}

/** a matched process and its CPU use since the last frame (% of one core; null on its first frame) */
export type ProcessUse = { pid: number; cpu: number | null; args: string }

/** Linux's USER_HZ: /proc/<pid>/stat counts CPU time in these */
export const CLOCK_TICKS_PER_S = 100

export type Patterns = { lidar: string; dimos: string; lidarPorts: number[] }

export const DEFAULT_PATTERNS: Patterns = {
    // RoboSense's rsdriver on NOS, the vendor hsLidar driver (masked by dimos's M20 setup), any *lidar* driver
    lidar: "rsdriver|rslidar|hslidar|lidar_driver|lidar_node",
    // a `dimos ... run` (or `python -m dimos`) process
    dimos: "dimos[^ ]* .*run|python[0-9.]* .*-m dimos",
    // RoboSense MSOP / DIFOP
    lidarPorts: [6699, 7788],
}

/** single-quotes `text` for a POSIX shell */
export function shellQuote(text: string): string {
    return `'${text.replaceAll("'", `'"'"'`)}'`
}

/** The loop the board runs (sh, busybox-friendly): one frame a second until ssh goes away. */
export function statsScript(patterns: Patterns, periodS = 1): string {
    const both = shellQuote(`${patterns.lidar}|${patterns.dimos}`)
    return `
while true; do
    echo "@@frame $(date +%s%3N)"
    echo "@@stat"; grep '^cpu' /proc/stat
    echo "@@loadavg"; cat /proc/loadavg
    echo "@@uptime"; cat /proc/uptime
    echo "@@meminfo"; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
    echo "@@temps"
    for zone in /sys/class/thermal/thermal_zone*; do
        [ -r "$zone/temp" ] && echo "$(cat "$zone/type" 2>/dev/null | tr ' ' _) $(cat "$zone/temp" 2>/dev/null)"
    done
    echo "@@procs"
    ps -eo pid=,args= | grep -Ei ${both} | grep -v -e 'grep ' -e '@@' | while read -r pid args; do
        echo "$pid $(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) $args"
    done
    echo "@@udp"; cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk 'NR>1 {print $2}'
    echo "@@end"
    sleep ${periodS}
done
`
}

/** What one frame says, before differencing. */
export type Frame = {
    t: number
    ticks: Map<string, [number, number]>
    load: number[] | null
    uptimeS: number | null
    mem: { totalKb: number; availableKb: number } | null
    temps: { name: string; celsius: number }[]
    processes: MatchedProcess[]
    udpPorts: number[]
}

/** /proc/stat cpu line → [busy, total] jiffies */
export function cpuTicks(line: string): [string, [number, number]] | null {
    const [name, ...rest] = line.trim().split(/\s+/)
    const fields = rest.map(Number).filter(Number.isFinite)
    if (!name?.startsWith("cpu") || fields.length < 5) {
        return null
    }
    // user nice system idle iowait irq softirq steal: idle + iowait aren't busy
    const total = fields.slice(0, 8).reduce((a, b) => a + b, 0)
    const idle = fields[3] + (fields[4] ?? 0)
    return [name, [total - idle, total]]
}

/** Splits a frame's text into its sections and reads each. */
export function parseFrame(text: string): Frame | null {
    const sections = new Map<string, string[]>()
    let current: string[] | null = null
    let t = NaN
    for (const line of text.split("\n")) {
        const header = /^@@(\w+)\s*(.*)$/.exec(line)
        if (header) {
            if (header[1] === "frame") {
                t = Number(header[2])
            }
            current = []
            sections.set(header[1], current)
        } else if (current && line.trim()) {
            current.push(line)
        }
    }
    if (!sections.has("stat")) {
        return null
    }
    const ticks = new Map<string, [number, number]>()
    for (const line of sections.get("stat") ?? []) {
        const parsed = cpuTicks(line)
        if (parsed) {
            ticks.set(...parsed)
        }
    }
    const loadFields = (sections.get("loadavg")?.[0] ?? "").trim().split(/\s+/).slice(0, 3).map(Number)
    const uptime = Number((sections.get("uptime")?.[0] ?? "").trim().split(/\s+/)[0])
    const memValue = (key: string) => {
        const line = (sections.get("meminfo") ?? []).find((l) => l.startsWith(`${key}:`))
        return line ? Number(line.split(/\s+/)[1]) : NaN
    }
    const totalKb = memValue("MemTotal")
    const availableKb = memValue("MemAvailable")
    const temps = (sections.get("temps") ?? []).flatMap((line) => {
        const [name, milli] = line.trim().split(/\s+/)
        const celsius = Number(milli) / 1000
        return name && Number.isFinite(celsius) && celsius > -50 && celsius < 200 ? [{ name, celsius }] : []
    })
    const processes = (sections.get("procs") ?? []).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)?\s*(.*)$/.exec(line)
        if (!match) {
            return []
        }
        return [{ pid: Number(match[1]), ticks: match[2] === undefined ? null : Number(match[2]), args: match[3] }]
    })
    const udpPorts = [
        ...new Set(
            (sections.get("udp") ?? []).flatMap((line) => {
                const port = parseInt(line.trim().split(":").pop() ?? "", 16)
                return Number.isFinite(port) && port > 0 ? [port] : []
            }),
        ),
    ].sort((a, b) => a - b)
    return {
        t: Number.isFinite(t) ? t : Date.now(),
        ticks,
        load: loadFields.length === 3 && loadFields.every(Number.isFinite) ? loadFields : null,
        uptimeS: Number.isFinite(uptime) ? uptime : null,
        mem: Number.isFinite(totalKb) && Number.isFinite(availableKb) ? { totalKb, availableKb } : null,
        temps,
        processes,
        udpPorts,
    }
}

const percent = (now: [number, number] | undefined, before: [number, number] | undefined) => {
    if (!now || !before || now[1] <= before[1]) {
        return null
    }
    return Math.round(1000 * Math.max(0, Math.min(1, (now[0] - before[0]) / (now[1] - before[1])))) / 10
}

/** Turns frames into Samples: CPU % from the previous frame's ticks. */
export class StatsParser {
    #last: Frame | null = null
    #lidar: RegExp
    #dimos: RegExp
    constructor(readonly patterns: Patterns = DEFAULT_PATTERNS) {
        this.#lidar = new RegExp(patterns.lidar, "i")
        this.#dimos = new RegExp(patterns.dimos, "i")
    }

    sample(text: string): Sample | null {
        const frame = parseFrame(text)
        if (!frame) {
            return null
        }
        const last = this.#last
        this.#last = frame
        const coreNames = [...frame.ticks.keys()].filter((name) => name !== "cpu")
        const elapsedS = last ? (frame.t - last.t) / 1000 : 0
        const use = (process: MatchedProcess): ProcessUse => {
            const before = last?.processes.find((p) => p.pid === process.pid)
            const cpu = before && before.ticks !== null && process.ticks !== null && elapsedS > 0
                ? Math.round(1000 * (process.ticks - before.ticks) / CLOCK_TICKS_PER_S / elapsedS) / 10
                : null
            return { pid: process.pid, cpu, args: process.args.slice(0, 300) }
        }
        const memUsedKb = frame.mem ? frame.mem.totalKb - frame.mem.availableKb : 0
        return {
            t: frame.t,
            cpu: {
                total: percent(frame.ticks.get("cpu"), last?.ticks.get("cpu")),
                cores: coreNames.map((name) => percent(frame.ticks.get(name), last?.ticks.get(name))),
            },
            load: frame.load,
            uptimeS: frame.uptimeS,
            mem: frame.mem
                ? {
                    totalMb: Math.round(frame.mem.totalKb / 1024),
                    usedMb: Math.round(memUsedKb / 1024),
                    percent: Math.round(1000 * memUsedKb / frame.mem.totalKb) / 10,
                }
                : null,
            temps: frame.temps,
            lidar: {
                processes: frame.processes.filter((p) => this.#lidar.test(p.args)).map(use),
                ports: frame.udpPorts.filter((port) => this.patterns.lidarPorts.includes(port)),
            },
            dimos: { processes: frame.processes.filter((p) => this.#dimos.test(p.args)).map(use) },
        }
    }
}
