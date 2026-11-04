// Driving from a gamepad (the Gamepad API's standard mapping: the Steam Deck when launched through Steam, Xbox,
// PlayStation; other pads are read with the common layout, sticks on axes 0-3). Controller's design (dim-controller
// core/gamepad.ts), DOM-free so it's testable:
//   left stick   forward / back, strafe          right stick X   turn
//   LT or RB (held) run (×2.2)                   LT + RT or B    STOP: the pad holds until A
//   A            drive again after a stop        hold B 1 s      SIT DOWN (stop, then StandDown)
// Safety: nothing drives until the sticks have been seen at rest (a pad connected with a stick off center, or
// drifting, sends nothing); a disconnect, blur or hidden page zeroes it and asks for rest again.
// The raw axes and buttons (never velocities) also go to the recording as sensor_msgs/Joy (Control.tsx).

export interface PadLike {
    index: number
    id: string
    mapping: string
    connected: boolean
    timestamp?: number
    axes: readonly number[]
    buttons: readonly { pressed: boolean; value: number }[]
}

export interface GamepadStatus {
    connected: boolean
    id: string
    /** sticks seen at rest since connect / the last stop: input counts */
    ready: boolean
    /** LT + RT or B pressed: the pad holds until A */
    stopped: boolean
    /** 0..1 while B is held toward Sit down */
    sitHold: number
}

export interface Axes {
    forward: number
    strafe: number
    turn: number
}

export const DEAD_ZONE = 0.15
export const EXPO = 1.6
/** a trigger counts as pulled past this */
const TRIGGER = 0.5
/** LT's travel below this is slack, not boost */
const BOOST_SLACK = 0.05

/** How much LT boosts: 0 released .. 1 fully pulled (past a little slack), in 0.05 steps so it isn't resent per tick. */
export function boostOf(value: number): number {
    const pulled = Math.min(1, Math.max(0, (value - BOOST_SLACK) / (1 - BOOST_SLACK)))
    return Math.round(pulled * 20) / 20
}
/** how long B must be held to sit down */
export const SIT_HOLD_MS = 1000
/** standard mapping buttons (w3.org/TR/gamepad) */
export const BUTTON = { a: 0, b: 1, rb: 5, lt: 6, rt: 7 } as const

export const noPad = (): GamepadStatus => ({
    connected: false,
    id: "",
    ready: false,
    stopped: false,
    sitHold: 0,
})

const clean = (value: number) => Math.round(value * 1000) / 1000 || 0

function shape1(value: number, deadZone: number): number {
    const size = Math.min(1, Math.abs(value))
    return size <= deadZone ? 0 : clean(
        Math.sign(value) * Math.pow((size - deadZone) / (1 - deadZone), EXPO),
    )
}

/** A two-axis stick with a radial dead zone and an expo curve; y up = +. */
export function shapeStick(
    x: number,
    yDown: number,
    deadZone = DEAD_ZONE,
): { x: number; y: number } {
    const y = -yDown
    const length = Math.hypot(x, y)
    if (length <= deadZone) {
        return { x: 0, y: 0 }
    }
    const scaled = Math.pow(
        (Math.min(1, length) - deadZone) / (1 - deadZone),
        EXPO,
    )
    return { x: clean((x / length) * scaled), y: clean((y / length) * scaled) }
}

export function readPad(pad: PadLike) {
    const axis = (index: number) => Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0
    const button = (index: number) => {
        const entry = pad.buttons[index]
        return !!entry && (entry.pressed || entry.value > TRIGGER)
    }
    return {
        lx: axis(0),
        ly: axis(1),
        rx: axis(2),
        ry: axis(3),
        a: button(BUTTON.a),
        b: button(BUTTON.b),
        rb: button(BUTTON.rb),
        lt: button(BUTTON.lt),
        rt: button(BUTTON.rt),
        ltValue: pad.buttons[BUTTON.lt]?.value ?? 0,
    }
}

/** The drive's -1..1 axes from the sticks: left = forward + strafe (left = +), right X = turn (left = +). */
export function padAxes(
    read: { lx: number; ly: number; rx: number },
    deadZone = DEAD_ZONE,
): Axes {
    const left = shapeStick(read.lx, read.ly, deadZone)
    return {
        forward: left.y,
        strafe: clean(-left.x),
        turn: clean(-shape1(read.rx, deadZone)),
    }
}

export function atRest(
    read: {
        lx: number
        ly: number
        rx: number
        ry: number
        lt: boolean
        rt: boolean
    },
    deadZone = DEAD_ZONE,
) {
    return Math.hypot(read.lx, read.ly) <= deadZone &&
        Math.hypot(read.rx, read.ry) <= deadZone && !read.lt && !read.rt
}

/** 4 decimals; not-a-number (a missing axis) as 0 */
const round4 = (value: number) => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0

/**
 * The Joy sample for the recording: the raw axes (4 decimals) and buttons (0/1), as the Gamepad API reports them, and
 * after the axes the two triggers' analog travel (0 released .. 1 fully pressed, LT then RT: standard-mapping buttons 6
 * and 7), since a Joy button is only an integer.
 */
