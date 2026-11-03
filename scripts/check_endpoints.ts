// dimos.yaml's `provides:` (an OpenAPI 3.1 document) must list exactly the backend's routes (method + path), so Desktop
// sees every endpoint even before the app runs. `deno task check-endpoints`; `--write` rewrites its info and paths.
import { parse, stringify } from "@std/yaml"
import { openapi } from "../backend/http.ts"
import { INFO, routes } from "../backend/routes.ts"

/** An OpenAPI document's operations, as `GET api/thing`. */
function operations(doc: { paths?: object } | undefined): string[] {
    return Object.entries(doc?.paths ?? {}).flatMap(([path, item]) =>
        Object.keys(item).filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
            .map((method) => `${method.toUpperCase()} ${path.replace(/^\//, "")}`)
    )
}

const file = new URL("../dimos.yaml", import.meta.url)
const yaml = parse(await Deno.readTextFile(file)) as Record<string, unknown>
const want = openapi(INFO, routes)
if (Deno.args.includes("--write")) {
    const provides = (yaml.provides ?? {}) as { info?: object }
    yaml.provides = { ...provides, ...want, info: { ...provides.info, ...want.info } }
    await Deno.writeTextFile(file, stringify(yaml, { lineWidth: 120 }))
    console.log(`wrote ${operations(want).length} endpoints into dimos.yaml`)
    Deno.exit(0)
}
const have = new Set(operations(yaml.provides as { paths?: object }))
const need = new Set(operations(want))
const missing = [...need].filter((k) => !have.has(k))
const extra = [...have].filter((k) => !need.has(k))
if (missing.length || extra.length) {
    console.error(
        `dimos.yaml's provides: paths differ from backend/routes.ts:\n  missing: ${
            missing.join(", ") || "-"
        }\n  extra: ${extra.join(", ") || "-"}\nrun: deno task check-endpoints --write`,
    )
    Deno.exit(1)
}
console.log(`dimos.yaml lists all ${need.size} endpoints`)
