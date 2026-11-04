// The Wi-Fi password never shows: not in a dry run's plan, not in a script or command line sent to a board (it goes
// over stdin into a temp file the script deletes), and redact() masks it in anything else printed.
import { assert, assertEquals } from "@std/assert"
import { type Dog, wifiStep } from "./setup.ts"
import { MASK, redact, registerSecret, Script } from "./scripts.ts"
import { wrap } from "./remote.ts"

const PASSWORD = "hunter2-Sekr3t!"
const board = (name: "GOS" | "AOS" | "NOS") => ({ name, target: `user@${name}`, sharedAddress: true })
const dog: Dog = { gos: board("GOS"), aos: board("AOS"), nos: board("NOS"), wired: true, how: "test" }

Deno.test("a dry run's plan for the Wi-Fi step shows ******** and never the password", () => {
    const plan = wifiStep(dog, "office", PASSWORD).plan().join("\n")
    assert(!plan.includes(PASSWORD), plan)
    assert(plan.includes(MASK), plan)
})

Deno.test("the password is in no script and no command line: only stdin -> a temp file the script deletes", async () => {
    const step = wifiStep(dog, "office", PASSWORD)
    // what goes over ssh as the command (the script inside is base64 of text without the password)
    const script = new Script(true).line(`printf '%s' "$M20_SECRET"`).text()
    for (const root of [false, true]) {
        const line = wrap(script, root, true)
        assert(!line.includes(PASSWORD))
        assert(!atob(line.match(/printf %s (\S+) \| base64 -d/)![1]).includes(PASSWORD))
    }
    assert(!JSON.stringify(step).includes(PASSWORD))
    // the plumbing, locally (not as root): stdin -> temp file -> $M20_SECRET -> the file is gone
    const probe = new Script(false).line(
        `printf '%s|' "$M20_SECRET"`,
        `[ -e "$M20_SECRET_FILE" ] && echo left || echo gone`,
    )
    const child = new Deno.Command("sh", {
        args: ["-c", wrap(probe.text(), false, true)],
        stdin: "piped",
        stdout: "piped",
    })
        .spawn()
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(PASSWORD))
    await writer.close()
    const out = new TextDecoder().decode((await child.output()).stdout).trim()
    assertEquals(out, `${PASSWORD}|gone`)
})

Deno.test("redact masks a registered secret anywhere", () => {
    registerSecret(PASSWORD)
    assertEquals(redact(`nmcli said: bad psk ${PASSWORD}.`), `nmcli said: bad psk ${MASK}.`)
})
