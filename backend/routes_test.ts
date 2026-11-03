// Every route against fake boards and a fake dimos gateway (a local server answering active, streams, peek, modules
// and RPC calls the way dimos's gateway does): mode switching, motion through the blueprint's RPCs only, direct mode's
// refusal, and a recording whose mcap holds the boards' stats and the blueprint's streams.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { applySettings, stopApp } from "./app.ts"
import { setGatewayUrl } from "./blueprint.ts"
import { handle } from "./http.ts"
import { readMcap } from "./mcap.ts"
import { INFO, routes } from "./routes.ts"
import { loadSettings, updateSettings } from "./settings.ts"

const options = { sanitizeOps: false, sanitizeResources: false }

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        INFO,
    )
    return { status: response!.status, json: await response!.json() }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
    const start = Date.now()
    while (!(await check())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timed out")
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

/** A dimos gateway with one M20 blueprint running; `calls` records every RPC it was asked for. */
function fakeGateway() {
    const calls: string[] = []
    let running = true
    let n = 0
    const server = Deno.serve({ port: 0, onListen: () => {} }, async (request) => {
        const path = new URL(request.url).pathname.replace(/^\/gateways\/dimos\//, "")
        if (path === "active") {
            return Response.json({
                running,
                runId: running ? "run-1" : null,
                blueprint: running ? "deeprobotics-m20-kronknav-control" : null,
                pid: 1,
                startedAt: null,
                logDir: null,
                launch: null,
            })
        }
        if (path === "active/streams") {
            return Response.json({
                streams: [
                    {
                        name: "odom",
                        type: "dimos.msgs.geometry_msgs.PoseStamped",
                        direction: "out",
                        channel: "/odom",
                        module: "m20connection",
                    },
                    {
                        name: "motion_state",
                        type: "dimos.msgs.std_msgs.Int32",
                        direction: "in",
                        channel: "/motion_state",
                        module: "m20connection",
                    },
                    {
                        name: "slam_body_points",
                        type: "dimos.msgs.sensor_msgs.PointCloud2",
                        direction: "out",
                        channel: "/p",
                        module: "lio",
                    },
                ],
            })
        }
        if (path === "active/modules") {
            return Response.json({
                modules: [
                    { id: "rerunbridgemodule", class: "dimos.visualization.rerun.bridge.RerunBridgeModule", rpcs: [] },
                    {
                        id: "m20connection",
                        class: "dimos.robot.deeprobotics.m20.connection.M20Connection",
                        rpcs: [{ name: "standup" }, { name: "liedown" }, { name: "stop_movement" }, { name: "move" }],
                    },
                ],
            })
        }
        const peek = /^active\/streams\/([^/]+)\/peek$/.exec(path)
        if (peek) {
            n++
            const value = peek[1] === "odom" ? { position: { x: n * 0.1, y: 0, z: 0 } } : { data: 3 }
            return Response.json({ name: peek[1], type: "t", value, ts: Date.now() / 1000 })
        }
        const rpc = /^active\/modules\/([^/]+)\/rpcs\/([^/]+)$/.exec(path)
        if (rpc && request.method === "POST") {
            calls.push(`${rpc[1]}.${rpc[2]} ${await request.text()}`)
            return Response.json({ ok: true, result: true, error: null })
        }
        return Response.json({ detail: `no ${path}` }, { status: 404 })
    })
    const port = (server.addr as Deno.NetAddr).port
    return { url: `http://127.0.0.1:${port}/gateways/dimos/`, calls, server, stopBlueprint: () => (running = false) }
}

Deno.test("M20 Ctrl end to end: fake boards, blueprint mode, motion, direct mode, a recording", options, async () => {
    const dir = Deno.makeTempDirSync()
    Deno.env.set("M20_DASH_RECORDINGS_DIR", `${dir}/recordings`)
    const gateway = fakeGateway()
    setGatewayUrl(gateway.url)
    loadSettings(`${dir}/settings.json`)
    updateSettings({ source: "fake", mode: "blueprint" })
    applySettings()
    try {
        // the boards come up from the fakes
        await until(async () =>
            (await call("GET", "api/state")).json.boards.every((b: { latest: unknown }) => b.latest)
        )
        const state = (await call("GET", "api/state?history=true")).json
        assertEquals(state.boards.map((b: { name: string }) => b.name), ["gos", "aos", "nos"])
        assert(Array.isArray(state.boards[0].history))
        assertEquals((await call("GET", "api/boards/aos")).json.label, "AOS")
        assertEquals((await call("GET", "api/boards/nope")).status, 404)

        // blueprint mode: the running blueprint, its streams and its M20Connection
        await until(async () => (await call("GET", "api/blueprint")).json.connection !== null)
        const blueprint = (await call("GET", "api/blueprint")).json
        assertEquals(blueprint.blueprint, "deeprobotics-m20-kronknav-control")
        assertEquals(blueprint.connection.id, "m20connection")
        await until(async () => Boolean((await call("GET", "api/blueprint")).json.peeked.odom))

        // a recording while blueprint streams and board stats flow
        const started = (await call("POST", "api/record/start")).json
        assertEquals(started.active, true)
        assertMatch(started.file, /_m20_.*\.mcap$/)

        // motion: dryRun calls nothing; a real one goes to the blueprint's RPC; bad actions are refused
        const dry = (await call("POST", "api/motion", { action: "standup", dryRun: true })).json
        assertEquals(dry.wouldCall, "POST active/modules/m20connection/rpcs/standup")
        assertEquals(gateway.calls, [])
        const stood = await call("POST", "api/motion", { action: "standup" })
        assertEquals(stood.status, 200)
        assertEquals(stood.json.ok, true)
        await call("POST", "api/motion", { action: "stop" })
        assertEquals(gateway.calls, [
            'm20connection.standup {"args":[],"kwargs":{}}',
            'm20connection.stop_movement {"args":[],"kwargs":{}}',
        ])
        assertEquals((await call("POST", "api/motion", { action: "backflip" })).status, 400)

        await new Promise((resolve) => setTimeout(resolve, 2500))
        const stopped = (await call("POST", "api/record/stop")).json
        assertEquals(stopped.stopped, true)
        const messages = readMcap(Deno.readFileSync(stopped.path))
        const topics = new Set(messages.map((m) => m.topic))
        for (
            const topic of [
                "/boards/gos/stats",
                "/boards/aos/stats",
                "/boards/nos/stats",
                "/blueprint/odom",
                "/robot_action",
                "/logs",
            ]
        ) {
            assert(topics.has(topic), `${topic} in ${[...topics]}`)
        }
        const odom = messages.find((m) => m.topic === "/blueprint/odom")!.message as {
            value: { position: { x: number } }
        }
        assert(odom.value.position.x > 0)
        const stats = messages.find((m) => m.topic === "/boards/gos/stats")!.message as { cpu: { cores: number[] } }
        assertEquals(stats.cpu.cores.length, 8)
        assertEquals((await call("GET", "api/recordings")).json.recordings.length, 1)

        // the fake boards' overrides show up in the indicators
        await call("PUT", "api/fake", { board: "nos", lidar: "off", reachable: true })
        await until(async () => (await call("GET", "api/boards/nos")).json.indicators.lidar.text === "no lidar driver")
        assertEquals((await call("GET", "api/boards/nos")).json.indicators.lidar.level, "bad")
        await call("PUT", "api/fake", { board: "gos", reachable: false })
        await until(async () => (await call("GET", "api/boards/gos")).json.indicators.network.level === "bad")
        await call("PUT", "api/fake", { board: "gos", clear: true })

        // direct mode: no blueprint, no motion (and nothing reaches the gateway)
        assertEquals((await call("PUT", "api/mode", { mode: "direct" })).json.mode, "direct")
        const refused = await call("POST", "api/motion", { action: "standup" })
        assertEquals(refused.status, 501)
        assertMatch(refused.json.error, /Direct mode has no motion/)
        assertEquals((await call("GET", "api/blueprint")).status, 409)
        assertEquals(gateway.calls.length, 2)
        assertEquals((await call("PUT", "api/mode", { mode: "sideways" })).status, 400)

        // blueprint mode with no blueprint running: motion is refused, not sent
        await call("PUT", "api/mode", { mode: "blueprint" })
        gateway.stopBlueprint()
        await until(async () => (await call("GET", "api/blueprint")).json.running === false)
        assertEquals((await call("POST", "api/motion", { action: "liedown" })).status, 409)
        assertEquals(gateway.calls.length, 2)

        // settings: validation, then a save that persists
        assertEquals((await call("PUT", "api/settings", { boards: [] })).status, 400)
        assertEquals((await call("PUT", "api/settings", { source: "carrier-pigeon" })).status, 400)
        const saved = (await call("PUT", "api/settings", { blueprintStreams: ["odom"] })).json
        assertEquals(saved.blueprintStreams, ["odom"])
        assertEquals(JSON.parse(Deno.readTextFileSync(`${dir}/settings.json`)).blueprintStreams, ["odom"])
    } finally {
        stopApp()
        await gateway.server.shutdown()
        Deno.env.delete("M20_DASH_RECORDINGS_DIR")
    }
})

Deno.test("dimos.yaml lists exactly the backend's routes", async () => {
    const run = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", new URL("../scripts/check_endpoints.ts", import.meta.url).pathname],
    }).output()
    assertEquals(run.code, 0, new TextDecoder().decode(run.stderr))
})
