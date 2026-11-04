// M20 Ctrl, laid out like its siblings G1 Ctrl and Go2 Ctrl: the main view (a camera, or the 3D view of the lidar and
// the robot's pose) fills the stage; the board stats, the blueprint and the other view float over it on the left; the
// commands sit in a dock at the bottom; STOP and Record in the top bar. Nothing sits over the video: it has its own box
// (between the panels and the d-pad column on a desktop, between the commands and the thumb sticks on a phone). Driving: keyboard (W/S A/D Q/E, Shift boost,
// Space STOP), the on-screen pad (desktop) or two thumb sticks (phone), and a gamepad, all through drive.ts.
// Board stats, recording, the blueprint and stand / lie down / dock come from the backend (api.ts → backend/routes.ts);
// the live topics (pose, lidar, cameras) and the drive Twist go through Desktop's zenoh-gateway (live.ts).
//   keyboard: W/S forward·back  A/D turn  Q/E strafe  Shift boost  Space STOP  C front/rear camera  V camera/3D
import { useCallback, useEffect, useRef, useState } from "react"
import { type AppState, type Battery, type Board, call, message, type Robot, type Settings } from "./api.ts"
import { CameraCanvas, type CameraStats } from "./camera.ts"
import { type Axes, Drive, type DriveStatus, SPEED_DEFAULTS, SPEED_LIMITS, type Speeds, teleopStream } from "./drive.ts"
import { GAMEPAD_BINDINGS, GamepadDriver, type GamepadStatus, noPad, type PadLike } from "./gamepad.ts"
import { Icon } from "./icons.tsx"
import { type CameraName, type LinkState, Live } from "./live.ts"
import { createScene3D, type Scene3D } from "./scene3d.ts"
import { RecordPanel } from "./RecordPanel.tsx"
import { releaseAllThumbSticks, ThumbStick } from "./ThumbStick.tsx"

const POLL_MS = 1000
const CHART_SECONDS = 120
const KEY_MAP: Record<string, keyof typeof KEY_AXES> = {
    KeyW: "w",
    KeyS: "s",
    KeyA: "a",
    KeyD: "d",
    KeyQ: "q",
    KeyE: "e",
    ArrowUp: "w",
    ArrowDown: "s",
    ArrowLeft: "a",
    ArrowRight: "d",
}
const KEY_AXES = {
    w: { forward: 1 },
    s: { forward: -1 },
    a: { turn: 1 },
    d: { turn: -1 },
    q: { strafe: 1 },
    e: { strafe: -1 },
} as const
const DPAD: { key: keyof typeof KEY_AXES; cls: string; icon: string; help: string }[] = [
    { key: "q", cls: "sl", icon: "arrow-left", help: "strafe left (Q)" },
    { key: "w", cls: "fwd", icon: "arrow-up", help: "forward (W)" },
    { key: "e", cls: "sr", icon: "arrow-right", help: "strafe right (E)" },
    { key: "a", cls: "tl", icon: "rotate-left", help: "turn left (A)" },
    { key: "s", cls: "back", icon: "arrow-down", help: "back (S)" },
    { key: "d", cls: "tr", icon: "rotate-right", help: "turn right (D)" },
]

type Motion = {
    action: "standup" | "liedown" | "dock" | "undock" | "enable" | "direct" | "gait"
    label: string
    rpc: string
    tone: string
    title: string
    warn: string
}
/** Enable driving: what it does in each mode (POST api/drive/enable) */
const enableMotion = (mode: "blueprint" | "direct"): Motion => ({
    action: "enable",
    label: "Enable driving",
    rpc: "",
    tone: "good",
    title: "Put the robot in the state this mode drives in",
    warn: mode === "blueprint"
        ? "Runs <b>m20 stand</b>: the robot <b>STANDS UP</b> into RL control, then navigation control mode and the " +
            "agile stairs gait (steps already done are skipped). It refuses on the dock. Make sure nothing is around its legs."
        : "Runs <b>m20 direct</b>: the robot <b>STANDS UP</b> into RL control, then regular control mode (the one that " +
            "takes direct commands) and the basic gait. Make sure nothing is around its legs.",
})
const DIRECT_SWITCH: Motion = {
    action: "direct",
    label: "Direct mode",
    rpc: "",
    tone: "warn",
    title: "Drive through the robot's basic_server instead of the blueprint",
    warn: "A blueprint is running and drives the robot in <b>navigation</b> control mode. Direct mode drives through " +
        "the robot's own basic_server instead, which needs <b>regular</b> control mode (Enable driving switches it), " +
        "so the blueprint's navigation stops moving the robot. When the next blueprint run starts, M20 Ctrl goes back " +
        "to blueprint mode.",
}
/** the gaits (the vendor guide's, and 0x3004 seen live), short names, and which mode each suits */
const GAITS: { code: number; name: string; short: string; suits: string }[] = [
    { code: 0x1001, name: "basic", short: "Basic", suits: "direct mode (its Enable driving default)" },
    { code: 0x1002, name: "high obstacles", short: "High obstacles", suits: "direct mode, rough ground" },
    { code: 0x1003, name: "stairs (standard)", short: "Stairs", suits: "direct mode, stairs" },
    { code: 0x3002, name: "flat (agile)", short: "Flat (agile)", suits: "blueprint/nav, flat ground" },
    { code: 0x3003, name: "stairs (agile)", short: "Stairs (agile)", suits: "blueprint/nav (its default)" },
    { code: 0x3004, name: "off-road (agile)", short: "Off-road (agile)", suits: "blueprint/nav; undocumented" },
]
const gaitShort = (code: number | undefined, name?: string) => GAITS.find((g) => g.code === code)?.short ?? name ?? "?"

const MOTIONS: Motion[] = [
    {
        action: "standup",
        label: "Stand up",
        rpc: "standup",
        tone: "good",
        title: "Stand up (m20 stand in blueprint mode, m20 direct in direct mode)",
        warn:
            "The robot <b>stands up</b> into RL control, then the control mode and gait this mode drives in (m20 stand " +
            "in blueprint mode, m20 direct in direct mode). Make sure nothing and no one is around its legs.",
    },
    {
        action: "liedown",
        label: "Lie down",
        rpc: "liedown",
        tone: "warn",
        title: "Lie down (M20Connection.liedown): stops driving and lies the robot down",
        warn: "The robot <b>stops and lies down</b> where it is.",
    },
    {
        action: "dock",
        label: "Dock",
        rpc: "dock",
        tone: "warn",
        title: "Dock (M20Connection.dock): walk onto the charging dock in front",
        warn:
            "The robot <b>walks onto the charging dock</b>. It must already stand still about 2 m in front of the dock, " +
            "facing it with both reflectors in view (it can't find the dock from elsewhere).",
    },
    {
        action: "undock",
        label: "Undock",
        rpc: "",
        tone: "warn",
        title: "Undock (m20 undock): leave the dock, then stand up ready for blueprint driving",
        warn: "The robot <b>walks off the charging dock</b>, then <b>stands</b> in RL control, navigation mode (m20 " +
            "undock, then m20 stand). Make sure the way off the dock is clear.",
    },
]

/** motor temperature levels (G1 Ctrl's): warm from 60 °C, hot (the overheat warning) from 75 °C */
const TEMP_WARM = 60
const TEMP_HOT = 75
/** battery levels: warn at 30 %, danger at 15 % */
const BATTERY_WARN = 30
const BATTERY_LOW = 15
/** the vendor's error codes that mean motors or their drivers are too hot (backend/robot.ts OVERHEAT_ERRORS) */
const OVERHEAT_ERRORS = new Set([0x8001, 0x8002, 0x8003, 0x8007, 0x8030])
const LEGS = [["LeftFront", "FL"], ["RightFront", "FR"], ["LeftBack", "BL"], ["RightBack", "BR"]] as const
const JOINT_COLUMNS = ["HipX", "HipY", "Knee", "Wheel"] as const
const tempTone = (celsius: number | null | undefined) =>
    celsius == null ? "" : celsius >= TEMP_HOT ? "danger" : celsius >= TEMP_WARM ? "warn" : "ok"
const batteryTone = (level: number) => (level <= BATTERY_LOW ? "danger" : level <= BATTERY_WARN ? "warn" : "ok")
/** "LeftFrontKnee" → "front-left knee" */
const jointName = (joint: string) =>
    joint.replace(
        /^(Left|Right)(Front|Back)(.*)$/,
        (_, side: string, end: string, part: string) =>
            `${end.toLowerCase()}-${side.toLowerCase()} ${
                part.replace("HipX", "hip (side)").replace("HipY", "hip").toLowerCase()
            }`,
    )

/** a speed's step and its clamp (SPEED_LIMITS) */
const SPEED_STEP = { linear: 0.05, angular: 0.1 }

