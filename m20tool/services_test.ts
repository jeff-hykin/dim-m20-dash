// The board services, old (shell, test_fixtures/old/) against new (standalone Deno, board_files/): run side by side
// with fake system tools (ip, iptables, sysctl, dhclient, resolvectl, systemctl, phc_ctl, curl, ssh) that log every
// call, and the same fake /sys and /run. Equivalent = the same system commands in the same order, the same output and
// the same files. network-safety: the old script, the new one and (when built) the compiled tool reach the same states
// on the same fake nmcli / tailscale / iw.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const OLD = `${here}test_fixtures/old`
const NEW = `${here}board_files`

const FAKE = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$FAKE_LOG"
case "$name" in
    iptables) case " $* " in *" -C "*) exit "\${FAKE_IPTABLES_C:-1}" ;; esac ;;
    ip) [ "$*" = "-o -4 addr show" ] && printf '%s\\n' "$FAKE_IP_ADDR" ;;
    phc_ctl) echo "phc_ctl[123.456]: clock time is $FAKE_PHC.123456789 or Thu Jun 20 10:00:00 2024" ;;
    curl) [ -n "$FAKE_DATE" ] && printf 'HTTP/1.1 301 Moved Permanently\\r\\nDate: %s\\r\\n\\r\\n' "$FAKE_DATE" ;;
    ssh) [ -n "$FAKE_PEER_OFFSET" ] && echo "$FAKE_PEER_OFFSET" || exit 255 ;;