export function joySample(pad: PadLike): { axes: number[]; buttons: number[] } {
    const trigger = (index: number) => round4(pad.buttons[index]?.value ?? 0)
    return {
        axes: [...pad.axes.map(round4), trigger(BUTTON.lt), trigger(BUTTON.rt)],
        buttons: pad.buttons.map((b) => (b.pressed ? 1 : 0)),
    }
}

/** What the pad drives (Control.tsx; a test passes fakes). */
export interface PadTarget {
    /** the pad's axes; all zero = let go */
    setAxes: (axes: Axes) => void
    /** 0..1: LT's pull (RB: all of it) */
    setBoost: (boost: number) => void
    /** STOP now */
    stop: () => void
    /** the safe way down (stop, StandDown) */
    sitDown: () => void
}

const ZERO: Axes = { forward: 0, strafe: 0, turn: 0 }

/** Steam Input can expose several virtual pads: the one used most recently drives. */
export function activePad(pads: readonly (PadLike | null)[]): PadLike | null {
    const all = pads.filter((pad): pad is PadLike => !!pad && pad.connected)
    // a handheld can also show its raw pad (e.g. a Legion Go S variant's 1a86:e310) with its own axis order: when a
    // standard-mapped pad (Steam's virtual one) is there, only those count
    const standard = all.filter((pad) => pad.mapping === "standard")
    const connected = standard.length ? standard : all
    if (connected.length < 2) {
        return connected[0] ?? null
    }
    return connected.reduce((
        best,
        pad,
    ) => ((pad.timestamp ?? 0) > (best.timestamp ?? 0) ? pad : best))
}

export class GamepadDriver {
    status: GamepadStatus = noPad()
    #index: number | null = null
    #last = { a: false, b: false, combo: false, boost: 0 }
    #bSince: number | null = null
    #sitSent = false
    #sent = JSON.stringify(ZERO)

    constructor(
        readonly target: PadTarget,
        readonly onStatus: (status: GamepadStatus) => void = () => {},
    ) {}

    #update(change: Partial<GamepadStatus>) {
        const next = { ...this.status, ...change }
        if (JSON.stringify(next) !== JSON.stringify(this.status)) {
            this.status = next
            this.onStatus(next)
        }
    }

    /** One read of navigator.getGamepads(); `now` in ms. */
    poll(pads: readonly (PadLike | null)[], now: number) {
        const pad = activePad(pads)
        if (!pad) {
            if (this.status.connected) {
                this.release()
                this.#index = null
                this.#update(noPad())
            }
            return
        }
        if (pad.index !== this.#index) {
            this.release()
            this.#index = pad.index
            this.#last = { a: false, b: false, combo: false, boost: 0 }
            this.#update({
                connected: true,
                id: pad.id,
                ready: false,
                stopped: false,
                sitHold: 0,
            })
        }
        const read = readPad(pad)

        // LT + RT, or B: STOP at once, whatever else is going on
        const combo = (read.lt && read.rt) || read.b
        if (combo && !this.#last.combo) {
            this.#zero()
            this.target.stop()
            this.#update({ stopped: true, ready: false })
        }
        // hold B: sit down after SIT_HOLD_MS (once per hold)
        if (read.b) {
            this.#bSince ??= now
            const held = Math.min(1, (now - this.#bSince) / SIT_HOLD_MS)
            if (held >= 1 && !this.#sitSent) {
                this.#sitSent = true
                this.target.sitDown()
            }
            this.#update({ sitHold: this.#sitSent ? 1 : held })
        } else {
            this.#bSince = null
            this.#sitSent = false
            this.#update({ sitHold: 0 })
        }
        // A: drive again after a stop (still from rest)
        if (read.a && !this.#last.a && this.status.stopped && !read.b) {
            this.#update({ stopped: false, ready: false })
        }
        this.#last.a = read.a
        this.#last.b = read.b
        this.#last.combo = combo

        if (!this.status.ready && !this.status.stopped && atRest(read)) {
            this.#update({ ready: true })
        }
        const boost = this.status.ready && !this.status.stopped ? (read.rb ? 1 : boostOf(read.ltValue)) : 0
        if (boost !== this.#last.boost) {
            this.#last.boost = boost
            this.target.setBoost(boost)
        }
        if (this.status.stopped || !this.status.ready) {
            this.#zero()
            return
        }
        this.#send(padAxes(read))
    }

    /** Blur, a hidden page, a disconnect: zero now, and nothing again until the sticks are at rest. */
    release() {
        this.#zero()
        this.#bSince = null
        if (this.#last.boost) {
            this.#last.boost = 0
            this.target.setBoost(0)
        }
        if (this.status.connected) {
            this.#update({ ready: false, sitHold: 0 })
        }
    }

    #zero() {
        this.#send(ZERO)
    }

    #send(axes: Axes) {
        const key = JSON.stringify(axes)
        if (key !== this.#sent) {
            this.#sent = key
            this.target.setAxes(axes)
        }
    }
}

/** The pad's controls, for the help line. */
export const GAMEPAD_BINDINGS: [string, string][] = [
    ["Left stick", "forward / back, strafe"],
    ["Right stick", "turn"],
    ["LT or RB (hold)", "walk fast (like Shift)"],
    ["LT + RT or B", "STOP (holds until A)"],
    ["A", "drive again after a stop"],
    ["Hold B 1 s", "STOP (Lie down is its button: it asks first)"],
]
