// setup five times in a row against a fake GOS and AOS (a folder each, M20_TEST_ROOT, with fake systemctl / ip /
// iptables / nmcli / iw / tailscale / ping / ssh-keygen / udevadm / rmmod / resolvectl, a fake board deno, and the
// vendor's files as a fresh dog has them). Every board step runs as setup runs it: `m20tool board-step <id> check`,
// then `apply` only when the check found something to do, its parameters on stdin.
// Run 1 converges; runs 2-5 apply nothing, run no command that writes, and leave every file as it was (no new files,
// no rewritten ones, no backups).
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const MAIN = `${here}main.ts`
const encoder = new TextEncoder()

// each fake logs "W <tool> <args>" for anything that changes state, "R ..." for reads
const FAKES: Record<string, string> = {
    systemctl: `#!/bin/bash
S=$FAKE_STATE; mkdir -p $S/enabled $S/active
args=("$@"); [ "$1" = "-q" ] && shift
case "$1" in
  is-enabled) echo "R systemctl $*" >> $FAKE_LOG; [ -e "$S/enabled/$2" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  is-active) echo "R systemctl $*" >> $FAKE_LOG; u="\${@: -1}"; [ -e "$S/active/$u" ] && exit 0; exit 3 ;;
  enable) echo "W systemctl $*" >> $FAKE_LOG; shift; now=""; [ "$1" = "--now" ] && { now=1; shift; }; touch "$S/enabled/$1"; [ -n "$now" ] && touch "$S/active/$1" ;;
  disable) echo "W systemctl $*" >> $FAKE_LOG; shift; [ "$1" = "--now" ] && shift; rm -f "$S/enabled/$1" "$S/active/$1" ;;
  start|restart) echo "W systemctl $*" >> $FAKE_LOG; touch "$S/active/$2"
    [ "$2" = aos-uplink.service ] && touch $S/route_aos
    if [ "$2" = network-safety ] || [ "$2" = network-safety.service ]; then
      for p in $S/nm/*; do [ -e "$p/ssid" ] && [ "$(cat $p/ssid)" = "$FAKE_JOIN_SSID" ] && basename "$p" > $S/wlan; done
    fi ;;
  *) echo "W systemctl $*" >> $FAKE_LOG ;;
esac
exit 0
`,
    ip: `#!/bin/bash
S=$FAKE_STATE
case "$*" in
  "-o -4 addr show") echo "R ip $*" >> $FAKE_LOG; echo "2: eth0    inet 10.21.31.104/24 brd 10.21.31.255 scope global eth0" ;;
  "route show default") echo "R ip $*" >> $FAKE_LOG; [ -e $S/route_aos ] && echo "default via 10.21.31.103 dev eth0 metric 600" ;;
  *) echo "W ip $*" >> $FAKE_LOG ;;
esac
exit 0
`,
    iptables: `#!/bin/bash
case " $* " in *" -C "*) echo "R iptables $*" >> $FAKE_LOG; [ -e $FAKE_STATE/nat_ok ] && exit 0; exit 1 ;; esac
echo "W iptables $*" >> $FAKE_LOG
`,
    nmcli: `#!/bin/bash
S=$FAKE_STATE; mkdir -p $S/nm
args="$*"
case "$args" in
  "radio wifi") echo "R nmcli $*" >> $FAKE_LOG; cat $S/radio 2>/dev/null || echo enabled ;;
  "radio wifi on") echo "W nmcli $*" >> $FAKE_LOG; echo enabled > $S/radio ;;
  "-t -f NAME,TYPE connection show") echo "R nmcli $*" >> $FAKE_LOG; echo "myap50G:802-11-wireless"; for p in $S/nm/*; do [ -d "$p" ] && echo "$(basename "$p"):802-11-wireless"; done ;;
  "-g GENERAL.CONNECTION device show wlan0") echo "R nmcli $*" >> $FAKE_LOG; cat $S/wlan 2>/dev/null ;;
  "-g "*" connection show "*|"-s -g "*" connection show "*)
    echo "R nmcli $*" >> $FAKE_LOG
    [ "$1" = "-s" ] && shift; field="$2"; name="\${*:5}"
    case "$field" in 802-11-wireless.ssid) f=ssid ;; 802-11-wireless-security.psk) f=psk ;; connection.autoconnect) f=autoconnect ;; 802-11-wireless.band) f=band ;; *) f=x ;; esac
    cat "$S/nm/$name/$f" 2>/dev/null ;;
  "connection add "*)
    echo "W nmcli $*" >> $FAKE_LOG
    name=""; ssid=""; while [ $# -gt 0 ]; do case "$1" in con-name) name="$2"; shift ;; ssid) ssid="$2"; shift ;; esac; shift; done
    mkdir -p "$S/nm/$name"; echo "$ssid" > "$S/nm/$name/ssid"; echo yes > "$S/nm/$name/autoconnect" ;;
  "connection modify "*)
    echo "W nmcli $*" >> $FAKE_LOG
    name="$3"; shift 3
    while [ $# -gt 1 ]; do case "$1" in connection.autoconnect) echo "$2" > "$S/nm/$name/autoconnect" ;; 802-11-wireless.band) printf %s "$2" > "$S/nm/$name/band" ;; esac; shift 2; done ;;
  "connection edit id "*)
    echo "W nmcli $*" >> $FAKE_LOG
    name="\${*:4}"; while read -r verb key value; do [ "$verb $key" = "set 802-11-wireless-security.psk" ] && echo "$value" > "$S/nm/$name/psk"; done ;;
  *) echo "W nmcli $*" >> $FAKE_LOG ;;
esac
exit 0
`,
    iw: `#!/bin/sh
echo "R iw $*" >> $FAKE_LOG
printf '\\t\\t\\t* 2412 MHz [1] (19.0 dBm)\\n\\t\\t\\t* 5180 MHz [36] (17.0 dBm)\\n'
`,
    ping: `#!/bin/sh
echo "R ping $*" >> $FAKE_LOG
`,
    tailscale: `#!/bin/sh
echo "R tailscale $*" >> $FAKE_LOG
[ "$1" = ip ] && echo 100.64.0.9
exit 0
`,
    "ssh-keygen": `#!/bin/bash
echo "W ssh-keygen $*" >> $FAKE_LOG
f=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && f="$2"; shift; done
mkdir -p "$(dirname "$M20_TEST_ROOT$f")"; echo private > "$M20_TEST_ROOT$f"; echo "ssh-ed25519 AAAAroot root@aos" > "$M20_TEST_ROOT$f.pub"
`,
    udevadm: `#!/bin/sh\necho "W udevadm $*" >> $FAKE_LOG\n`,
    rmmod: `#!/bin/sh\necho "W rmmod $*" >> $FAKE_LOG\n`,
    resolvectl: `#!/bin/sh\necho "W resolvectl $*" >> $FAKE_LOG\n`,
}

