// The boards' monitor: the indicators, a fake ssh standing in for the real one (the same code path as a real board),
// and the fake boards' source.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { Boards, type BoardState, indicators, readFrames, STALE_MS } from "./boards.ts"
import { DEFAULT_PATTERNS, type Sample } from "./stats.ts"

const options = { sanitizeOps: false, sanitizeResources: false }

async function until(check: () => boolean, timeoutMs = 8000) {
    const start = Date.now()
    while (!check()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timed out")
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

const sample = (lidarCpu: number | null, dimos: boolean): Sample => ({
    t: 0,
    cpu: { total: 20, cores: [20] },
    load: null,
    uptimeS: null,
    mem: null,
    temps: [],
    lidar: { processes: lidarCpu === null ? [] : [{ pid: 1, cpu: lidarCpu, args: "rsdriver" }], ports: [6699] },
    dimos: { processes: dimos ? [{ pid: 2, cpu: 50, args: "dimos run x" }] : [] },
})

const board = (over: Partial<BoardState>, expect = {}): BoardState => ({
    config: { name: "nos", label: "NOS", hosts: ["user@h"], ...expect },
    link: { state: "up", host: "user@h", error: null, since: 0 },
    reachable: true,
    latest: sample(10, false),
    receivedAt: 1000,
    history: [],
    ...over,
})

Deno.test("indicators: lidar publishing / idle / missing, dimos, staleness, network", () => {
    const now = 1500
    let lights = indicators(board({}), now)
    assertEquals([lights.network.level, lights.stats.level, lights.lidar.level, lights.dimos.level], [
        "ok",
        "ok",
        "ok",
        "off",
    ])
    assertMatch(lights.lidar.text, /publishing: driver at 10% CPU, udp 6699/)
    assertEquals(indicators(board({ latest: sample(0.5, true) }), now).lidar.level, "warn")
    assertEquals(indicators(board({ latest: sample(0.5, true) }), now).dimos.level, "ok")
    assertEquals(indicators(board({ latest: sample(null, false) }, { expectLidar: true }), now).lidar.level, "bad")
    assertEquals(indicators(board({ latest: sample(null, false) }, { expectDimos: true }), now).dimos.level, "bad")
    // stale: no lights from an old sample
    lights = indicators(board({}), 1000 + STALE_MS + 1)
    assertEquals([lights.stats.level, lights.lidar.level], ["warn", "unknown"])
    lights = indicators(
        board({ reachable: false, link: { state: "down", host: "user@h", error: "refused", since: 0 } }),
        1000 + STALE_MS + 1,
    )
    assertEquals([lights.network.level, lights.stats.level, lights.stats.text], ["bad", "bad", "refused"])
})

Deno.test("readFrames: frames split across chunks", async () => {
    const chunks = ["junk\n@@frame 1\n@@st", "at\ncpu 1 0 0 1\n@@end\n@@frame 2\n", "@@end\n"]
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
            controller.close()
        },
    })
    const frames: string[] = []
    await readFrames(stream, (text) => frames.push(text))
    assertEquals(frames, ["@@frame 1\n@@stat\ncpu 1 0 0 1\n@@end", "@@frame 2\n@@end"])
})

Deno.test("ssh source: a fake ssh streams frames (link up), then exits (link down, next host)", options, async () => {
    const dir = Deno.makeTempDirSync()
    const fakeSsh = `${dir}/ssh`
    Deno.writeTextFileSync(
        fakeSsh,
        `#!/bin/sh
echo "$@" >> "${dir}/calls"
cat > "${dir}/script"
case "$*" in *bad-host*) echo "ssh: connect to host bad-host port 22: Connection refused" >&2; exit 255;; esac
for i in 1 2 3; do
    printf '@@frame %s000\\n@@stat\\ncpu %s 0 0 %s 0 0 0 0\\ncpu0 %s 0 0 %s 0 0 0 0\\n@@procs\\n812 %s /opt/robot/bin/rsdriver\\n@@end\\n' $i $((i * 50)) $((i * 950)) $((i * 50)) $((i * 950)) $((i * 20))
    sleep 0.2
done
`,
    )
    Deno.chmodSync(fakeSsh, 0o755)
    Deno.env.set("M20_DASH_SSH", fakeSsh)
    const links: string[] = []
    const boards = new Boards(() => {}, (state) => links.push(`${state.link.state}:${state.link.host}`))
    try {
        boards.start(
            [{ name: "gos", label: "GOS", hosts: ["user@good-host", "user@bad-host"] }],
            "ssh",
            DEFAULT_PATTERNS,
        )
        const state = () => boards.states.get("gos")!
        await until(() => (state().latest?.cpu.total ?? null) !== null)
        assertEquals(state().latest!.cpu.total, 5) // 50 busy of 1000 jiffies between frames
        assertEquals(state().latest!.lidar.processes[0].cpu, 20) // 20 ticks in 1 s
        assert(links.includes("up:user@good-host"))
        await until(() => links.some((l) => l.startsWith("down:user@good-host")))
        await until(() => links.some((l) => l.startsWith("down:user@bad-host")), 10000)
        assertMatch(state().link.error ?? "", /Connection refused/)
        const calls = Deno.readTextFileSync(`${dir}/calls`)
        assertMatch(calls, /BatchMode=yes .*user@good-host sh -s/)
        assertMatch(Deno.readTextFileSync(`${dir}/script`), /@@frame/) // the stats loop went in on stdin
    } finally {
        boards.stop()
        Deno.env.delete("M20_DASH_SSH")
    }
})

Deno.test("fake source: boards come up with samples and history", options, async () => {
    const boards = new Boards()
    try {
        boards.start(
            [
                { name: "gos", label: "GOS", hosts: ["user@10.21.31.104"], expectDimos: true },
                { name: "nos", label: "NOS", hosts: ["user@10.21.31.106"], expectLidar: true },
            ],
            "fake",
            DEFAULT_PATTERNS,
        )
        await until(() => boards.summary().every((b) => b.history.length >= 2), 5000)
        const [gos, nos] = boards.summary()
        assertEquals(gos.indicators.network.level, "ok")
        assertEquals(gos.indicators.stats.level, "ok")
        assertEquals(gos.latest!.cpu.cores.length, 8)
        assertEquals(nos.indicators.lidar.level, "ok") // the script starts with the lidar publishing
    } finally {
        boards.stop()
    }
})
