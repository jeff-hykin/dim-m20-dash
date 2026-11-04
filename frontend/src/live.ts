// The robot's live topics, straight from Desktop's zenoh-gateway (dim-app getZenoh) and decoded with the dimos gateway's
// msgs.js: the pose (tf map→base_link, else slam_odom), the lidar scan (slam_body_points, body frame), the local map
// (map frame), command_ready, and the cameras (JPEG CompressedImage, or H.265/H.264 CompressedVideo). The page also
// publishes the drive Twist on this connection (drive.ts).
// With the fake boards (Settings → source: fake) nothing here touches zenoh: FakeWorld makes a room, a scan of it from a
// pose that follows the drive's own Twist, and a camera test card, so the whole page can be tried without a robot.
import { getZenoh } from "./dim-app/source/zenoh.js"

export const TOPICS = {
    scan: "dimos/slam_body_points/sensor_msgs.PointCloud2",
    map: "dimos/local_map/sensor_msgs.PointCloud2",
    tf: "dimos/tf/tf2_msgs.TFMessage",
    odom: "dimos/slam_odom/nav_msgs.Odometry",
    ready: "dimos/command_ready/std_msgs.Bool",
    motionState: "dimos/motion_state/std_msgs.Int32",
}
export type CameraName = "front" | "rear"
export const cameraTopics = (camera: CameraName) => ({
    jpeg: `dimos/${camera}_camera_image/sensor_msgs.CompressedImage`,
    video: `dimos/${camera}_camera/foxglove_msgs.CompressedVideo`,
})

/** the mini picture of the other camera: 320 px wide at most, 5 fps, the lowest bandwidth priority (dropped first) */
const MINI_CAMERA = { maxResolution: [320, 180], maxHz: 5, qualityToHzTradeoff: 1, bandwidthPriority: 0.25 }

/** the deadman fires after this much silence from the page (zenoh-gateway heartbeat × misses) */
export const HEARTBEAT_HZ = 10
export const DEADMAN_MS = 400
/** a scan or map is cut down to this many points (every nth) */
const MAX_SCAN_POINTS = 40_000
const MAX_MAP_POINTS = 150_000

export type Pose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; at: number }
export type Cloud = { xyz: Float32Array; count: number; at: number }
export type CameraFrame =
    /** the gateway's video track of the JPEG topic (what the Controller shows: re-encoded to H.264, paced to the link) */
    | { kind: "stream"; stream: MediaStream }
    | { kind: "jpeg"; data: Uint8Array; stamp: number | null }
    | { kind: "video"; format: string; data: Uint8Array; stamp: number | null }
export type LinkState = "off" | "connecting" | "connected" | "degraded" | "lost"

type Listener<T> = (value: T) => void
// deno-lint-ignore no-explicit-any
type Msgs = any
// deno-lint-ignore no-explicit-any
type Decoded = any

class Emitter<T> {
    #listeners = new Set<Listener<T>>()
    last: T | null = null
    on(listener: Listener<T>) {
        this.#listeners.add(listener)
        if (this.last !== null) {
            listener(this.last)
        }
        return () => void this.#listeners.delete(listener)
    }
    emit(value: T) {
        this.last = value
        for (const listener of this.#listeners) {
            listener(value)
        }
    }
}

const stampOf = (header: Decoded) =>
    header?.stamp ? Number(header.stamp.sec) * 1000 + Number(header.stamp.nsec) / 1e6 : null

/** A PointCloud2's x, y, z (float32 fields) as a packed array, every nth point to stay under `max`. */
export function cloudXyz(cloud: Decoded, max: number): Cloud | null {
    const field = (name: string) => cloud.fields?.find((f: Decoded) => f.name === name)
    const [fx, fy, fz] = [field("x"), field("y"), field("z")]
    const step = Number(cloud.point_step)
    const data: Uint8Array = cloud.data
    if (!fx || !fy || !fz || !step || !data || fx.datatype !== 7) {
        return null
    }
    const total = Math.floor(data.byteLength / step)
    const stride = Math.max(1, Math.ceil(total / max))
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const little = !cloud.is_bigendian
    const xyz = new Float32Array(Math.ceil(total / stride) * 3)
    let count = 0
    for (let i = 0; i < total; i += stride) {
        const base = i * step
        const x = view.getFloat32(base + fx.offset, little)
        const y = view.getFloat32(base + fy.offset, little)
        const z = view.getFloat32(base + fz.offset, little)
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            xyz[count * 3] = x
            xyz[count * 3 + 1] = y
            xyz[count * 3 + 2] = z
            count++
        }
    }
    return { xyz, count, at: Date.now() }
}

