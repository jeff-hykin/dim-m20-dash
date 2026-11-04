// The recording-space warning's words, from api/state's record.space (backend/record_space.ts does the arithmetic).
import type { RecordSpace } from "./api.ts"

const minutes = (seconds: number) => seconds < 60 ? "<1 min" : `${Math.floor(seconds / 60)} min`
const rate = (bytesPerSecond: number) =>
    bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : `${(bytesPerSecond / 1e3).toFixed(0)} KB/s`
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`

/** Where the rate came from, in words. */
export function rateSource(space: RecordSpace): string {
    return space.rateSource === "measured"
        ? "this recording's rate"
        : space.rateSource === "last_recording"
        ? "estimate from the last recording"
        : "estimate from the Record options"
}

/** The record button's warning, or null when there's 5 min or more (or nothing known). */
export function spaceWarning(space: RecordSpace | undefined, recording: boolean): {
    /** on the pill: "~3 min left" (a "~" when it's an estimate) */
    text: string
    /** the pill on a phone */
    short: string
    /** its title, and the start toast */
    detail: string
    full: boolean
} | null {
    if (!space?.low) {
        return null
    }
    const full = space.freeBytes !== null && space.freeBytes <= space.reserveBytes
    const free = space.freeBytes === null ? "" : `${size(space.freeBytes)} free`
    if (full || space.secondsLeft === null || space.secondsLeft <= 0) {
        return {
            text: "⚠ Disk full",
            short: "⚠ Full",
            detail: `Recording disk full (${free}): ${
                recording ? "the recording stops itself" : "a recording stops itself"
            } at ${size(space.reserveBytes)} free`,
            full: true,
        }
    }
    const tilde = space.estimate ? "~" : ""
    const left = `${tilde}${minutes(space.secondsLeft)}`
    return {
        text: `⚠ ${left} left`,
        short: `⚠ ${left.replace(" min", "m")}`,
        detail: `Under 5 min of recording space: ${left} left (${free} at ${rate(space.bytesPerSecond ?? 0)}, ${
            rateSource(space)
        }); a recording stops itself at ${size(space.reserveBytes)} free`,
        full: false,
    }
}

/** The Record panel's line: free space and minutes at the rate, always shown. */
export function spaceLine(space: RecordSpace | undefined): string | null {
    if (!space || space.freeBytes === null) {
        return null
    }
    const free = `${size(space.freeBytes)} free on the robot's recording disk`
    if (space.secondsLeft === null || !space.bytesPerSecond) {
        return free
    }
    return `${free}: ${space.estimate ? "~" : ""}${minutes(space.secondsLeft)} at ${rate(space.bytesPerSecond)} (${
        rateSource(space)
    })`
}
