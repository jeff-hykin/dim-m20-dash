// How long the recordings' disk lasts: (free bytes − the 1 GB a recording stops itself at) ÷ the write rate.
// While recording the rate is the measured one (bytes written, smoothed over ~15 s); otherwise it's an estimate for the
// Record options: each ticked group at the rate the last recording that had it measured (at the same rate cap), else
// its documented full rate (record_streams.ts fullRate) scaled by its cap. Under 5 minutes is "low".
import { statfsSync } from "node:fs"
import { type GroupId, GROUPS, type RecordOptions } from "./record_streams.ts"

/** a recording stops itself when its disk is down to this */
export const RESERVE_BYTES = 1e9
/** under this many seconds left the page warns */
export const LOW_SECONDS = 5 * 60
/** the measured rate's smoothing time constant */
export const SMOOTH_SECONDS = 15
/** a "small" group's guess when nothing was measured */
const SMALL_BYTES_PER_SECOND = 2e3

/** Bytes free (to a non-root user, as df's Available) on the disk holding `dir` (or its nearest existing parent). */
export function diskFree(dir: string): number | null {
    for (let path = dir; path.startsWith("/"); path = path.slice(0, Math.max(path.lastIndexOf("/"), 1))) {
        try {
            const stats = statfsSync(path)
            return Number(stats.bavail) * Number(stats.bsize)
        } catch {
            if (path === "/") {
                return null
            }
        }
    }
    return null
}

/** Exponential smoothing of a rate sampled every `dtSeconds` (the first sample is taken as it is). */
export function smooth(previous: number | null, sample: number, dtSeconds: number, tau = SMOOTH_SECONDS): number {
    if (previous === null) {
        return sample
    }
    const weight = 1 - Math.exp(-dtSeconds / tau)
    return previous + weight * (sample - previous)
}

/** what one group wrote in a past recording */
export type GroupRate = { bytesPerSecond: number; maxHz: number | null }
export type PastRates = Partial<Record<GroupId | "other", GroupRate>>

/** "~30 fps, ~3.5 MB/s" → {hz: 30, bytesPerSecond: 3.5e6}; "small" → a few KB/s */
export function nominalRate(fullRate: string): { hz: number | null; bytesPerSecond: number } {
    const hz = fullRate.match(/(\d+(?:\.\d+)?)\s*(?:fps|Hz)/)
    const mb = fullRate.match(/(\d+(?:\.\d+)?)\s*MB\/s/)
    return {
        hz: hz ? Number(hz[1]) : null,
        bytesPerSecond: mb ? Number(mb[1]) * 1e6 : SMALL_BYTES_PER_SECOND,
    }
}

export type RateEstimate = { bytesPerSecond: number; source: "last_recording" | "options" }

/** The write rate `options` should give: past measurements where the cap matches, else the nominal rates. */
export function estimateRate(options: RecordOptions, past: PastRates): RateEstimate {
    let total = past.other?.bytesPerSecond ?? SMALL_BYTES_PER_SECOND
    let allMeasured = true
    for (const group of GROUPS) {
        const choice = options.streams[group.id]
        if (!choice?.on) {
            continue
        }
        const measured = past[group.id]
        if (measured && measured.maxHz === choice.maxHz) {
            total += measured.bytesPerSecond
            continue
        }
        allMeasured = false
        const nominal = nominalRate(group.fullRate)
        const share = choice.maxHz !== null && nominal.hz ? Math.min(1, choice.maxHz / nominal.hz) : 1
        total += nominal.bytesPerSecond * share
    }
    return { bytesPerSecond: total, source: allMeasured && past.other ? "last_recording" : "options" }
}

export type Space = {
    freeBytes: number | null
    reserveBytes: number
    bytesPerSecond: number | null
    /** measured: this recording's own rate; last_recording / options: an estimate for the next one */
    rateSource: "measured" | "last_recording" | "options" | null
    estimate: boolean
    /** seconds of recording until it stops itself (null: unknown) */
    secondsLeft: number | null
    low: boolean
}

export function space(freeBytes: number | null, rate: number | null, source: Space["rateSource"]): Space {
    const secondsLeft = freeBytes === null || !rate || rate <= 0
        ? null
        : Math.max(0, (freeBytes - RESERVE_BYTES) / rate)
    return {
        freeBytes,
        reserveBytes: RESERVE_BYTES,
        bytesPerSecond: rate,
        rateSource: source,
        estimate: source !== "measured",
        secondsLeft,
        low: secondsLeft !== null ? secondsLeft < LOW_SECONDS : freeBytes !== null && freeBytes < RESERVE_BYTES,
    }
}

/** Past per-group rates, kept in a JSON file (a missing or broken one is no history). */
export function loadPastRates(path: string): PastRates {
    try {
        return JSON.parse(Deno.readTextFileSync(path)) as PastRates
    } catch {
        return {}
    }
}

export function savePastRates(path: string, rates: PastRates) {
    try {
        Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
        Deno.writeTextFileSync(path, JSON.stringify(rates, null, 2))
    } catch {
        // no history next time: the estimate falls back to the nominal rates
    }
}
