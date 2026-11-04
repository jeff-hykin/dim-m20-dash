// Driving (the Controller's drive loop, core/drive.ts, cut down to one Twist topic): the keyboard, the on-screen sticks,
// the d-pad and a gamepad each push -1..1 axes; while any is off center a geometry_msgs/Twist goes out at PUBLISH_HZ on
// the running blueprint's teleop input (m20-nav: tele_cmd_vel, which its MovementManager hands to M20Connection's
// cmd_vel). Safety, as in Go2 Ctrl and the Controller:
//   - nothing is published while idle: no publisher exists before the first drive input (never at page load);
//   - while moving, the zenoh-gateway holds a zero Twist as a deadman and publishes it if this page goes silent for
//     DEADMAN_MS or disconnects; a release sends zeros for a second so the stop is heard, then clears the deadman;
//   - STOP (button, Space, gamepad) releases every source at once.
// Dry run computes and shows the Twist but publishes nothing; with the fake boards it moves the simulated robot instead.
import { DEADMAN_MS, type Live } from "./live.ts"
import { Priority } from "./dim-app/source/vendor/zenoh-gateway/zenoh_gateway.js"

export const PUBLISH_HZ = 20
/** direct mode: a held drive renews its move this often; each holds this long */
const DIRECT_RENEW_MS = 150
const DIRECT_HOLD_MS = 400
export type Axes = { forward: number; strafe: number; turn: number }
export type Twist = { x: number; y: number; yaw: number }
export type Speeds = { linear: number; angular: number }
export const SPEED_LIMITS = { linear: [0.1, 1.5], angular: [0.2, 2.0] } as const
export const SPEED_DEFAULTS: Speeds = { linear: 0.5, angular: 0.8 }
/** Shift / LT */
export const BOOST = 1.6
/** strafe as a share of forward speed */
const STRAFE_SHARE = 0.6

export type DriveTarget =
    /** publish on this zenoh key */
    | { kind: "topic"; key: string; stream: string }
    /** the fake boards: move the simulated robot */
    | { kind: "fake" }
    /** direct mode: the backend's axis commands to basic_server (POST api/direct/move, renewed while held) */
    | { kind: "direct" }
    /** nothing can be driven, and why */
    | { kind: "none"; why: string }

export type DriveStatus = {
    axes: Axes
    twist: Twist
    boost: number
    moving: boolean
    /** publishing (moving, or the stop flush after it) */
    publishing: boolean
    sent: number
    error: string | null
}

const zero = (): Axes => ({ forward: 0, strafe: 0, turn: 0 })
const isMoving = (t: Twist) => t.x !== 0 || t.y !== 0 || t.yaw !== 0
const clamp = (v: number) => Math.max(-1, Math.min(1, v))

type Publisher = {
    state: string
    put(value: Uint8Array): void
    setDeadman(value: Uint8Array): Promise<void>
    clearDeadman(): Promise<void>
    close(): void
}

export class Drive {
    status: DriveStatus = {
        axes: zero(),
        twist: { x: 0, y: 0, yaw: 0 },
        boost: 0,
        moving: false,
        publishing: false,
        sent: 0,
        error: null,
    }
    target: DriveTarget = { kind: "none", why: "starting" }
    dryRun = false
    speeds: Speeds = { ...SPEED_DEFAULTS }
    #sources = new Map<string, Axes>()
    #publisher: { key: string; publisher: Publisher; deadman: boolean } | null = null
    #flushUntil = 0
    #timer: number
    #listeners = new Set<(status: DriveStatus) => void>()

    constructor(readonly live: Live) {
        this.#timer = setInterval(() => this.#tick(), 1000 / PUBLISH_HZ)
    }

    onChange(listener: (status: DriveStatus) => void) {
        this.#listeners.add(listener)
        return () => void this.#listeners.delete(listener)
    }

