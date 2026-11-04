// Secrets in what m20tool prints: the Wi-Fi password shows as ********.

/** what a secret looks like in anything m20tool prints */
export const MASK = "********"
const secrets = new Set<string>()
/** From now on, `redact` masks `secret` (the Wi-Fi password) wherever it shows up. */
export function registerSecret(secret: string | undefined) {
    if (secret) {
        secrets.add(secret)
    }
}
/** `text` with every registered secret replaced by MASK */
export function redact(text: string): string {
    let out = text
    for (const secret of secrets) {
        out = out.replaceAll(secret, MASK)
    }
    return out
}
