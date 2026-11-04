// What setup downloads on the laptop (the boards may have no internet, or a 2024 clock that breaks TLS), cached in
// ~/.cache/m20tool: Deno for AOS's network-safety, Tailscale's arm64 tarball, m20tool's own aarch64 binary.
import { unzipSync } from "fflate"

const DENO_FOR_BOARD = "2.9.8"

function cacheDir(): string {
    const dir = `${Deno.env.get("XDG_CACHE_HOME") ?? `${Deno.env.get("HOME") ?? "."}/.cache`}/m20tool`
    Deno.mkdirSync(dir, { recursive: true })
    return dir
}

/** Downloads `url` into the cache as `name` (once); its path. */
export async function download(url: string, name: string): Promise<string> {
    const path = `${cacheDir()}/${name}`
    try {
        if (Deno.statSync(path).size > 0) {
            return path
        }
    } catch {
        // not cached
    }
    console.log(`    downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`download failed: ${url}: HTTP ${response.status}`)
    }
    const temp = `${path}.part`
    await Deno.writeFile(temp, new Uint8Array(await response.arrayBuffer()))
    Deno.renameSync(temp, path)
    return path
}

/** deno for aarch64 Linux (glibc), unzipped. */
export async function denoForBoard(): Promise<string> {
    const zip = await download(
        `https://github.com/denoland/deno/releases/download/v${DENO_FOR_BOARD}/deno-aarch64-unknown-linux-gnu.zip`,
        `deno-${DENO_FOR_BOARD}-aarch64-unknown-linux-gnu.zip`,
    )
    const path = `${cacheDir()}/deno-${DENO_FOR_BOARD}-aarch64-unknown-linux-gnu`
    const files = unzipSync(Deno.readFileSync(zip))
    Deno.writeFileSync(path, files["deno"], { mode: 0o755 })
    return path
}

/** The latest stable Tailscale tarball for arm64 Linux. */
export async function tailscaleForBoard(): Promise<string> {
    const listing = await (await fetch("https://pkgs.tailscale.com/stable/?mode=json")).json()
    const name = listing?.Tarballs?.arm64
    if (typeof name !== "string") {
        throw new Error("pkgs.tailscale.com didn't list an arm64 tarball")
    }
    return await download(`https://pkgs.tailscale.com/stable/${name}`, name)
}
