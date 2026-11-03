// What dimOS Desktop tells this server at start: the DIMOS_APP env var, one JSON object (dimos-desktop docs/apps.md).
// Desktop passes no flags or other variables.
// Its `secrets` section is the one part never to print or pass on. Nothing here prints the object, which is what
// Desktop otherwise has to redact the zenoh-gateway token out of; if that ever changes, print `loggable()` of it.
// Where recordings live is the dimos gateway's to say, not DIMOS_APP's: `GET /gateways/dimos/history/recordings`
// answers {path}. loadRecordingsRoot() asks once at start and recordingsDir() reads what it got; DIMOS_APP's
// recordingsDir only stands in while the gateway hasn't answered (no Desktop, or it couldn't be reached).

export type DimosApp = {
    socket?: string
    dataDir?: string
    recordingsDir?: string
    desktopUrl?: string
    /** names this machine in a recording's metadata; Desktop 0.2.226 and newer */
    machineId?: string
    /** this app's secrets (its zenohGatewayToken among them): never print it, never pass it on */
    secrets?: Record<string, string>
}

let parsed: DimosApp | null = null

export function dimosApp(): DimosApp {
    if (parsed) {
        return parsed
    }
    try {
        parsed = JSON.parse(Deno.env.get("DIMOS_APP") || "{}") as DimosApp
    } catch {
        console.error("DIMOS_APP isn't valid JSON; ignoring it")
        parsed = {}
    }
    // a standalone run (deno task dev / fake) can still reach a Desktop's gateways
    parsed.desktopUrl ??= Deno.env.get("M20_DASH_DESKTOP_URL")
    return parsed
}

/** `DIMOS_APP` with its `secrets` left out: what may be printed. */
export function loggable(app: DimosApp = dimosApp()): Omit<DimosApp, "secrets"> {
    const { secrets: _secrets, ...rest } = app
    return rest
}

/** Where the app keeps its log: M20_DASH_DATA_DIR, else Desktop's dataDir, else ~/.local/share/dim-m20-dash. */
export function dataDir(): string {
    return Deno.env.get("M20_DASH_DATA_DIR") ?? dimosApp().dataDir ??
        `${Deno.env.get("HOME") ?? "."}/.local/share/dim-m20-dash`
}

/** The gateway's answer, kept for the whole run (null until loadRecordingsRoot() got one). */
let recordingsRoot: string | null = null

/**
 * Asks the dimos gateway for the recordings folder (`GET history/recordings` → `{path}`) and keeps the answer, so the
 * three callers of recordingsDir() share one lookup. Called once at start; off Desktop (no desktopUrl) or when the
 * gateway can't be reached it leaves recordingsDir() on DIMOS_APP's fallback. Returns the folder it got, else null.
 */
export async function loadRecordingsRoot(): Promise<string | null> {
    const base = dimosApp().desktopUrl
    if (!base) {
        return null // not started by Desktop: nothing to ask
    }
    try {
        const response = await fetch(new URL("/gateways/dimos/history/recordings", base), {
            signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
        }
        const { path } = await response.json() as { path?: string }
        if (!path) {
            throw new Error("no path in the answer")
        }
        recordingsRoot = path
        return path
    } catch (error) {
        console.error(
            `the dimos gateway didn't say where recordings live (${(error as Error).message}); ` +
                `using ${recordingsDir()}`,
        )
        return null
    }
}

/**
 * Where recordings go: M20_DASH_RECORDINGS_DIR, else the m20/ of the recordings folder the gateway named (DIMOS_APP's
 * recordingsDir until it has), else <data dir>/recordings.
 */
export function recordingsDir(): string {
    const root = recordingsRoot ?? dimosApp().recordingsDir
    return Deno.env.get("M20_DASH_RECORDINGS_DIR") ?? (root ? `${root}/m20` : `${dataDir()}/recordings`)
}