esac
exit 0
`

type Run = { log: string[]; stdout: string; code: number }

async function setupFakes(): Promise<{ dir: string; bin: string; root: string; log: string }> {
    const dir = Deno.makeTempDirSync({ prefix: "m20svc-" })
    const bin = `${dir}/bin`
    Deno.mkdirSync(bin)
    for (const tool of ["ip", "iptables", "sysctl", "dhclient", "resolvectl", "systemctl", "phc_ctl", "curl", "ssh"]) {
        Deno.writeTextFileSync(`${bin}/${tool}`, FAKE, { mode: 0o755 })
    }
    return await Promise.resolve({ dir, bin, root: `${dir}/root`, log: `${dir}/log` })
}

async function runOne(argv: string[], env: Record<string, string>, log: string): Promise<Run> {
    try {
        Deno.removeSync(log)
    } catch {
        // first run
    }
    const out = await new Deno.Command(argv[0], { args: argv.slice(1), env, stdout: "piped", stderr: "null" }).output()
    let lines: string[] = []
    try {
        lines = Deno.readTextFileSync(log).trim().split("\n").filter(Boolean)
    } catch {
        // nothing ran
    }
    return { log: lines, stdout: new TextDecoder().decode(out.stdout).trim(), code: out.code }
}

/** the old shell script with its absolute paths moved under `root` (as the new scripts' M20_TEST_ROOT does) */
function oldScript(name: string, dir: string, root: string, extra: [string, string][] = []): string {
    let text = Deno.readTextFileSync(`${OLD}/${name}`)
    for (
        const [from, to] of [["/sys/", `${root}/sys/`], ["/run/phc", `${root}/run/phc`], [
            "/etc/default/",
            `${root}/etc/default/`,
        ], ...extra]
    ) {
        text = text.replaceAll(from, to)
    }
    // the PEER's file is on the peer: not moved
    text = text.replaceAll(`cat ${root}/run/phc2sys-offset.verified`, "cat /run/phc2sys-offset.verified")
    const path = `${dir}/old-${name}`
    Deno.writeTextFileSync(path, text, { mode: 0o755 })
    return path
}

async function compare(
    name: string,
    newPath: string,
    env: Record<string, string>,
    prepare: (root: string) => void,
    options: { ignoreOld?: RegExp; oldExtra?: [string, string][]; newEnv?: Record<string, string> } = {},
) {
    const fakes = await setupFakes()
    const results: { run: Run; files: Record<string, string> }[] = []
    for (const which of ["old", "new"] as const) {
        try {
            Deno.removeSync(fakes.root, { recursive: true })
        } catch {
            // first
        }
        Deno.mkdirSync(fakes.root, { recursive: true })
        prepare(fakes.root)
        const fullEnv = {
            ...env,
            PATH: `${fakes.bin}:${gnuDir ? `${gnuDir}:` : ""}${Deno.env.get("PATH")}`,
            FAKE_LOG: fakes.log,
            M20_TEST_ROOT: fakes.root,
            ...(which === "new" ? options.newEnv ?? {} : {}),
        }
        const argv = which === "old"
            ? ["sh", oldScript(name, fakes.dir, fakes.root, options.oldExtra)]
            : [Deno.execPath(), "run", "-A", "--no-config", newPath]
        const run = await runOne(argv, fullEnv, fakes.log)
        if (which === "old" && options.ignoreOld) {
            run.log = run.log.filter((line) => !options.ignoreOld!.test(line))
        }
        results.push({ run, files: snapshot(fakes.root) })
    }
    Deno.removeSync(fakes.dir, { recursive: true })
    const [old, now] = results
    assertEquals(now.run.log, old.run.log, `${name}: system commands`)
    assertEquals(now.run.stdout, old.run.stdout, `${name}: output`)
    assertEquals(now.run.code, old.run.code, `${name}: exit code`)
    delete now.files["run/phc2sys-offset.env"]
    assertEquals(now.files, old.files, `${name}: files`)
    return now
}

function snapshot(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
    for (const entry of Deno.readDirSync(dir)) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory) {
            snapshot(root, path, out)
        } else if (entry.isFile) {
            out[path.slice(root.length + 1)] = Deno.readTextFileSync(path)
        }
    }
    return out
}

Deno.test("office-nat: the same iptables calls, fresh (every rule added) and rerun (every -C passes: nothing added)", async () => {
    const fresh = await compare("office-nat", `${NEW}/aos/office-nat`, { FAKE_IPTABLES_C: "1" }, () => {})
    assertEquals(fresh.run.log.filter((l) => / -[AI] /.test(l)).length, 17)
    const rerun = await compare("office-nat", `${NEW}/aos/office-nat`, { FAKE_IPTABLES_C: "0" }, () => {})
    assertEquals(rerun.run.log.filter((l) => / -[AI] /.test(l)), [])
})

Deno.test("aos-uplink-up: the same route and DNS calls, the same output", async () => {
    await compare("aos-uplink-up", `${NEW}/gos/aos-uplink-up`, {
        FAKE_IP_ADDR:
            "1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 10.21.31.104/24 brd 10.21.31.255 scope global eth0",
    }, () => {})
})

Deno.test("usb-ethernet-up: the same sysfs writes, ip/dhclient/iptables calls and output", async () => {
    const run = await compare("usb-ethernet-up", `${NEW}/gos/usb-ethernet-up`, {}, (root) => {
        const usb = `${root}/sys/devices/platform/usb7/7-1/7-1.1`
        Deno.mkdirSync(`${usb}/7-1.1:2.0`, { recursive: true })
        Deno.mkdirSync(`${root}/sys/bus/usb/devices`, { recursive: true })
        Deno.symlinkSync(usb, `${root}/sys/bus/usb/devices/7-1.1`)
        Deno.writeTextFileSync(`${usb}/idVendor`, "0bda\n")
        Deno.writeTextFileSync(`${usb}/idProduct`, "8153\n")
        Deno.writeTextFileSync(`${usb}/bConfigurationValue`, "1\n")
        Deno.mkdirSync(`${root}/sys/bus/usb/drivers/cdc_ether`, { recursive: true })
        Deno.writeTextFileSync(`${root}/sys/bus/usb/drivers/cdc_ether/new_id`, "")
        Deno.mkdirSync(`${root}/sys/bus/platform/drivers/rk_gmac`, { recursive: true })
        Deno.mkdirSync(`${root}/sys/devices/platform/gmac/net`, { recursive: true })
        Deno.mkdirSync(`${root}/sys/class/net/eth0`, { recursive: true })
        Deno.symlinkSync(`${root}/sys/devices/platform/gmac`, `${root}/sys/class/net/eth0/device`)
        Deno.symlinkSync(`${root}/sys/bus/platform/drivers/rk_gmac`, `${root}/sys/devices/platform/gmac/driver`)
        Deno.mkdirSync(`${root}/sys/class/net/wwan0`, { recursive: true })
        Deno.symlinkSync(`${usb}/7-1.1:2.0`, `${root}/sys/class/net/wwan0/device`)
        Deno.symlinkSync(`${root}/sys/bus/usb/drivers/cdc_ether`, `${usb}/7-1.1:2.0/driver`)
    })
    assert(run.run.stdout.includes("usb ethernet up on wwan0"), run.run.stdout)
    assertEquals(run.files["sys/devices/platform/usb7/7-1/7-1.1/bConfigurationValue"], "2\n")
})

/** the old real-time-offset needs GNU date (date -d): the system's, else nix's coreutils (macOS) */
const dateWorks = async (date: string) => {
    try {
        return (await new Deno.Command(date, { args: ["-d", "@0"], stdout: "null", stderr: "null" }).output()).success
    } catch {
        return false
    }
}
const nixBin = `${Deno.env.get("HOME")}/.nix-profile/bin`
const gnuDir = (await dateWorks("date")) ? "" : (await dateWorks(`${nixBin}/date`)) ? nixBin : null
const gnuDate = gnuDir !== null

for (
    const [label, env, current, expectRestart] of [
        ["HTTP Date, offset moved", { FAKE_DATE: "Wed, 05 Nov 2026 00:00:10 GMT" }, "0", true],
        ["HTTP Date, within 2 s", { FAKE_DATE: "Wed, 05 Nov 2026 00:00:10 GMT" }, "OFFSET_MINUS_1", false],
        ["offline, the PEER's offset", { FAKE_PEER_OFFSET: "77" }, "5", true],
        ["offline, no PEER answer", {}, "5", false],
    ] as const
) {
    Deno.test({
        name: `real-time-offset (${label}): the same offset, files and phc2sys restart as the old script`,
        ignore: !gnuDate,
        fn: async () => {
            const phc = "1718877600"
            const offset = Date.parse("Wed, 05 Nov 2026 00:00:10 GMT") / 1000 - Number(phc)
            const server = Deno.serve({ port: 0, onListen: () => {} }, () =>
                new Response(null, {
                    status: 301,
                    headers: "FAKE_DATE" in env ? { date: env.FAKE_DATE } : {},
                }))
            try {
                const url = "FAKE_DATE" in env ? `http://127.0.0.1:${server.addr.port}/` : "http://127.0.0.1:1/"
                const run = await compare(
                    "real-time-offset",
                    `${NEW}/both/real-time-offset`,
                    { ...env, FAKE_PHC: phc },
                    (root) => {
                        Deno.mkdirSync(`${root}/run`, { recursive: true })
                        Deno.mkdirSync(`${root}/etc/default`, { recursive: true })
                        Deno.writeTextFileSync(`${root}/etc/default/real-time-offset`, "PEER=user@10.21.31.104\n")
                        Deno.writeTextFileSync(
                            `${root}/run/phc2sys-offset`,
                            `${current === "OFFSET_MINUS_1" ? offset - 1 : current}\n`,
                        )
                    },
                    { ignoreOld: /^curl /, newEnv: { M20_TIME_URL: url } },
                )
                assertEquals(run.run.log.some((l) => l === "systemctl restart phc2sys"), expectRestart)
            } finally {
                await server.shutdown()
            }
        },
    })
}

