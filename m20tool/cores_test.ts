// gos/all-cores and aos/camera-cores against a fake board: what they leave in the dtb, Desktop's drop-in and AOS's unit.
import { assert, assertEquals } from "@std/assert"
import { fakeBootAndDesktop } from "./fake_boot.ts"

const MAIN = new URL("./main.ts", import.meta.url).pathname

async function step(root: string, bin: string, id: string, mode: "check" | "apply") {
    const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--unstable-net", MAIN, "board-step", id, mode],
        env: { M20_TEST_ROOT: root, PATH: `${bin}:${Deno.env.get("PATH")}`, NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
    }).output()
    const line = new TextDecoder().decode(out.stdout).split("\n").reverse().find((l) => l.startsWith("M20TOOL "))
    assert(line, new TextDecoder().decode(out.stderr))
    return JSON.parse(line.slice(8)) as { todos: string[]; error?: string }
}

Deno.test("gos/all-cores blanks isolcpus in place and drops Desktop's CPUAffinity; aos/camera-cores pins the relay", async () => {
    const dir = Deno.makeTempDirSync({ prefix: "m20cores-" })
    try {
        const bin = `${dir}/bin`
        Deno.mkdirSync(bin)
        Deno.writeTextFileSync(`${bin}/systemctl`, `#!/bin/sh\necho "$*" >> ${dir}/systemctl.log\n`, { mode: 0o755 })
        const gos = `${dir}/GOS`
        Deno.mkdirSync(`${gos}/home/user`, { recursive: true })
        fakeBootAndDesktop(gos)
        const before = Deno.readFileSync(`${gos}/boot/board_v2.dtb`)

        assertEquals((await step(gos, bin, "gos/all-cores", "check")).todos.length, 2)
        assert(!(await step(gos, bin, "gos/all-cores", "apply")).error)
        assertEquals((await step(gos, bin, "gos/all-cores", "check")).todos, [])

        const after = Deno.readFileSync(`${gos}/boot/board_v2.dtb`)
        assertEquals(after.length, before.length)
        const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b)
        assertEquals(text(after), text(before).replace("isolcpus=4,5,6,7", " ".repeat(16)))
        assert(Deno.lstatSync(`${gos}/boot/rk-kernel.dtb`).isSymlink, "the links stay links")
        const dropins = `${gos}/home/user/.config/systemd/user/dimos-desktop.service.d`
        assertEquals(Deno.readTextFileSync(`${dropins}/encoder.conf`), "[Service]\nEnvironment=ZDC_PIN_PIPELINES=1\n")
        assertEquals([...Deno.readDirSync(`${gos}/boot`)].filter((e) => e.name.includes(".bak-m20tool-")).length, 1)

        const aos = `${dir}/AOS`
        Deno.mkdirSync(`${aos}/etc/systemd/system`, { recursive: true })
        assertEquals((await step(aos, bin, "aos/camera-cores", "check")).todos.length, 1)
        assert(!(await step(aos, bin, "aos/camera-cores", "apply")).error)
        assertEquals((await step(aos, bin, "aos/camera-cores", "check")).todos, [])
        const unit = Deno.readTextFileSync(`${aos}/etc/systemd/system/m20-camera.service.d/big-cores.conf`)
        assert(unit.includes("[Service]\nCPUAffinity=6 7\n"))
        assertEquals(Deno.readTextFileSync(`${dir}/systemctl.log`), "daemon-reload\ntry-restart m20-camera.service\n")
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
})
