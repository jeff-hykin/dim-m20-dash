// Simulated M20 boards, for working with no dog: each prints the same frames the real stats loop does (stats.ts), from
// a scripted day that changes over time — the network drops out now and then, the lidar driver stops and goes idle,
// dimos starts and stops on GOS — so every indicator gets exercised. `overrides` pins any of it (PUT api/fake).

/** what a fake board is doing at a moment */
export type FakeCondition = { reachable: boolean; lidar: "publishing" | "idle" | "off"; dimos: boolean; busy: number }

export type FakeOverrides = Partial<FakeCondition>

/** The script: `elapsedS` since the fakes started, `index` the board's place in the list (staggers them). */
export function fakeCondition(name: string, index: number, elapsedS: number): FakeCondition {
    const reachable = (elapsedS + 25 * index) % 90 < 75
    let lidar: FakeCondition["lidar"] = "off"
    let dimos = false
    if (name === "nos" || index === 2) {
        const phase = elapsedS % 75
        lidar = phase >= 50 && phase < 62 ? "off" : phase >= 30 && phase < 38 ? "idle" : "publishing"
    }
    if (name === "gos" || index === 0) {
        const phase = elapsedS % 120
        dimos = phase >= 12 && phase < 100
    }
    const busy = 0.15 + 0.1 * Math.sin(elapsedS / 7 + index) + (dimos ? 0.35 : 0) + (lidar === "publishing" ? 0.1 : 0)
    return { reachable, lidar, dimos, busy: Math.max(0.02, Math.min(0.97, busy)) }
}

/** One fake board's counters: frames whose differences give the CPU, process use and so on. */
export class FakeBoard {
    #busy: number[]
    #total: number[]
    #lidarTicks = 0
    #dimosTicks = 0
    #lastT: number
    readonly startedAt: number
    overrides: FakeOverrides = {}

    constructor(
        readonly name: string,
        readonly index: number,
        readonly cores = name === "aos" ? 4 : 8,
        now = Date.now(),
    ) {
        this.#busy = Array(cores).fill(0).map((_, i) => 1000 * (i + 1))
        this.#total = Array(cores).fill(0).map((_, i) => 5000 * (i + 1))
        this.startedAt = now
        this.#lastT = now
    }

    condition(now = Date.now()): FakeCondition {
        return { ...fakeCondition(this.name, this.index, (now - this.startedAt) / 1000), ...this.overrides }
    }

    /** The next frame's text, as the stats loop would print it at `now`. */
    frame(now = Date.now()): string {
        const condition = this.condition(now)
        const elapsedS = Math.max(0.001, (now - this.#lastT) / 1000)
        this.#lastT = now
        const jiffies = Math.round(100 * elapsedS)
        for (let core = 0; core < this.cores; core++) {
            const wobble = 0.12 * Math.sin(now / 3000 + core * 1.7)
            const busy = Math.max(0, Math.min(1, condition.busy + wobble))
            this.#busy[core] += Math.round(jiffies * busy)
            this.#total[core] += jiffies
        }
        if (condition.lidar === "publishing") {
            this.#lidarTicks += Math.round(jiffies * 0.18)
        }
        if (condition.dimos) {
            this.#dimosTicks += Math.round(jiffies * 1.6)
        }
        const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
        const cpuLine = (name: string, busy: number, total: number) => `${name} ${busy} 0 0 ${total - busy} 0 0 0 0 0 0`
        const uptimeS = 3600 + (now - this.startedAt) / 1000
        const load = condition.busy * this.cores
        const lines = [
            `@@frame ${now}`,
            "@@stat",
            cpuLine("cpu", sum(this.#busy), sum(this.#total)),
            ...this.#busy.map((busy, core) => cpuLine(`cpu${core}`, busy, this.#total[core])),
            "@@loadavg",
            `${load.toFixed(2)} ${(load * 0.9).toFixed(2)} ${(load * 0.8).toFixed(2)} 2/412 4242`,
            "@@uptime",
            `${uptimeS.toFixed(2)} ${(uptimeS * 6).toFixed(2)}`,
            "@@meminfo",
            "MemTotal:       16000000 kB",
            `MemAvailable:   ${Math.round(16000000 * (0.75 - condition.busy * 0.4))} kB`,
            "@@temps",
            `soc-thermal ${Math.round(1000 * (42 + 30 * condition.busy))}`,
            `gpu-thermal ${Math.round(1000 * (40 + 22 * condition.busy))}`,
            "@@procs",
        ]
        if (condition.lidar !== "off") {
            lines.push(`812 ${this.#lidarTicks} /opt/robot/bin/rsdriver --config /opt/robot/share/rslidar/config.yaml`)
        }
        if (condition.dimos) {
            lines.push(
                `2301 ${this.#dimosTicks} /var/opt/robot/data/dimos-m20-kronknav/.venv/bin/python .venv/bin/dimos run deeprobotics-m20-kronknav-control`,
            )
        }
        // RoboSense's ports (6699, 7788) while its driver runs; 8080 always
        const lidarSockets = condition.lidar === "off" ? [] : ["00000000:1A2B", "00000000:1E6C"]
        lines.push("@@udp", ...lidarSockets, "00000000:1F90", "@@end")
        return lines.join("\n")
    }
}
