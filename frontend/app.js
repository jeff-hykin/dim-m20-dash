// M20 Ctrl's page: everything it shows comes from GET api/state (polled once a second); every action is one of the
// backend's endpoints. Plain JS, no build. Colors and fonts are Desktop's theme tokens (../../theme.css).

const POLL_MS = 1000
const CHART_SECONDS = 120

// ── Desktop's skin, followed live (what dim-app's initTheme does: html[data-skin] from Desktop's saved choice) ──
function applySkin() {
    let skin = null
    try {
        skin = location.pathname.startsWith("/apps/") ? localStorage.getItem("portal.theme") : null
    } catch {
        // storage blocked: the default skin
    }
    document.documentElement.dataset.skin = skin || "portal"
    document.body?.classList.add("science")
}
applySkin()
addEventListener("storage", (event) => {
    if (event.key === null || event.key === "portal.theme") {
        applySkin()
        lastState && render(lastState)
    }
})

/** One call to the app's own API: its JSON, or throws with the error it gave. */
async function api(method, path, body) {
    const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(json.error ?? `HTTP ${response.status}`)
    }
    return json
}

/** `tag.class` with children (strings are text) */
function el(spec, attrs = {}, ...children) {
    const [tag, ...classes] = spec.split(".")
    const node = document.createElement(tag || "div")
    if (classes.length) {
        node.className = classes.join(" ")
    }
    for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) {
            node.addEventListener(key.slice(2), value)
        } else if (value !== undefined && value !== null && value !== false) {
            node.setAttribute(key, value === true ? "" : value)
        }
    }
    node.append(...children.flat().filter((child) => child !== null && child !== undefined))
    return node
}