export class Live {
    readonly pose = new Emitter<Pose>()
    readonly scan = new Emitter<Cloud>()
    readonly map = new Emitter<Cloud>()
    readonly ready = new Emitter<{ value: boolean; at: number }>()
    readonly link = new Emitter<LinkState>()
    readonly rates = { scan: new Rate(), camera: new Rate(), pose: new Rate() }
    /** the zenoh-gateway client (drive.ts publishes on it); null until connected, and always null when fake */
    // deno-lint-ignore no-explicit-any
    client: any = null
    msgs: Msgs = null
    fake: FakeWorld | null = null
    #zenoh: ReturnType<typeof getZenoh> | null = null
    #stops: (() => void)[] = []
    #tfAt = 0

    constructor() {
        this.link.emit("off")
    }

    /** Real topics through Desktop's zenoh-gateway (only under Desktop: standalone there's none). */
    startZenoh() {
        if (this.#zenoh || this.fake) {
            return
        }
        this.link.emit("connecting")
        const zenoh = getZenoh({ connectOptions: { heartbeatHz: HEARTBEAT_HZ, heartbeatMisses: DEADMAN_MS / 100 } })
        this.#zenoh = zenoh
        this.#stops.push(zenoh.onState((state: LinkState) => this.link.emit(state)))
        import(/* @vite-ignore */ new URL("../../gateways/dimos/msgs.js", location.href).href).then((msgs) => {
            this.msgs = msgs
            this.#subscribeAll()
        }).catch((error) => {
            console.error("M20 Ctrl: the dimos gateway's msgs.js didn't load", error)
            this.link.emit("lost")
        })
        zenoh.ready.then(() => {
            this.client = zenoh.client
            this.link.emit(zenoh.state as LinkState)
        })
    }

    /** Simulated topics (the fake boards' mode): nothing goes to or comes from a robot. */
    startFake() {
        if (this.fake) {
            return
        }
        this.stop()
        this.fake = new FakeWorld(this)
        this.link.emit("connected")
    }

    stop() {
        this.#stops.forEach((stop) => stop())
        this.#stops = []
        this.fake?.stop()
        this.fake = null
        this.#zenoh?.close()
        this.#zenoh = null
        this.client = null
        this.link.emit("off")
    }