// the board's /usr/local/bin/deno (what the deno step uploads): --check reads, a run of office-nat writes
const FAKE_DENO = `#!/bin/bash
case " $* " in
  *" --version "*) echo "R deno $*" >> $FAKE_LOG; echo "deno 2.9.8 (fake)" ;;
  *" --check"*) echo "R deno $*" >> $FAKE_LOG; [ -e $FAKE_STATE/nat_ok ] && exit 0; exit 1 ;;
  *office-nat*) echo "W deno $*" >> $FAKE_LOG; touch $FAKE_STATE/nat_ok ;;
  *) echo "W deno $*" >> $FAKE_LOG ;;
esac
exit 0
`

type Board = { name: "GOS" | "AOS"; root: string; state: string; log: string }

function makeBoard(name: "GOS" | "AOS", dir: string): Board {
    const root = `${dir}/${name}`
    const board = { name, root, state: `${dir}/${name}-state`, log: `${dir}/${name}.log` }
    for (
        const path of [
            "home/user",
            "run",
            "etc/systemd/system",
            "usr/local/bin",
            "opt/robot/scripts/board_resources/wifi",
        ]
    ) {
        Deno.mkdirSync(`${root}/${path}`, { recursive: true })
    }
    Deno.mkdirSync(board.state, { recursive: true })
    Deno.writeTextFileSync(`${root}/run/phc2sys-offset`, "-1\n")
    // the vendor's files as a fresh dog has them
    Deno.writeTextFileSync(
        `${root}/opt/robot/scripts/board_resources/wifi/host_start.sh`,
        "#!/bin/sh\n/opt/robot/scripts/wifi/ap_start.sh start 5G\n\n/opt/robot/scripts/wifi/loop_start_ap.sh\n",
    )
    Deno.writeTextFileSync(`${root}/opt/robot/scripts/board_resources/wifi/ap_start.sh`, "#!/bin/sh\n")
    return board
}

