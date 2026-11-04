// m20tool on the boards: the binary at /usr/local/bin/m20tool (on PATH for every shell, ssh commands too), and
// ~/.local/bin/m20 (the old Python CLI's path, which M20 Ctrl and the Controller's action buttons call) a wrapper.
import { BOARD_BIN, OLD_CLI, RELEASE_TAG, REPO, VERSION } from "./dog.ts"
import { download } from "./downloads.ts"
import { CheckScript, Script } from "./scripts.ts"

export const BOARD_TARGET = "aarch64-unknown-linux-gnu"

export const WRAPPER = `#!/bin/sh
# m20 is m20tool now (github.com/${REPO}, m20tool/); the old Python CLI, if there was one, is m20.python-bak
exec ${BOARD_BIN} "$@"
`

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

/** Root script on a board: install the uploaded binary, then the `m20` wrapper (keeping a non-wrapper m20). */
export function installOnBoardScript(uploaded: string): Script {
    return new Script(true)
        .line(`install -m 755 ${uploaded} ${BOARD_BIN}`, `rm -f ${uploaded}`)
        .line(
            `mkdir -p ${OLD_CLI.replace(/\/m20$/, "")}`,
            `if [ -f ${OLD_CLI} ] && ! grep -q m20tool ${OLD_CLI}; then mv ${OLD_CLI} ${OLD_CLI}.python-bak; fi`,
        )
        .file(OLD_CLI, WRAPPER, "755", "user:user")
        .line(`${BOARD_BIN} --version`)
}

export function installedCheckScript(): CheckScript {
    return new CheckScript()
        .line(
            `v=$(${BOARD_BIN} --version 2>/dev/null); case "$v" in *" ${VERSION}"*) ;; *) echo "TODO ${BOARD_BIN} is \${v:-missing}, not ${VERSION}" ;; esac`,
        )
        .file(OLD_CLI, WRAPPER)
}
