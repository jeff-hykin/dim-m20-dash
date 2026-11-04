// syslogs.ts: the script is valid sh and only reads; its output becomes health / journal / basic_server / dump messages,
// rate-limited per source.
import { assert, assertEquals } from "@std/assert"
import { BoardLogs, conditions, logsScript, parseWifi } from "./syslogs.ts"

Deno.test("the logs script is valid sh and reads only", async () => {
    const script = logsScript()
    const check = await new Deno.Command("sh", { args: ["-n", "-c", script] }).output()
    assertEquals(check.code, 0, new TextDecoder().decode(check.stderr))
    for (const writes of [/\brm\b/, /\bkill [^0]/, /systemctl (start|stop|restart)/, />\s*\/(sys|proc|var|etc)/]) {
        assert(!writes.test(script), `${writes}`)
    }
})

Deno.test("iw link, health samples, a weak signal's dump, journal and basic_server lines, the rate limit", () => {
    const wifi = parseWifi(
        "W wlan0|Connected to 9e:30 (on wlan0)| SSID: dimensional-edge| freq: 5500| signal: -70 dBm| tx bitrate: 434.0 MBit/s|",
    )
    assertEquals(wifi, {
        iface: "wlan0",
        connected: true,
        ssid: "dimensional-edge",
        signalDbm: -70,
        bitrateMbps: 434,
        freqMhz: 5500,
    })
    assertEquals(parseWifi("W wlan0|Not connected.|").connected, false)
    assertEquals(Object.keys(conditions({ t: 0, board: "aos", wifi: { ...wifi, signalDbm: -85 } })), ["wifi"])

    const out: Record<string, unknown>[] = []
    const logs = new BoardLogs("aos", (m) => out.push(m), () => ({ stats: { cpu: { total: 12 } }, reachable: true }))
    for (const signal of [-70, -86]) {
        logs.line(`H ${Date.now()}`)
        logs.line(`W wlan0|Connected to x| SSID: e| signal: ${signal} dBm|`)
        logs.line("R default via 10.21.31.1 dev wlan0|")
        logs.line("P battery 80 Discharging")
        logs.line("E")
    }
    const health = out.filter((m) => m.type === "health")
    assertEquals(health.length, 2)
    assertEquals((health[0] as { routes: string[] }).routes, ["default via 10.21.31.1 dev wlan0"])
    const dump = out.find((m) => m.type === "health_dump") as { reason: string; samples: unknown[] }
    assert(dump && /signal -86 dBm/.test(dump.reason) && dump.samples.length === 2)

    logs.line("B [2026-11-04 14:47:38] [DDSWorker] motion state: 17 -> 17, gait: 0x3003 -> 0x3001")
    for (let i = 0; i < 40; i++) {
        logs.line(`J 2026-11-04T14:00:00 kernel: warning ${i}`)
    }
    assertEquals(out.filter((m) => m.type === "basic_server").length, 1)
    assertEquals(out.filter((m) => m.type === "journal").length, 30, "at most 30 a window")
    // routine lines (phc2sys stepping the clock) are counted on the next health sample, not kept
    logs.line("J -- Logs begin at Wed 2026-11-04 14:43:27 CST. --")
    logs.line("J 2026-11-04T14:54:19+0800 host kernel: change wall clock (adjtimex) by pid: 1930 comm: phc2sys.")
    logs.line(`H ${Date.now()}`)
    logs.line("E")
    assertEquals(
        (out.filter((m) => m.type === "health").pop() as { routineJournalLines?: number }).routineJournalLines,
        1,
    )
})
