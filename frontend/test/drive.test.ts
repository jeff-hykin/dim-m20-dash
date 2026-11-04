// drive.ts against a stand-in zenoh-gateway client: nothing is published before a drive input, a held input publishes
// Twists with a deadman armed, a release sends zeros for a second then clears the deadman, dry run publishes nothing.
// `deno test -A frontend/test/` (msgs.js is the dimos gateway's, fetched from a running Desktop: M20_MSGS_JS=<path>)
import { assert, assertEquals } from "@std/assert"
import { Drive, teleopStream } from "../src/drive.ts"

const msgsPath = Deno.env.get("M20_MSGS_JS")

type Put = { key: string; bytes: Uint8Array }
function fakeLive() {
    const puts: Put[] = []
    const deadmen: string[] = []
    const cleared: string[] = []
    const client = {
        publisher(key: string) {
            return {
                state: "open",
                put: (bytes: Uint8Array) => puts.push({ key, bytes }),
                setDeadman: async () => void deadmen.push(key),
                clearDeadman: async () => void cleared.push(key),
                close() {},
            }
        },
    }
    // deno-lint-ignore no-explicit-any
    const msgs: any = {
        geometry_msgs: { Twist: { encode: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)) } },
    }
    // deno-lint-ignore no-explicit-any
    const live: any = { client, msgs, link: { last: "connected" }, fake: null }
    return { live, puts, deadmen, cleared }
}
const decode = (put: Put) => JSON.parse(new TextDecoder().decode(put.bytes))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const KEY = "dimos/tele_cmd_vel/geometry_msgs.Twist"

Deno.test("idle: no publisher, nothing sent; held: Twists with a deadman; release: zeros, then quiet", async () => {
    const { live, puts, deadmen, cleared } = fakeLive()
    const drive = new Drive(live)
    drive.setTarget({ kind: "topic", key: KEY, stream: "tele_cmd_vel" })
    await sleep(200)
    assertEquals(puts.length, 0, "nothing while idle")
    drive.setAxes("keys", { forward: 1 })
    await sleep(260)
    assert(puts.length >= 4)
    assertEquals(decode(puts.at(-1)!).linear.x, 0.5)
    assertEquals(deadmen, [KEY])
    drive.setAxes("keys", {})
    const atRelease = puts.length
    assertEquals(decode(puts[atRelease - 1]).linear.x, 0, "the release is heard at once")
    await sleep(1200)
    assert(puts.slice(atRelease).every((put) => decode(put).linear.x === 0))
    assertEquals(cleared, [KEY])
    const quiet = puts.length
    await sleep(200)
    assertEquals(puts.length, quiet, "quiet after the stop flush")
    drive.dispose()
})

Deno.test("dry run and no target publish nothing; STOP lets every source go", async () => {
    const { live, puts } = fakeLive()
    const drive = new Drive(live)
    drive.dryRun = true
    drive.setTarget({ kind: "topic", key: KEY, stream: "tele_cmd_vel" })
    drive.setAxes("stick", { turn: 1 })
    await sleep(200)
    assertEquals(puts.length, 0)
    assertEquals(drive.status.twist.yaw, 0.8)
    drive.stop()
    assertEquals(drive.status.moving, false)
    drive.dryRun = false
    drive.setTarget({ kind: "none", why: "no blueprint" })
    drive.setAxes("stick", { turn: 1 })
    await sleep(200)
    assertEquals(puts.length, 0)
    drive.dispose()
})

Deno.test("teleopStream: m20-nav's tele_cmd_vel, not the cmd_vel MovementManager feeds", () => {
    const streams = [
        {
            name: "cmd_vel",
            type: "Twist",
            direction: "out",
            channel: "dimos/cmd_vel/geometry_msgs.Twist",
            module: "m20connection",
        },
        {
            name: "cmd_vel",
            type: "Twist",
            direction: "out",
            channel: "dimos/cmd_vel/geometry_msgs.Twist",
            module: "movementmanager",
        },
        {
            name: "nav_cmd_vel",
            type: "Twist",
            direction: "in",
            channel: "dimos/nav_cmd_vel/geometry_msgs.Twist",
            module: "movementmanager",
        },
        {
            name: "nav_cmd_vel",
            type: "Twist",
            direction: "out",
            channel: "dimos/nav_cmd_vel/geometry_msgs.Twist",
            module: "trajectoryfollowernative",
        },
        {
            name: "tele_cmd_vel",
            type: "Twist",
            direction: "in",
            channel: "dimos/tele_cmd_vel/geometry_msgs.Twist",
            module: "movementmanager",
        },
    ]
    assertEquals(teleopStream(streams, "m20connection")?.channel, "dimos/tele_cmd_vel/geometry_msgs.Twist")
})

Deno.test({
    name: "the dimos gateway's msgs.js encodes the drive Twist (M20_MSGS_JS)",
    ignore: !msgsPath,
    fn: async () => {
        const msgs = await import(msgsPath!)
        const bytes = msgs.geometry_msgs.Twist.encode({
            linear: { x: 0.5, y: 0, z: 0 },
            angular: { x: 0, y: 0, z: 0.8 },
        })
        const back = msgs.geometry_msgs.Twist.decode(bytes)
        assertEquals([back.linear.x, back.angular.z], [0.5, 0.8])
    },
})