const token = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function formatUptime(seconds) {
    if (seconds === null || seconds === undefined) {
        return "–"
    }
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

function formatBytes(bytes) {
    return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} kB`
}

const LIGHTS = [
    ["network", "Network"],
    ["stats", "Stats link"],
    ["lidar", "Lidar"],
    ["dimos", "dimos"],
]

// ── a board's card, made once and updated every poll (so its chart keeps its canvas) ──
const cards = new Map()

function boardCard(board) {
    let card = cards.get(board.name)
    if (!card) {
        const lights = Object.fromEntries(LIGHTS.map(([key, what]) => {
            const text = el("div.text")
            const node = el(
                "div.light.unknown",
                { "data-light": key },
                el("span.dot"),
                el("div", {}, el("div.what", {}, what), text),
            )
            return [key, { node, text }]
        }))
        const canvas = el("canvas", {
            width: 600,
            height: 128,
            title: `CPU, last ${CHART_SECONDS} s (total bold, cores faint)`,
        })
        const big = el("div.big")
        const cores = el("div.cores")
        const numbers = el("div.numbers")
        const node = el(
            "article.board",
            { "data-board": board.name },
            el("div.head", {}, el("h2", {}, board.label), el("span.hosts.mono.muted", {}, board.hosts.join(" · "))),
            el("div.role.muted", {}, board.role ?? ""),
            el("div.lights", {}, Object.values(lights).map((l) => l.node)),
            el("div.cpu", {}, big, canvas),
            cores,
            numbers,
        )
        card = { node, lights, canvas, big, cores, numbers }
        cards.set(board.name, card)
    }
    return card
}

function drawChart(canvas, history, now) {
    const context = canvas.getContext("2d")
    const { width, height } = canvas
    context.clearRect(0, 0, width, height)
    const x = (t) => width - ((now - t) / 1000 / CHART_SECONDS) * width
    const y = (percent) => height - (percent / 100) * (height - 4) - 2
    context.strokeStyle = token("--border", "rgba(255,255,255,0.1)")
    context.lineWidth = 1
    for (const level of [25, 50, 75]) {
        context.beginPath()
        context.moveTo(0, y(level))
        context.lineTo(width, y(level))
        context.stroke()
    }
    const line = (values, color, lineWidth, alpha) => {
        context.globalAlpha = alpha
        context.strokeStyle = color
        context.lineWidth = lineWidth
        context.beginPath()
        let started = false
        for (const [t, value] of values) {
            if (value === null || value === undefined) {
                started = false
                continue
            }
            started ? context.lineTo(x(t), y(value)) : context.moveTo(x(t), y(value))
            started = true
        }
        context.stroke()
        context.globalAlpha = 1
    }
    const coreCount = Math.max(0, ...history.map((h) => h.cores.length))
    const accent = token("--primary", "#4a8cff")
    for (let core = 0; core < coreCount; core++) {
        line(history.map((h) => [h.t, h.cores[core]]), accent, 1, 0.25)
    }
    line(history.map((h) => [h.t, h.total]), token("--fg", "#e6eaf2"), 3, 1)
}

function updateBoard(board, now) {
    const card = boardCard(board)
    card.node.classList.toggle("stale", board.stale)
    for (const [key] of LIGHTS) {
        const indicator = board.indicators[key]
        const light = card.lights[key]
        light.node.className = `light ${indicator.level}`
        light.node.dataset.level = indicator.level
        light.text.textContent = indicator.text
    }
    const sample = board.latest
    const total = sample?.cpu.total
    card.big.replaceChildren(
        total === null || total === undefined ? "–" : `${Math.round(total)}%`,
        el("small", {}, board.stale ? "CPU (stale)" : "CPU total"),
    )
    drawChart(card.canvas, board.history ?? [], now)
    card.cores.replaceChildren(...(sample?.cpu.cores ?? []).map((percent, index) =>
        el(
            percent >= 85 ? "div.core.hot" : "div.core",
            { title: `cpu${index}: ${percent ?? "–"}%` },
            el("div", { style: `height:${percent ?? 0}%` }),
        )
    ))
    const hottest = sample?.temps.length ? sample.temps.reduce((a, b) => (b.celsius > a.celsius ? b : a)) : null
    const pairs = [
        ["load", sample?.load ? sample.load.map((v) => v.toFixed(2)).join(" ") : "–"],
        ["temperature", hottest ? `${hottest.celsius.toFixed(1)} °C (${hottest.name})` : "–"],
        ["memory", sample?.mem ? `${sample.mem.usedMb} / ${sample.mem.totalMb} MB (${sample.mem.percent}%)` : "–"],
        ["uptime", formatUptime(sample?.uptimeS)],
        ["cores", sample ? String(sample.cpu.cores.length) : "–"],
        ["link", `${board.link.state}${board.link.host ? ` · ${board.link.host}` : ""}`],
    ]
    card.numbers.replaceChildren(...pairs.flatMap(([key, value]) => [el("span", {}, key), el("span.mono", {}, value)]))
    return card.node
}

// ── the blueprint panel (blueprint mode) or the direct-mode notice ──
/** what each motion button asks before it sends (null: no question; Stop only zeroes the velocity) */
const MOTIONS = [
    ["standup", "Stand up", "Stand up: this MOVES THE ROBOT through the running blueprint. Continue?"],
    ["liedown", "Lie down", "Lie down: this MOVES THE ROBOT through the running blueprint. Continue?"],
    [
        "dock",
        "Dock",
        "Dock: the robot WALKS ONTO THE CHARGING DOCK. It must already stand still about 2 m in front of the dock, " +
        "facing it with both reflectors in view (it can't find the dock from elsewhere). Continue?",
    ],
    ["stop", "Stop", null],
]
const DOCK_DIRECT =
    "Docking is the blueprint's M20Connection dock skill: blueprint mode only (direct mode sends nothing to the robot)"

async function motion(action, label, question) {
    if (question && !confirm(question)) {
        return
    }
    try {
        const result = await api("POST", "api/motion", { action })
        motionNote = result.ok ? `${label}: ${JSON.stringify(result.result)}` : `${label} failed: ${result.error}`
    } catch (error) {
        motionNote = `${label}: ${error.message}`
    }
    refresh()
}
let motionNote = ""

// made once and never taken out of the page: rebuilt every poll, a button pressed across a re-render lost its click
const motionButtons = Object.fromEntries(MOTIONS.map(([action, label, question]) => [
    action,
    el(
        "button",
        { "data-ui": `motion.${action}`, disabled: true, onclick: () => motion(action, label, question) },
        label,
    ),
]))
const motionRow = el("div.motion", { style: "margin:8px 0" }, Object.values(motionButtons))
const panelTop = el("div")
const panelRest = el("div")

async function toggleWatch(name, watched) {
    const settings = await api("GET", "api/settings")
    const streams = new Set(settings.blueprintStreams)
    watched ? streams.add(name) : streams.delete(name)
    await api("PUT", "api/settings", { blueprintStreams: [...streams] })
    currentStreams = streams
    // the settings form's list too, or its Save would put back what the checkbox just changed
    document.getElementById("streams").value = [...streams].join(", ")
    refresh()
}

/** Each button's state: enabled only with a running blueprint whose M20Connection has that RPC. */
function updateMotionButtons(state) {
    const bp = state.blueprint ?? {}
    const rpcs = new Set(bp.connection?.rpcs ?? [])
    const rpcOf = { standup: "standup", liedown: "liedown", dock: "dock", stop: "stop_movement" }
    for (const [action, button] of Object.entries(motionButtons)) {
        let why = null
        if (state.mode === "direct") {
            why = action === "dock" ? DOCK_DIRECT : state.directMotion
        } else if (!bp.running) {
            why = "no blueprint running"
        } else if (!bp.connection) {
            why = "the running blueprint has no M20Connection"
        } else if (!rpcs.has(rpcOf[action])) {
            why = action === "dock"
                ? `${bp.connection.id} has no dock RPC: docking needs a dimos with the M20 self-charging skill`
                : `${bp.connection.id} has no ${rpcOf[action]} RPC`
        }
        button.disabled = why !== null
        button.title = why ?? ""
    }
}

function blueprintPanel(state) {
    const panel = document.getElementById("blueprint")
    if (panel.children.length !== 3) {
        panel.replaceChildren(panelTop, motionRow, panelRest)
    }
    updateMotionButtons(state)
    if (state.mode === "direct") {
        panelTop.replaceChildren(
            el("div.head", {}, el("h2", {}, "Direct mode")),
            el(
                "div.note",
                { "data-ui": "direct.note" },
                "Boards only. Motion is not available in direct mode: M20 Ctrl doesn't implement the M20's own control " +
                    "protocol (it isn't documented here), so nothing is sent to the robot. Switch to Blueprint mode to " +
                    "command it through a running dimos blueprint's M20Connection.",
            ),
        )
        panelRest.replaceChildren()
        return
    }
    const bp = state.blueprint ?? {}
    const lidarStreams = (bp.streams ?? []).filter((s) => /lidar|points|cloud/i.test(s.name))
    const status = bp.error ? el("span.error", {}, bp.error) : bp.running
        ? el(
            "span",
            {},
            "running ",
            el("b.mono", {}, bp.blueprint),
            el("span.muted", {}, ` · ${bp.streams.length} streams`),
        )
        : el("span.muted", {}, "no blueprint running")
    panelTop.replaceChildren(
        el("div.head", {}, el("h2", {}, "Blueprint"), status),
        el(
            "div.muted",
            {},
            bp.connection
                ? `Motion goes through ${bp.connection.id}'s RPCs (the blueprint keeps the robot connection).`
                : bp.running
                ? "This blueprint has no M20Connection: motion is unavailable."
                : "Launch an M20 blueprint (e.g. m20-nav) to watch its streams and command it.",
        ),
    )
    // nulls are the parts that don't apply right now
    panelRest.replaceChildren(...[
        motionNote ? el("div.muted.mono", { "data-ui": "motion.note" }, motionNote) : null,
        lidarStreams.length
            ? el(
                "div.muted",
                {},
                "lidar streams in the blueprint: ",
                el("span.mono", {}, lidarStreams.map((s) => s.name).join(", ")),
            )
            : null,
        bp.streams?.length
            ? el(
                "table",
                {},
                el(
                    "tr",
                    {},
                    ["sample", "stream", "type", "module", "latest (sampled 1/s)"].map((h) => el("th", {}, h)),
                ),
                bp.streams.map((stream) => {
                    const peeked = bp.peeked?.[stream.name]
                    return el(
                        "tr",
                        {},
                        el(
                            "td",
                            {},
                            el("input", {
                                type: "checkbox",
                                checked: currentStreams.has(stream.name),
                                title: "sample (and record) this stream",
                                onchange: (event) => toggleWatch(stream.name, event.target.checked),
                            }),
                        ),
                        el("td.mono", {}, stream.name),
                        el("td.mono.muted", {}, stream.type.split(".").pop()),
                        el("td.mono.muted", {}, stream.module),
                        el(
                            "td.value",
                            { title: peeked ? JSON.stringify(peeked.value) : "" },
                            peeked ? JSON.stringify(peeked.value) : "",
                        ),
                    )
                }),
            )
            : null,
    ].filter(Boolean))
}

