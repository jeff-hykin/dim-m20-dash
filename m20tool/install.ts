// Which m20tool binary goes on the boards (aarch64 Linux); steps.ts's self-install puts it at /usr/local/bin/m20tool
// (on PATH for every shell, ssh commands too) with ~/.local/bin/m20 (the old Python CLI's path, which M20 Ctrl and the
// Controller's action buttons call) a wrapper.
import { RELEASE_TAG, REPO, VERSION } from "./dog.ts"
import { download } from "./downloads.ts"

export const BOARD_TARGET = "aarch64-unknown-linux-gnu"

/** Running as a `deno compile`d binary (not `deno run`)? */
export const compiled = () => !/^deno(\.exe)?$/.test(Deno.execPath().split("/").pop() ?? "")

/** A local m20tool for aarch64 Linux: this binary when it is one, M20TOOL_BOARD_BINARY, a local build, else the release. */
export async function boardBinary(): Promise<string> {
    if (compiled() && Deno.build.os === "linux" && Deno.build.arch === "aarch64") {
        return Deno.execPath()
    }
    const given = Deno.env.get("M20TOOL_BOARD_BINARY")
    if (given) {
        return given
    }
    if (!compiled()) {
        const local = new URL(`./dist/m20tool-${BOARD_TARGET}`, import.meta.url)
        try {
            Deno.statSync(local)
            return local.pathname
        } catch {
            // not built here
        }
    }
    return await download(
        `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/m20tool-${BOARD_TARGET}`,
        `m20tool-${VERSION}-${BOARD_TARGET}`,
    )
}

/** The compiled network-safety for aarch64 Linux: M20TOOL_NETWORK_SAFETY_BINARY, a local build, else this release's. */
export async function networkSafetyBinary(): Promise<string> {
    const name = `m20-network-safety-${BOARD_TARGET}`
    const given = Deno.env.get("M20TOOL_NETWORK_SAFETY_BINARY")
    if (given) {
        return given
    }
    if (!compiled()) {
        const local = new URL(`./dist/${name}`, import.meta.url)
        try {
            Deno.statSync(local)
            return local.pathname
        } catch {
            // not built here
        }
    }
    return await download(`https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${name}`, `${VERSION}-${name}`)
}