    #sub(key: string, callback: (decoded: Decoded) => void) {
        const zenoh = this.#zenoh!
        return zenoh.subscribe(key, { delivery: "latest" }, (message) => {
            try {
                const decoded = this.msgs.decodeMessage(message)
                if (decoded !== undefined) {
                    callback(decoded)
                }
            } catch (error) {
                console.debug(`M20 Ctrl: ${key}: ${(error as Error).message}`)
            }
        })
    }

    #subscribeAll() {
        const posed = (p: Decoded, q: Decoded) => {
            this.rates.pose.tick()
            this.pose.emit({ x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, at: Date.now() })
        }
        this.#stops.push(
            this.#sub(TOPICS.tf, (message) => {
                for (const t of message.transforms ?? []) {
                    if (
                        t.child_frame_id === "base_link" &&
                        (t.header?.frame_id === "map" || t.header?.frame_id === "odom")
                    ) {
                        this.#tfAt = Date.now()
                        posed(t.transform.translation, t.transform.rotation)
                    }
                }
            }),
            // slam_odom only while tf has no base_link (it's the same pose, from the same SLAM)
            this.#sub(TOPICS.odom, (message) => {
                if (Date.now() - this.#tfAt > 1000) {
                    posed(message.pose.pose.position, message.pose.pose.orientation)
                }
            }),
            this.#sub(TOPICS.ready, (message) => this.ready.emit({ value: !!message.data, at: Date.now() })),
        )
    }

    /** The lidar scan and the local map, while a 3D view shows (they're the heavy topics). */
    watchClouds(): () => void {
        if (this.fake) {
            return () => {}
        }
        if (!this.#zenoh || !this.msgs) {
            // not connected yet: try again shortly
            let stop: (() => void) | null = null
            const timer = setInterval(() => {
                if (this.#zenoh && this.msgs) {
                    clearInterval(timer)
                    stop = this.watchClouds()
                }
            }, 300)
            return () => {
                clearInterval(timer)
                stop?.()
            }
        }
        const stops = [
            this.#sub(TOPICS.scan, (message) => {
                const cloud = cloudXyz(message, MAX_SCAN_POINTS)
                if (cloud) {
                    this.rates.scan.tick()
                    this.scan.emit(cloud)
                }
            }),
            this.#sub(TOPICS.map, (message) => {
                const cloud = cloudXyz(message, MAX_MAP_POINTS)
                if (cloud) {
                    this.map.emit(cloud)
                }
            }),
        ]
        return () => stops.forEach((stop) => stop())
    }

    /** One camera's frames, JPEG or video, whichever it publishes. */
    /** One camera's frames, JPEG or video, whichever it publishes. `mini`: the corner thumbnail of the other camera, a
     * small slow track at the lowest bandwidth priority (the gateway drops it first), from the JPEG topic only. */
    watchCamera(camera: CameraName, onFrame: (frame: CameraFrame) => void, mini = false): () => void {
        if (this.fake) {
            return this.fake.camera(camera, onFrame, mini ? 200 : 100)
        }
        let stop: (() => void) | null = null
        const start = () => {
            const topics = cameraTopics(camera)
            const stops = [
                // not the JPEGs themselves (~120 KB each over a data channel: 2-3 fps on a phone over Tailscale) but the
                // gateway's video track of them, as the Controller does (core/video.ts): its "dimos_lcm_compressed_image"
                // encoding re-encodes to H.264, sized and paced to the link, and the browser plays it in a <video>
                this.#zenoh!.subscribe(
                    topics.jpeg,
                    mini
                        ? { delivery: "latest", encoding: "dimos_lcm_compressed_image", ...MINI_CAMERA }
                        : { delivery: "latest", encoding: "dimos_lcm_compressed_image", bandwidthPriority: 2 },
                    (message) => {
                        if (!mini) {
                            this.rates.camera.tick()
                        }
                        const stream = (message as { mediaStream?: MediaStream }).mediaStream
                        if (stream) {
                            onFrame({ kind: "stream", stream })
                        }
                    },
                ),
                // (the H.265 topic only for the main view: the mini picture never decodes a full stream)
                ...(mini ? [] : [this.#sub(topics.video, (message) => {
                    this.rates.camera.tick()
                    onFrame({
                        kind: "video",
                        format: String(message.format ?? "h265").toLowerCase(),
                        data: message.data,
                        stamp: message.timestamp ? stampOf({ stamp: message.timestamp }) : null,
                    })
                })]),
            ]
            stop = () => stops.forEach((s) => s())
        }
        const timer = setInterval(() => {
            if (this.#zenoh && this.msgs) {
                clearInterval(timer)
                start()
            }
        }, 200)
        return () => {
            clearInterval(timer)
            stop?.()
        }
    }
}

/** Messages per second over the last 2 s. */
export class Rate {
    #times: number[] = []
    tick() {
        const now = performance.now()
        this.#times.push(now)
        while (this.#times.length && now - this.#times[0] > 2000) {
            this.#times.shift()
        }
    }
    get hz() {
        const now = performance.now()
        return this.#times.filter((t) => now - t <= 2000).length / 2
    }
}

/** The fake boards' robot: a room, a scan of it from a pose that the drive's Twist moves, and a camera test card. */
export class FakeWorld {
    twist = { x: 0, y: 0, yaw: 0 }
    #pose = { x: 0, y: 0, yaw: 0 }
    #room: Float32Array
    #timers: number[] = []
    #live: Live

