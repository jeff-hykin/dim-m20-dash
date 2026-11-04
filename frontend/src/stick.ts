// Stick math shared by the on-screen ThumbStick and gamepads (input/gamepad.ts): a -1..1 offset shaped with a dead zone
// and an expo curve for fine control near the center, and the easing that moves a value toward where the thumb is.

/** below this share of the radius a resting thumb sends nothing */
export const STICK_DEAD_ZONE = 0.12
/** >1 flattens the middle: small moves are finer, the edge is still full speed */
export const STICK_EXPO = 1.6
/** how quickly a held stick's output follows the thumb (time constant, ms) */
export const STICK_SMOOTH_MS = 70

const clean = (value: number) => Math.round(value * 1000) / 1000 || 0

/** One axis: its own dead zone, then the expo curve. */
export function shapeAxis(value: number, deadZone = STICK_DEAD_ZONE): number {
    const size = Math.min(1, Math.abs(value))
    if (size <= deadZone) {
        return 0
    }
    return clean(Math.sign(value) * Math.pow((size - deadZone) / (1 - deadZone), STICK_EXPO))
}

/**
 * The thumb's offset from the stick's center (px, screen y down) → `{ x, y }` in -1..1 (up = +y). `axes` "xy" uses a
 * radial dead zone (no snapping to an axis); "x" / "y" look at that axis alone. A gamepad's stick is the same with a
 * radius of 1 and its own dead zone.
 */
export function shapeStick(
    dx: number,
    dy: number,
    radius: number,
    axes: StickAxes = "xy",
    deadZone = STICK_DEAD_ZONE,
): StickValue {
    if (!(radius > 0)) {
        return { x: 0, y: 0 }
    }
    let x = dx / radius
    let y = -dy / radius
    if (axes === "x") {
        return { x: shapeAxis(x, deadZone), y: 0 }
    }
    if (axes === "y") {
        return { x: 0, y: shapeAxis(y, deadZone) }
    }
    const length = Math.hypot(x, y)
    if (length <= deadZone) {
        return { x: 0, y: 0 }
    }
    const scaled = Math.pow((Math.min(1, length) - deadZone) / (1 - deadZone), STICK_EXPO)
    x = (x / length) * scaled
    y = (y / length) * scaled
    return { x: clean(x), y: clean(y) }
}

/**
 * One easing step: `current` toward `target` over `dtMs` (exponential, time constant `tauMs`). Snaps when close; a
 * target of exactly zero is returned as zero (releasing is never eased).
 */
export function smoothToward(current: number, target: number, dtMs: number, tauMs: number = STICK_SMOOTH_MS): number {
    if (target === 0) {
        return 0
    }
    const next = current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs))
    return Math.abs(next - target) < 0.005 ? target : clean(next)
}

export type StickAxes = "xy" | "x" | "y"
export interface StickValue {
    x: number
    y: number
}
