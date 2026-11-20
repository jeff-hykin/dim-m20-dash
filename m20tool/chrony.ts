// dimos's old clock sync, undone: its deploy/setup.sh made GOS a chrony LAN master (clock-master.sh: an
// `allow`/`local stratum` block) and pointed NOS and AOS at it (sync-clock.sh: a `server 10.21.31.104` block, the stock
// pools commented out as `#dimos-disabled`). The dog's clock is PTP (ptp4l / phc2sys), so those blocks either do
// nothing (chrony off) or fight it. Same edit on every board: the blocks out, the pools back, the first original kept
// as CHRONY_ORIGINAL for the revert; chrony restarts only when it runs and its effective config (non-comment lines)
// changed. GOS and AOS do it in Deno (steps.ts); NOS has no m20tool, so nosChronyShell is the same in POSIX sh + sed.

export const CHRONY_CONF = "/etc/chrony/chrony.conf"
export const CHRONY_ORIGINAL = `${CHRONY_CONF}.orig-before-m20tool`

const BLOCKS = [
    /^# dimos-m20-clock BEGIN$[\s\S]*?^# dimos-m20-clock END$\n?/gm,
    /^# dimos-m20-clock-master BEGIN$[\s\S]*?^# dimos-m20-clock-master END$\n?/gm,
]
const DISABLED = /^#dimos-disabled /gm

/** chrony.conf without dimos's blocks, its commented-out sources back */
export const withoutDimosClock = (text: string) =>
    BLOCKS.reduce((t, block) => t.replace(block, ""), text).replace(DISABLED, "")

/** what chrony reads: the lines that aren't comments or blank */
export const effectiveLines = (text: string) => text.split("\n").filter((line) => !/^[\t ]*(#|$)/.test(line)).join("\n")

/** NOS's version, run there over ssh (root for apply / revert). check / revert-check print "todo" when there's work. */
export function nosChronyShell(mode: "check" | "apply" | "revert-check" | "revert", conf = CHRONY_CONF): string {
    const original = `${conf}.orig-before-m20tool`
    const effective = `grep -vE '^[[:space:]]*(#|$)' "$f"`
    const restart = `[ "$before" = "$(${effective})" ] || ! systemctl is-active -q chrony || systemctl restart chrony`
    const dirty = `grep -qE '^# dimos-m20-clock(-master)? BEGIN$|^#dimos-disabled ' "$f"`
    const head = `f='${conf}'; o='${original}';`
    if (mode === "check") {
        return `${head} if ${dirty}; then echo todo; fi`
    }
    if (mode === "revert-check") {
        return `${head} if [ -e "$o" ]; then echo todo; fi`
    }
    if (mode === "apply") {
        const sed = [
            `-e '/^# dimos-m20-clock BEGIN$/,/^# dimos-m20-clock END$/d'`,
            `-e '/^# dimos-m20-clock-master BEGIN$/,/^# dimos-m20-clock-master END$/d'`,
            `-e 's/^#dimos-disabled //'`,
        ].join(" ")
        return `${head} ${dirty} || exit 0; before=$(${effective}); [ -e "$o" ] || cp -p "$f" "$o"; ` +
            `sed ${sed} "$f" > "$f.m20tool-new" && cat "$f.m20tool-new" > "$f" && rm -f "$f.m20tool-new"; ${restart}`
    }
    return `${head} [ -e "$o" ] || exit 0; before=$(${effective}); cat "$o" > "$f" && rm -f "$o"; ${restart}`
}