    constructor(live: Live) {
        this.#live = live
        this.#room = fakeRoom()
        live.map.emit({ xyz: this.#room, count: this.#room.length / 3, at: Date.now() })
        let last = performance.now()
        this.#timers.push(setInterval(() => {
            const now = performance.now()
            const dt = (now - last) / 1000
            last = now
            const p = this.#pose
            p.yaw += this.twist.yaw * dt
            p.x += (this.twist.x * Math.cos(p.yaw) - this.twist.y * Math.sin(p.yaw)) * dt
            p.y += (this.twist.x * Math.sin(p.yaw) + this.twist.y * Math.cos(p.yaw)) * dt
            live.rates.pose.tick()
            live.pose.emit({
                x: p.x,
                y: p.y,
                z: 0,
                qx: 0,
                qy: 0,
                qz: Math.sin(p.yaw / 2),
                qw: Math.cos(p.yaw / 2),
                at: Date.now(),
            })
        }, 50))
        this.#timers.push(setInterval(() => {
            live.rates.scan.tick()
            live.scan.emit(this.#scan())
        }, 100))
        this.#timers.push(
            setInterval(() => live.map.emit({ xyz: this.#room, count: this.#room.length / 3, at: Date.now() }), 2000),
        )
    }

    /** the room's points within 8 m, in the robot's frame */
    #scan(): Cloud {
        const { x, y, yaw } = this.#pose
        const [c, s] = [Math.cos(-yaw), Math.sin(-yaw)]
        const out = new Float32Array(this.#room.length)
        let count = 0
        for (let i = 0; i < this.#room.length; i += 3) {
            const dx = this.#room[i] - x
            const dy = this.#room[i + 1] - y
            if (dx * dx + dy * dy < 64 && Math.random() < 0.5) {
                out[count * 3] = dx * c - dy * s
                out[count * 3 + 1] = dx * s + dy * c
                out[count * 3 + 2] = this.#room[i + 2] - 0.35
                count++
            }
        }
        return { xyz: out, count, at: Date.now() }
    }

    camera(camera: CameraName, onFrame: (frame: CameraFrame) => void, everyMs = 100): () => void {
        const canvas = new OffscreenCanvas(640, 360)
        const context = canvas.getContext("2d")!
        let busy = false
        const timer = setInterval(async () => {
            if (busy) {
                return
            }
            busy = true
            const t = performance.now() / 1000
            const hue = camera === "front" ? 210 : 30
            const gradient = context.createLinearGradient(0, 0, 640, 360)
            gradient.addColorStop(0, `hsl(${hue} 30% 18%)`)
            gradient.addColorStop(1, `hsl(${hue + 40} 30% 8%)`)
            context.fillStyle = gradient
            context.fillRect(0, 0, 640, 360)
            context.strokeStyle = "rgba(255,255,255,0.12)"
            const shift = ((this.#pose.x * 40) % 40 + 40) % 40
            for (let i = -1; i < 18; i++) {
                context.beginPath()
                context.moveTo(320, 150)
                context.lineTo(i * 40 - shift, 360)
                context.stroke()
            }
            context.fillStyle = "rgba(255,255,255,0.8)"
            context.font = "20px sans-serif"
            context.fillText(`Simulated ${camera} camera`, 24, 40)
            context.font = "14px monospace"
            context.fillText(
                `t ${t.toFixed(1)} s  ·  x ${this.#pose.x.toFixed(2)}  y ${this.#pose.y.toFixed(2)}`,
                24,
                66,
            )
            const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })
            this.#live.rates.camera.tick()
            onFrame({ kind: "jpeg", data: new Uint8Array(await blob.arrayBuffer()), stamp: Date.now() })
            busy = false
        }, everyMs)
        return () => clearInterval(timer)
    }

    stop() {
        this.#timers.forEach(clearInterval)
    }
}

/** A 12 × 8 m room with a few boxes, as points (map frame, z up). */
function fakeRoom(): Float32Array {
    const points: number[] = []
    const wall = (x0: number, y0: number, x1: number, y1: number, height: number) => {
        const length = Math.hypot(x1 - x0, y1 - y0)
        for (let d = 0; d <= length; d += 0.08) {
            for (let z = 0; z <= height; z += 0.1) {
                points.push(x0 + ((x1 - x0) * d) / length, y0 + ((y1 - y0) * d) / length, z)
            }
        }
    }
    wall(-4, -4, 8, -4, 2.4)
    wall(8, -4, 8, 4, 2.4)
    wall(8, 4, -4, 4, 2.4)
    wall(-4, 4, -4, -4, 2.4)
    for (const [bx, by] of [[3, 1.5], [5, -2], [1, -2.5]]) {
        wall(bx, by, bx + 0.8, by, 0.8)
        wall(bx + 0.8, by, bx + 0.8, by + 0.8, 0.8)
        wall(bx + 0.8, by + 0.8, bx, by + 0.8, 0.8)
        wall(bx, by + 0.8, bx, by, 0.8)
    }
    for (let x = -4; x <= 8; x += 0.25) {
        for (let y = -4; y <= 4; y += 0.25) {
            points.push(x, y, 0)
        }
    }
    return new Float32Array(points)
}