async function sha256(path: string) {
    const digest = await crypto.subtle.digest("SHA-256", Deno.readFileSync(path))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** every file under `root`: path -> size and mtime */
function snapshot(root: string, dir = root, out = new Map<string, string>()) {
    for (const entry of Deno.readDirSync(dir)) {
        const path = `${dir}/${entry.name}`
        const info = Deno.lstatSync(path)
        if (info.isDirectory) {
            snapshot(root, path, out)
        } else {
            out.set(path.slice(root.length), `${info.size} ${info.mtime?.getTime()}`)
        }
    }
    return out
}

Deno.test({
    name: "setup 5 times: run 1 converges; runs 2-5 apply nothing, write nothing, touch no file",
    // two fake boards, about 25 steps each run, the fresh dog's install of a 100 MB m20tool (Deno itself here)
    fn: async () => {
        const dir = Deno.makeTempDirSync({ prefix: "m20setup5-" })
        try {
            const bin = `${dir}/bin`
            Deno.mkdirSync(bin)
            for (const [name, text] of Object.entries(FAKES)) {
                Deno.writeTextFileSync(`${bin}/${name}`, text, { mode: 0o755 })
            }
            // uploads: the fake board deno, a fake compiled network-safety, a tailscale tarball
            Deno.writeTextFileSync(`${dir}/deno-upload`, FAKE_DENO, { mode: 0o755 })
            Deno.writeTextFileSync(`${dir}/ns-upload`, "#!/bin/sh\necho network-safety (fake)\n", { mode: 0o755 })
            const ts = `${dir}/ts/tailscale_1.0_arm64`
            Deno.mkdirSync(`${ts}/systemd`, { recursive: true })
            for (
                const [file, text] of [["tailscale", "ts"], ["tailscaled", "tsd"], [
                    "systemd/tailscaled.service",
                    "[Service]\n",
                ], ["systemd/tailscaled.defaults", "PORT=41641\n"]]
            ) {
                Deno.writeTextFileSync(`${ts}/${file}`, text)
            }
            assert(
                (await new Deno.Command("tar", {
                    args: ["czf", `${dir}/ts.tgz`, "-C", `${dir}/ts`, "tailscale_1.0_arm64"],
                }).output()).success,
            )
            const nsSha = await sha256(`${dir}/ns-upload`)

            const gos = makeBoard("GOS", dir)
            const aos = makeBoard("AOS", dir)
            const pubkey = "ssh-ed25519 AAAAlaptop laptop"
            let aosRootKey: string | undefined

            const step = async (board: Board, id: string, mode: "check" | "apply", params: Record<string, unknown>) => {
                const child = new Deno.Command(Deno.execPath(), {
                    args: ["run", "-A", "--unstable-net", MAIN, "board-step", id, mode],
                    env: {
                        PATH: `${bin}:${Deno.env.get("PATH")}`,
                        M20_TEST_ROOT: board.root,
                        FAKE_STATE: board.state,
                        FAKE_LOG: board.log,
                        FAKE_JOIN_SSID: "office",
                        NO_COLOR: "1",
                    },
                    stdin: "piped",
                    stdout: "piped",
                    stderr: "piped",
                }).spawn()
                const writer = child.stdin.getWriter()
                await writer.write(encoder.encode(JSON.stringify(params)))
                await writer.close()
                const out = await child.output()
                const text = new TextDecoder().decode(out.stdout)
                const line = text.split("\n").reverse().find((l) => l.startsWith("M20TOOL "))
                assert(line, `${board.name} ${id} ${mode}: ${text}${new TextDecoder().decode(out.stderr)}`)
                const result = JSON.parse(line.slice(8))
                assert(!result.error, `${board.name} ${id} ${mode}: ${result.error}`)
                return result as { todos: string[]; data?: { rootKey?: string } }
            }
            const upload = (board: Board, source: string, name: string) => {
                const path = `/tmp/m20tool-upload-${name}`
                Deno.mkdirSync(`${board.root}/tmp`, { recursive: true })
                Deno.copyFileSync(source, `${board.root}${path}`)
                return path
            }

            // the board steps in setup's order, with the parameters setup gives them
            const plan: [Board, string, (todos: string[]) => Record<string, unknown>][] = [
                [gos, "gos/ssh-key", () => ({ pubkey })],
                [aos, "aos/ssh-key", () => ({ pubkey })],
                [gos, "gos/self-install", () => ({})],
                [gos, "gos/docs", () => ({})],
                [aos, "aos/self-install", () => ({})],
                [aos, "aos/docs", () => ({})],
                [
                    gos,
                    "gos/deno",
                    (t) => ({ upload: t.length ? upload(gos, `${dir}/deno-upload`, "deno") : undefined }),
                ],
                [
                    aos,
                    "aos/deno",
                    (t) => ({ upload: t.length ? upload(aos, `${dir}/deno-upload`, "deno") : undefined }),
                ],
                [gos, "gos/usb-ethernet", () => ({ onCable: false })],
                [aos, "aos/route", () => ({})],
                [gos, "gos/time", () => ({})],
                [aos, "aos/time", () => ({})],
                [gos, "gos/trust-aos", () => ({ aosRootKey })],
                [aos, "aos/time-start", () => ({})],
                [aos, "aos/vendor", () => ({})],
                [aos, "aos/network-safety", (t) => ({
                    networkSafetySha256: nsSha,
                    upload: t.some((x) => x.includes("not this build"))
                        ? upload(aos, `${dir}/ns-upload`, "ns")
                        : undefined,
                })],
                [aos, "aos/firewall", () => ({})],
                [
                    gos,
                    "gos/tailscale",
                    (t) => ({
                        upload: t.some((x) => x.includes("not installed"))
                            ? upload(gos, `${dir}/ts.tgz`, "ts")
                            : undefined,
                    }),
                ],
                [
                    aos,
                    "aos/tailscale",
                    (t) => ({
                        upload: t.some((x) => x.includes("not installed"))
                            ? upload(aos, `${dir}/ts.tgz`, "ts")
                            : undefined,
                    }),
                ],
                [aos, "aos/bands", () => ({})],
                [aos, "aos/wifi", () => ({ ssid: "office", password: "s3cret-pass" })],
                [gos, "gos/aos-uplink", () => ({ aosWlanOnline: true })],
                [aos, "aos/drop-route", () => ({})],
            ]
            // step ids whose check data / params depend on others (network-safety's hash, AOS's root key)
            const base = (
                id: string,
            ) => (id === "aos/network-safety"
                ? { networkSafetySha256: nsSha }
                : id === "aos/wifi"
                ? { ssid: "office", password: "s3cret-pass" }
                : id === "gos/trust-aos"
                ? { aosRootKey }
                : id === "gos/usb-ethernet"
                ? { onCable: false }
                : id.endsWith("ssh-key")
                ? { pubkey }
                : {})

            const runs: { applied: string[]; writes: string[]; files: Map<string, string> }[] = []
            for (let run = 1; run <= 5; run++) {
                for (const board of [gos, aos]) {
                    Deno.writeTextFileSync(board.log, "")
                }
                const applied: string[] = []
                for (const [board, id, params] of plan) {
                    const checked = await step(board, id, "check", base(id))
                    if (id === "aos/time") {
                        aosRootKey = checked.data?.rootKey
                    }
                    if (checked.todos.length) {
                        applied.push(`${id}: ${checked.todos.join("; ")}`)
                        await step(board, id, "apply", params(checked.todos))
                        if (id === "aos/time") {
                            aosRootKey = (await step(board, id, "check", {})).data?.rootKey
                        }
                        const after = await step(board, id, "check", base(id))
                        assertEquals(after.todos, [], `run ${run}: ${id} didn't converge`)
                    }
                }
                const writes = [gos, aos].flatMap((board) =>
                    Deno.readTextFileSync(board.log).split("\n").filter((l) => l.startsWith("W ")).map((l) =>
                        `${board.name}: ${l}`
                    )
                )
                const files = new Map(
                    [...snapshot(gos.root), ...snapshot(aos.root)].map(([k, v], i) => [`${i < 0 ? "" : ""}${k}`, v]),
                )
                runs.push({
                    applied,
                    writes,
                    files: new Map([
                        ...[...snapshot(gos.root)].map(([k, v]) => [`GOS${k}`, v] as const),
                        ...[...snapshot(aos.root)].map(([k, v]) => [`AOS${k}`, v] as const),
                    ]),
                })
                files.clear()
            }
            assert(runs[0].applied.length >= 15, `run 1 applied only: ${runs[0].applied.join("\n")}`)
            for (let i = 1; i < 5; i++) {
                assertEquals(runs[i].applied, [], `run ${i + 1} applied`)
                assertEquals(runs[i].writes, [], `run ${i + 1} ran commands that write`)
                assertEquals([...runs[i].files.entries()], [...runs[0].files.entries()], `run ${i + 1} touched files`)
            }
            const backups = [...runs[0].files.keys()].filter((k) => k.includes(".bak-m20tool-"))
            console.log(
                `run 1: ${runs[0].applied.length} steps applied, ${runs[0].writes.length} write commands, ${
                    runs[0].files.size
                } files (${backups.length} backups); runs 2-5: 0 / 0 / 0`,
            )
        } finally {
            Deno.removeSync(dir, { recursive: true })
        }
    },
})
