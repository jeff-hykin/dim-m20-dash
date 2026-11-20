// The robot-level setup steps (steps.ts "vendor fixes", chrony.ts) against fake boards: each one's apply converges,
// its revert puts back exactly what was there, and nothing restarts a vendor unit. The chrony fixtures are the live
// dog's chrony.conf files (Nov 20 2026): GOS with clock-master.sh's block, AOS with sync-clock.sh's block (its server
// line commented out since), NOS with sync-clock.sh's block and its pools commented out.
import { assert, assertEquals, assertThrows } from "@std/assert"
import { CHRONY_CONF, effectiveLines, nosChronyShell, withoutDimosClock } from "./chrony.ts"

const here = new URL(".", import.meta.url).pathname
const MAIN = `${here}main.ts`
const fixture = (board: string) => Deno.readTextFileSync(`${here}test_fixtures/chrony/${board}.conf`)

// systemd as files: $FAKE_STATE/{enabled,active,masked}/<unit>; every call logged ("R ..." reads, "W ..." writes)
const SYSTEMCTL = `#!/bin/bash
S=$FAKE_STATE; mkdir -p $S/enabled $S/active $S/masked
[ "$1" = "-q" ] && shift
cmd=$1; shift
case "$cmd" in
  is-enabled) echo "R systemctl is-enabled $*" >> $FAKE_LOG
    [ -e "$S/masked/$1" ] && { echo masked; exit 1; }; [ -e "$S/enabled/$1" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  is-active) echo "R systemctl is-active $*" >> $FAKE_LOG; u="\${@: -1}"; [ -e "$S/active/$u" ] && exit 0; exit 3 ;;
esac
echo "W systemctl $cmd $*" >> $FAKE_LOG
now=""; [ "$1" = "--now" ] && { now=1; shift; }
case "$cmd" in
  enable) touch "$S/enabled/$1"; [ -n "$now" ] && touch "$S/active/$1" ;;
  disable) rm -f "$S/enabled/$1"; [ -n "$now" ] && rm -f "$S/active/$1" ;;
  mask) touch "$S/masked/$1"; [ -n "$now" ] && rm -f "$S/active/$1" ;;
  unmask) rm -f "$S/masked/$1" ;;
  start|restart) [ -e "$S/masked/$1" ] && exit 1; touch "$S/active/$1" ;;
  stop) rm -f "$S/active/$1" ;;
esac
exit 0
`

type Fake = { dir: string; root: string; state: string; log: string; env: Record<string, string> }

function fakeBoard(): Fake {
    const dir = Deno.makeTempDirSync({ prefix: "m20vendor-" })
    const fake = { dir, root: `${dir}/root`, state: `${dir}/state`, log: `${dir}/systemctl.log` } as Fake
    Deno.mkdirSync(`${dir}/bin`)
    Deno.mkdirSync(`${fake.root}/home/user`, { recursive: true })
    for (const sub of ["enabled", "active", "masked"]) {
        Deno.mkdirSync(`${fake.state}/${sub}`, { recursive: true })
    }
    Deno.writeTextFileSync(`${dir}/bin/systemctl`, SYSTEMCTL, { mode: 0o755 })
    Deno.writeTextFileSync(fake.log, "")
    fake.env = {
        PATH: `${dir}/bin:${Deno.env.get("PATH")}`,
        M20_TEST_ROOT: fake.root,
        FAKE_STATE: fake.state,
        FAKE_LOG: fake.log,
        NO_COLOR: "1",
    }
    return fake
}

const units = (fake: Fake, kind: "enabled" | "active" | "masked") =>
    [...Deno.readDirSync(`${fake.state}/${kind}`)].map((e) => e.name).sort()
const writes = (fake: Fake) => Deno.readTextFileSync(fake.log).split("\n").filter((l) => l.startsWith("W "))

async function step(fake: Fake, id: string, mode: "check" | "apply" | "revert-check" | "revert") {
    const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--unstable-net", MAIN, "board-step", id, mode],
        env: fake.env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
    }).output()
    const line = new TextDecoder().decode(out.stdout).split("\n").reverse().find((l) => l.startsWith("M20TOOL "))
    assert(line, `${id} ${mode}: ${new TextDecoder().decode(out.stderr)}`)
    const result = JSON.parse(line.slice(8)) as { todos: string[]; error?: string }
    assert(!result.error, `${id} ${mode}: ${result.error}`)
    return result.todos
}