let currentStreams = new Set()

// ── header: mode, recording, banner ──
function header(state) {
    for (const button of document.querySelectorAll(".mode button")) {
        button.classList.toggle("on", button.dataset.mode === state.mode)
    }
    const record = document.getElementById("record")
    record.classList.toggle("on", state.record.active)
    record.textContent = state.record.active ? "Stop" : "Record"
    document.getElementById("record-status").textContent = state.record.active
        ? `● ${state.record.seconds} s · ${formatBytes(state.record.bytes)} · ${state.record.messages} msgs`
        : lastRecording
        ? `saved ${lastRecording}`
        : ""
    const banner = document.getElementById("banner")
    banner.hidden = state.source !== "fake"
    banner.textContent =
        "Simulated boards: these stats come from M20 Ctrl's fake boards, not the robot (Settings → source)."
}
let lastRecording = ""

let lastState = null

function render(state) {
    lastState = state
    header(state)
    const grid = document.getElementById("boards")
    const nodes = state.boards.map((board) => updateBoard(board, state.now))
    if (nodes.length !== grid.children.length || nodes.some((node, i) => grid.children[i] !== node)) {
        grid.replaceChildren(...nodes)
    }
    blueprintPanel(state)
}

let polling = false
async function refresh() {
    if (polling) {
        return
    }
    polling = true
    try {
        render(await api("GET", "api/state?history=true"))
    } catch (error) {
        document.getElementById("banner").hidden = false
        document.getElementById("banner").textContent = `M20 Ctrl's backend: ${error.message}`
    } finally {
        polling = false
    }
}

