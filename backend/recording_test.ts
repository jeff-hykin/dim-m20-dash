// A recording with the Record options: the live topics come raw from the zenoh tap (a stand-in here that prints the
// tap's frames: no zenoh, no robot) on dimos-layout channels, an unticked JSON group stays out, the label names the
// file, the folder holds it, and a size cap splits it into parts; the download refuses anything outside m20/.
import { assert, assertEquals } from "@std/assert"
import { readMcap } from "./mcap.ts"
import { DEFAULT_RECORD_OPTIONS, validRecordOptions } from "./record_streams.ts"
import { listRecordings, record, recordingFile, recordingStatus, startRecording, stopRecording } from "./recording.ts"

const STAND_IN_TAP = `#!/usr/bin/env python3
import json, struct, sys, time
request = json.loads(sys.argv[2])
out = sys.stdout.buffer
for i in range(40):
    for topic in request["topics"]:
        key = topic["key"].encode()
        payload = bytes([i % 256]) * 20000
        out.write(struct.pack("<BH", 1, len(key)) + key + struct.pack("<QI", time.time_ns(), len(payload)) + payload)
    body = json.dumps({t["key"]: {"received": i + 1, "skipped": 0, "dropped": 0} for t in request["topics"]}).encode()
    out.write(struct.pack("<BI", 2, len(body)) + body)
    out.flush()
    time.sleep(0.01)
sys.stdin.read()
`

// the tap child exits a moment after its stdin closes, after the test returns
const options = { sanitizeOps: false, sanitizeResources: false }

Deno.test("a recording with options: raw live topics, groups, label, folder, split, download", options, async () => {
    const dir = await Deno.makeTempDir()
    const stub = `${dir}/python`
    await Deno.writeTextFile(stub, STAND_IN_TAP)
    await Deno.chmod(stub, 0o755)
    Deno.env.set("M20_DASH_PYTHON", stub)
    Deno.env.set("M20_DASH_ZENOH_CONNECT", "tcp/127.0.0.1:1")
    try {
        const chosen = validRecordOptions({
            ...DEFAULT_RECORD_OPTIONS,
            label: "hallway",
            folder: "tests",
            splitMb: 1,
            streams: {
                ...DEFAULT_RECORD_OPTIONS.streams,
                boards: { on: false, maxHz: null },
                lidar: { on: false, maxHz: null },
            },
        })
        startRecording(dir, {}, chosen)
        record("/boards/gos/stats", { cpu: 1 })
        record("/robot/basic", { BasicStatus: { MotionState: 1 } })
        await new Promise((resolve) => setTimeout(resolve, 2500))
        const status = recordingStatus() as {
            streams: Record<string, { written: number; received: number }>
            tap: { state: string }
        }
        assertEquals(status.tap.state, "running")
        assert(status.streams.front_camera.written > 0 && status.streams.front_camera.received > 0)
        assertEquals(status.streams.boards, undefined, "boards unticked")
        const stopped = stopRecording() as { files: string[] }
        assert(stopped.files.length >= 2, `split into parts: ${stopped.files}`)
        assert(stopped.files.every((f) => f.startsWith("tests/") && f.includes("_hallway")))
        assertEquals(stopped.files[1].endsWith("_part2.mcap"), true)
        const messages = stopped.files.flatMap((f) => readMcap(Deno.readFileSync(`${dir}/${f}`)))
        const topics = new Set(messages.map((m) => m.topic))
        assert(topics.has("front_camera_image") && topics.has("tf") && topics.has("/robot/basic"), [...topics].join())
        assert(!topics.has("slam_body_points") && !topics.has("/boards/gos/stats"), "unticked groups stay out")
        assertEquals(listRecordings(dir).recordings.length, stopped.files.length)
        const download = await recordingFile(stopped.files[0], dir)
        assertEquals(download.status, 200)
        assertEquals((await download.arrayBuffer()).byteLength, Deno.statSync(`${dir}/${stopped.files[0]}`).size)
        assertEquals((await recordingFile("../escape.mcap", dir)).status, 404)
    } finally {
        Deno.env.delete("M20_DASH_PYTHON")
        Deno.env.delete("M20_DASH_ZENOH_CONNECT")
        await Deno.remove(dir, { recursive: true })
    }
})