/** "Driving speed − 0.50 m/s +": one tap per step, clamped to SPEED_LIMITS */
function SpeedStepper(
    { label, value, unit, kind, onChange }: {
        label: string
        value: number
        unit: string
        kind: "linear" | "angular"
        onChange: (value: number) => void
    },
) {
    const [low, high] = SPEED_LIMITS[kind]
    const step = (direction: number) =>
        onChange(Math.min(high, Math.max(low, Math.round((value + direction * SPEED_STEP[kind]) * 100) / 100)))
    return (
        <div className="stepper" data-ui={`speed.${kind}`}>
            <span className="stepper-label">{label}</span>
            <button
                type="button"
                className="dim-btn sm icon"
                data-ui={`speed.${kind}.minus`}
                aria-label={`${label} down`}
                disabled={value <= low}
                onClick={() => step(-1)}
            >
                −
            </button>
            <span className="stepper-value dim-mono">
                {value.toFixed(2)} <small>{unit}</small>
            </span>
            <button
                type="button"
                className="dim-btn sm icon"
                data-ui={`speed.${kind}.plus`}
                aria-label={`${label} up`}
                disabled={value >= high}
                onClick={() => step(1)}
            >
                +
            </button>
        </div>
    )
}

function BatteryRow({ label, battery }: { label: string; battery: Battery }) {
    if (!battery.present) {
        return (
            <>
                <span className="k">{label}</span>
                <span className="v muted">empty bay</span>
            </>
        )
    }
    return (
        <>
            <span className="k">{label}</span>
            <span className={`v ${batteryTone(battery.level)}`}>
                {battery.level}% · {battery.voltage} V ·{" "}
                {battery.celsius.toFixed(0)}°C{battery.charging ? " · charging" : ""}
            </span>
        </>
    )
}

/** The M20's own status: motion, gait, charging, batteries, every joint's motor temperature, errors. */
function RobotCard({ robot }: { robot: Robot }) {
    const b = robot.basic
    const m = robot.motion
    if (robot.link !== "up" && !b) {
        return (
            <div className="note">
                {robot.link === "error"
                    ? robot.error
                    : robot.link === "down"
                    ? `No status reports from basic_server (${robot.host}) — is AOS up?`
                    : `Waiting for basic_server's status reports (${robot.host})…`}
            </div>
        )
    }
    const deg = (rad: number) => `${(rad * 180 / Math.PI).toFixed(1)}°`
    return (
        <>
            {robot.link !== "up" && <div className="note error">Status reports stopped: these are the last ones.</div>}
            <div className="kv">
                <span className="k">motion</span>
                <span className={`v${b?.hardEstop || b?.motion === 2 ? " danger" : ""}`}>
                    {b?.hardEstop ? "HARD E-STOP" : b?.motionName ?? "–"}
                </span>
                <span className="k">gait</span>
                <span className="v">{b?.gaitName ?? "–"}</span>
                <span className="k">control mode</span>
                <span
                    className="v"
                    title="navigation: follows the blueprint's velocity; regular: follows direct (axis) commands"
                >
                    {b?.usage ?? "–"}
                </span>
                <span className="k">charging</span>
                <span className={`v${b?.charge === 4 ? " danger" : ""}`}>{b?.chargeName ?? "–"}</span>
                {robot.battery && <BatteryRow label="battery L" battery={robot.battery.left} />}
                {robot.battery && <BatteryRow label="battery R" battery={robot.battery.right} />}
                <span className="k">height</span>
                <span className="v">{m ? `${m.height.toFixed(2)} m` : "–"}</span>
                <span className="k">roll · pitch</span>
                <span className="v">{m ? `${deg(m.roll)} · ${deg(m.pitch)}` : "–"}</span>
                <span className="k">speed</span>
                <span className="v">{m ? `${m.vx.toFixed(2)} m/s · ${m.wz.toFixed(2)} rad/s` : "–"}</span>
                <span className="k">hottest driver</span>
                <span className={`v ${tempTone(robot.hottestDriver?.celsius)}`}>
                    {robot.hottestDriver ? `${robot.hottestDriver.celsius.toFixed(0)}°C` : "–"}
                </span>
            </div>
            {robot.joints.length > 0 && (
                <div className="motors" title="each joint's motor temperature (°C); hover for its driver's">
                    <span />
                    {JOINT_COLUMNS.map((c) => (
                        <span key={c} className="head">
                            {c === "Knee" || c === "Wheel" ? c.toLowerCase() : c.replace("Hip", "hip ")}
                        </span>
                    ))}
                    {LEGS.map(([leg, short]) => [
                        <span key={leg} className="head">{short}</span>,
                        ...JOINT_COLUMNS.map((column) => {
                            const joint = robot.joints.find((j) =>
                                j.joint === `${leg}${column}`
                            )
                            return (
                                <span
                                    key={`${leg}${column}`}
                                    className={`cell ${tempTone(joint?.motor)}`}
                                    title={`${jointName(`${leg}${column}`)}: motor ${
                                        joint?.motor?.toFixed(1) ?? "?"
                                    }°C, driver ${joint?.driver?.toFixed(1) ?? "?"}°C`}
                                >
                                    {joint?.motor != null ? joint.motor.toFixed(0) : "–"}
                                </span>
                            )
                        }),
                    ])}
                </div>
            )}
            {robot.errors.length > 0 && (
                <div className="errors">
                    {robot.errors.map((e) => (
                        <div key={`${e.code}-${e.component}`} className="robot-error">
                            <span className="dim-mono">{e.hex}</span> {e.name}
                            {e.parts.length ? ` (${e.parts.map(jointName).join(", ")})` : ""}
                        </div>
                    ))}
                </div>
            )}
        </>
    )
}

const LIGHTS = [["network", "Network"], ["stats", "Stats"], ["lidar", "Lidar"], ["dimos", "dimos"]] as const

function loadStored<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : { ...fallback, ...JSON.parse(raw) } as T
    } catch {
        return fallback
    }
}
function store(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        // private mode
    }
}