/** apply converges (and a second check is clean), revert-check sees it, revert undoes it, idempotently */
async function roundTrip(fake: Fake, id: string) {
    const todos = await step(fake, id, "check")
    assert(todos.length, `${id}: nothing to do on the fresh board`)
    assertEquals(await step(fake, id, "revert-check"), [], `${id}: something to undo before it ran`)
    await step(fake, id, "apply")
    assertEquals(await step(fake, id, "check"), [], `${id} didn't converge`)
    const undo = await step(fake, id, "revert-check")
    assert(undo.length, `${id}: nothing to undo after it ran`)
    await step(fake, id, "revert")
    assertEquals(await step(fake, id, "revert-check"), [], `${id} revert didn't converge`)
    await step(fake, id, "revert")
    return { todos, undo }
}

Deno.test("chrony: the Deno edit and NOS's sh + sed give the same file on all three live chrony.conf; both reverts give back the original", async () => {
    const fake = fakeBoard()
    try {
        for (const board of ["gos", "aos", "nos"]) {
            const original = fixture(board)
            const deno = withoutDimosClock(original)
            assert(!/dimos-m20-clock|#dimos-disabled|m20time-disabled/.test(deno), `${board}: ${deno}`)
            const conf = `${fake.dir}/${board}.conf`
            Deno.writeTextFileSync(conf, original)
            const sh = (mode: Parameters<typeof nosChronyShell>[0]) =>
                new Deno.Command("sh", { args: ["-c", nosChronyShell(mode, conf)], env: fake.env, stdout: "piped" })
                    .output().then((o) => new TextDecoder().decode(o.stdout).trim())
            assertEquals(await sh("check"), "todo")
            assertEquals(await sh("revert-check"), "")
            await sh("apply")
            assertEquals(Deno.readTextFileSync(conf), deno, `${board}: sed and Deno differ`)
            assertEquals(await sh("check"), "")
            await sh("apply")
            assertEquals(Deno.readTextFileSync(conf), deno, `${board}: a second apply changed it`)
            assertEquals(await sh("revert-check"), "todo")
            await sh("revert")
            assertEquals(Deno.readTextFileSync(conf), original, `${board}: the revert isn't the original`)
            assertEquals(await sh("revert-check"), "")
        }
        // chrony isn't running in the fake: never restarted
        assertEquals(writes(fake), [])
        // what chrony reads: GOS loses allow/local stratum, NOS gets its pools back instead of GOS, AOS is unchanged
        assertEquals(effectiveLines(withoutDimosClock(fixture("aos"))), effectiveLines(fixture("aos")))
        assert(!effectiveLines(withoutDimosClock(fixture("gos"))).includes("allow 10.21.31.0/24"))
        const nos = effectiveLines(withoutDimosClock(fixture("nos")))
        assert(nos.includes("pool ntp.ubuntu.com") && !nos.includes("server 10.21.31.104"), nos)
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})

Deno.test("chrony on a board: restarted only when it runs and what it reads changed (NOS-like yes, AOS-like no)", async () => {
    for (const [board, restarts] of [["nos", true], ["aos", false]] as const) {
        const fake = fakeBoard()
        try {
            Deno.mkdirSync(`${fake.root}/etc/chrony`, { recursive: true })
            Deno.writeTextFileSync(`${fake.root}${CHRONY_CONF}`, fixture(board))
            Deno.writeTextFileSync(`${fake.state}/active/chrony.service`, "")
            await roundTrip(fake, "gos/chrony")
            assertEquals(Deno.readTextFileSync(`${fake.root}${CHRONY_CONF}`), fixture(board))
            const restartsSeen = writes(fake).filter((l) => l === "W systemctl restart chrony.service").length
            assertEquals(restartsSeen, restarts ? 2 : 0, `${board}: ${writes(fake).join("\n")}`)
        } finally {
            Deno.removeSync(fake.dir, { recursive: true })
        }
    }
})

Deno.test("vendor drop-ins (cpuset, hide-tailscale, ctrlmcu frames, imu-udp): installed with one daemon-reload, no vendor unit restarted, removed by the revert", async () => {
    const fake = fakeBoard()
    try {
        const cpuset = await roundTrip(fake, "aos/vendor-cpuset")
        assertEquals(cpuset.todos.length, 5)
        await roundTrip(fake, "aos/ctrlmcu-hide-tailscale")
        await roundTrip(fake, "aos/ctrlmcu-frames")
        const udp = await roundTrip(fake, "aos/imu-udp")
        assertEquals(udp.todos.length, 2)
        assertEquals(writes(fake), Array(8).fill("W systemctl daemon-reload "))
        // the revert leaves nothing behind but the folders
        const left: string[] = []
        const walk = (dir: string) => {
            for (const entry of Deno.readDirSync(dir)) {
                entry.isDirectory ? walk(`${dir}/${entry.name}`) : left.push(`${dir}/${entry.name}`)
            }
        }
        walk(fake.root)
        assertEquals(left, [])
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})

Deno.test("the shipped hide_tailscale.so is the one setup installs, byte for byte, and an aarch64 ELF", async () => {
    const fake = fakeBoard()
    try {
        await step(fake, "aos/ctrlmcu-hide-tailscale", "apply")
        const shipped = Deno.readFileSync(`${here}board_files/aos/vendor_fixes/hide_tailscale.so`)
        assertEquals(Deno.readFileSync(`${fake.root}/opt/robot/vendor_fixes/hide_tailscale.so`), shipped)
        assertEquals([...shipped.slice(0, 4)], [0x7f, 0x45, 0x4c, 0x46])
        // e_machine 183 = AArch64
        assertEquals(shipped[18] | (shipped[19] << 8), 183)
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})

Deno.test("GOS rsdriver: masked and stopped, its state saved; the revert unmasks, enables and starts it as it was", async () => {
    const fake = fakeBoard()
    try {
        for (const kind of ["enabled", "active"]) {
            Deno.writeTextFileSync(`${fake.state}/${kind}/rsdriver.service`, "")
        }
        const leftover = `${fake.root}/etc/systemd/system/dimos-m20-fastdds-permissions.path`
        Deno.mkdirSync(`${fake.root}/etc/systemd/system`, { recursive: true })
        Deno.writeTextFileSync(leftover, "[Path]\n")
        const id = "gos/rsdriver"
        assertEquals((await step(fake, id, "check")).length, 3)
        await step(fake, id, "apply")
        assertEquals(await step(fake, id, "check"), [])
        assertEquals(units(fake, "masked"), ["rsdriver.service"])
        assertEquals(units(fake, "active"), [])
        assertThrows(() => Deno.lstatSync(leftover), Deno.errors.NotFound)
        assertEquals(
            Deno.readTextFileSync(`${fake.root}/home/user/.local/state/m20tool/before-setup-rsdriver.service`),
            "enabled active\n",
        )
        await step(fake, id, "revert")
        assertEquals(await step(fake, id, "revert-check"), [])
        assertEquals([units(fake, "masked"), units(fake, "enabled"), units(fake, "active")], [
            [],
            ["rsdriver.service"],
            ["rsdriver.service"],
        ])
        assertEquals(writes(fake), [
            "W systemctl disable --now dimos-m20-fastdds-permissions.path",
            "W systemctl daemon-reload ",
            "W systemctl mask --now rsdriver.service",
            "W systemctl unmask rsdriver.service",
            "W systemctl enable rsdriver.service",
            "W systemctl start rsdriver.service",
        ])
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})

Deno.test("units already off before setup (the live GOS's masked rsdriver): nothing to do, nothing to undo", async () => {
    const fake = fakeBoard()
    try {
        Deno.writeTextFileSync(`${fake.state}/masked/rsdriver.service`, "")
        assertEquals(await step(fake, "gos/rsdriver", "check"), [])
        assertEquals(await step(fake, "gos/rsdriver", "revert-check"), [])
        await step(fake, "gos/rsdriver", "revert")
        assertEquals(units(fake, "masked"), ["rsdriver.service"])
        // not installed at all: off already
        assertEquals(await step(fake, "aos/old-camera", "check"), [])
        assertEquals(writes(fake), [])
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})

Deno.test("AOS old camera relay: disabled and stopped (files kept); the revert enables and starts it again", async () => {
    const fake = fakeBoard()
    try {
        for (const kind of ["enabled", "active"]) {
            Deno.writeTextFileSync(`${fake.state}/${kind}/m20-camera.service`, "")
        }
        const { todos } = await roundTrip(fake, "aos/old-camera")
        assertEquals(todos, ["m20-camera.service is enabled", "m20-camera.service is running"])
        assertEquals([units(fake, "enabled"), units(fake, "active")], [["m20-camera.service"], ["m20-camera.service"]])
        assertEquals(writes(fake), [
            "W systemctl disable --now m20-camera.service",
            "W systemctl enable m20-camera.service",
            "W systemctl start m20-camera.service",
        ])
    } finally {
        Deno.removeSync(fake.dir, { recursive: true })
    }
})
