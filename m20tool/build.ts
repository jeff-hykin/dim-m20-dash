// Builds m20tool for every target into m20tool/dist (`deno task m20tool-build`); `--release` also publishes them as
// the GitHub release m20tool-v<VERSION> (install.sh downloads from it), which needs `gh`.
import { $ } from "dax"
import { RELEASE_TAG, REPO, VERSION } from "./dog.ts"

const TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin"]
const here = $.path(import.meta.dirname!)
const dist = here.join("dist")
dist.mkdirSync()

for (const target of TARGETS) {
    const out = dist.join(`m20tool-${target}`)
    $.logStep("compile", target)
    await $`deno compile -A --unstable-net --no-check --no-code-cache --target ${target} --include ${
        here.join("board_files")
    } --output ${out} ${here.join("main.ts")}`.cwd(here.parent()!)
}

// network-safety (AOS's lockout protection), compiled so no Deno change can break it: the board's aarch64, plus this
// computer's for services_test.ts
const NS_TARGETS = [
    "aarch64-unknown-linux-gnu",
    `${Deno.build.arch}-${Deno.build.os === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`,
]
for (const target of [...new Set(NS_TARGETS)]) {
    $.logStep("compile network-safety", target)
    await $`deno compile -A --no-config --no-check --no-code-cache --target ${target} --output ${
        dist.join(`m20-network-safety-${target}`)
    } ${here.join("board_files/aos/network_safety_main.js")}`
}

if (Deno.args.includes("--release")) {
    const assets = [
        ...TARGETS.map((target) => dist.join(`m20tool-${target}`).toString()),
        dist.join("m20-network-safety-aarch64-unknown-linux-gnu").toString(),
    ]
    const exists = (await $`gh release view ${RELEASE_TAG} --repo ${REPO}`.noThrow().quiet()).code === 0
    if (exists) {
        await $`gh release upload ${RELEASE_TAG} ${assets} --clobber --repo ${REPO}`
    } else {
        await $`gh release create ${RELEASE_TAG} ${assets} --repo ${REPO} --title ${`m20tool ${VERSION}`} --notes ${`m20tool ${VERSION}: the M20 setup and robot CLI. Install: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/m20tool/install.sh | sh`}`
    }
}
