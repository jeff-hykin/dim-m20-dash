// Every M20 Ctrl action, as an endpoint (http.ts). The page calls only these, and so can Desktop's agent. Motion takes
// `dryRun: true`, which validates and answers with what would be called without calling it.
import { logLine } from "./applog.ts"
import { applySettings, blueprint, boards, robot } from "./app.ts"
import { MOTIONS } from "./blueprint.ts"
import { fakeBoards } from "./boards.ts"
import { HttpError, type Info, type Route } from "./http.ts"
import {
    listRecordings,
    record,
    recordingFile,
    recordingStatus,
    recordLog,
    startRecording,
    stopRecording,
} from "./recording.ts"
import { GROUPS } from "./record_streams.ts"
import { type Mode, settings, updateSettings } from "./settings.ts"

export const INFO: Info = {
    title: "M20 Ctrl",
    version: "1.0.0",
    description:
        "M20 Ctrl: monitor a Deep Robotics Lynx M20 quadruped's computers (GOS, AOS, NOS) — CPU, temperature, memory, " +
        "network, lidar and dimos — record them, and in blueprint mode watch, record and command the running dimos blueprint",
}

/** what direct mode says when asked to move: there is no direct M20 protocol here (on purpose: it isn't documented) */
export const DIRECT_MOTION =
    "Direct mode has no motion: M20 Ctrl doesn't speak the M20's own control protocol (it isn't documented here). " +
    "Switch to blueprint mode and run a blueprint with M20Connection (m20-nav, or deeprobotics-m20-kronknav-control before the rename)."

function bool(value: unknown, name: string): boolean {
    if (value === undefined) {
        return false
    }
    if (typeof value === "boolean") {
        return value
    }
    if (value === "true" || value === "false") {
        return value === "true"
    }
    throw new HttpError(400, `${name} must be true or false`)
}

