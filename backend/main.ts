// dimos-app-server: this app's API and its page on the unix socket Desktop gives (DIMOS_APP's `socket`, the one
// interface: docs/apps.md), else port 8788 (M20_DASH_PORT) for a standalone run. `--frontend` is the nix wrapper's.
import { applySettings } from "./app.ts"
import { initLog } from "./applog.ts"
import { dimosApp, loadRecordingsRoot } from "./dimos_app.ts"
import { handle } from "./http.ts"
import { recoverRecordings } from "./recording.ts"
import { INFO, routes } from "./routes.ts"
import { loadSettings } from "./settings.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend") ?? new URL("../frontend", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    json: "application/json",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    try {
        const bytes = await Deno.readFile(`${frontend}/${clean}`)
        const type = types[clean.split(".").pop() ?? ""] ?? "application/octet-stream"
        return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-cache" } })
    } catch {
        return new Response("not found", { status: 404 })
    }
}

async function serve(request: Request): Promise<Response> {
    return (await handle(request, routes, INFO)) ?? file(new URL(request.url).pathname)
}

initLog()
await loadRecordingsRoot() // the one lookup of Desktop's recordings folder: every recordingsDir() reads it
recoverRecordings() // a recording a quit or crash ended gets its footer, so it opens
loadSettings()
applySettings()

const socket = dimosApp().socket
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    // loopback unless asked: the API moves the robot and has no login of its own
    const hostname = Deno.env.get("M20_DASH_HOST") ?? "127.0.0.1"
    Deno.serve({ hostname, port: Number(Deno.env.get("M20_DASH_PORT") ?? 8788) }, serve)
}
