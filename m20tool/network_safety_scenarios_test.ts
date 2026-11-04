// network-safety, the compiled tool against the script, on scripted trouble: fake nmcli / iw / tailscale / ap_start
// play each scenario, and both must make the same decisions (the same state transitions; in --dry-run the same
// "WOULD run" changes). Prints a comparison table. Needs the compiled tool for this computer in m20tool/dist
// (`deno task m20tool-build`); without it, only the script runs (and the test says so).
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const SCRIPT = `${here}board_files/aos/network_safety_main.js`
const COMPILED = `${here}dist/m20-network-safety-${Deno.build.arch}-${
    Deno.build.os === "darwin" ? "apple-darwin" : "unknown-linux-gnu"
}`
const hasCompiled = (() => {
    try {
        return Deno.statSync(COMPILED).isFile
    } catch {
        return false
    }
})()

// state in $NS_STATE: conn (current connection, empty = none), shows (device show calls)
const NMCLI = `#!/bin/bash
D=$NS_STATE; conn=$(cat $D/conn 2>/dev/null); args="$*"
shows=$(( $(cat $D/shows 2>/dev/null || echo 0) + 1 ))
if [ -n "$NS_WLAN_MISSING" ] && [[ "$args" == *wlan0* ]]; then echo "Error: Device 'wlan0' not found."; exit 10; fi
case "$args" in
  *"device show"*)
    echo $shows > $D/shows
    # Wi-Fi lost: after NS_DROP_AFTER shows the link goes and stays gone (joins fail from then on)
    if [ -n "$NS_DROP_AFTER" ] && [ "$shows" -ge "$NS_DROP_AFTER" ] && [ "$conn" != myap50G ]; then : > $D/conn; touch $D/dropped; conn=""; fi
    # a flapping link: every Nth look it's down
    if [ -n "$conn" ] && [ -n "$FLAKY_EVERY" ] && [ "$conn" != myap50G ] && [ $((shows % FLAKY_EVERY)) -eq 0 ]; then echo "30 (disconnected)"; echo ""; : > $D/conn; exit 0; fi
    if [ -n "$conn" ]; then echo "100 (connected)"; echo "$conn"; else echo "30 (disconnected)"; echo ""; fi ;;
  *"wifi list"*) printf '%b\\n' "\${NS_VISIBLE:-70:5180 MHz::OpenNet\\n50:2412 MHz:WPA2:Locked}" ;;
  *"-g 802-11-wireless.ssid"*) name="\${args#*connection show }"; v="NS_SSID_\${name//[^A-Za-z0-9]/_}"; echo "\${!v}" ;;
  *"connection show"*) echo "myap50G:802-11-wireless"; [ -n "$NS_PROFILES" ] && printf '%b\\n' "$NS_PROFILES" ;;
  *"wifi connect"*|*"connection up"*)
    [ -e $D/dropped ] && exit 4
    if [[ "$args" == *"wifi connect"* ]]; then n="$4"; else n="$3"; fi
    echo "$n" > $D/conn ;;
  *"connection down"*|*"device disconnect"*) : > $D/conn ;;
esac
`
const AP_START = `#!/bin/bash
# a half-up hotspot: the start "succeeds" but the connection never comes up
[ -n "$NS_AP_HALF" ] && exit 0
echo myap50G > $NS_STATE/conn
`
const TAILSCALE = `#!/bin/sh
if [ "$TS_ONLINE" = 1 ]; then echo '{"BackendState":"Running","Self":{"Online":true}}'; else echo '{"BackendState":"Running","Self":{"Online":false}}'; fi
`

type Scenario = { name: string; savedMode: string; connectedTo?: string; env: Record<string, string>; seconds: number }

const SCENARIOS: Scenario[] = [
    {
        name: "Wi-Fi lost (link gone, rejoins fail)",
        savedMode: "wifiInternet",
        connectedTo: "OpenNet",
        env: { TS_ONLINE: "1", NS_DROP_AFTER: "4" },
        seconds: 20,
    },
    { name: "flapping link", savedMode: "wifiInternet", env: { TS_ONLINE: "1", FLAKY_EVERY: "4" }, seconds: 12 },
    {
        name: "wrong SSID (saved network not in range, no open ones)",
        savedMode: "wifiInternet",
        env: {
            TS_ONLINE: "1",
            NS_PROFILES: "office-wifi:802-11-wireless",
            NS_SSID_office_wifi: "dimensional-edge",
            NS_VISIBLE: "60:5180 MHz:WPA2:SomeoneElse",
        },
        seconds: 20,
    },
    { name: "wlan0 missing", savedMode: "wifiInternet", env: { TS_ONLINE: "0", NS_WLAN_MISSING: "1" }, seconds: 12 },
    {
        name: "half-up hotspot (start ok, never up)",
        savedMode: "ap",
        env: { TS_ONLINE: "1", NS_AP_HALF: "1" },
        seconds: 20,
    },
    {
        name: "saved network back, internet",
        savedMode: "wifiInternet",
        env: {
            TS_ONLINE: "1",
            NS_PROFILES: "office-wifi:802-11-wireless",
            NS_SSID_office_wifi: "dimensional-edge",
            NS_VISIBLE: "60:5180 MHz:WPA2:dimensional-edge",
        },
        seconds: 20,
    },
]

