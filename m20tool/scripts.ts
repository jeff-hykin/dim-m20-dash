// Shell scripts for the boards: what they really run (file contents as base64) and how they read to a person.
import { encodeBase64 } from "@std/encoding/base64"

/** a shell word in single quotes */
export const q = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
export const b64 = (text: string) => encodeBase64(new TextEncoder().encode(text))

/** A managed block in a file someone else may also write: only the text between these lines is ours. */
export const managedBlock = (body: string) =>
    `<!-- m20tool:begin (written by m20tool setup; it replaces only what is between these two lines) -->\n${body.trimEnd()}\n<!-- m20tool:end -->\n`

// m20_block FILE B64: the block goes in place of an existing one, else at the end (after the file's own text), else
// it is the whole new file; the file is rewritten only if that changes it
const BLOCK_FUNCTION =
    `m20_block() { f="$1"; t="$f.m20tool-new"; mkdir -p "$(dirname "$f")"; printf %s "$2" | base64 -d > "$t.block"; ` +
    `if [ -f "$f" ] && grep -q '^<!-- m20tool:begin' "$f"; then awk -v bf="$t.block" 'BEGIN { while ((getline l < bf) > 0) b = b l "\\n" } /^<!-- m20tool:begin/ { printf "%s", b; skip = 1; next } /^<!-- m20tool:end/ { skip = 0; next } !skip { print }' "$f" > "$t"; ` +
    `elif [ -s "$f" ]; then { cat "$f"; [ -z "$(tail -c 1 "$f")" ] || echo; echo; cat "$t.block"; } > "$t"; ` +
    `else cp "$t.block" "$t"; fi; rm -f "$t.block"; if cmp -s "$t" "$f"; then rm -f "$t"; else mv "$t" "$f"; fi; }`

/** A shell script for a board, plus how it reads to a person (file contents summarized). */
export class Script {
    real: string[] = []
    shown: string[] = []
    constructor(readonly root: boolean) {}
    line(...lines: string[]) {
        this.real.push(...lines)
        this.shown.push(...lines)
        return this
    }
    /** installs `content` at `path` (a timestamped .bak-m20tool-* of a different existing file first) */
    file(path: string, content: string, mode: string, owner?: string) {
        this.real.push(
            `m20_put ${q(path)} ${mode} ${b64(content)}${owner ? ` && chown ${owner} ${q(path)}` : ""}`,
        )
        this.shown.push(
            `install ${new TextEncoder().encode(content).length}-byte file -> ${path} (mode ${mode}${
                owner ? `, owner ${owner}` : ""
            }; a different existing file is kept as ${path}.bak-m20tool-<time>)`,
        )
        return this
    }
    /** puts a managed block (managedBlock) into `path`, keeping whatever else is in it */
    block(path: string, body: string) {
        this.real.push(`m20_block ${q(path)} ${b64(managedBlock(body))}`)
        this.shown.push(
            `put a ${
                body.split("\n").length
            }-line block between <!-- m20tool:begin --> / <!-- m20tool:end --> lines in ${path} (replacing an earlier one; the rest of the file is kept; a new file if missing)`,
        )
        return this
    }
    text() {
        return [
            "set -e",
            BLOCK_FUNCTION,
            `m20_put() { new="$1.m20tool-new"; mkdir -p "$(dirname "$1")"; printf %s "$3" | base64 -d > "$new"; chmod "$2" "$new"; if [ -f "$1" ] && ! cmp -s "$new" "$1"; then cp -p "$1" "$1.bak-m20tool-$(date +%Y%m%d%H%M%S)"; fi; mv "$new" "$1"; }`,
            ...this.real,
        ].join("\n")
    }
}

/** A read-only check script: each unmet condition prints "TODO <why>". */
export class CheckScript {
    lines: string[] = []
    file(path: string, content: string) {
        this.lines.push(
            `printf %s ${b64(content)} | base64 -d | cmp -s - ${q(path)} || echo "TODO ${path} missing or different"`,
        )
        return this
    }
    /** the file holds exactly this managed block (its other text doesn't matter) */
    block(path: string, body: string) {
        this.lines.push(
            `want=$(printf %s ${
                b64(managedBlock(body))
            } | base64 -d); have=$(awk '/^<!-- m20tool:begin/ { p = 1 } p { print } /^<!-- m20tool:end/ { p = 0 }' ${
                q(path)
            } 2>/dev/null); [ "$have" = "$want" ] || echo "TODO ${path}: no current m20tool block"`,
        )
        return this
    }
    enabled(unit: string) {
        this.lines.push(
            `[ "$(systemctl is-enabled ${unit} 2>/dev/null)" = enabled ] || echo "TODO ${unit} not enabled"`,
        )
        return this
    }
    active(unit: string) {
        this.lines.push(`systemctl is-active -q ${unit} || echo "TODO ${unit} not running"`)
        return this
    }
    line(...lines: string[]) {
        this.lines.push(...lines)
        return this
    }
    text() {
        return this.lines.join("\n")
    }
}
