// The guards that keep a stray request off the robot: no writes from other pages in the browser, and Defaults never
// leaves the fake boards a run was started on.
import { assert, assertEquals } from "@std/assert"
import { handle } from "./http.ts"
import { INFO, routes } from "./routes.ts"
import { loadSettings, updateSettings } from "./settings.ts"

Deno.test("a write from another page in the browser is refused (no drive-by api/motion)", async () => {
    const send = (site: string | null) =>
        handle(
            new Request("http://app/api/motion", {
                method: "POST",
                headers: site ? { "sec-fetch-site": site, "content-type": "text/plain" } : {},
                body: JSON.stringify({ action: "dock", dryRun: true }),
            }),
            routes,
            INFO,
        )
    for (const site of ["cross-site", "same-site"]) {
        const response = await send(site)
        assertEquals(response!.status, 403, site)
        await response!.body?.cancel()
    }
    // the page itself (same-origin) and server-side callers (Desktop's agent: no header) get through to the route
    for (const site of ["same-origin", null]) {
        const response = await send(site)
        assert(response!.status !== 403, String(site))
        await response!.body?.cancel()
    }
})

Deno.test("Defaults keeps M20_DASH_SOURCE's fake boards (it went back to ssh: the real robot)", () => {
    const dir = Deno.makeTempDirSync()
    Deno.env.set("M20_DASH_SOURCE", "fake")
    try {
        loadSettings(`${dir}/settings.json`)
        assertEquals(updateSettings({ reset: true }).source, "fake")
    } finally {
        Deno.env.delete("M20_DASH_SOURCE")
    }
})
