// The recording-space estimate with made-up numbers: minutes left, the 5-minute line, the 1 GB stop reserve, the
// smoothing, the options estimate (past measurements at the same cap, else the nominal rates scaled by the cap), and
// statfs agreeing with df.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert"
import { DEFAULT_RECORD_OPTIONS, type RecordOptions } from "./record_streams.ts"
import {
    diskFree,
    estimateRate,
    LOW_SECONDS,
    nominalRate,
    type PastRates,
    RESERVE_BYTES,
    smooth,
    space,
} from "./record_space.ts"

const MB = 1e6
const GB = 1e9

Deno.test("seconds left = (free - 1 GB reserve) / rate; low under 5 min", () => {
    const plenty = space(11 * GB, 10 * MB, "measured")
    assertEquals(plenty.secondsLeft, 1000)
    assertEquals(plenty.low, false)
    assertEquals(plenty.estimate, false)

    // 1 GB + 2.9 GB at 10 MB/s = 290 s
    const low = space(RESERVE_BYTES + 2.9 * GB, 10 * MB, "options")
    assertEquals(low.secondsLeft, 290)
    assertEquals(low.low, true)
    assertEquals(low.estimate, true)

    assertEquals(space(RESERVE_BYTES + LOW_SECONDS * MB, MB, "measured").low, false, "exactly 5 min is not under")
    assertEquals(space(0.5 * GB, MB, "measured").secondsLeft, 0, "under the reserve: none left")
    assertEquals(space(null, MB, "measured").secondsLeft, null, "no disk reading: unknown")
    assertEquals(space(null, MB, "measured").low, false)
    assertEquals(space(0.5 * GB, null, null).low, true, "no rate but under the reserve: low")
})

Deno.test("the measured rate is smoothed", () => {
    assertEquals(smooth(null, 8 * MB, 5), 8 * MB, "first sample as is")
    const next = smooth(8 * MB, 2 * MB, 5, 15)
    assert(next < 8 * MB && next > 2 * MB, `between: ${next}`)
    assertAlmostEquals(next, 8 * MB - (1 - Math.exp(-5 / 15)) * 6 * MB, 1)
    let rate: number | null = null
    for (let i = 0; i < 60; i++) {
        rate = smooth(rate, i % 2 ? 4 * MB : 6 * MB, 5)
    }
    assertAlmostEquals(rate!, 5 * MB, 0.6 * MB)
})

Deno.test("nominal rates from record_streams' fullRate", () => {
    assertEquals(nominalRate("~30 fps, ~3.5 MB/s"), { hz: 30, bytesPerSecond: 3.5 * MB })
    assertEquals(nominalRate("~10 Hz, ~7 MB/s"), { hz: 10, bytesPerSecond: 7 * MB })
    assert(nominalRate("1 Hz, small").bytesPerSecond < 0.01 * MB)
})

function only(streams: Partial<RecordOptions["streams"]>): RecordOptions {
    const off = Object.fromEntries(
        Object.keys(DEFAULT_RECORD_OPTIONS.streams).map((id) => [id, { on: false, maxHz: null }]),
    )
    return { ...DEFAULT_RECORD_OPTIONS, streams: { ...off, ...streams } as RecordOptions["streams"] }
}

Deno.test("options estimate: measured where the cap matches, else nominal scaled by the cap", () => {
    // nothing measured: front camera at 5 of ~30 fps of 3.5 MB/s, lidar at full ~7 MB/s
    const nominal = estimateRate(
        only({ front_camera: { on: true, maxHz: 5 }, lidar: { on: true, maxHz: null } }),
        {},
    )
    assertEquals(nominal.source, "options")
    assertAlmostEquals(nominal.bytesPerSecond, 3.5 * MB / 6 + 7 * MB, 0.01 * MB)

    const past: PastRates = {
        front_camera: { bytesPerSecond: 0.4 * MB, maxHz: 5 },
        lidar: { bytesPerSecond: 5 * MB, maxHz: null },
        other: { bytesPerSecond: 0.01 * MB, maxHz: null },
    }
    const same = estimateRate(only({ front_camera: { on: true, maxHz: 5 }, lidar: { on: true, maxHz: null } }), past)
    assertEquals(same.source, "last_recording")
    assertAlmostEquals(same.bytesPerSecond, 5.41 * MB, 1)

    // the camera's cap changed: back to the nominal for it
    const changed = estimateRate(
        only({ front_camera: { on: true, maxHz: 10 }, lidar: { on: true, maxHz: null } }),
        past,
    )
    assertEquals(changed.source, "options")
    assertAlmostEquals(changed.bytesPerSecond, 3.5 * MB / 3 + 5 * MB + 0.01 * MB, 1)

    // unticking a group drops its bytes
    const fewer = estimateRate(only({ lidar: { on: true, maxHz: null } }), past)
    assertAlmostEquals(fewer.bytesPerSecond, 5.01 * MB, 1)
})

Deno.test("free space matches df's Available", async () => {
    const dir = await Deno.makeTempDir()
    try {
        const free = diskFree(`${dir}/not/made/yet`)
        const out = new TextDecoder().decode(
            (await new Deno.Command("df", { args: ["-Pk", dir], stdout: "piped" }).output()).stdout,
        )
        const dfFree = Number(out.trim().split("\n").pop()!.split(/\s+/)[3]) * 1024
        assert(free !== null)
        // the two reads are a moment apart: other writers may move it a little
        assert(Math.abs(free - dfFree) < 50 * MB, `statfs ${free} vs df ${dfFree}`)
    } finally {
        await Deno.remove(dir, { recursive: true })
    }
})
