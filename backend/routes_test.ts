// Every route against fake boards and a fake dimos gateway (fake_gateway.ts: active, streams, peek, modules and RPC
// calls shaped the way dimos's gateway answers them): mode switching, motion through the blueprint's RPCs only, direct mode's
// refusal, and a recording whose mcap holds the boards' stats and the blueprint's streams.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { applySettings, stopApp } from "./app.ts"
import { setGatewayUrl } from "./blueprint.ts"
import { handle } from "./http.ts"
import { readMcap } from "./mcap.ts"
import { startFakeGateway } from "./fake_gateway.ts"
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

Deno.test("M20 Ctrl end to end: fake boards, blueprint mode, motion, direct mode, a recording", options, async () => {
    const dir = Deno.makeTempDirSync()
    Deno.env.set("M20_DASH_RECORDINGS_DIR", `${dir}/recordings`)
    const gateway = startFakeGateway()
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

        // motion: dryRun calls nothing; stand up is `m20 stand` (simulated here: it stands, then sets navigation mode,
        // which the robot resets on every stand); the rest go to the blueprint's RPCs; bad actions are refused
        const dry = (await call("POST", "api/motion", { action: "liedown", dryRun: true })).json
        assertEquals(dry.wouldCall, "POST active/modules/m20connection/rpcs/liedown")
        assertMatch(
            (await call("POST", "api/motion", { action: "standup", dryRun: true })).json.wouldDo[0],
            /m20 stand/,
        )
        assertEquals(gateway.calls, [])
        await until(async () => (await call("GET", "api/state")).json.robot.link === "up")
        const stood = await call("POST", "api/motion", { action: "standup" })
        assertEquals(stood.status, 200)
        assertEquals(stood.json.ok, true)
        const afterStand = (await call("GET", "api/robot")).json.basic
        assertEquals([afterStand.motionName, afterStand.usage, afterStand.gaitName], [
            "RL control",
            "navigation",
            "stairs (agile)",
        ])
        await call("POST", "api/motion", { action: "stop" })
        assertEquals(gateway.calls, ['m20connection.stop_movement {"args":[],"kwargs":{}}'])
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
        // the system logs ride on /logs: each board's health (AOS's Wi-Fi among it) and M20 Ctrl's own log lines
        const logTypes = messages.filter((m) => m.topic === "/logs").map((m) =>
            m.message as { type: string; board?: string }
        )
        assert(
            logTypes.some((m) => m.type === "health" && m.board === "aos"),
            JSON.stringify(logTypes.map((m) => m.type)),
        )
        assert(logTypes.some((m) => m.type === "app_log"))
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

        // direct mode: through the (simulated) robot's basic_server, nothing to the gateway. The robot stood up for the
        // blueprint above (navigation mode): direct driving is refused (and says why) until Enable driving (m20 direct)
        assertEquals((await call("PUT", "api/mode", { mode: "direct" })).json.mode, "direct")
        const navMode = (await call("GET", "api/state")).json.driving
        assertEquals([navMode.ok, navMode.fixable], [false, true])
        assertMatch(navMode.reason, /navigation control mode/)
        assertEquals((await call("POST", "api/direct/move", { x: 0.5, durationMs: 300 })).status, 409)
        const enableDry = await call("POST", "api/drive/enable", { dryRun: true })
        assertMatch(enableDry.json.wouldDo.join(" "), /m20 direct/)
        assertEquals((await call("POST", "api/drive/enable")).json.ok, true)
        assertEquals((await call("GET", "api/state")).json.driving.ok, true)
        assertEquals((await call("POST", "api/direct/move", { x: 2 })).status, 400, "axes are -1..1")
        assertEquals((await call("POST", "api/direct/move", { x: 0.5, yaw: -0.2, durationMs: 300 })).json.moving, true)
        await until(async () => (await call("GET", "api/robot")).json.motion.vx === 0.5)
        // the move lapses on its own (the deadman), zeros follow
        await until(async () => (await call("GET", "api/robot")).json.motion.vx === 0)
        assertEquals((await call("GET", "api/blueprint")).status, 200)
        assertEquals(gateway.calls.length, 1, "only the stop went to the gateway")

        // blueprint mode: regular control mode won't follow the blueprint; Enable driving runs (simulated) m20 stand
        await call("PUT", "api/mode", { mode: "blueprint" })
        assertMatch((await call("GET", "api/state")).json.driving.reason, /regular control mode/)
        assertEquals(
            (await call("POST", "api/direct/move", { x: 0.5 })).status,
            409,
            "direct moves only in direct mode",
        )
        assertEquals((await call("POST", "api/drive/enable")).json.ok, true)
        await until(async () => (await call("GET", "api/state")).json.driving.ok === true)
        assertEquals((await call("PUT", "api/mode", { mode: "sideways" })).status, 400)

        // blueprint mode with no blueprint running: motion is refused, not sent
        await call("PUT", "api/mode", { mode: "blueprint" })
        gateway.setRunning(false)
        await until(async () => (await call("GET", "api/blueprint")).json.running === false)
        assertEquals((await call("POST", "api/motion", { action: "liedown" })).status, 409)
        assertEquals(gateway.calls.length, 1, "only the stop went to the gateway")

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

Deno.test(
    "dock: through M20Connection's dock RPC in blueprint mode (refused when it has none), `m20 dock` in direct mode",
    options,
    async () => {
        const dir = Deno.makeTempDirSync()
        const gateway = startFakeGateway()
        setGatewayUrl(gateway.url)
        loadSettings(`${dir}/settings.json`)
        updateSettings({ source: "fake", mode: "blueprint", blueprintStreams: ["odom", "motion_state"] })
        applySettings()
        try {
            await until(async () => (await call("GET", "api/blueprint")).json.connection?.rpcs.includes("dock"))
            const dry = (await call("POST", "api/motion", { action: "dock", dryRun: true })).json
            assertEquals(dry.wouldCall, "POST active/modules/m20connection/rpcs/dock")
            assertEquals(gateway.calls, [])

            // lying down: M20Connection says why not (ok, with its answer as the result)
            const lying = (await call("POST", "api/motion", { action: "dock" })).json
            assertEquals(lying.ok, true)
            assertMatch(lying.result, /^Not docking: the robot is not standing/)
            // (m20-nav standing the dog: its own RPC, called here directly)
            await fetch(new URL("active/modules/m20connection/rpcs/standup", gateway.url), {
                method: "POST",
                body: "{}",
            })
            const docking = (await call("POST", "api/motion", { action: "dock" })).json
            assertMatch(docking.result, /^Docking\./)
            assertEquals(gateway.calls, [
                'm20connection.dock {"args":[],"kwargs":{}}',
                "m20connection.standup {}",
                'm20connection.dock {"args":[],"kwargs":{}}',
            ])

            // an unwatched stream's last value goes (it kept its checkbox ticked)
            await until(async () => Boolean((await call("GET", "api/blueprint")).json.peeked.odom))
            await call("PUT", "api/settings", { blueprintStreams: ["motion_state"] })
            await until(async () => !(await call("GET", "api/blueprint")).json.peeked.odom)

            // an M20Connection from before self-charging: refused here, nothing sent
            gateway.setCanDock(false)
            gateway.setRunning(false)
            await until(async () => (await call("GET", "api/blueprint")).json.running === false)
            gateway.setRunning(true)
            await until(async () => (await call("GET", "api/blueprint")).json.connection?.rpcs.includes("standup"))
            const old = await call("POST", "api/motion", { action: "dock" })
            assertEquals(old.status, 409)
            assertMatch(old.json.error, /no dock RPC.*self-charging/)

            // direct mode docks through `m20 dock` (simulated here), not the gateway
            await call("PUT", "api/mode", { mode: "direct" })
            assertEquals((await call("POST", "api/motion", { action: "dock" })).json.ok, true)
            assertEquals(gateway.calls.length, 3)
            await until(async () => /dock|charging/.test((await call("GET", "api/state")).json.driving.reason ?? ""))
            // undock: `m20 undock` (leave the dock, then `m20 stand`: navigation mode, so direct mode needs Enable driving)
            assertEquals((await call("POST", "api/motion", { action: "undock" })).json.ok, true)
            const undocked = (await call("GET", "api/robot")).json.basic
            assertEquals([undocked.chargeName, undocked.usage], ["not charging", "navigation"])
            assertMatch((await call("GET", "api/state")).json.driving.reason, /navigation control mode/)
        } finally {
            stopApp()
            await gateway.server.shutdown()
        }
    },
)

Deno.test("dimos.yaml lists exactly the backend's routes", async () => {
    const run = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", new URL("../scripts/check_endpoints.ts", import.meta.url).pathname],
    }).output()
    assertEquals(run.code, 0, new TextDecoder().decode(run.stderr))
})
