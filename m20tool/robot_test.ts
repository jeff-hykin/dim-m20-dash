// m20tool's robot commands against a stand-in basic_server on loopback (UDP reports + TCP usage-mode switch) that
// behaves like the real one: Stand resets the usage mode and gait, RL Control only from a stand, leaving the dock
// resets the usage mode. Checks what each command sends, and that status / battery send only heartbeats.
import { assert, assertEquals } from "@std/assert"
import { commandFrame, parseReport } from "../backend/basic_server.ts"
import { battery, dock, lieDown, Link, stand, status, stop, undock } from "./robot.ts"

type Fake = {
    motion: number
    usage: number
    gait: number
    charge: number
    received: { type: number; command: number; items: Record<string, unknown> }[]
    udpPort: number
    tcpPort: number
    close: () => void
}

function fakeBasicServer(start: Partial<Fake> = {}, ports = [0, 0]): Fake {
    const udp = Deno.listenDatagram({ transport: "udp", hostname: "127.0.0.1", port: ports[0] })
    const tcp = Deno.listen({ hostname: "127.0.0.1", port: ports[1] })
    const fake: Fake = {
        motion: 4,
        usage: 1,
        gait: 0x3003,
        charge: 0,
        received: [],
        udpPort: (udp.addr as Deno.NetAddr).port,
        tcpPort: (tcp.addr as Deno.NetAddr).port,
        close: () => {},
        ...start,
    }
    const clients = new Map<string, Deno.NetAddr>()
    const timers: number[] = []
    const later = (ms: number, change: () => void) => timers.push(setTimeout(change, ms))
    let id = 0
    const reports = () => {
        const items: Record<number, Record<string, unknown>> = {
            6: {
                BasicStatus: {
                    MotionState: fake.motion,
                    Gait: fake.gait,
                    Charge: fake.charge,
                    HES: 0,
                    ControlUsageMode: fake.usage,
                    Sleep: 0,
                    Version: "PRO",
                },
            },
            4: { MotionStatus: { Height: 0.4, LinearX: 0, LinearY: 0, OmegaZ: 0 } },
            5: { BatteryStatus: { VoltageLeft: 82.5, VoltageRight: 0, BatteryLevelLeft: 77, BatteryLevelRight: 0 } },
            3: { ErrorList: [{ errorCode: 0, component: 0 }] },
        }
        for (const address of clients.values()) {
            for (const [command, body] of Object.entries(items)) {
                udp.send(commandFrame(1002, Number(command), body, id++), address).catch(() => {})
            }
        }
    }
    timers.push(setInterval(reports, 50))
    ;(async () => {
        try {
            for await (const [bytes, address] of udp) {
                const frame = parseReport(bytes)
                if (!frame) {
                    continue
                }
                const a = address as Deno.NetAddr
                clients.set(`${a.hostname}:${a.port}`, a)
                fake.received.push(frame)
                const { type, command, items } = frame
                if (type === 2 && command === 22) {
                    const want = items.MotionParam as number
                    if (want === 1) {
                        later(100, () => {
                            fake.motion = 1
                            fake.usage = 0
                            fake.gait = 0x1001
                        })
                    } else if (want !== 17 || fake.motion === 1 || fake.motion === 17) {
                        later(100, () => (fake.motion = want))
                    }
                } else if (type === 2 && command === 23) {
                    fake.gait = items.GaitParam as number
                } else if (type === 2 && command === 24) {
                    if (items.Charge === 1) {
                        fake.charge = 1
                        later(300, () => (fake.charge = 2))
                    } else if (fake.charge !== 0) {
                        fake.charge = 3
                        later(300, () => {
                            fake.charge = 0
                            fake.usage = 0
                        })
                    }
                }
            }
        } catch {
            // closed
        }
    })()
    ;(async () => {
        try {
            for await (const connection of tcp) {
                const buffer = new Uint8Array(4096)
                const n = (await connection.read(buffer)) ?? 0
                const frame = parseReport(buffer.subarray(0, n))!
                fake.received.push(frame)
                fake.usage = frame.items.Mode as number
                fake.gait = 0x1001
                const reply = commandFrame(1101, 5, { ErrorCode: 0 }, new DataView(buffer.buffer).getUint16(6, true))
                await connection.write(reply)
                connection.close()
            }
        } catch {
            // closed
        }
    })()
    fake.close = () => {
        timers.forEach((t) => clearTimeout(t))
        udp.close()
        tcp.close()
    }
    return fake
}

const sent = (fake: Fake) =>
    fake.received.filter((f) => f.type !== 100).map((f) => `${f.type}/${f.command} ${JSON.stringify(f.items)}`)

async function withFake(start: Partial<Fake>, body: (link: Link, fake: Fake, lines: string[]) => Promise<void>) {
    const fake = fakeBasicServer(start)
    const lines: string[] = []
    const link = new Link("127.0.0.1", false, (line) => lines.push(line), fake.udpPort, fake.tcpPort)
    try {
        await body(link, fake, lines)
    } finally {
        link.close()
        fake.close()
    }
}

