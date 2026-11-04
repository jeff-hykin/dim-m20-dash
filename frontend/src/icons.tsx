// dimOS shared line icons (24-unit grid, stroke = currentColor) — the ones this app uses.
const PATHS: Record<string, string> = {
    camera: "M4 7h3l2-2h6l2 2h3v12H4V7Zm8 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
    expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
    shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
    "chevron-down": "m6 9 6 6 6-6",
    "arrow-up": "M12 19V5m-6 6 6-6 6 6",
    "arrow-down": "M12 5v14m-6-6 6 6 6-6",
    "arrow-left": "M19 12H5m6-6-6 6 6 6",
    "arrow-right": "M5 12h14m-6-6 6 6-6 6",
    "rotate-left": "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
    "rotate-right": "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
    menu: "M4 6h16M4 12h16M4 18h16",
    gamepad:
        "M6 8h12a4 4 0 0 1 4 4v2a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-2a4 4 0 0 1 4-4Zm2 2v4m-2-2h4m6-1h.01M17 13h.01",
    swap: "M7 7h13l-4-4M17 17H4l4 4",
    cube: "M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v0M4 7.5l8 4.5 8-4.5M12 12v9",
    // the M20: a four-legged body seen side on
    dog: "M4 10h13l3-2h1v4l-3 1H5Zm1 3-1 6m4-6 1 6m7-6-1 6m4-6 1 6",
    warn: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
    return (
        <svg className="dim-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path d={PATHS[name] ?? ""} />
        </svg>
    )
}
