// A stand-in for dimos's gateway with an M20 blueprint "running": the routes blueprint mode calls (active, streams,
// peek, modules, RPC calls, history/recordings), answered the way the real gateway shapes them. For the tests and for
// demos with no dog: `deno task fake-gateway` (port 8790), then run M20 Ctrl with M20_DASH_DESKTOP_URL pointing at it.
// Nothing here talks to a robot; standup/liedown just change the simulated motion_state.

export type FakeGateway = {
    url: string
    calls: string[]
    server: Deno.HttpServer
    setRunning(running: boolean): void
}

const STREAMS = [
    ["odom", "dimos.msgs.geometry_msgs.PoseStamped", "out", "m20connection"],
    ["motion_state", "dimos.msgs.std_msgs.Int32", "in", "m20connection"],
    ["gait_state", "dimos.msgs.std_msgs.UInt32", "in", "m20connection"],
    ["command_ready", "dimos.msgs.std_msgs.Bool", "in", "m20connection"],
    ["cmd_vel", "dimos.msgs.geometry_msgs.Twist", "out", "m20connection"],
    ["front_camera", "dimos.msgs.sensor_msgs.CompressedVideo", "out", "m20camerarelay"],
    ["slam_body_points", "dimos.msgs.sensor_msgs.PointCloud2", "in", "raytracingvoxelmap"],
]

export function startFakeGateway(port = 0, recordingsPath: string | null = null): FakeGateway {
    const calls: string[] = []
    let running = true
    let motionState = 1 // lying down
    const startedAt = Date.now()
    const value = (name: string) => {
        const t = (Date.now() - startedAt) / 1000
        const stamp = { ts: Date.now() / 1000, frame_id: "odom" }
        if (name === "odom") {
            return {
                ...stamp,
                position: { x: Math.cos(t / 10) * 2, y: Math.sin(t / 10) * 2, z: 0.45 },
                orientation: { x: 0, y: 0, z: Math.sin(t / 20), w: Math.cos(t / 20) },
            }
        }
        if (name === "motion_state") {
            return { data: motionState }
        }
        if (name === "gait_state") {
            return { data: motionState === 2 ? 4 : 1 }
        }
        if (name === "command_ready") {
            return { data: motionState === 2 }
        }
        if (name === "cmd_vel") {
            return { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }
        }
        return null
    }
    const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, async (request) => {
        const path = new URL(request.url).pathname.replace(/^\/gateways\/dimos\//, "")
        if (path === "history/recordings") {
            return recordingsPath
                ? Response.json({ path: recordingsPath })
                : Response.json({ detail: "no recordings folder" }, { status: 404 })
        }
        if (path === "active") {
            return Response.json({
                running,
                runId: running ? "20261103-fake-m20" : null,
                pid: running ? 4242 : null,
                blueprint: running ? "deeprobotics-m20-kronknav-control" : null,
                startedAt: running ? new Date(startedAt).toISOString() : null,
                logDir: null,
                launch: null,
            })
        }
        if (!running && path.startsWith("active/")) {
            return Response.json({ detail: "no blueprint is running" }, { status: 409 })
        }
        if (path === "active/streams") {
            return Response.json({
                streams: STREAMS.map(([name, type, direction, module]) => ({
                    name,
                    type,
                    direction,
                    channel: `/${name}`,
                    module,
                })),
            })
        }
        if (path === "active/modules") {
            return Response.json({
                modules: [
                    {
                        id: "m20connection",
                        class: "dimos.robot.deeprobotics.m20.connection.M20Connection",
                        rpcs: ["liedown", "move", "set_navigation_terrain", "standup", "stop_movement"].map((name) => ({
                            name,
                        })),
                    },
                    { id: "m20camerarelay", class: "dimos.robot.deeprobotics.m20.camera.M20CameraRelay", rpcs: [] },
                ],
            })
        }
        const peek = /^active\/streams\/([^/]+)\/peek$/.exec(path)
        if (peek) {
            const name = decodeURIComponent(peek[1])
            const stream = STREAMS.find(([n]) => n === name)
            if (!stream) {
                return Response.json({ detail: `no running stream ${name}` }, { status: 404 })
            }
            const found = value(name)
            if (found === null) {
                return Response.json({ detail: `${name} sent nothing within 0.8 s` }, { status: 504 })
            }
            return Response.json({ name, type: stream[1], value: found, ts: Date.now() / 1000 })
        }
        const rpc = /^active\/modules\/([^/]+)\/rpcs\/([^/]+)$/.exec(path)
        if (rpc && request.method === "POST") {
            calls.push(`${rpc[1]}.${rpc[2]} ${await request.text()}`)
            if (rpc[2] === "standup") {
                motionState = 2
            } else if (rpc[2] === "liedown") {
                motionState = 1
            }
            return Response.json({ ok: true, result: rpc[2] === "stop_movement" ? null : true, error: null })
        }
        return Response.json({ detail: `no ${request.method} ${path}` }, { status: 404 })
    })
    const address = server.addr as Deno.NetAddr
    return {
        url: `http://127.0.0.1:${address.port}/gateways/dimos/`,
        calls,
        server,
        setRunning: (value: boolean) => {
            running = value
        },
    }
}

if (import.meta.main) {
    const gateway = startFakeGateway(
        Number(Deno.env.get("M20_FAKE_GATEWAY_PORT") ?? 8790),
        Deno.env.get("M20_FAKE_RECORDINGS") ?? null,
    )
    console.error(
        `fake dimos gateway at ${gateway.url} (run M20 Ctrl with M20_DASH_DESKTOP_URL=${new URL(gateway.url).origin})`,
    )
}
