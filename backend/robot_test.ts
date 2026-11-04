// robot.ts: the only frame it can send is the heartbeat; reports (shaped like a real M20's) fold into the state; and
// against a stand-in basic_server on loopback, everything it sends is a heartbeat.
import { assert, assertEquals } from "@std/assert"
import { applyReport, commandFrame, heartbeatFrame, parseReport, Robot, type RobotState } from "./robot.ts"

const frame = (type: number, command: number, items: unknown) => {
    const payload = new TextEncoder().encode(
        JSON.stringify({ PatrolDevice: { Type: type, Command: command, Items: items } }),
    )
    const bytes = new Uint8Array(16 + payload.length)
    bytes.set([0xeb, 0x91, 0xeb, 0x90])
    new DataView(bytes.buffer).setUint16(4, payload.length, true)
    bytes[8] = 1
    bytes.set(payload, 16)
    return bytes
}

Deno.test("heartbeatFrame is basic_server's heartbeat and nothing else", () => {
    const report = parseReport(heartbeatFrame(7))!
    assertEquals([report.type, report.command, report.items], [100, 100, {}])
})

Deno.test("reports: basic status, both batteries (an empty bay), motor temperatures, errors with their joints", () => {
    const state = new Robot().state as RobotState
    applyReport(
        state,
        parseReport(
            frame(1002, 6, {
                BasicStatus: {
                    MotionState: 4,
                    Gait: 12292,
                    Charge: 2,
                    HES: 0,
                    ControlUsageMode: 1,
                    PowerManagement: 1,
                    Sleep: 0,
                    Version: "PRO",
                },
            }),
        )!,
    )
    applyReport(
        state,
        parseReport(frame(1002, 5, {
            BatteryStatus: {
                VoltageLeft: 0,
                VoltageRight: 83,
                BatteryLevelLeft: 0,
                BatteryLevelRight: 100,
                battery_temperatureLeft: 0,
                battery_temperatureRight: 31.7,
                chargeLeft: true,
                chargeRight: false,
            },
            DeviceTemperature: {
                LeftFrontHipXMotor: 37.2,
                LeftFrontHipXDriver: 51.3,
                RightBackKneeMotor: 44.0,
                RightBackKneeDriver: 47,
            },
        }))!,
    )
    applyReport(
        state,
        parseReport(
            frame(1002, 3, { ErrorList: [{ errorCode: 0, component: 0 }, { errorCode: 0x8001, component: 0x21 }] }),
        )!,
    )
    assertEquals(state.link, "up")
    assertEquals([state.basic!.motionName, state.basic!.gaitName, state.basic!.chargeName], [
        "sitting",
        "off-road (agile)",
        "charging",
    ])
    assertEquals(state.battery!.left.present, false)
    assertEquals([state.battery!.right.level, state.battery!.right.celsius], [100, 31.7])
    assertEquals(state.hottestMotor, { joint: "RightBackKnee", celsius: 44 })
    assertEquals(state.hottestDriver, { joint: "LeftFrontHipX", celsius: 51.3 })
    assertEquals(state.errors.map((e) => [e.hex, e.parts]), [["0x8001", ["LeftFrontHipX", "RightFrontHipY"]]])
})

Deno.test("against a stand-in basic_server: it only ever sends heartbeats, and reads the reports back", async () => {
    const server = Deno.listenDatagram({ transport: "udp", hostname: "127.0.0.1", port: 0 })
    const port = (server.addr as Deno.NetAddr).port
    const received: { type: number; command: number }[] = []
    const serving = (async () => {
        for await (const [bytes, from] of server) {
            const report = parseReport(bytes)
            received.push({ type: report?.type ?? -1, command: report?.command ?? -1 })
            await server.send(
                frame(1002, 6, { BasicStatus: { MotionState: 1, Gait: 0x1001, Charge: 0, HES: 1 } }),
                from,
            )
        }
    })()
    const robot = new Robot()
    robot.start("127.0.0.1", port, false)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    robot.stop()
    server.close()
    await serving.catch(() => {})
    assert(received.length >= 2)
    assert(received.every((r) => r.type === 100 && r.command === 100), JSON.stringify(received))
    assertEquals(robot.state.basic?.hardEstop, true)
})

Deno.test('axis commands carry every float as a decimal (basic_server ignores "X":0)', () => {
    const frame = commandFrame(2, 21, { X: 0, Y: -1, Z: 0, Roll: 0, Pitch: 0, Yaw: -0.396 }, 1)
    const text = new TextDecoder().decode(frame.subarray(16))
    assert(text.includes('"X":0.0,"Y":-1.0,"Z":0.0,"Roll":0.0,"Pitch":0.0,"Yaw":-0.396}'), text)
    assertEquals(
        new DataView(frame.buffer).getUint16(4, true),
        frame.length - 16,
        "the header's length is the payload's",
    )
    // integer fields stay integers
    assert(
        new TextDecoder().decode(commandFrame(2, 23, { GaitParam: 4097 }, 2).subarray(16)).includes(
            '"GaitParam":4097}',
        ),
    )
})