const underDesktop = location.pathname.startsWith("/apps/")
const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`

function Card(
    { title, meta, collapsed, onToggle, children, className = "" }: {
        title: string
        meta?: React.ReactNode
        collapsed: boolean
        onToggle: () => void
        children: React.ReactNode
        className?: string
    },
) {
    return (
        <div className={`dim-panel glass card ${className}${collapsed ? " collapsed" : ""}`}>
            <h3 className="dim-label" title="click to collapse / expand" onClick={onToggle}>
                <span className="chev">
                    <Icon name="chevron-down" size={10} />
                </span>
                {title}
                {meta !== undefined && <span className="meta">{meta}</span>}
            </h3>
            {children}
        </div>
    )
}

/** One board: its lights, CPU (big number + 2 min chart), temperature and memory; tap for the rest. */
function BoardRow({ board, now }: { board: Board; now: number }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [open, setOpen] = useState(false)
    useEffect(() => {
        const element = canvas.current
        if (!element) {
            return
        }
        const context = element.getContext("2d")!
        const { width, height } = element
        context.clearRect(0, 0, width, height)
        const style = getComputedStyle(document.body)
        const x = (t: number) => width - ((now - t) / 1000 / CHART_SECONDS) * width
        const y = (percent: number) => height - (percent / 100) * (height - 2) - 1
        const history = board.history ?? []
        context.strokeStyle = style.getPropertyValue("--primary").trim() || "#7aa2ff"
        context.lineWidth = 1.5
        context.beginPath()
        let started = false
        for (const h of history) {
            if (h.total === null) {
                started = false
                continue
            }
            started ? context.lineTo(x(h.t), y(h.total)) : context.moveTo(x(h.t), y(h.total))
            started = true
        }
        context.stroke()
    }, [board.history, now])
    const sample = board.latest
    const total = sample?.cpu.total
    const hottest = sample?.temps.length ? sample.temps.reduce((a, b) => (b.celsius > a.celsius ? b : a)) : null
    const hot = hottest ? hottest.celsius >= 80 ? " hot" : hottest.celsius >= 70 ? " warm" : "" : ""
    return (
        <div className={`board${board.stale ? " stale" : ""}`} data-board={board.name}>
            <div className="board-head" onClick={() => setOpen(!open)} title="click for more">
                <span className="board-name">{board.label}</span>
                <span className="lights">
                    {LIGHTS.map(([key, what]) => (
                        <span
                            key={key}
                            className={`light ${board.indicators[key].level}`}
                            title={`${what}: ${board.indicators[key].text}`}
                        >
                            <span className="dot" />
                            {what}
                        </span>
                    ))}
                </span>
            </div>
            <div className="board-body">
                <div className="cpu-big dim-mono">
                    {total === null || total === undefined ? "–" : `${Math.round(total)}%`}
                    <small>{board.stale ? "stale" : "CPU"}</small>
                </div>
                <canvas ref={canvas} width={240} height={34} title={`CPU, last ${CHART_SECONDS} s`} />
                <div className="board-nums dim-mono">
                    <span className={hot} title={hottest ? `hottest: ${hottest.name}` : ""}>
                        {hottest ? `${hottest.celsius.toFixed(0)}°C` : "–"}
                    </span>
                    <span title="memory used">{sample?.mem ? `${sample.mem.percent}% mem` : "–"}</span>
                </div>
            </div>
            {open && (
                <div className="kv board-more">
                    <span className="k">role</span>
                    <span className="v">{board.role ?? "–"}</span>
                    <span className="k">host</span>
                    <span className="v">{board.link.host ?? board.hosts.join(" · ")}</span>
                    {LIGHTS.map(([key, what]) => [
                        <span key={key + "k"} className="k">{what}</span>,
                        <span key={key + "v"} className="v">{board.indicators[key].text}</span>,
                    ])}
                    <span className="k">load</span>
                    <span className="v">{sample?.load ? sample.load.map((v) => v.toFixed(2)).join(" ") : "–"}</span>
                    <span className="k">memory</span>
                    <span className="v">{sample?.mem ? `${sample.mem.usedMb} / ${sample.mem.totalMb} MB` : "–"}</span>
                    <span className="k">uptime</span>
                    <span className="v">{sample?.uptimeS ? `${(sample.uptimeS / 3600).toFixed(1)} h` : "–"}</span>
                    <span className="k">cores</span>
                    <span className="v cores">
                        {(sample?.cpu.cores ?? []).map((percent, i) => (
                            <span
                                key={i}
                                className={`core${(percent ?? 0) >= 85 ? " hot" : ""}`}
                                title={`cpu${i}: ${percent ?? "–"}%`}
                            >
                                <span style={{ height: `${percent ?? 0}%` }} />
                            </span>
                        ))}
                    </span>
                </div>
            )}
        </div>
    )
}

export function App() {
    const [state, setState] = useState<AppState | null>(null)
    const [backendError, setBackendError] = useState<string | null>(null)
    const [settings, setSettings] = useState<Settings | null>(null)
    const [toast, setToast] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<Motion | null>(null)
    const [collapsed, setCollapsed] = useState<Set<string>>(() =>
        new Set(loadStored<{ c: string[] }>("m20.collapsed", { c: ["Streams", "Settings"] }).c)
    )
    const [panelsOpen, setPanelsOpen] = useState(false)
    const [view, setView] = useState(() =>
        loadStored("m20.view", { main: "camera" as "camera" | "map", camera: "front" as CameraName, mini: true })
    )
    const [pipBig, setPipBig] = useState(false)
    const [follow, setFollow] = useState(true)
    const [speeds, setSpeeds] = useState<Speeds>(() => loadStored("m20.speeds", SPEED_DEFAULTS))
    const [dryRun, setDryRun] = useState(false)
    const [driveStatus, setDriveStatus] = useState<DriveStatus | null>(null)
    const [held, setHeld] = useState<Set<string>>(new Set())
    const [pad, setPad] = useState<GamepadStatus>(noPad())
    const [link, setLink] = useState<LinkState>("off")
    const [ready, setReady] = useState<boolean | null>(null)
    const [cameraStats, setCameraStats] = useState<CameraStats>({
        fps: 0,
        width: 0,
        height: 0,
        kind: null,
        error: null,
    })
    const [rates, setRates] = useState({ scan: 0, pose: 0 })
    const [points, setPoints] = useState(0)
    const [busy, setBusy] = useState<string | null>(null)
    const [lastRecording, setLastRecording] = useState("")
    const [recordPanel, setRecordPanel] = useState(false)
    /** the overheat warning, acknowledged until the motors are back under TEMP_WARM and no overheat error remains */
    const [overheatDismissed, setOverheatDismissed] = useState(false)
    const [settingsForm, setSettingsForm] = useState({ source: "ssh", boards: "", note: "" })

    const live = useRef<Live>(null as unknown as Live)
    live.current ??= new Live()
    const drive = useRef<Drive>(null as unknown as Drive)
    drive.current ??= new Drive(live.current)
    const stateRef = useRef<AppState | null>(null)
    stateRef.current = state
    const mainCam = useRef<HTMLCanvasElement>(null)
    const pipCam = useRef<HTMLCanvasElement>(null)
    const mainVideo = useRef<HTMLVideoElement>(null)
    const pipVideo = useRef<HTMLVideoElement>(null)
    const mainMap = useRef<HTMLCanvasElement>(null)
    const pipMap = useRef<HTMLCanvasElement>(null)
    const scene = useRef<Scene3D | null>(null)
    const toastTimer = useRef(0)
    const hintAt = useRef(0)
    const keys = useRef(new Set<string>())
    const topbar = useRef<HTMLDivElement>(null)
    const dock = useRef<HTMLDivElement>(null)

    const showToast = useCallback((text: string) => {
        setToast(text)
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3000)
    }, [])

    // ── the backend: state once a second ──
    const refresh = useCallback(async () => {
        try {
            setState(await call<AppState>("GET", "api/state?history=true"))
            setBackendError(null)
        } catch (error) {
            setBackendError(message(error))
        }
    }, [])
    const loadSettings = useCallback(async () => {
        const next = await call<Settings>("GET", "api/settings")
        setSettings(next)
        setSettingsForm({ source: next.source, boards: JSON.stringify(next.boards, null, 4), note: "" })
    }, [])
    useEffect(() => {
        refresh()
        loadSettings().catch(() => {})
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
    }, [refresh, loadSettings])

    // ── live topics: the fake world with the fake boards, else Desktop's zenoh-gateway ──
    const source = state?.source
    useEffect(() => {
        const l = live.current
        if (source === "fake") {
            l.startFake()
        } else if (source === "ssh" && underDesktop) {
            l.stop()
            l.startZenoh()
        }
    }, [source])
    useEffect(() => {
        const l = live.current
        const stops = [
            l.link.on(setLink),
            l.ready.on((r) => setReady(r.value)),
            l.scan.on((cloud) => {
                scene.current?.setScan(cloud)
                setPoints(cloud.count)
            }),
            l.map.on((cloud) => scene.current?.setMap(cloud)),
            l.pose.on((pose) => scene.current?.setPose(pose)),
            drive.current.onChange(setDriveStatus),
        ]
        const timer = setInterval(() => setRates({ scan: l.rates.scan.hz, pose: l.rates.pose.hz }), 1000)
        return () => {
            stops.forEach((stop) => stop())
            clearInterval(timer)
        }
    }, [])
    useEffect(() => () => {
        drive.current.dispose()
        live.current.stop()
    }, [])

    // ── the 3D view: on whichever canvas shows it (main or the corner card), with the clouds only while it shows ──
    const mapCanvas = view.main === "map" ? mainMap : pipMap
    const pipCollapsed = collapsed.has("View")
    const mapShown = view.main === "map" || !pipCollapsed
    useEffect(() => {
        if (!mapShown || !mapCanvas.current) {
            return
        }
        const s = createScene3D(mapCanvas.current)
        scene.current = s
        s.setFollow(follow)
        const l = live.current
        l.pose.last && s.setPose(l.pose.last)
        l.map.last && s.setMap(l.map.last)
        l.scan.last && s.setScan(l.scan.last)
        const stop = l.watchClouds()
        return () => {
            stop()
            s.dispose()
            scene.current = null
        }
    }, [mapShown, view.main, source])
    useEffect(() => scene.current?.setFollow(follow), [follow])

    // ── the camera: on the main canvas or the corner card ──
    const camCanvas = view.main === "camera" ? mainCam : pipCam
    const camVideo = view.main === "camera" ? mainVideo : pipVideo
    const camShown = view.main === "camera" || !pipCollapsed
    useEffect(() => {
        if (!camShown || !camCanvas.current || !camVideo.current) {
            return
        }
        const canvas = camCanvas.current
        const decoder = new CameraCanvas(canvas, camVideo.current, setCameraStats)
        setCameraStats({ fps: 0, width: 0, height: 0, kind: null, error: null })
        const stop = live.current.watchCamera(view.camera, (frame) => decoder.push(frame))
        return () => {
            stop()
            decoder.close()
            canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
        }
    }, [camShown, view.main, view.camera, source])
    useEffect(() => store("m20.view", view), [view])
    // ── the other camera, small, in the main camera's corner (low resolution and rate, dropped first) ──
    const miniCanvas = useRef<HTMLCanvasElement>(null)
    const miniVideo = useRef<HTMLVideoElement>(null)
    const [miniLive, setMiniLive] = useState(false)
    const otherCamera: CameraName = view.camera === "front" ? "rear" : "front"
    const miniShown = view.main === "camera" && view.mini
    useEffect(() => {
        setMiniLive(false)
        if (!miniShown || !miniCanvas.current || !miniVideo.current) {
            return
        }
        const decoder = new CameraCanvas(miniCanvas.current, miniVideo.current, (stats) => setMiniLive(stats.fps > 0))
        const stop = live.current.watchCamera(otherCamera, (frame) => decoder.push(frame), true)
        return () => {
            stop()
            decoder.close()
        }
    }, [miniShown, otherCamera, source])
    const flipCamera = useCallback(
        () => setView((v) => ({ ...v, camera: v.camera === "front" ? "rear" : "front" })),
        [],
    )
    const swapViews = useCallback(() => setView((v) => ({ ...v, main: v.main === "camera" ? "map" : "camera" })), [])

    // ── where the drive goes ──
    const bp = state?.blueprint ?? null
    const teleop = bp?.running ? teleopStream(bp.streams, bp.connection?.id ?? null) : null
    useEffect(() => {
        const d = drive.current
        if (!state) {
            d.setTarget({ kind: "none", why: "waiting for M20 Ctrl's backend" })
        } else if (state.mode === "direct") {
            d.setTarget({ kind: "direct" })
        } else if (state.source === "fake") {
            d.setTarget({ kind: "fake" })
        } else if (!underDesktop) {
            d.setTarget({
                kind: "none",
                why: "driving goes through Desktop's zenoh-gateway: open M20 Ctrl in DimOS Desktop",
            })
        } else if (!bp?.running) {
            d.setTarget({ kind: "none", why: "no blueprint running: launch m20-nav to drive" })
        } else if (!teleop) {
            d.setTarget({ kind: "none", why: `${bp.blueprint} has no Twist input to drive (tele_cmd_vel)` })
        } else {
            d.setTarget({ kind: "topic", key: teleop.channel!, stream: teleop.name })
        }
    }, [state?.source, state?.mode, bp?.running, teleop?.channel])
    const driving = state?.driving ?? null
    const drivingRef = useRef(driving)
    drivingRef.current = driving
    /** the Enable driving button, flashed when a drive input is refused */
    const [pointAtEnable, setPointAtEnable] = useState(0)
    useEffect(() => {
        drive.current.dryRun = dryRun
    }, [dryRun])
    useEffect(() => {
        drive.current.setSpeeds(speeds)
        store("m20.speeds", speeds)
    }, [speeds])

    /** a drive input: refused (with why) when nothing can be driven */
    const driveInput = useCallback((source: string, axes: Partial<Axes>) => {
        const d = drive.current
        const moving = Object.values(axes).some((v) => v)
        if (moving && d.target.kind === "none") {
            if (Date.now() - hintAt.current > 4000) {
                hintAt.current = Date.now()
                showToast(`Can't drive: ${d.target.why}`)
            }
            return
        }
        // the robot isn't in the state this mode drives in: nothing is sent; point at the fix
        const ready = drivingRef.current
        if (moving && ready && !ready.ok) {
            if (Date.now() - hintAt.current > 2500) {
                hintAt.current = Date.now()
                showToast(`Driving disabled: ${ready.reason}${ready.fixable ? ". Tap Enable driving." : ""}`)
                setPointAtEnable(Date.now())
            }
            return
        }
        if (moving && !d.held && live.current.ready.last?.value === false && Date.now() - hintAt.current > 4000) {
            hintAt.current = Date.now()
            showToast("The robot says it isn't ready for velocity (command_ready false): Stand up first")
        }
        d.setAxes(source, axes)
    }, [showToast])

    // ── STOP: every drive source let go, and M20Connection.stop_movement (a zero velocity) when there is one ──
    const stopAll = useCallback(() => {
        releaseAllThumbSticks()
        keys.current.clear()
        setHeld(new Set())
        drive.current.stop()
        const s = stateRef.current
        if (s?.mode === "blueprint" && s.blueprint?.connection?.rpcs.includes("stop_movement")) {
            call("POST", "api/motion", { action: "stop", dryRun: drive.current.dryRun }).catch((e) =>
                showToast(message(e))
            )
        }
    }, [showToast])

    // ── motion commands (stand up, lie down, dock): always confirmed ──
    const motionBlocked = (m: Motion): string | null => {
        if (!state) {
            return "waiting for the backend"
        }
        const onDock = [1, 2, 3, 5].includes(state.robot.basic?.charge ?? -1)
        if (m.action === "undock") {
            return state.robot.link !== "up"
                ? "no status from the robot's basic_server"
                : onDock
                ? null
                : "not on the dock"
        }
        if (state.mode === "direct" || m.action === "standup") {
            return state.robot.link === "up" ? null : "no status from the robot's basic_server"
        }
        if (!bp?.running) {
            return "no blueprint running"
        }
        if (!bp.connection) {
            return "the running blueprint has no M20Connection"
        }
        if (!bp.connection.rpcs.includes(m.rpc)) {
            return `${bp.connection.id} has no ${m.rpc} RPC`
        }
        return null
    }
    const [gaitBusy, setGaitBusy] = useState<number | null>(null)
    /** Changes the gait (POST api/gait, confirmed by the robot's report); asks first while the robot moves. */
    const changeGait = async (code: number, ask: boolean) => {
        const target = GAITS.find((g) => g.code === code)
        if (!target) {
            return
        }
        const m = state?.robot.motion
        const movingNow = drive.current.status.moving ||
            (!!m && (Math.abs(m.vx) > 0.05 || Math.abs(m.vy) > 0.05 || Math.abs(m.wz) > 0.05))
        if (ask && movingNow) {
            setConfirm({
                action: "gait",
                label: `Gait: ${target.short}`,
                rpc: String(code),
                tone: "warn",
                title: "",
                warn:
                    `The robot is <b>moving</b>. Changing its gait now changes how it walks mid-stride. Suits: ${target.suits}.`,
            })
            return
        }
        setGaitBusy(code)
        try {
            const result = await call<
                { ok?: boolean; result?: string; error?: string; dryRun?: boolean; wouldDo?: string[] }
            >(
                "POST",
                "api/gait",
                { gait: code, dryRun },
            )
            showToast(
                result.dryRun
                    ? `Dry run: would ${result.wouldDo?.join(", ")}`
                    : result.ok
                    ? `Gait: ${target.short} (confirmed by the robot)`
                    : `Gait ${target.short} failed: ${result.error}`,
            )
        } catch (error) {
            showToast(`Gait: ${message(error)}`)
        } finally {
            setGaitBusy(null)
            refresh()
        }
    }
    const runMotion = async (m: Motion) => {
        if (m.action === "direct") {
            await call("PUT", "api/mode", { mode: "direct" }).catch((e) => showToast(message(e)))
            refresh()
            return
        }
        if (m.action === "gait") {
            await changeGait(Number(m.rpc), false)
            return
        }
        setBusy(m.action)
        try {
            const result = await call<
                { ok?: boolean; result?: unknown; error?: string; dryRun?: boolean; wouldCall?: string }
            >(
                "POST",
                m.action === "enable" ? "api/drive/enable" : "api/motion",
                m.action === "enable" ? { dryRun } : { action: m.action, dryRun },
            )
            showToast(
                result.dryRun
                    ? `Dry run: would ${
                        result.wouldCall
                            ? `call ${result.wouldCall}`
                            : (result as { wouldDo?: string[] }).wouldDo?.join(", ")
                    }`
                    : result.ok
                    ? `${m.label}: ${typeof result.result === "string" ? result.result : JSON.stringify(result.result)}`
                    : `${m.label} failed: ${result.error}`,
            )
        } catch (error) {
            showToast(`${m.label}: ${message(error)}`)
        } finally {
            setBusy(null)
        }
    }

    // ── keyboard ──
    useEffect(() => {
        const typing = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")
        }
        const update = () => {
            const axes = { forward: 0, strafe: 0, turn: 0 }
            for (const key of keys.current) {
                Object.assign(
                    axes,
                    Object.fromEntries(
                        Object.entries(KEY_AXES[key as keyof typeof KEY_AXES]).map((
                            [k, v],
                        ) => [k, axes[k as keyof Axes] + v]),
                    ),
                )
            }
            setHeld(new Set(keys.current))
            driveInput("keys", axes)
        }
        const down = (e: KeyboardEvent) => {
            if (e.code === "Escape" && confirm) {
                e.preventDefault()
                e.stopImmediatePropagation()
                setConfirm(null)
                return
            }
            if (typing(e) || e.altKey || e.ctrlKey || e.metaKey) {
                return
            }
            if (e.code === "Space") {
                e.preventDefault()
                stopAll()
                return
            }
            if (confirm) {
                return // nothing drives under a dialog
            }
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
                drive.current.setBoost(1)
                return
            }
            if (e.code === "KeyC" && !e.repeat) {
                flipCamera()
                return
            }
            if (e.code === "KeyV" && !e.repeat) {
                swapViews()
                return
            }
            const key = KEY_MAP[e.code]
            if (key) {
                e.preventDefault()
                if (!keys.current.has(key)) {
                    keys.current.add(key)
                    update()
                }
            }
        }
        const up = (e: KeyboardEvent) => {
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
                drive.current.setBoost(0)
                return
            }
            const key = KEY_MAP[e.code]
            if (key && keys.current.delete(key)) {
                update()
            }
        }
        // focus gone mid-drive: let go of everything
        const blur = () => {
            keys.current.clear()
            setHeld(new Set())
            drive.current.setAxes("keys", {})
            drive.current.setBoost(0)
        }
        addEventListener("keydown", down, true)
        addEventListener("keyup", up)
        addEventListener("blur", blur)
        return () => {
            removeEventListener("keydown", down, true)
            removeEventListener("keyup", up)
            removeEventListener("blur", blur)
        }
    }, [confirm, stopAll, driveInput, flipCamera, swapViews])

    // ── gamepad (Go2 Ctrl's driver: nothing drives until the sticks are seen at rest; LT+RT or B = STOP) ──
    useEffect(() => {
        if (!navigator.getGamepads) {
            return
        }
        const driver = new GamepadDriver({
            setAxes: (axes) => driveInput("gamepad", axes),
            setBoost: (boost) => drive.current.setBoost(boost),
            stop: stopAll,
            sitDown: stopAll,
        }, setPad)
        const timer = setInterval(() => {
            if (document.hidden || !document.hasFocus()) {
                driver.release()
            } else {
                driver.poll([...navigator.getGamepads()] as (PadLike | null)[], performance.now())
            }
        }, 16)
        return () => {
            clearInterval(timer)
            driver.release()
        }
    }, [driveInput, stopAll])

    // the bar wraps on a phone: the dock and the tools under it follow its height
    useEffect(() => {
        const sync = () => {
            const root = document.documentElement.style
            root.setProperty("--topbar-h", Math.ceil(topbar.current!.getBoundingClientRect().height) + "px")
            root.setProperty("--dock-h", Math.ceil(dock.current!.getBoundingClientRect().height) + "px")
        }
        const observer = new ResizeObserver(sync)
        observer.observe(topbar.current!)
        observer.observe(dock.current!)
        sync()
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        const sync = () => setPanelsOpen(false)
        addEventListener("orientationchange", sync)
        return () => removeEventListener("orientationchange", sync)
    }, [])

    const toggleCard = (title: string) => {
        setCollapsed((current) => {
            const next = new Set(current)
            if (!next.delete(title)) {
                next.add(title)
            }
            store("m20.collapsed", { c: [...next] })
            return next
        })
    }

    // ── record ──
    const record = state?.record
    const toggleRecord = async () => {
        try {
            if (record?.active) {
                const stopped = await call<{ file?: string }>("POST", "api/record/stop")
                setLastRecording(stopped.file ?? "")
                showToast(`Saved ${stopped.file ?? "the recording"}`)
            } else {
                await call("POST", "api/record/start")
            }
        } catch (error) {
            showToast(`Recording: ${message(error)}`)
        }
        refresh()
    }

    const setMode = async (mode: "blueprint" | "direct") => {
        if (mode === "direct" && state?.mode !== "direct" && bp?.running) {
            setConfirm(DIRECT_SWITCH)
            return
        }
        await call("PUT", "api/mode", { mode }).catch((e) => showToast(message(e)))
        refresh()
    }
    const toggleWatch = async (name: string, watched: boolean) => {
        const streams = new Set(settings?.blueprintStreams ?? [])
        watched ? streams.add(name) : streams.delete(name)
        await call("PUT", "api/settings", { blueprintStreams: [...streams] }).catch((e) => showToast(message(e)))
        loadSettings()
    }
    const saveSettings = async (reset = false) => {
        try {
            await call(
                "PUT",
                "api/settings",
                reset ? { reset: true } : { source: settingsForm.source, boards: JSON.parse(settingsForm.boards) },
            )
            await loadSettings()
            setSettingsForm((f) => ({ ...f, note: "saved" }))
            refresh()
        } catch (error) {
            setSettingsForm((f) => ({ ...f, note: message(error) }))
        }
    }

    // ── what's shown ──
    const target = drive.current.target
    const fake = state?.source === "fake"
    const linkLabel = fake
        ? "Simulated"
        : !underDesktop
        ? "No Desktop"
        : link === "connected"
        ? "Live"
        : link === "off"
        ? "Off"
        : link
    const linkTone = fake ? "warn" : link === "connected" ? "ok" : link === "lost" || !underDesktop ? "danger" : "info"
    const twist = driveStatus?.twist ?? { x: 0, y: 0, yaw: 0 }
    const moving = !!driveStatus?.moving
    const cameraLive = cameraStats.fps > 0
    const cameraPlaceholder = !underDesktop && !fake
        ? "The cameras come through DimOS Desktop's zenoh-gateway: open M20 Ctrl in Desktop."
        : cameraStats.error ??
            `Waiting for the ${view.camera} camera (dimos/${view.camera}_camera_image, JPEG, or dimos/${view.camera}_camera, H.265)…`
    const watched = new Set(settings?.blueprintStreams ?? [])
    const hotBoard = state?.boards.some((b) => b.indicators.network.level === "bad")
    const robot = state?.robot ?? null
    const robotUp = robot?.link === "up"
    const hotMotor = robotUp ? robot?.hottestMotor ?? null : null
    const packs = robot?.battery ? [robot.battery.left, robot.battery.right].filter((p) => p.present) : []
    const lowestPack = packs.length ? Math.min(...packs.map((p) => p.level)) : null
    const charging = robot?.basic?.charge === 2 || packs.some((p) => p.charging)
    const estop = robotUp && (robot?.basic?.hardEstop || robot?.basic?.motion === 2)
    const overheatErrors = robotUp ? (robot?.errors ?? []).filter((e) => OVERHEAT_ERRORS.has(e.code)) : []
    const overheating = (hotMotor?.celsius ?? 0) >= TEMP_HOT || overheatErrors.length > 0
    const cooled = (hotMotor?.celsius ?? 0) < TEMP_WARM && overheatErrors.length === 0
    useEffect(() => {
        if (cooled) {
            setOverheatDismissed(false)
        }
    }, [cooled])

    const cameraSwitch = (
        <div className="cam-switch seg" role="group" aria-label="camera">
            {(["front", "rear"] as const).map((name) => (
                <button
                    key={name}
                    type="button"
                    data-ui={`camera.${name}`}
                    className={`dim-btn sm${view.camera === name ? " on" : ""}`}
                    title={`${name} camera (C switches)`}
                    onClick={() => setView((v) => ({ ...v, camera: name }))}
                >
                    {name === "front" ? "Front" : "Rear"}
                </button>
            ))}
        </div>
    )
    const mapTools = (compact: boolean) => (
        <>
            <span className="m">
                {points
                    ? `${(points / 1000).toFixed(1)}k pts${compact ? "" : ` · ${rates.scan.toFixed(0)} Hz`}`
                    : "no lidar yet"}
            </span>
            <button
                type="button"
                className={`dim-btn sm ghost${follow ? " on" : ""}`}
                title="keep the view on the robot"
                onClick={() => setFollow(!follow)}
            >
                Follow
            </button>
            {!compact && (
                <button
                    type="button"
                    className="dim-btn sm ghost"
                    title="back behind the robot"
                    onClick={() => scene.current?.recenter()}
                >
                    Recenter
                </button>
            )}
        </>
    )

    const driveOff = !!driving && !driving.ok && (driving.known || state?.mode === "direct")
    const driveBanner = (where: "side" | "phone") =>
        driveOff && driving
            ? (
                <div className={`drive-off-banner ${where}`} data-ui="drive.disabled" role="status">
                    <span>
                        <b>Driving disabled:</b> {driving.reason}
                    </span>
                    {driving.fixable && state && (
                        <button
                            type="button"
                            key={pointAtEnable}
                            className={`dim-btn sm good${Date.now() - pointAtEnable < 3000 ? " point" : ""}`}
                            data-ui="drive.enable"
                            onClick={() => setConfirm(enableMotion(state.mode))}
                        >
                            Enable driving
                        </button>
                    )}
                </div>
            )
            : null

    return (
        <div className={`stage${fake ? " fake" : ""}${driveOff ? " drive-off" : ""}`}>
            {/* the main view */}
            <div className={`main-view ${view.main}${view.main === "camera" && cameraLive ? " live" : ""}`}>
                <div className="cam-box" style={{ display: view.main === "camera" ? undefined : "none" }}>
                    <video ref={mainVideo} className="cam-video" autoPlay muted playsInline disablePictureInPicture />
                    <canvas ref={mainCam} className="cam-canvas" />
                </div>
                {/* the other camera, small, top-left: tap to swap; × hides it (the bar's Mini brings it back) */}
                {miniShown && (
                    <div
                        className={`cam-mini${miniLive ? " live" : ""}`}
                        data-ui="camera.mini"
                        title={`the ${otherCamera} camera: tap to make it the main one`}
                        onClick={flipCamera}
                    >
                        <div className="cam-box">
                            <video ref={miniVideo} autoPlay muted playsInline disablePictureInPicture />
                            <canvas ref={miniCanvas} />
                        </div>
                        <span className="cam-mini-label">{otherCamera === "front" ? "Front" : "Rear"}</span>
                        <button
                            type="button"
                            className="cam-mini-hide"
                            data-ui="camera.mini.hide"
                            aria-label="hide the small camera"
                            title="hide the small camera"
                            onClick={(e) => {
                                e.stopPropagation()
                                setView((v) => ({ ...v, mini: false }))
                            }}
                        >
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                )}
                <canvas
                    ref={mainMap}
                    className="map-canvas"
                    style={{ display: view.main === "map" ? undefined : "none" }}
                />
                {view.main === "camera" && !cameraLive && (
                    <div className="cam-ph">
                        <div className="glyph">
                            <Icon name="camera" size={46} />
                        </div>
                        <div>{cameraPlaceholder}</div>
                    </div>
                )}
            </div>
            <div className="vignette" />

            <div className="topbar" ref={topbar}>
                <button
                    type="button"
                    className="dim-btn icon ghost panels-btn"
                    title="show/hide the panels"
                    aria-label="panels"
                    onClick={() => setPanelsOpen((open) => !open)}
                >
                    <Icon name="menu" />
                </button>
                {window.parent === window && (
                    <div className="brand">
                        <Icon name="dog" size={24} />
                        <span className="dim-title name">M20 Ctrl</span>
                    </div>
                )}
                <div
                    className={`dim-badge pill ${linkTone}`}
                    title={fake
                        ? "Simulated: fake boards and a simulated robot (Settings → source). Nothing goes to the M20."
                        : "the live topics (Desktop's zenoh-gateway)"}
                >
                    <span className="dot" />
                    <span>{linkLabel}</span>
                </div>
                <div
                    className={`dim-badge pill hide-phone ${
                        bp?.running ? "ok" : state?.mode === "direct" ? "" : "warn"
                    }`}
                    title={bp?.error ?? (bp?.running ? `running ${bp.blueprint}` : "no blueprint running")}
                >
                    <span className="dot" />
                    <span className="dim-mono">
                        {state?.mode === "direct" ? "Direct mode" : bp?.running ? bp.blueprint : "No blueprint"}
                    </span>
                </div>
                {ready !== null && (
                    <div
                        className={`dim-badge pill hide-phone ${ready ? "ok" : "warn"}`}
                        title="M20 command_ready: whether the robot takes velocity commands (Stand up makes it ready)"
                    >
                        <span className="dot" />
                        <span>{ready ? "Ready to drive" : "Not ready"}</span>
                    </div>
                )}
                {dryRun && <span className="dim-badge warn">Dry run</span>}
                {estop && (
                    <span
                        className="dim-badge pill danger"
                        title="the M20 reports an e-stop: it won't move until it's released"
                    >
                        <span className="dot" />
                        {robot?.basic?.hardEstop ? "HARD E-STOP" : "Soft e-stop"}
                    </span>
                )}
                {lowestPack !== null && robotUp && (
                    <span
                        className={`dim-badge dim-mono pill ${batteryTone(lowestPack)}`}
                        title={`battery: ${
                            robot!.battery!.left.present ? `left ${robot!.battery!.left.level}%` : "left bay empty"
                        }, ${
                            robot!.battery!.right.present ? `right ${robot!.battery!.right.level}%` : "right bay empty"
                        }${charging ? ", charging" : ""}`}
                    >
                        <span className="dot" />
                        {packs.length === 2
                            ? (
                                <>
                                    <span className="hide-phone">
                                        {robot!.battery!.left.level}% · {robot!.battery!.right.level}%
                                    </span>
                                    <span className="show-phone">{lowestPack}%</span>
                                </>
                            )
                            : `${lowestPack}%`}
                        {charging ? " ⚡" : ""}
                    </span>
                )}
                {robotUp && robot?.basic && (
                    <span
                        className={`dim-badge pill hide-phone ${driving?.ok ? "ok" : "warn"}`}
                        title={`the robot's control mode: ${robot.basic.usage} (blueprint mode drives in navigation, direct mode in regular)`}
                    >
                        <span className="dot" />
                        {robot.basic.usage === "navigation"
                            ? "Nav mode"
                            : `${robot.basic.usage[0].toUpperCase()}${robot.basic.usage.slice(1)} mode`}
                    </span>
                )}
                {robotUp && robot?.basic && (
                    <span
                        className="dim-badge pill gait-badge"
                        data-ui="gait.current"
                        title={`the robot's gait: ${robot.basic.gaitName} (suits ${
                            GAITS.find((g) => g.code === robot.basic!.gait)?.suits ?? "?"
                        })`}
                    >
                        {gaitShort(robot.basic.gait, robot.basic.gaitName)}
                    </span>
                )}
                {hotMotor && (
                    <span
                        className={`dim-badge dim-mono pill hide-phone ${tempTone(hotMotor.celsius)}`}
                        title={`the hottest motor: ${
                            jointName(hotMotor.joint)
                        } (warm from ${TEMP_WARM}°C, hot from ${TEMP_HOT}°C)`}
                    >
                        <span className="dot" />
                        {hotMotor.celsius.toFixed(0)}°C
                    </span>
                )}
                <PadChip pad={pad} />
                <div className="spacer" />
                <button
                    type="button"
                    data-ui="record"
                    className={`dim-btn sm rec-btn${record?.active ? " on" : ""}`}
                    title={record?.active
                        ? `Recording to ${record.file}: click to stop and save it`
                        : "Record to an .mcap: the cameras, lidar, pose, tf, driving, robot status and board stats (⋯ picks)"}
                    onClick={toggleRecord}
                >
                    <span className="rec-dot" />
                    {record?.active
                        ? (
                            <>
                                <span className="hide-phone">Stop ·{" "}</span>
                                {clock(record.seconds)}
                                <span className="hide-phone">{" "}· {megabytes(record.bytes)}</span>
                            </>
                        )
                        : <span className="hide-phone">Record</span>}
                </button>
                <button
                    type="button"
                    data-ui="record.options"
                    className={`dim-btn sm icon rec-more${recordPanel ? " on" : ""}`}
                    title="Recording options and past recordings"
                    aria-label="Recording options"
                    aria-expanded={recordPanel}
                    onClick={() => setRecordPanel(!recordPanel)}
                >
                    <Icon name="more" size={14} />
                </button>
                <button
                    type="button"
                    data-ui="stop"
                    className="dim-btn danger estop"
                    title="STOP (Space): every drive input let go, zero velocity"
                    onClick={stopAll}
                >
                    STOP
                </button>
            </div>

            {(backendError || fake) && (
                <div className={`banner ${backendError ? "danger" : "warn"}`}>
                    {backendError
                        ? `M20 Ctrl's backend: ${backendError}`
                        : "Simulated: fake boards and a simulated robot (Settings → source). Nothing goes to the M20."}
                </div>
            )}

            {recordPanel && <RecordPanel record={record} onClose={() => setRecordPanel(false)} onToast={showToast} />}

            <div className={`left-col${panelsOpen ? " open" : ""}`}>
                <div className="rail">
                    <Card
                        title="Robot"
                        meta={robot?.link === "up"
                            ? robot.basic?.motionName
                            : robot?.link === "down"
                            ? "no reports"
                            : robot?.link ?? undefined}
                        collapsed={collapsed.has("Robot")}
                        onToggle={() => toggleCard("Robot")}
                    >
                        {robot ? <RobotCard robot={robot} /> : <div className="muted">Waiting for the backend…</div>}
                    </Card>

                    <Card
                        title="Boards"
                        meta={hotBoard ? "unreachable" : undefined}
                        collapsed={collapsed.has("Boards")}
                        onToggle={() => toggleCard("Boards")}
                    >
                        <div className="boards">
                            {state?.boards.map((board) => <BoardRow key={board.name} board={board} now={state.now} />)}
                            {!state && <div className="muted">Waiting for the backend…</div>}
                        </div>
                    </Card>

                    <Card
                        title="Blueprint"
                        meta={state?.mode === "direct" ? "direct" : bp?.running ? "running" : "none"}
                        collapsed={collapsed.has("Blueprint")}
                        onToggle={() => toggleCard("Blueprint")}
                    >
                        <div className="seg mode-switch" role="group" aria-label="mode">
                            <button
                                type="button"
                                data-ui="mode.blueprint"
                                className={`dim-btn sm${state?.mode === "blueprint" ? " on" : ""}`}
                                title="Watch, record and command the running dimos blueprint"
                                onClick={() => setMode("blueprint")}
                            >
                                Blueprint
                            </button>
                            <button
                                type="button"
                                data-ui="mode.direct"
                                className={`dim-btn sm${state?.mode === "direct" ? " on" : ""}`}
                                title="Boards only: no blueprint, no motion"
                                onClick={() => setMode("direct")}
                            >
                                Direct
                            </button>
                        </div>
                        <div className="kv">
                            <span className="k">blueprint</span>
                            <span className="v">
                                {bp?.running ? bp.blueprint : "none"}
                            </span>
                            <span className="k">connection</span>
                            <span className="v">{bp?.connection?.id ?? "–"}</span>
                            <span className="k">drive topic</span>
                            <span className="v" title={target.kind === "none" ? target.why : ""}>
                                {target.kind === "topic"
                                    ? target.stream
                                    : target.kind === "direct"
                                    ? "basic_server"
                                    : target.kind === "fake"
                                    ? "simulated"
                                    : "none"}
                            </span>
                            <span className="k">pose</span>
                            <span className="v">{rates.pose ? `${rates.pose.toFixed(0)} Hz` : "–"}</span>
                            <span className="k">camera</span>
                            <span className="v">
                                {cameraLive
                                    ? `${cameraStats.fps} fps · ${cameraStats.width}×${cameraStats.height} ${
                                        cameraStats.kind === "jpeg"
                                            ? "JPEG"
                                            : cameraStats.kind === "stream"
                                            ? "video"
                                            : "H.265"
                                    }`
                                    : "–"}
                            </span>
                        </div>
                        {bp?.error && <div className="note error">{bp.error}</div>}
                        {state?.mode === "direct" && <div className="note">{state.directMotion}</div>}
                    </Card>

                    <Card title="Speed" collapsed={collapsed.has("Speed")} onToggle={() => toggleCard("Speed")}>
                        <div className="speed">
                            <div className="speed-foot">
                                <span>Shift / LT boosts ×1.6</span>
                                <label className="dry">
                                    <input
                                        type="checkbox"
                                        data-ui="dry_run"
                                        checked={dryRun}
                                        onChange={(e) => setDryRun(e.target.checked)}
                                    />
                                    dry run
                                </label>
                                <button type="button" onClick={() => setSpeeds(SPEED_DEFAULTS)}>reset</button>
                            </div>
                        </div>
                    </Card>

                    {bp?.running && (
                        <Card
                            title="Streams"
                            meta={`${bp.streams.length}`}
                            collapsed={collapsed.has("Streams")}
                            onToggle={() => toggleCard("Streams")}
                        >
                            <div className="note">
                                Ticked streams are sampled once a second, shown here and recorded.
                            </div>
                            <div className="streams">
                                {bp.streams.map((stream) => {
                                    const peeked = bp.peeked?.[stream.name]
                                    return (
                                        <label
                                            key={`${stream.module}.${stream.name}.${stream.direction}`}
                                            className="stream"
                                            title={`${stream.module} · ${stream.type} · ${stream.direction}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={watched.has(stream.name)}
                                                onChange={(e) => toggleWatch(stream.name, e.target.checked)}
                                            />
                                            <span className="dim-mono">{stream.name}</span>
                                            <span className="dim-mono muted">{stream.type.split(".").pop()}</span>
                                            {peeked && (
                                                <span className="dim-mono val">{JSON.stringify(peeked.value)}</span>
                                            )}
                                        </label>
                                    )
                                })}
                            </div>
                        </Card>
                    )}

                    <Card
                        title="Settings"
                        collapsed={collapsed.has("Settings")}
                        onToggle={() => toggleCard("Settings")}
                    >
                        <div className="settings">
                            <label>
                                Board stats from
                                <select
                                    className="dim-input"
                                    data-ui="settings.source"
                                    value={settingsForm.source}
                                    onChange={(e) => setSettingsForm({ ...settingsForm, source: e.target.value })}
                                >
                                    <option value="ssh">ssh (the real boards)</option>
                                    <option value="fake">fake boards (simulated)</option>
                                </select>
                            </label>
                            <label>
                                Boards (ssh targets, tried in order)
                                <textarea
                                    className="dim-input dim-mono"
                                    rows={8}
                                    value={settingsForm.boards}
                                    onChange={(e) => setSettingsForm({ ...settingsForm, boards: e.target.value })}
                                />
                            </label>
                            <div className="row">
                                <button
                                    type="button"
                                    className="dim-btn sm"
                                    data-ui="settings.save"
                                    onClick={() => saveSettings()}
                                >
                                    Save
                                </button>
                                <button type="button" className="dim-btn sm ghost" onClick={() => saveSettings(true)}>
                                    Defaults
                                </button>
                                <span className="muted">
                                    {settingsForm.note || (lastRecording && `last recording: ${lastRecording}`)}
                                </span>
                            </div>
                            <div className="note">
                                Keys: W/S forward·back, A/D turn, Q/E strafe, Shift boost, Space STOP, C front/rear
                                camera, V camera/3D. Gamepad:{" "}
                                {GAMEPAD_BINDINGS.map(([b, a]) => `${b}: ${a}`).join("; ")}.
                            </div>
                        </div>
                    </Card>
                </div>

                {/* the other view: the 3D map under a camera, or the camera under the map */}
                <div
                    className={`dim-panel glass card view-card${pipBig ? " big" : ""}${
                        pipCollapsed ? " collapsed" : ""
                    }`}
                >
                    <div className="view-head">
                        <h3 className="dim-label" title="click to collapse / expand" onClick={() => toggleCard("View")}>
                            <span className="chev">
                                <Icon name="chevron-down" size={10} />
                            </span>
                            {view.main === "camera" ? "3D" : "Camera"}
                        </h3>
                        {view.main === "camera" ? mapTools(true) : cameraSwitch}
                        <button
                            type="button"
                            className="dim-btn icon ghost expand"
                            title="swap with the main view (V)"
                            aria-label="swap"
                            onClick={swapViews}
                        >
                            <Icon name="swap" />
                        </button>
                        <button
                            type="button"
                            className={`dim-btn icon ghost expand${pipBig ? " on" : ""}`}
                            title={pipBig ? "Shrink" : "Expand"}
                            aria-label="Expand"
                            onClick={() => setPipBig((big) => !big)}
                        >
                            <Icon name={pipBig ? "shrink" : "expand"} />
                        </button>
                    </div>
                    <canvas
                        ref={pipMap}
                        className="map-canvas"
                        style={{ display: view.main === "camera" ? undefined : "none" }}
                    />
                    <div className="cam-box" style={{ display: view.main === "map" ? undefined : "none" }}>
                        <video
                            ref={pipVideo}
                            className="cam-video"
                            autoPlay
                            muted
                            playsInline
                            disablePictureInPicture
                        />
                        <canvas ref={pipCam} className="cam-canvas" />
                    </div>
                </div>
            </div>

            {/* over the main view: which camera / the 3D tools, and the swap */}
            <div className="main-tools">
                {view.main === "camera"
                    ? cameraSwitch
                    : <div className="dim-panel glass map-tools">{mapTools(false)}</div>}
                {view.main === "camera" && (
                    <button
                        type="button"
                        className={`dim-btn sm view-swap${view.mini ? " on" : ""}`}
                        data-ui="camera.mini.toggle"
                        aria-pressed={view.mini}
                        title={view.mini
                            ? "hide the small picture of the other camera"
                            : "show the other camera, small, in the corner"}
                        onClick={() => setView((v) => ({ ...v, mini: !v.mini }))}
                    >
                        Mini
                    </button>
                )}
                <button
                    type="button"
                    className="dim-btn sm view-swap"
                    data-ui="view.swap"
                    title="camera / 3D (V)"
                    onClick={swapViews}
                >
                    <Icon name={view.main === "camera" ? "cube" : "camera"} size={14} />
                    {view.main === "camera" ? "3D" : "Camera"}
                </button>
            </div>

            {/* desktop: the speeds beside the video, over the readout and the pad */}
            {driveBanner("side")}
            <div className="side-speeds dim-panel glass">
                <SpeedStepper
                    label="Driving speed"
                    value={speeds.linear}
                    unit="m/s"
                    kind="linear"
                    onChange={(linear) => setSpeeds((now) => ({ ...now, linear }))}
                />
                <SpeedStepper
                    label="Turning speed"
                    value={speeds.angular}
                    unit="rad/s"
                    kind="angular"
                    onChange={(angular) => setSpeeds((now) => ({ ...now, angular }))}
                />
            </div>

            <div className={`dim-panel glass dim-mono vel${moving ? " on" : ""}`}>
                <div className="row">
                    <span>vx</span>
                    <span>{twist.x.toFixed(2)}</span>
                </div>
                <div className="row">
                    <span>vy</span>
                    <span>{twist.y.toFixed(2)}</span>
                </div>
                <div className="row">
                    <span>ω</span>
                    <span>{twist.yaw.toFixed(2)}</span>
                </div>
                <div className="row muted" title={target.kind === "none" ? target.why : ""}>
                    <span>
                        {dryRun
                            ? "dry run"
                            : target.kind === "topic"
                            ? target.stream
                            : target.kind === "direct"
                            ? "basic_server"
                            : target.kind === "fake"
                            ? "simulated"
                            : "can't drive"}
                    </span>
                    <span>{driveStatus?.publishing ? "●" : ""}</span>
                </div>
            </div>

            {/* desktop: the d-pad, shaped like Q W E / A S D */}
            <div className="dpad">
                {DPAD.map(({ key, cls, icon, help }) => (
                    <button
                        key={key}
                        type="button"
                        data-ui={`dpad.${cls}`}
                        className={`dim-btn icon db ${cls}${held.has(key) ? " held" : ""}${
                            target.kind === "none" ? " blocked" : ""
                        }`}
                        title={target.kind === "none" ? target.why ?? help : help}
                        onPointerDown={(e) => {
                            e.preventDefault()
                            e.currentTarget.setPointerCapture?.(e.pointerId)
                            keys.current.add(key)
                            setHeld(new Set(keys.current))
                            driveInput("dpad", KEY_AXES[key])
                        }}
                        onPointerUp={() => {
                            keys.current.delete(key)
                            setHeld(new Set(keys.current))
                            drive.current.setAxes("dpad", {})
                        }}
                        onPointerCancel={() => {
                            keys.current.delete(key)
                            setHeld(new Set(keys.current))
                            drive.current.setAxes("dpad", {})
                        }}
                    >
                        <Icon name={icon} />
                    </button>
                ))}
            </div>

            {/* phone: two thumbs (left moves, right turns) with STOP between */}
            <div className="sticks">
                {/* the speeds, over each thumb: − / + (saved on this device) */}
                {driveBanner("phone")}
                <div className="stick-speeds">
                    <SpeedStepper
                        label="speed"
                        value={speeds.linear}
                        unit="m/s"
                        kind="linear"
                        onChange={(linear) => setSpeeds((now) => ({ ...now, linear }))}
                    />
                    <SpeedStepper
                        label="turn"
                        value={speeds.angular}
                        unit="rad/s"
                        kind="angular"
                        onChange={(angular) => setSpeeds((now) => ({ ...now, angular }))}
                    />
                </div>
                <ThumbStick
                    className="stick-zone left"
                    label="move"
                    data-ui="stick.left"
                    onMove={(x, y) => driveInput("left-stick", { forward: y, strafe: -x })}
                />
                <div className="stick-middle">
                    {/* the velocity, between the thumbs (never over the video) */}
                    <div
                        className={`vel-mini dim-mono${moving ? " on" : ""}`}
                        title={target.kind === "none" ? target.why : ""}
                    >
                        <span>vx {twist.x.toFixed(2)}</span>
                        <span>vy {twist.y.toFixed(2)}</span>
                        <span>ω {twist.yaw.toFixed(2)}</span>
                        <span className="muted">
                            {dryRun
                                ? "dry run"
                                : target.kind === "topic"
                                ? target.stream
                                : target.kind === "direct"
                                ? "basic_server"
                                : target.kind === "fake"
                                ? "simulated"
                                : "can't drive"}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="dim-btn sm cam-flip"
                        data-ui="camera.flip"
                        onClick={flipCamera}
                        title="front / rear camera"
                    >
                        <Icon name="camera" size={14} />
                        {view.camera === "front" ? "Front" : "Rear"}
                    </button>
                    <button
                        type="button"
                        className="dim-btn danger stick-stop"
                        data-ui="stick.stop"
                        onPointerDown={(e) => {
                            e.preventDefault()
                            stopAll()
                        }}
                    >
                        STOP
                    </button>
                </div>
                <ThumbStick
                    className="stick-zone right"
                    label="turn"
                    axes="x"
                    data-ui="stick.right"
                    onMove={(x) => driveInput("right-stick", { turn: -x })}
                />
            </div>

            <div className="dock" ref={dock}>
                {robotUp && robot?.basic && (
                    <span
                        className={`dim-badge mode-badge hide-phone ${
                            estop ? "danger" : robot.basic.motion === 1 || robot.basic.motion === 17 ? "ok" : ""
                        }`}
                        title="the M20's motion state and gait (its own status report)"
                    >
                        {robot.basic.motionName}
                    </span>
                )}
                {robotUp && robot?.basic && (
                    <label className="gait-pick" title="the robot's gait (confirmed by its own report)">
                        <span className="hide-phone">Gait</span>
                        <select
                            className="dim-select"
                            data-ui="gait.pick"
                            value={gaitBusy ?? robot.basic.gait}
                            disabled={gaitBusy !== null}
                            onChange={(e) =>
                                changeGait(Number(e.target.value), true)}
                        >
                            {!GAITS.some((g) =>
                                g.code === robot.basic!.gait
                            ) && <option value={robot.basic.gait}>{robot.basic.gaitName}</option>}
                            {GAITS.map((g) => (
                                <option key={g.code} value={g.code}>
                                    {g.short} — {g.suits}
                                </option>
                            ))}
                        </select>
                        {gaitBusy !== null && <span className="muted">…</span>}
                    </label>
                )}
                {MOTIONS.map((m) => {
                    const blocked = motionBlocked(m)
                    return (
                        <button
                            key={m.action}
                            type="button"
                            data-ui={`motion.${m.action}`}
                            className={`dim-btn act ${m.tone}`}
                            disabled={!!blocked || busy === m.action}
                            title={blocked ?? m.title}
                            onClick={() => setConfirm(m)}
                        >
                            {busy === m.action ? `${m.label}…` : m.label}
                        </button>
                    )
                })}
            </div>

            <div className="dim-toasts toast-stack">
                <div className={`dim-toast toast${toast ? " show" : ""}`}>{toast}</div>
            </div>

            <div className={"scrim" + (panelsOpen ? " open" : "")} onClick={() => setPanelsOpen(false)} />

            {overheating && !overheatDismissed && (
                <div className="overheat-back" role="alertdialog" aria-labelledby="overheat-title">
                    <div className="overheat dim-panel glass">
                        <header id="overheat-title">
                            <Icon name="warn" size={20} />
                            Warning: M20 overheating
                        </header>
                        <p>
                            {hotMotor && hotMotor.celsius >= TEMP_HOT
                                ? `The ${jointName(hotMotor.joint)} motor is at ${hotMotor.celsius.toFixed(0)}°C. `
                                : ""}
                            {overheatErrors.map((e) =>
                                `${e.name[0].toUpperCase()}${e.name.slice(1)}${
                                    e.parts.length ? ` (${e.parts.map(jointName).join(", ")})` : ""
                                }`
                            )
                                .join("; ")}
                            {overheatErrors.length ? ". " : ""}
                            Have the robot lie down until it cools below {TEMP_WARM}°C.
                        </p>
                        <footer>
                            <button
                                type="button"
                                className="dim-btn"
                                data-ui="overheat.dismiss"
                                onClick={() =>
                                    setOverheatDismissed(true)}
                            >
                                Dismiss
                            </button>
                            <button
                                type="button"
                                className="dim-btn danger"
                                data-ui="overheat.lie_down"
                                autoFocus
                                onClick={() => {
                                    setOverheatDismissed(true)
                                    setConfirm(
                                        MOTIONS.find((m) =>
                                            m.action === "liedown"
                                        )!,
                                    )
                                }}
                            >
                                Lie down…
                            </button>
                        </footer>
                    </div>
                </div>
            )}

            <div
                className={"confirm" + (confirm ? " show amber" : "")}
                onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
            >
                {confirm && (
                    <div className="confirm-box">
                        <div className="glyph">
                            <Icon name="warn" size={44} />
                        </div>
                        <h2 className="dim-h1">
                            {confirm.label} —{" "}
                            {confirm.action === "direct"
                                ? "switch how it drives"
                                : dryRun
                                ? "dry run"
                                : "the robot moves"}
                        </h2>
                        {/* the warnings are this file's own text, with <b> for emphasis */}
                        <p
                            dangerouslySetInnerHTML={{
                                __html: confirm.warn + (dryRun ? "<br><b>Dry run:</b> nothing is sent." : ""),
                            }}
                        />
                        <div className="confirm-actions">
                            <button type="button" className="dim-btn" autoFocus onClick={() => setConfirm(null)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="dim-btn danger"
                                id="confirm-go"
                                data-ui="confirm.go"
                                onClick={() => {
                                    const m = confirm
                                    setConfirm(null)
                                    runMotion(m)
                                }}
                            >
                                {confirm.label} now
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function PadChip({ pad }: { pad: GamepadStatus }) {
    if (!pad.connected) {
        return null
    }
    const [tone, label] = pad.stopped
        ? ["warn", "Stopped — press A"]
        : pad.ready
        ? ["ok", "Gamepad"]
        : ["warn", "Center the sticks"]
    return (
        <span
            className={`dim-badge hide-phone ${tone}`}
            title={`Gamepad: ${pad.id}\n${GAMEPAD_BINDINGS.map(([b, a]) => `${b}: ${a}`).join("\n")}`}
        >
            <Icon name="gamepad" size={12} />
            {label}
        </span>
    )
}