async function play(command: string[], scenario: Scenario) {
    const dir = Deno.makeTempDirSync({ prefix: "m20ns-scn-" })
    try {
        Deno.mkdirSync(`${dir}/bin`)
        Deno.mkdirSync(`${dir}/state`)
        Deno.writeTextFileSync(`${dir}/bin/nmcli`, NMCLI, { mode: 0o755 })
        Deno.writeTextFileSync(`${dir}/bin/ap_start`, AP_START, { mode: 0o755 })
        Deno.writeTextFileSync(`${dir}/bin/tailscale`, TAILSCALE, { mode: 0o755 })
        Deno.writeTextFileSync(`${dir}/bin/iw`, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
        if (scenario.connectedTo) {
            Deno.writeTextFileSync(`${dir}/state/conn`, `${scenario.connectedTo}\n`)
        }
        Deno.writeTextFileSync(
            `${dir}/config.json`,
            JSON.stringify({
                savedMode: scenario.savedMode,
                apStartCommand: [`${dir}/bin/ap_start`],
                apCheckMinutes: 0.05,
                discoveryMinutes: 0.1,
                softToHardMinutes: 0.08,
                noInternetIdleMinutes: 0.05,
                joinHoldSeconds: 0.5,
                onlineWaitSeconds: 0.5,
                onlineCheckSeconds: 1,
                pollSeconds: 0.1,
                countedInterfaces: ["m20test0"],
            }),
        )
        const child = new Deno.Command(command[0], {
            args: command.slice(1),
            env: {
                PATH: `${dir}/bin:${Deno.env.get("PATH")}`,
                NS_STATE: `${dir}/state`,
                NETWORK_SAFETY_DIR: dir,
                NETWORK_SAFETY_TEST: "1",
                ...scenario.env,
            },
            stdout: "piped",
            stderr: "piped",
        }).spawn()
        setTimeout(() => child.kill("SIGKILL"), scenario.seconds * 1000)
        const out = await child.output()
        const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
        const lines = text.split("\n")
        const dedupe = (list: string[]) => list.filter((l, i) => l !== list[i - 1])
        return {
            states: dedupe(lines.filter((l) => l.includes("state: ")).map((l) => l.slice(l.indexOf("state: ") + 7))),
            would: dedupe(
                lines.filter((l) => l.includes("WOULD run: ")).map((l) =>
                    l.slice(l.indexOf("WOULD run: ") + 11).replace(dir, "<dir>")
                ),
            ),
            crashed: /error: Uncaught|unexpected error/.test(text),
        }
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
}

/** the shared prefix of two decision lists (runs are timed, so one may get a step further in the same seconds) */
function samePrefix(a: string[], b: string[]) {
    const n = Math.min(a.length, b.length)
    return { n, same: JSON.stringify(a.slice(0, n)) === JSON.stringify(b.slice(0, n)) }
}

Deno.test({
    name: `network-safety scenarios: ${
        hasCompiled ? "the compiled tool decides like the script" : "the script (no compiled tool built here)"
    }, real and --dry-run`,
    fn: async () => {
        const script = (extra: string[]) => [Deno.execPath(), "run", "-A", SCRIPT, "run", ...extra]
        const compiled = (extra: string[]) => [COMPILED, "run", ...extra]
        // one scenario at a time (its four runs together): a busy machine slows the compiled start-up
        const rows = []
        for (const scenario of SCENARIOS) {
            rows.push(
                await (async () => {
                    const [sReal, sDry, cReal, cDry] = await Promise.all([
                        play(script([]), scenario),
                        play(script(["--dry-run"]), scenario),
                        hasCompiled ? play(compiled([]), scenario) : null,
                        hasCompiled ? play(compiled(["--dry-run"]), scenario) : null,
                    ])
                    return { scenario, sReal, sDry, cReal, cDry }
                })(),
            )
        }
        const table = [
            "| scenario | script (real) states | compiled (real) | script --dry-run WOULD | compiled --dry-run |",
            "|---|---|---|---|---|",
        ]
        for (const { scenario, sReal, sDry, cReal, cDry } of rows) {
            assert(!sReal.crashed && !sDry.crashed, `${scenario.name}: the script crashed`)
            assert(sReal.states.length >= 2, `${scenario.name}: ${sReal.states.join(" | ")}`)
            const real = cReal ? samePrefix(sReal.states, cReal.states) : null
            const dry = cDry ? samePrefix(sDry.states, cDry.states) : null
            const would = cDry ? samePrefix(sDry.would, cDry.would) : null
            table.push(
                `| ${scenario.name} | ${sReal.states.join(" → ")} | ${
                    real ? (real.same ? `same (${real.n})` : "DIFFERENT") : "-"
                } | ${[...new Set(sDry.would.map((w) => w.split(" ").slice(0, 3).join(" ")))].join(", ") || "none"} | ${
                    dry && would
                        ? (dry.same && would.same ? `same (${dry.n} states, ${would.n} changes)` : "DIFFERENT")
                        : "-"
                } |`,
            )
            if (cReal && cDry) {
                assert(!cReal.crashed && !cDry.crashed, `${scenario.name}: the compiled tool crashed`)
                assert(
                    real!.same && real!.n >= 2,
                    `${scenario.name} real:\n${sReal.states.join("\n")}\n--\n${cReal.states.join("\n")}`,
                )
                assert(
                    dry!.same,
                    `${scenario.name} dry-run states:\n${sDry.states.join("\n")}\n--\n${cDry.states.join("\n")}`,
                )
                assert(would!.same, `${scenario.name} WOULD:\n${sDry.would.join("\n")}\n--\n${cDry.would.join("\n")}`)
            }
        }
        console.log(table.join("\n"))
        assertEquals(rows.length, SCENARIOS.length)
    },
})
