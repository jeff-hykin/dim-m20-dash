// setup without a dog: the Wi-Fi password never shows (plans print ********, and it reaches a board only as JSON on
// ssh's stdin, then nmcli's stdin), and the board-side helpers (board.ts) behave: managed blocks keep the rest of a
// file and are idempotent, put() backs up a changed file, /proc lookups never match this process.
import { assert, assertEquals } from "@std/assert"
import { blockCurrent, describe, processes, put, putBlock, readText } from "./board.ts"
import { planLines } from "./board_step.ts"
import { MASK, redact, registerSecret } from "./scripts.ts"
import { stepById } from "./steps.ts"

const PASSWORD = "hunter2-Sekr3t!"

Deno.test("the Wi-Fi step's plan (what a dry run prints) shows ******** and never the password", () => {
    const plan = planLines("aos/wifi", { ssid: "office", password: PASSWORD }).join("\n")
    assert(!plan.includes(PASSWORD), plan)
    assert(plan.includes(MASK), plan)
    // no action of any step puts the password on a command line: only nmcli's stdin
    for (const action of stepById("aos/wifi")!.actions({ ssid: "office", password: PASSWORD })) {
        if (action.kind === "exec") {
            assert(!action.argv.join(" ").includes(PASSWORD))
        }
        assert(!describe(action).includes(PASSWORD))
    }
})

Deno.test("board-step gets its parameters on stdin, not argv (a local run of a read-only step)", async () => {
    const main = new URL("./main.ts", import.meta.url).pathname
    const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--unstable-net", main, "board-step", "aos/wifi-joined", "check"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({ ssid: "office", password: PASSWORD })))
    await writer.close()
    const out = await child.output()
    const text = new TextDecoder().decode(out.stdout)
    assert(text.startsWith("M20TOOL "), text + new TextDecoder().decode(out.stderr))
    assert(!text.includes(PASSWORD))
})

Deno.test("redact masks a registered secret anywhere", () => {
    registerSecret(PASSWORD)
    assertEquals(redact(`nmcli said: bad psk ${PASSWORD}.`), `nmcli said: bad psk ${MASK}.`)
})

Deno.test("managed blocks: appended after the file's own text, replaced in place, idempotent", () => {
    const dir = Deno.makeTempDirSync()
    try {
        const path = `${dir}/AGENTS.md`
        Deno.writeTextFileSync(path, "user notes\nkeep me")
        assert(!blockCurrent(path, "v1"))
        putBlock(path, "v1")
        putBlock(path, "v1")
        assert(blockCurrent(path, "v1"))
        putBlock(path, "v2\nline2")
        const text = readText(path)!
        assert(text.startsWith("user notes\nkeep me\n\n<!-- m20tool:begin"), text)
        assertEquals(text.match(/m20tool:begin/g)!.length, 1)
        assert(text.includes("v2\nline2\n<!-- m20tool:end -->"), text)
        assert(blockCurrent(path, "v2\nline2"))
        putBlock(`${dir}/new/CLAUDE.local.md`, "x")
        assert(blockCurrent(`${dir}/new/CLAUDE.local.md`, "x"))
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
})

Deno.test("put: same content changes nothing; different content keeps a .bak-m20tool-*", () => {
    const dir = Deno.makeTempDirSync()
    try {
        const path = `${dir}/svc`
        put(path, "a\n", 0o644)
        put(path, "a\n", 0o644)
        assertEquals([...Deno.readDirSync(dir)].length, 1)
        put(path, "b\n", 0o755)
        assertEquals(readText(path), "b\n")
        assertEquals(Deno.statSync(path).mode! & 0o777, 0o755)
        const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.startsWith("svc.bak-m20tool-"))
        assertEquals(backups.length, 1)
        assertEquals(readText(`${dir}/${backups[0].name}`), "a\n")
    } finally {
        Deno.removeSync(dir, { recursive: true })
    }
})

Deno.test({
    name: "processes(): matches other processes' command lines from /proc, never its own",
    ignore: Deno.build.os !== "linux",
    fn: async () => {
        const child = new Deno.Command("sleep", { args: ["30.12345"] }).spawn()
        try {
            await new Promise((resolve) => setTimeout(resolve, 200))
            assertEquals(processes(/sleep 30\.12345/), [child.pid])
            assertEquals(processes(/processes\(\): matches/), [])
        } finally {
            child.kill()
            await child.status
        }
    },
})