Deno.test("stand from sitting: Stand, RL control, THEN navigation mode, Basic, agile stairs", async () => {
    await withFake({ motion: 4, usage: 1 }, async (link, fake, lines) => {
        await stand(link)
        assertEquals(sent(fake), [
            '2/22 {"MotionParam":1}',
            '2/22 {"MotionParam":17}',
            '1101/5 {"Mode":1}',
            '2/23 {"GaitParam":4097}',
            '2/23 {"GaitParam":12291}',
        ])
        assertEquals([fake.motion, fake.usage, fake.gait], [17, 1, 0x3003])
        assert(lines.at(-1)!.startsWith("standing in RL control, navigation mode"))
    })
})

Deno.test("status and battery send nothing but heartbeats", async () => {
    await withFake({ charge: 2 }, async (link, fake, lines) => {
        await status(link)
        await battery(link)
        assertEquals(sent(fake), [])
        assert(fake.received.length > 0 && fake.received.every((f) => f.type === 100 && f.command === 100))
        assert(lines.some((line) => line.startsWith("motion: sitting")), lines.join("\n"))
        assert(lines.some((line) => line === "battery: left: 77% 82.5 V, right: empty bay"), lines.join("\n"))
    })
})

Deno.test("lie_down: zero velocity (floats), then Sit; stop refuses on the dock", async () => {
    await withFake({ motion: 17 }, async (link, fake) => {
        await lieDown(link)
        assertEquals(sent(fake), [
            '2/21 {"X":0,"Y":0,"Z":0,"Roll":0,"Pitch":0,"Yaw":0}',
            '2/22 {"MotionParam":4}',
        ])
        assertEquals(fake.motion, 4)
    })
    await withFake({ charge: 2 }, async (link, fake) => {
        let error = ""
        await stop(link).catch((e) => (error = e.message))
        assert(error.includes("undock first"), error)
        assertEquals(sent(fake), [])
    })
})

Deno.test("the axis command's floats go out as 0.0, ints stay ints", () => {
    const text = new TextDecoder().decode(
        commandFrame(2, 21, { X: 0, Y: 1, Z: 0, Roll: 0, Pitch: 0, Yaw: -2, GaitParam: 4097 }, 1).subarray(16),
    )
    assert(text.includes('"X":0.0,"Y":1.0,"Z":0.0,"Roll":0.0,"Pitch":0.0,"Yaw":-2.0,"GaitParam":4097'), text)
})

Deno.test("undock: Charge 0, wait for idle, then stand (mode set after the dock reset it)", async () => {
    await withFake({ charge: 2, motion: 4 }, async (link, fake) => {
        await undock(link)
        assertEquals(sent(fake), [
            '2/24 {"Charge":0}',
            '2/22 {"MotionParam":1}',
            '2/22 {"MotionParam":17}',
            '1101/5 {"Mode":1}',
            '2/23 {"GaitParam":4097}',
            '2/23 {"GaitParam":12291}',
        ])
        assertEquals([fake.charge, fake.motion, fake.usage], [0, 17, 1])
    })
})

Deno.test("dock: refuses unless standing; foreground watches to charging; background hands off once it entered", async () => {
    await withFake({ motion: 4 }, async (link, fake) => {
        let error = ""
        await dock(link, "foreground").catch((e) => (error = e.message))
        assert(error.includes("m20tool stand first"), error)
        assertEquals(sent(fake), [])
    })
    await withFake({ motion: 17 }, async (link, fake, lines) => {
        await dock(link, "foreground")
        assertEquals(sent(fake), ['2/24 {"Charge":1}'])
        assertEquals(lines.at(-1), "docked and charging")
    })
    await withFake({ motion: 17 }, async (link, fake, lines) => {
        let handedOff = false
        await dock(link, "background", () => {
            handedOff = true
            return Promise.resolve("watching in the background")
        })
        assert(handedOff)
        assertEquals(sent(fake), ['2/24 {"Charge":1}'])
        assertEquals(lines.at(-1), "watching in the background")
    })
})

Deno.test("a dry run opens no socket and prints every frame", async () => {
    const lines: string[] = []
    const link = new Link("10.21.31.103", true, (line) => lines.push(line))
    await stand(link)
    link.close()
    assertEquals(lines.filter((l) => /^(UDP|TCP) /.test(l)).length, 6)
})

Deno.test("the CLI: dock returns once the robot took it, and a detached copy watches it to the end in ~/m20_dock.log", async () => {
    let fake: Fake
    try {
        fake = fakeBasicServer({ motion: 17 }, [30000, 30001])
    } catch {
        console.log("ports 30000/30001 are busy here: skipped")
        return
    }
    const home = Deno.makeTempDirSync()
    try {
        const main = new URL("./main.ts", import.meta.url).pathname
        const output = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--unstable-net", main, "dock", "--host", "127.0.0.1"],
            env: { HOME: home },
        }).output()
        const text = new TextDecoder().decode(output.stdout)
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr))
        assert(text.includes("watching it in the background"), text)
        let log = ""
        for (let i = 0; i < 100 && !log.includes("docked and charging"); i++) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            try {
                log = Deno.readTextFileSync(`${home}/m20_dock.log`)
            } catch {
                // not yet
            }
        }
        assert(log.includes("docked and charging"), log)
        assertEquals(sent(fake).filter((line) => line.startsWith("2/24")), ['2/24 {"Charge":1}'])
    } finally {
        fake.close()
        Deno.removeSync(home, { recursive: true })
    }
})