// ---------------------------------------------------------------------------------------------------- network-safety

const NS_FAKES: Record<string, string> = {
    ap_start: `#!/bin/sh
echo myap50G > $NS_STATE/conn; echo "ap_start" >> $NS_STATE/events
`,
    iw: "#!/bin/sh\nexit 0\n",
    nmcli: `#!/bin/bash
D=$NS_STATE; conn=$(cat $D/conn 2>/dev/null)
args="$*"
case "$args" in
  *"device show"*)
    if [ -n "$conn" ]; then echo "100 (connected)"; echo "$conn"; else echo "30 (disconnected)"; echo ""; fi ;;
  *"wifi list"*) echo "70:5180 MHz::OpenNet"; echo "50:2412 MHz:WPA2:Locked" ;;
  *"-g 802-11-wireless.ssid"*) echo "" ;;
  *"connection show"*) echo "myap50G:802-11-wireless" ;;
  *"wifi connect"*) echo "$4" > $D/conn; echo "joined $4" >> $D/events ;;
  *"connection up"*) echo "$3" > $D/conn; echo "up $3" >> $D/events ;;
  *"connection down"*|*"device disconnect"*) : > $D/conn ;;
esac
`,
    tailscale: `#!/bin/sh
if [ "$TS_ONLINE" = 1 ]; then echo '{"BackendState":"Running","Self":{"Online":true}}'; else echo '{"BackendState":"Running","Self":{"Online":false}}'; fi
`,
}

