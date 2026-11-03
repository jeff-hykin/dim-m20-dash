// The app's HTTP API: every user-facing action is a route here, so the UI and Desktop's agent drive the app the same
// way. `routes` is also served as openapi.json (Desktop's agent finds the endpoints there; dimos.yaml's `provides:`
// repeats them, and `deno task check-endpoints` keeps the two in step). Docs: dimos-desktop docs/apps.md,
// docs/agent.md.

export type Params = Record<string, { type: string; description?: string; required?: boolean; items?: unknown }>

export type Route = {
    method: "GET" | "POST" | "PUT" | "DELETE"
    /** relative to the app, e.g. `api/scan`; `{name}` segments become params */
    path: string
    /** when to use it: reads after "If ", e.g. "you need to drive the robot forward" */
    when: string
    description: string
    params?: Params
    /** "view": what Desktop's screenshot() calls; "context": what desktop_context adds while the app is focused */
    role?: "view" | "context"
    handler: (args: Record<string, unknown>, request: Request) => unknown | Promise<unknown>
}

/** A readable error with an HTTP status: the UI and the agent both show `message`. */
export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

function match(route: Route, method: string, path: string): Record<string, string> | null {
    if (route.method !== method) {
        return null
    }
    const want = route.path.split("/")
    const got = path.split("/")
    if (want.length !== got.length) {
        return null
    }
    const params: Record<string, string> = {}
    for (let i = 0; i < want.length; i++) {
        const name = want[i].match(/^\{(.+)\}$/)?.[1]
        if (name) {
            params[name] = decodeURIComponent(got[i])
        } else if (want[i] !== got[i]) {
            return null
        }
    }
    return params
}

/** The app's API: its title, version (major = breaking, minor = added) and description. */
export type Info = { title: string; version: string; description: string }

/** A parameter's schema; a bare one is a string. */
const typed = (schema: object) => Object.keys(schema).length ? schema : { type: "string" }

/** What openapi.json / dimos.yaml's `provides:` say about the routes: an OpenAPI 3.1 document, where a route's `{name}`
 * params are path parameters, GET/DELETE's others query parameters, and POST/PUT's others a JSON body. */
export function openapi(info: Info, routes: Route[]) {
    const paths: Record<string, Record<string, unknown>> = {}
    for (const { method, path, when, description, params = {}, role } of routes) {
        const text = description.trim().split(/\s+/).join(" ")
        const operation: Record<string, unknown> = { [text.length <= 100 ? "summary" : "description"]: text }
        if (when) {
            operation["x-when"] = when
        }
        if (role) {
            operation["x-dimos-role"] = role
        }
        const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        const parameters: Record<string, unknown>[] = inPath.map((name) => {
            const { required: _, description, ...schema } = params[name] ?? { type: "string" }
            return { name, in: "path", required: true, schema: typed(schema), ...(description ? { description } : {}) }
        })
        const properties: Record<string, unknown> = {}
        const required: string[] = []
        for (const [name, { required: isRequired, ...schema }] of Object.entries(params)) {
            if (inPath.includes(name)) {
                continue
            }
            properties[name] = schema
            if (isRequired) {
                required.push(name)
            }
        }
        if (method === "GET" || method === "DELETE") {
            for (const [name, { description, ...schema }] of Object.entries(properties as Params)) {
                parameters.push({
                    name,
                    in: "query",
                    schema: typed(schema),
                    ...(required.includes(name) ? { required: true } : {}),
                    ...(description ? { description } : {}),
                })
            }
        } else if (Object.keys(properties).length) {
            const schema = { type: "object", properties, ...(required.length ? { required } : {}) }
            operation.requestBody = { content: { "application/json": { schema } } }
        }
        if (parameters.length) {
            operation.parameters = parameters
        }
        paths[`/${path}`] = { ...paths[`/${path}`], [method.toLowerCase()]: operation }
    }
    return { openapi: "3.1.0", info, paths }
}

/** Handles `/api/...` + `/openapi.json`; null for anything else (the static frontend). */
export async function handle(request: Request, routes: Route[], info: Info): Promise<Response | null> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/+/, "")
    if (path === "openapi.json") {
        return Response.json(openapi(info, routes))
    }
    if (path === "agent.json") {
        // openapi.json replaced it; a 404 (not the page) sends Desktop on to openapi.json
        return Response.json({ error: "see openapi.json" }, { status: 404 })
    }
    for (const route of routes) {
        const pathParams = match(route, request.method, path)
        if (!pathParams) {
            continue
        }
        const args: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...pathParams }
        if (request.method !== "GET" && request.method !== "DELETE") {
            const text = await request.text()
            if (text) {
                try {
                    Object.assign(args, JSON.parse(text))
                } catch {
                    return Response.json({ error: "the body isn't JSON" }, { status: 400 })
                }
            }
        }
        for (const [name, spec] of Object.entries(route.params ?? {})) {
            if (spec.required && args[name] === undefined) {
                return Response.json({ error: `${name} is required` }, { status: 400 })
            }
        }
        try {
            const result = await route.handler(args, request)
            return result instanceof Response ? result : Response.json(result ?? { ok: true })
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
        }
    }
    if (path.startsWith("api/")) {
        return Response.json({ error: `no such endpoint: ${request.method} /${path}` }, { status: 404 })
    }
    return null
}

/** Pages listening on `api/events/ws` (the standard backend → page channel): one JSON event per message. */
const pages = new Set<WebSocket>()

export function publishEvent(event: unknown) {
    const text = JSON.stringify(event)
    for (const ws of pages) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(text)
        }
    }
}

export function eventsSocket(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.onopen = () => pages.add(socket)
    socket.onclose = () => pages.delete(socket)
    return response
}