    #update(changes: Partial<DriveStatus>) {
        this.status = { ...this.status, ...changes }
        this.#listeners.forEach((listener) => listener(this.status))
    }

    setTarget(target: DriveTarget) {
        if (JSON.stringify(target) === JSON.stringify(this.target)) {
            return
        }
        this.target = target
        if (target.kind !== "topic" || target.key !== this.#publisher?.key) {
            this.#closePublisher()
        }
        if (target.kind === "none") {
            this.stop()
        }
    }

    /** One source's axes (keys, a stick, the pad); all at zero = that source let go. */
    setAxes(source: string, axes: Partial<Axes>) {
        const next = { ...zero(), ...axes }
        if (next.forward === 0 && next.strafe === 0 && next.turn === 0) {
            this.#sources.delete(source)
        } else {
            this.#sources.set(source, next)
        }
        this.#recompute()
    }

    setBoost(boost: number) {
        if (boost !== this.status.boost) {
            this.status.boost = boost
            this.#recompute()
        }
    }

    setSpeeds(speeds: Speeds) {
        this.speeds = speeds
        this.#recompute()
    }

    /** STOP: every source let go at once; the zero goes out now. */
    stop() {
        this.#sources.clear()
        this.#recompute()
    }

    get held() {
        return this.#sources.size > 0
    }

    #recompute() {
        const axes = zero()
        for (const share of this.#sources.values()) {
            axes.forward += share.forward
            axes.strafe += share.strafe
            axes.turn += share.turn
        }
        axes.forward = clamp(axes.forward)
        axes.strafe = clamp(axes.strafe)
        axes.turn = clamp(axes.turn)
        const gain = 1 + (BOOST - 1) * this.status.boost
        const twist = {
            x: axes.forward * this.speeds.linear * gain || 0,
            y: axes.strafe * this.speeds.linear * STRAFE_SHARE * gain || 0,
            yaw: axes.turn * this.speeds.angular * gain || 0,
        }
        const was = this.status.moving
        this.#update({ axes, twist, moving: isMoving(twist) })
        if (was && !isMoving(twist)) {
            this.#tick() // a release is heard now, not at the next tick
        }
    }

    /** Direct mode: a held drive renews the backend's move every DIRECT_RENEW_MS (it lapses on its own after
     * DIRECT_HOLD_MS); a release sends one stop. Axes are shares of the robot's top speed (the speed limits' maxima). */
    #directSent = 0
    #directMoving = false
    #direct(twist: Twist, moving: boolean) {
        if (this.live.fake) {
            this.live.fake.twist = { ...twist } // the 3D view's simulated pose follows too
        }
        if (!moving) {
            if (this.#directMoving) {
                this.#directMoving = false
                fetch("api/direct/stop", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                })
                    .catch(() => {})
            }
            this.#update({ publishing: false })
            return
        }
        const now = Date.now()
        if (this.#directMoving && now - this.#directSent < DIRECT_RENEW_MS) {
            return
        }
        this.#directMoving = true
        this.#directSent = now
        const share = (value: number, max: number) => Math.max(-1, Math.min(1, Math.round((value / max) * 1000) / 1000))
        fetch("api/direct/move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                x: share(twist.x, SPEED_LIMITS.linear[1]),
                y: share(twist.y, SPEED_LIMITS.linear[1]),
                yaw: share(twist.yaw, SPEED_LIMITS.angular[1]),
                durationMs: DIRECT_HOLD_MS,
            }),
        }).then(async (response) => {
            const error = response.ok
                ? null
                : (await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`
            this.#update({ publishing: response.ok, sent: this.status.sent + 1, error })
        }).catch((error) => this.#update({ publishing: false, error: String(error) }))
    }

    #closePublisher() {
        const current = this.#publisher
        if (!current) {
            return
        }
        // mid-drive (deadman armed): the stop goes out first, since closing clears the deadman without firing it
        if (current.deadman && !["tripped", "closed", "rejected"].includes(current.publisher.state)) {
            try {
                current.publisher.put(this.#encode({ x: 0, y: 0, yaw: 0 }))
            } catch {
                // closed under us
            }
        }
        current.publisher.close()
        this.#publisher = null
    }

    #encode(twist: Twist): Uint8Array {
        return this.live.msgs.geometry_msgs.Twist.encode({
            linear: { x: twist.x, y: twist.y, z: 0 },
            angular: { x: 0, y: 0, z: twist.yaw },
        })
    }

    #tick() {
        const { twist, moving } = this.status
        if (moving) {
            this.#flushUntil = Date.now() + 1000
        } else if (Date.now() >= this.#flushUntil) {
            // idle and the stop flush done: the deadman is cleared and nothing goes out
            const current = this.#publisher
            if (current?.deadman) {
                current.deadman = false
                current.publisher.clearDeadman().catch(() => {})
            }
            if (this.status.publishing) {
                this.#update({ publishing: false })
            }
            return
        }
        const target = this.target
        if (this.dryRun || target.kind === "none") {
            this.#update({ publishing: false, error: null })
            return
        }
        if (target.kind === "direct") {
            this.#direct(twist, moving)
            return
        }
        if (target.kind === "fake") {
            if (this.live.fake) {
                this.live.fake.twist = { ...twist }
            }
            this.#update({ publishing: true, sent: this.status.sent + 1, error: null })
            return
        }
        const client = this.live.client
        if (!client || !this.live.msgs || this.live.link.last === "lost") {
            this.#update({ publishing: false, error: "not connected to Desktop's zenoh-gateway" })
            return
        }
        if (this.#publisher && ["tripped", "closed", "rejected"].includes(this.#publisher.publisher.state)) {
            this.#publisher = null // tripped since the last tick: a fresh one
        }
        this.#publisher ??= {
            key: target.key,
            publisher: client.publisher(target.key, { priority: Priority.REAL_TIME, latencyLimit: DEADMAN_MS }),
            deadman: false,
        }
        const current = this.#publisher
        try {
            if (moving && !current.deadman) {
                current.deadman = true
                current.publisher.setDeadman(this.#encode({ x: 0, y: 0, yaw: 0 })).catch((error) => {
                    current.deadman = false
                    this.#update({ error: `deadman: ${error}` })
                })
            }
            current.publisher.put(this.#encode(twist))
            this.#update({ publishing: true, sent: this.status.sent + 1, error: null })
        } catch (error) {
            current.deadman = false
            this.#update({ error: String(error) })
        }
    }

    dispose() {
        clearInterval(this.#timer)
        this.stop()
        this.#closePublisher()
    }
}

/** The running blueprint's Twist input to drive: tele_cmd_vel (a teleop mux's input), else an unfed Twist input, else
 * M20Connection's own cmd_vel output (what its move RPC publishes on, which the robot's bridge consumes). */
export function teleopStream(
    streams: { name: string; type: string; direction: string | null; channel: string | null; module: string }[],
    connection: string | null,
) {
    const twist = streams.filter((s) => /(^|\.)Twist$/.test(s.type) && s.channel)
    const fed = new Set(twist.filter((s) => s.direction === "out" || s.direction === "inout").map((s) => s.channel))
    return twist.find((s) => s.name === "tele_cmd_vel" && s.direction !== "out") ??
        twist.find((s) => s.direction === "in" && !fed.has(s.channel)) ??
        twist.find((s) => s.name === "cmd_vel" && s.module === connection) ??
        null
}