/** the distinct state transitions network-safety logs in `seconds` */
async function networkSafetyStates(
    variant: string[],
    savedMode: string,
    online: boolean,
    seconds: number,
    options: { connectedTo?: string; full?: (text: string, events: string) => void } = {},
) {
    const dir = Deno.makeTempDirSync({ prefix: "m20ns-" })
    try {
        Deno.mkdirSync(`${dir}/bin`)
        Deno.mkdirSync(`${dir}/state`)
        if (options.connectedTo) {
            Deno.writeTextFileSync(`${dir}/state/conn`, `${options.connectedTo}\n`)
        }
        for (const [name, text] of Object.entries(NS_FAKES)) {
            Deno.writeTextFileSync(`${dir}/bin/${name}`, text, { mode: 0o755 })
        }
        Deno.writeTextFileSync(
            `${dir}/config.json`,
            JSON.stringify({
                savedMode,
                apStartCommand: [`${dir}/bin/ap_start`],
                apCheckMinutes: 0.05,
                discoveryMinutes: 0.15,
                softToHardMinutes: 0.1,
                noInternetIdleMinutes: 0.05,
                joinHoldSeconds: 1,
                onlineWaitSeconds: 1,
                onlineCheckSeconds: 2,
                pollSeconds: 0.2,
                // this computer's own sessions (ssh over Tailscale, ...) must not count as "someone connected"
                countedInterfaces: ["m20test0"],
            }),
        )
        // the old script reads config.json beside itself; a copy (root check off: these runs aren't root) goes there
        const argv = variant.map((word) => word.replace("{dir}", dir))
        if (argv.at(-2)?.endsWith(".js")) {
            const script = Deno.readTextFileSync(argv.at(-2)!).replace("Deno.uid() != 0", "false")
            Deno.writeTextFileSync(`${dir}/main.js`, script)
            argv[argv.length - 2] = `${dir}/main.js`
        }
        const child = new Deno.Command(argv[0], {
            args: argv.slice(1),
            env: {
                PATH: `${dir}/bin:${Deno.env.get("PATH")}`,
                NS_STATE: `${dir}/state`,
                TS_ONLINE: online ? "1" : "0",
                NETWORK_SAFETY_DIR: dir,
                // not root here: the tool's root check is skipped (its fakes change nothing real)
                NETWORK_SAFETY_TEST: "1",
            },
            stdout: "piped",
            stderr: "piped",
        }).spawn()
        setTimeout(() => child.kill("SIGKILL"), seconds * 1000)
        const out = await child.output()
        const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
        let events = ""
        try {
            events = Deno.readTextFileSync(`${dir}/state/events`)
        } catch {
            // nothing changed
        }
        options.full?.(text, events)
        return text.split("\n").filter((l) => l.includes("state: ")).map((l) => l.slice(l.indexOf("state: ")))
            .filter((l, i, all) => l !== all[i - 1])
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
}

const compiledNs = `${here}dist/m20-network-safety-${Deno.build.arch}-${
    Deno.build.os === "darwin" ? "apple-darwin" : "unknown-linux-gnu"
}`
const hasCompiled = (() => {
    try {
        return Deno.statSync(compiledNs).isFile
    } catch {
        return false
    }
})()

for (
    const [label, savedMode, online] of [
        ["Wi-Fi with internet: Discovery -> Soft -> Hard", "wifiInternet", true],
        ["no internet: Discovery runs out -> No Internet -> AP", "wifiInternet", false],
        ["boot into AP, nobody on it -> Wi-Fi", "ap", true],
    ] as const
) {
    Deno.test(`network-safety (${label}): the new script${hasCompiled ? " and the compiled tool" : ""} reach the old script's states`, async () => {
        const old = await networkSafetyStates(
            [Deno.execPath(), "run", "-A", `${OLD}/network_safety_main.js`, "run"],
            savedMode,
            online,
            8,
        )
        const now = await networkSafetyStates(
            [Deno.execPath(), "run", "-A", `${NEW}/aos/network_safety_main.js`, "run"],
            savedMode,
            online,
            8,
        )
        const variants = [now]
        if (hasCompiled) {
            variants.push(await networkSafetyStates([compiledNs, "run"], savedMode, online, 8))
        }
        assert(old.length >= 3, old.join("\n"))
        for (const states of variants) {
            const n = Math.min(old.length, states.length)
            assert(n >= 3, states.join("\n"))
            assertEquals(states.slice(0, n), old.slice(0, n))
        }
    })
}

Deno.test("network-safety run --dry-run (the shadow): decides like the real loop, changes nothing", async () => {
    const script = `${NEW}/aos/network_safety_main.js`
    // steady state: on a Wi-Fi network with internet -> the same states as the real loop
    const real = await networkSafetyStates([Deno.execPath(), "run", "-A", script, "run"], "wifiInternet", true, 10, {
        connectedTo: "OpenNet",
    })
    let shadowText = ""
    let shadowEvents = ""
    const shadow = await networkSafetyStates(
        [Deno.execPath(), "run", "-A", script, "run", "--dry-run"],
        "wifiInternet",
        true,
        10,
        { connectedTo: "OpenNet", full: (text, events) => ((shadowText = text), (shadowEvents = events)) },
    )
    // Boot -> Soft (kept the network it was on) -> Hard, in both
    assert(real.length >= 2, real.join("\n"))
    const n = Math.min(real.length, shadow.length)
    assertEquals(shadow.slice(0, n), real.slice(0, n))
    assertEquals(shadowEvents, "")
    assert(shadowText.includes('input wlan: {"connected":true,"connection":"OpenNet"}'), shadowText)
    // in AP mode it would start the hotspot: logged, not done
    let apText = ""
    let apEvents = ""
    await networkSafetyStates([Deno.execPath(), "run", "-A", script, "run", "--dry-run"], "ap", true, 3, {
        full: (text, events) => ((apText = text), (apEvents = events)),
    })
    assertEquals(apEvents, "")
    assert(/WOULD run: \S*ap_start/.test(apText), apText)
    assert(apText.includes("WOULD save config"), apText)
})