// ── controls ──
for (const button of document.querySelectorAll(".mode button")) {
    button.addEventListener("click", async () => {
        await api("PUT", "api/mode", { mode: button.dataset.mode })
        refresh()
    })
}
document.getElementById("record").addEventListener("click", async () => {
    try {
        if (lastState?.record.active) {
            const stopped = await api("POST", "api/record/stop")
            lastRecording = stopped.file ?? ""
        } else {
            await api("POST", "api/record/start")
        }
    } catch (error) {
        alert(`Recording: ${error.message}`)
    }
    refresh()
})

async function loadSettings() {
    const settings = await api("GET", "api/settings")
    document.getElementById("source").value = settings.source
    document.getElementById("boards-json").value = JSON.stringify(settings.boards, null, 4)
    document.getElementById("streams").value = settings.blueprintStreams.join(", ")
    currentStreams = new Set(settings.blueprintStreams)
}
document.getElementById("save").addEventListener("click", async () => {
    const note = document.getElementById("settings-note")
    try {
        await api("PUT", "api/settings", {
            source: document.getElementById("source").value,
            boards: JSON.parse(document.getElementById("boards-json").value),
            blueprintStreams: document.getElementById("streams").value.split(",").map((s) => s.trim()).filter(Boolean),
        })
        cards.clear()
        note.textContent = "saved"
        await loadSettings()
    } catch (error) {
        note.textContent = error.message
    }
})
document.getElementById("reset").addEventListener("click", async () => {
    await api("PUT", "api/settings", { reset: true })
    cards.clear()
    await loadSettings()
})

loadSettings().catch(() => {})
refresh()
setInterval(async () => {
    refresh()
    // the watched list can change from the stream table, the settings or an agent (the form keeps what's typed)
    try {
        currentStreams = new Set((await api("GET", "api/settings")).blueprintStreams)
    } catch {
        // the next tick
    }
}, POLL_MS)
