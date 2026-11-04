// The record button's space warning with made-up numbers: none at 5 min or more, "~N min left" for an estimate,
// "N min left" for a measured rate, "⚠ Disk full" under the 1 GB stop reserve.
import { assert, assertEquals } from "@std/assert"
import type { RecordSpace } from "../src/api.ts"
import { spaceLine, spaceWarning } from "../src/record_space.ts"

const MB = 1e6
const GB = 1e9
const space = (over: Partial<RecordSpace>): RecordSpace => ({
    freeBytes: 20 * GB,
    reserveBytes: GB,
    bytesPerSecond: 10 * MB,
    rateSource: "measured",
    estimate: false,
    secondsLeft: 1900,
    low: false,
    ...over,
})

Deno.test("no warning with 5 min or more, or nothing known", () => {
    assertEquals(spaceWarning(space({}), true), null)
    assertEquals(spaceWarning(undefined, false), null)
})

Deno.test("measured: minutes left, no tilde", () => {
    const warning = spaceWarning(space({ freeBytes: 3.4 * GB, secondsLeft: 240, low: true }), true)!
    assertEquals(warning.text, "⚠ 4 min left")
    assertEquals(warning.short, "⚠ 4m")
    assertEquals(warning.full, false)
    assert(warning.detail.includes("this recording's rate"), warning.detail)
})

Deno.test("estimate: a tilde and where it came from", () => {
    const warning = spaceWarning(
        space({ secondsLeft: 150, low: true, rateSource: "last_recording", estimate: true }),
        false,
    )!
    assertEquals(warning.text, "⚠ ~2 min left")
    assert(warning.detail.includes("estimate from the last recording"), warning.detail)
    assertEquals(spaceWarning(space({ secondsLeft: 30, low: true, estimate: true }), false)!.text, "⚠ ~<1 min left")
})

Deno.test("under the reserve: disk full", () => {
    const warning = spaceWarning(space({ freeBytes: 0.6 * GB, secondsLeft: 0, low: true }), false)!
    assertEquals(warning.text, "⚠ Disk full")
    assertEquals(warning.full, true)
})

Deno.test("the panel's line", () => {
    assertEquals(
        spaceLine(space({ freeBytes: 12.5 * GB, secondsLeft: 1150, rateSource: "options", estimate: true })),
        "12.50 GB free on the robot's recording disk: ~19 min at 10.0 MB/s (estimate from the Record options)",
    )
    assertEquals(spaceLine(space({ freeBytes: null })), null)
})
