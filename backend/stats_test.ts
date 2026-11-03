// The stats loop's text → samples: CPU % from two frames, processes matched and their CPU, temperatures, memory, ports.
import { assert, assertEquals } from "@std/assert"
import { cpuTicks, DEFAULT_PATTERNS, parseFrame, StatsParser, statsScript } from "./stats.ts"
import { FakeBoard, fakeCondition } from "./fake.ts"

const frame = (t: number, busy: number, total: number, lidarTicks: number) =>
    [
        `@@frame ${t}`,
        "@@stat",
        `cpu  ${busy} 0 0 ${total - busy} 0 0 0 0 0 0`,
        `cpu0 ${busy / 2} 0 0 ${(total - busy) / 2} 0 0 0 0 0 0`,
        `cpu1 ${busy / 2} 0 0 ${(total - busy) / 2} 0 0 0 0 0 0`,
        "@@loadavg",
        "0.52 0.40 0.31 1/300 999",
        "@@uptime",
        "12345.67 40000.00",
        "@@meminfo",
        "MemTotal:        8000000 kB",
        "MemAvailable:    6000000 kB",
        "@@temps",
        "soc-thermal 51250",
        "bogus notanumber",
        "@@procs",
        `812 ${lidarTicks} /opt/robot/bin/rsdriver --config x.yaml`,
        "2301 900 /home/user/.venv/bin/python .venv/bin/dimos run deeprobotics-m20-kronknav-control",
        "77 5 /usr/bin/python3 /usr/bin/networkd-dispatcher",
        "@@udp",
        "00000000:1A2B",
        "0100007F:0035",
        "@@end",
    ].join("\n")

Deno.test("cpuTicks: idle and iowait aren't busy", () => {
    assertEquals(cpuTicks("cpu  10 2 3 80 5 0 0 0 0 0"), ["cpu", [15, 100]])
    assertEquals(cpuTicks("intr 1 2 3"), null)
})

Deno.test("parseFrame reads every section", () => {
    const parsed = parseFrame(frame(1000, 100, 1000, 50))!
    assertEquals(parsed.t, 1000)
    assertEquals(parsed.load, [0.52, 0.4, 0.31])
    assertEquals(parsed.uptimeS, 12345.67)
    assertEquals(parsed.mem, { totalKb: 8000000, availableKb: 6000000 })
    assertEquals(parsed.temps, [{ name: "soc-thermal", celsius: 51.25 }])
    assertEquals(parsed.processes.length, 3)
    assertEquals(parsed.udpPorts, [53, 6699])
    assertEquals(parseFrame("no sections here"), null)
})

Deno.test("StatsParser: CPU % and process CPU from two frames", () => {
    const parser = new StatsParser()
    const first = parser.sample(frame(1000, 100, 1000, 50))!
    assertEquals(first.cpu.total, null) // needs a previous frame
    const second = parser.sample(frame(2000, 160, 1200, 70))! // 60 busy of 200 = 30%; lidar 20 ticks in 1 s = 20%
    assertEquals(second.cpu.total, 30)
    assertEquals(second.cpu.cores, [30, 30])
    assertEquals(second.mem, { totalMb: 7813, usedMb: 1953, percent: 25 })
    assertEquals(second.lidar.processes.map((p) => [p.pid, p.cpu]), [[812, 20]])
    assertEquals(second.lidar.ports, [6699])
    assertEquals(second.dimos.processes.map((p) => p.pid), [2301])
})

Deno.test("the stats loop is valid sh, and quotes its patterns", async () => {
    const script = statsScript({ ...DEFAULT_PATTERNS, dimos: "it's" })
    assert(script.includes(`'"'"'`))
    const check = await new Deno.Command("sh", { args: ["-n", "-c", script] }).output()
    assertEquals(check.code, 0, new TextDecoder().decode(check.stderr))
})

Deno.test("fake boards: their script changes over time, and their frames parse", () => {
    assertEquals(fakeCondition("nos", 2, 10).lidar, "publishing")
    assertEquals(fakeCondition("nos", 2, 33).lidar, "idle")
    assertEquals(fakeCondition("nos", 2, 55).lidar, "off")
    assertEquals(fakeCondition("gos", 0, 5).dimos, false)
    assertEquals(fakeCondition("gos", 0, 30).dimos, true)
    assertEquals(fakeCondition("gos", 0, 10).reachable, true)
    assertEquals(fakeCondition("gos", 0, 80).reachable, false)
    const fake = new FakeBoard("nos", 2, 8, 0)
    const parser = new StatsParser()
    parser.sample(fake.frame(1000))
    const sample = parser.sample(fake.frame(2000))!
    assertEquals(sample.cpu.cores.length, 8)
    assert(sample.cpu.total! > 0 && sample.cpu.total! < 100)
    assertEquals(sample.lidar.processes.length, 1)
    assert(sample.lidar.processes[0].cpu! >= 2)
    fake.overrides = { lidar: "off" }
    assertEquals(parser.sample(fake.frame(3000))!.lidar.processes, [])
})