function state(withHistory: boolean) {
    const now = Date.now()
    return {
        mode: settings().mode,
        source: settings().source,
        boards: boards.summary(now).map((board) => withHistory ? board : { ...board, history: undefined }),
        blueprint: settings().mode === "blueprint" ? blueprint.state : null,
        directMotion: settings().mode === "direct" ? DIRECT_MOTION : null,
        record: recordingStatus(),
        robot: robot.state,
        now,
    }
}

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        when: "you want the M20's boards' health (CPU, network, lidar, dimos) or what the running blueprint is doing",
        description:
            "Everything the panel shows: mode (blueprint|direct), source (ssh|fake), boards [{name, label, hosts, link " +
            "{state, host, error}, reachable, indicators {network, stats, lidar, dimos: {level ok|warn|bad|off|unknown, " +
            "text}}, latest (CPU total + per core %, load, memory, temperatures, lidar/dimos processes, uptime)}], " +
            "blueprint (blueprint mode: running, blueprint, streams, connection, peeked stream values), record, robot " +
            "(the M20's own status: GET api/robot)",
        params: {
            history: { type: "boolean", description: "include each board's last 2 minutes of CPU (the charts)" },
        },
        role: "context",
        handler: ({ history }) => state(bool(history, "history")),
    },
    {
        method: "GET",
        path: "api/boards/{name}",
        when: "you want one M20 board's latest stats and indicators",
        description:
            "One board (gos, aos, nos, …): its link, indicators, latest sample and CPU history; 404 for an unknown name",
        params: { name: { type: "string", description: "the board's name (GET api/settings lists them)" } },
        handler: ({ name }) => {
            const found = boards.summary().find((board) => board.name === name)
            if (!found) {
                throw new HttpError(404, `no board named ${name}`)
            }
            return found
        },
    },
    {
        method: "GET",
        path: "api/robot",
        when: "you want the M20's battery, motor temperatures, errors, e-stop, motion state, gait or charging",
        description:
            "The M20's own status, from its basic_server's reports (M20 Ctrl only heartbeats it, never commands it): " +
            "{link (up|down|connecting|off|error), basic {motionName, gaitName, chargeName, hardEstop, usage, sleep}, " +
            "motion {roll, pitch, yaw, height, vx, vy, wz}, battery {left, right: {level %, voltage, celsius, " +
            "charging, present}}, joints [{joint, motor °C, driver °C}], hottestMotor, hottestDriver, errors [{hex, " +
            "name, parts}]}",
        role: "context",
        handler: () => robot.state,
    },
    {
        method: "PUT",
        path: "api/mode",
        when: "you need to switch between blueprint mode and direct mode",
        description:
            "blueprint: M20 Ctrl watches and records the running dimos blueprint's streams and sends motion through its " +
            "M20Connection RPCs (never its own robot connection). direct: boards only; motion is not available. " +
            "Returns {mode}",
        params: { mode: { type: "string", description: "blueprint or direct", required: true } },
        handler: ({ mode }) => {
            const next = updateSettings({ mode: mode as Mode })
            applySettings(next)
            return { mode: next.mode }
        },
    },
    {
        method: "POST",
        path: "api/motion",
        when: "the M20 should stand up, lie down, dock to charge or stop",
        description:
            `MOVES THE ROBOT. action: ${Object.keys(MOTIONS).join(", ")} — the running blueprint's M20Connection ` +
            "standup / liedown / dock / stop_movement RPC through the dimos gateway. dock starts self-charging (the " +
            "robot must stand still about 2 m in front of the dock, facing it) and answers at once with what it's " +
            "doing. Blueprint mode only (501 in direct mode); 409 when no blueprint with M20Connection runs or its " +
            "M20Connection lacks that RPC. Returns {ok, rpc, module, result, error}",
        params: {
            action: { type: "string", description: "standup, liedown, dock or stop", required: true },
            dryRun: { type: "boolean", description: "validate and return what would be called, without calling it" },
        },
        handler: async ({ action, dryRun }) => {
            if (settings().mode !== "blueprint") {
                throw new HttpError(501, DIRECT_MOTION)
            }
            const dry = bool(dryRun, "dryRun")
            const result = await blueprint.motion(String(action ?? ""), dry)
            if (!dry) {
                logLine(`motion ${action}: ${JSON.stringify(result)}`)
                record("/robot_action", { action, ...result })
            }
            return result
        },
    },
    {
        method: "GET",
        path: "api/blueprint",
        when: "you want the running dimos blueprint's streams and their latest values, as M20 Ctrl sees them",
        description:
            "Blueprint mode's view: {running, blueprint, runId, error, streams [{name, type, direction, module}], " +
            "connection {id, rpcs} (its M20Connection), peeked {stream: {type, value, ts, at}}}; 409 in direct mode",
        handler: () => {
            if (settings().mode !== "blueprint") {
                throw new HttpError(409, "direct mode: switch to blueprint mode (PUT api/mode)")
            }
            return blueprint.state
        },
    },
    {
        method: "GET",
        path: "api/settings",
        when: "you want the M20 boards M20 Ctrl watches and how it reaches them",
        description:
            "{boards [{name, label, hosts (ssh targets, tried in order), role, expectLidar, expectDimos}], source " +
            "(ssh|fake), mode, patterns {lidar, dimos (regexes for ps), lidarPorts}, blueprintStreams}",
        handler: () => settings(),
    },
    {
        method: "PUT",
        path: "api/settings",
        when: "you need to change the boards, their addresses, fake boards or the watched blueprint streams",
        description:
            "Change any subset of the settings (see GET api/settings); reset: true starts from the defaults. Saved, and " +
            "the board links restart if boards, source or patterns changed. Returns the new settings; 400 if invalid",
        params: {
            boards: {
                type: "array",
                description: "[{name, label, hosts: [user@host, …], role?, expectLidar?, expectDimos?}]",
            },
            source: { type: "string", description: "ssh (the real boards) or fake (simulated boards)" },
            mode: { type: "string", description: "blueprint or direct" },
            patterns: { type: "object", description: "{lidar, dimos: regexes matched against ps args; lidarPorts}" },
            blueprintStreams: { type: "array", description: "stream names to sample in blueprint mode" },
            reset: { type: "boolean", description: "restore the defaults first" },
        },
        handler: (args) => {
            const next = updateSettings(args)
            applySettings(next)
            return next
        },
    },
    {
        method: "GET",
        path: "api/record",
        when: "you want to know whether M20 Ctrl is recording, and its size",
        description:
            "The recording in progress: {active: true, file, path, startedAt (ms), seconds, bytes, messages, topics}; " +
            "or {active: false}",
        handler: () => recordingStatus(),
    },
    {
        method: "POST",
        path: "api/record/start",
        when: "you need to record the M20's board stats (and, in blueprint mode, the blueprint's streams) to an mcap",
        description:
            "Record to an .mcap in Desktop's recordings folder (m20/[<folder>/]<date>_<time>_m20_<host>[_<label>]" +
            ".mcap) what the Record options pick (GET api/record/options): the live topics raw (cameras, lidar, map, " +
            "pose, tf, driving and commands; each with its rate cap), the robot status reports, the board stats, the " +
            "blueprint samples; always /robot_action and /logs. Splits into _partN files by the options' minutes / MB. " +
            "Runs until api/record/stop or the app quits. Returns its status (as GET api/record); if one is already " +
            "running, that one's",
        handler: () =>
            startRecording(undefined, {
                mode: settings().mode,
                source: settings().source,
                boards: settings().boards,
                // each board's link as the recording starts (later changes go on /boards/<board>/link)
                links: boards.summary().map(({ name, reachable, link }) => ({ name, reachable, link: link.state })),
                blueprint: settings().mode === "blueprint" ? blueprint.state.blueprint : null,
            }, settings().recordOptions),
    },
    {
        method: "POST",
        path: "api/record/stop",
        when: "you need to stop M20 Ctrl's recording",
        description:
            "Stop the recording and finish its file: {active: false, stopped: true, file, path, bytes, messages}, or " +
            "{active: false, stopped: false} if none was running",
        handler: () => stopRecording(),
    },
    {
        method: "GET",
        path: "api/record/options",
        when: "you want to know what M20 Ctrl's recordings hold, or what can be recorded",
        description:
            "The Record options: {options {streams {<group>: {on, maxHz (null: its own rate)}}, label, folder, " +
            "splitMinutes, splitMb}, groups [{id, label, about, keys (zenoh keys, recorded raw), fullRate}]}",
        handler: () => ({ options: settings().recordOptions, groups: GROUPS }),
    },
    {
        method: "PUT",
        path: "api/record/options",
        when: "you need to change what M20 Ctrl records (streams, rate caps, file label, folder, splitting)",
        description:
            "Change the Record options (any subset; a stream group you leave out keeps its setting); they apply from " +
            "the next recording. Returns them; 400 if invalid",
        params: {
            streams: {
                type: "object",
                description: "{<group id>: {on: bool, maxHz: number|null}} (ids: GET api/record/options)",
            },
            label: { type: "string", description: "added to the file name: letters, digits, - and _" },
            folder: { type: "string", description: 'a folder inside m20/ ("" for m20/ itself)' },
            splitMinutes: { type: "number", description: "a new _partN file after this many minutes (null: never)" },
            splitMb: { type: "number", description: "a new _partN file after this many MB (null: never)" },
        },
        handler: (args) => {
            const current = settings().recordOptions
            const streams = { ...current.streams }
            for (const [id, choice] of Object.entries((args.streams ?? {}) as Record<string, object>)) {
                if (!(id in streams)) {
                    throw new HttpError(400, `no stream group ${id}`)
                }
                streams[id as keyof typeof streams] = { ...streams[id as keyof typeof streams], ...choice }
            }
            const { streams: _, ...rest } = args
            return updateSettings({ recordOptions: { ...current, ...rest, streams } as never }).recordOptions
        },
    },
    {
        method: "GET",
        path: "api/recordings/download",
        when: "you need one of M20 Ctrl's recording files",
        description: "The .mcap itself (as a download); file is a name GET api/recordings lists. 404 for anything else",
        params: { file: { type: "string", description: "the file, as GET api/recordings names it", required: true } },
        handler: ({ file }) => recordingFile(String(file)),
    },
    {
        method: "GET",
        path: "api/recordings",
        when: "you want the list of M20 Ctrl's recording files",
        description:
            "This app's recordings: {directory, recordings: [{file, bytes, modified (ISO time), recording (still being " +
            "written)}]}, newest first",
        handler: () => listRecordings(),
    },
    {
        method: "PUT",
        path: "api/fake",
        when: "you want a fake board to show a condition (testing the panel without the dog)",
        description:
            "Fake boards only: pin a board's simulated condition — reachable (bool), lidar (publishing|idle|off), dimos " +
            "(bool), busy (0-1 CPU) — or clear: true to go back to its script. Returns {board, overrides}; 409 when " +
            "the source isn't fake",
        params: {
            board: { type: "string", description: "the board's name", required: true },
            reachable: { type: "boolean", description: "on the network or not" },
            lidar: { type: "string", description: "publishing, idle or off" },
            dimos: { type: "boolean", description: "dimos running or not" },
            busy: { type: "number", description: "CPU load, 0-1" },
            clear: { type: "boolean", description: "drop the overrides" },
        },
        handler: ({ board, clear, ...rest }) => {
            if (settings().source !== "fake") {
                throw new HttpError(409, "the boards aren't fake (PUT api/settings {source: fake})")
            }
            const fake = fakeBoards.get(String(board))
            if (!fake) {
                throw new HttpError(404, `no fake board named ${board}`)
            }
            if (bool(clear, "clear")) {
                fake.overrides = {}
            }
            for (const key of ["reachable", "lidar", "dimos", "busy"] as const) {
                if (rest[key] !== undefined) {
                    fake.overrides = { ...fake.overrides, [key]: rest[key] }
                }
            }
            recordLog({ type: "fake_override", board, overrides: fake.overrides })
            return { board, overrides: fake.overrides }
        },
    },
]
