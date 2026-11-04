// The Record button's ⋯ panel (Go2 Ctrl's RecordOptions and Recordings, in one): what a recording holds (each stream
// group on or off, with a rate cap), the file's label, a folder inside m20/, splitting by minutes or megabytes; while
// one runs, its size, time, parts and per-stream written / skipped (over the cap) / dropped (backed up) counts; and
// the past recordings with a download link each. Every change is PUT api/record/options and applies from the next
// recording.
import { useCallback, useEffect, useState } from "react"
import { call, message, type RecordGroup, type RecordingFile, type RecordOptions, type RecordState } from "./api.ts"
import { Icon } from "./icons.tsx"

const RATE_CAPS = [null, 30, 15, 10, 5, 2, 1] as const
const SHOWN_RECORDINGS = 12

const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
const clock = (seconds: number) =>
    `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${
        String(Math.floor((seconds % 3600) / 60)).padStart(Math.floor(seconds / 3600) ? 2 : 1, "0")
    }:${String(Math.floor(seconds % 60)).padStart(2, "0")}`

export function RecordPanel({ record, onClose, onToast }: {
    record: RecordState | undefined
    onClose: () => void
    onToast: (text: string) => void
}) {
    const [options, setOptions] = useState<RecordOptions | null>(null)
    const [groups, setGroups] = useState<RecordGroup[]>([])
    const [files, setFiles] = useState<RecordingFile[]>([])
    const [allFiles, setAllFiles] = useState(false)
    const [draft, setDraft] = useState({ label: "", folder: "", splitMinutes: "", splitMb: "" })

    const load = useCallback(async () => {
        const got = await call<{ options: RecordOptions; groups: RecordGroup[] }>("GET", "api/record/options")
        setOptions(got.options)
        setGroups(got.groups)
        setDraft({
            label: got.options.label,
            folder: got.options.folder,
            splitMinutes: got.options.splitMinutes === null ? "" : String(got.options.splitMinutes),
            splitMb: got.options.splitMb === null ? "" : String(got.options.splitMb),
        })
    }, [])
    const loadFiles = useCallback(() => {
        call<{ recordings: RecordingFile[] }>("GET", "api/recordings").then((r) => setFiles(r.recordings), () => {})
    }, [])
    useEffect(() => {
        load().catch((e) => onToast(message(e)))
        loadFiles()
    }, [load, loadFiles, onToast])
    // the list follows a recording starting, splitting and stopping
    const parts = record?.active ? record.files.length : 0
    useEffect(loadFiles, [record?.active, parts, loadFiles])

    const save = async (change: Partial<RecordOptions>) => {
        try {
            setOptions(await call<RecordOptions>("PUT", "api/record/options", change))
        } catch (error) {
            onToast(message(error))
            load().catch(() => {})
        }
    }
    const number = (text: string) => (text.trim() === "" ? null : Number(text))

    const active = record?.active ? record : null
    const shown = allFiles ? files : files.slice(0, SHOWN_RECORDINGS)
    return (
        <div className="record-panel dim-panel glass" role="dialog" aria-label="Recording options">
            <header>
                <span className="dim-label">Recording</span>
                <button type="button" className="dim-btn icon ghost" aria-label="close" onClick={onClose}>
                    <Icon name="close" size={14} />
                </button>
            </header>

            {active && (
                <div className="rec-now">
                    <div className="dim-mono rec-line">
                        ● {clock(active.seconds)} · {megabytes(active.bytes)} · {active.messages.toLocaleString()} msgs
                        {active.dropped ? <span className="warn">· {active.dropped} dropped</span> : null}
                    </div>
                    {active.freeBytes !== null && (
                        <div
                            className={`muted rec-file${active.freeBytes < 5e9 ? " warn" : ""}`}
                            title="the recording stops itself when the disk is down to 1 GB free"
                        >
                            {megabytes(active.freeBytes)} free on the robot's disk
                            {active.seconds > 5 && active.bytes > 0
                                ? ` (~${
                                    Math.round((active.freeBytes - 1e9) / (active.bytes / active.seconds) / 60)
                                } min at this rate)`
                                : ""}
                        </div>
                    )}
                    <div className="muted rec-file" title={active.files.join("\n")}>
                        {active.file}
                        {active.files.length > 1 ? ` (part ${active.files.length})` : ""}
                    </div>
                    {active.tap.state !== "running" && active.tap.state !== "off" && (
                        <div className={`note${active.tap.state === "starting" ? "" : " error"}`}>
                            Live topics: {active.tap.state === "starting" ? "starting…" : active.tap.error}
                        </div>
                    )}
                </div>
            )}

            <div className="rec-section-title">
                Streams {active && <span className="muted">(changes apply to the next recording)</span>}
            </div>
            <div className="rec-streams">
                {groups.map((group) => {
                    const choice = options?.streams[group.id]
                    const counts = active?.streams[group.id]
                    return (
                        <div key={group.id} className={`rec-stream${choice?.on ? "" : " off"}`}>
                            <label title={group.about}>
                                <input
                                    type="checkbox"
                                    data-ui={`record.stream.${group.id}`}
                                    checked={!!choice?.on}
                                    onChange={(e) =>
                                        save({
                                            streams: {
                                                [group.id]: { on: e.target.checked, maxHz: choice?.maxHz ?? null },
                                            },
                                        })}
                                />
                                <span>{group.label}</span>
                            </label>
                            {group.keys.length > 0
                                ? (
                                    <select
                                        className="dim-select"
                                        data-ui={`record.rate.${group.id}`}
                                        aria-label={`${group.label} rate cap`}
                                        title={`at its own rate: ${group.fullRate}`}
                                        value={choice?.maxHz ?? ""}
                                        disabled={!choice?.on}
                                        onChange={(e) =>
                                            save({
                                                streams: {
                                                    [group.id]: {
                                                        on: true,
                                                        maxHz: e.target.value ? Number(e.target.value) : null,
                                                    },
                                                },
                                            })}
                                    >
                                        {RATE_CAPS.map((hz) => (
                                            <option key={String(hz)} value={hz ?? ""}>
                                                {hz === null ? "full rate" : `≤ ${hz} Hz`}
                                            </option>
                                        ))}
                                    </select>
                                )
                                : <span className="muted rate-fixed">{group.fullRate.split(",")[0]}</span>}
                            {counts && (
                                <span
                                    className="dim-mono rec-counts"
                                    title={`written ${counts.written}, received ${counts.received}, skipped over the cap ${counts.skipped}, dropped (backed up) ${counts.dropped}`}
                                >
                                    {counts.written}
                                    {counts.dropped ? <span className="warn">−{counts.dropped}</span> : null}
                                </span>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="rec-fields">
                <label>
                    File label
                    <input
                        className="dim-input"
                        data-ui="record.label"
                        placeholder="e.g. hallway_loop"
                        value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                        onBlur={() => draft.label !== options?.label && save({ label: draft.label })}
                    />
                </label>
                <label>
                    Folder (in m20/)
                    <input
                        className="dim-input"
                        data-ui="record.folder"
                        placeholder="m20/"
                        value={draft.folder}
                        onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
                        onBlur={() => draft.folder !== options?.folder && save({ folder: draft.folder })}
                    />
                </label>
                <label>
                    Split every (min)
                    <input
                        className="dim-input"
                        inputMode="numeric"
                        data-ui="record.split_minutes"
                        placeholder="never"
                        value={draft.splitMinutes}
                        onChange={(e) => setDraft({ ...draft, splitMinutes: e.target.value })}
                        onBlur={() => save({ splitMinutes: number(draft.splitMinutes) })}
                    />
                </label>
                <label>
                    Split every (MB)
                    <input
                        className="dim-input"
                        inputMode="numeric"
                        data-ui="record.split_mb"
                        placeholder="never"
                        value={draft.splitMb}
                        onChange={(e) => setDraft({ ...draft, splitMb: e.target.value })}
                        onBlur={() => save({ splitMb: number(draft.splitMb) })}
                    />
                </label>
            </div>
            <div className="note">
                Format: .mcap (live topics raw in dimos' layout, the rest as JSON). Saved in Desktop's recordings
                folder, under m20/.
            </div>

            <div className="rec-section-title">Recordings</div>
            <div className="rec-files">
                {files.length === 0 && <div className="muted">None yet.</div>}
                {shown.map((file) => (
                    <div key={file.file} className="rec-file-row">
                        <span className="dim-mono name" title={file.file}>{file.file}</span>
                        <span className="dim-mono muted size">{megabytes(file.bytes)}</span>
                        {file.recording ? <span className="warn">recording</span> : (
                            <a
                                className="dim-btn sm ghost"
                                href={`api/recordings/download?file=${encodeURIComponent(file.file)}`}
                                download={file.file.split("/").pop()}
                                title={file.modified ? `saved ${new Date(file.modified).toLocaleString()}` : ""}
                            >
                                Download
                            </a>
                        )}
                    </div>
                ))}
                {files.length > SHOWN_RECORDINGS && (
                    <button
                        type="button"
                        className="dim-btn sm ghost"
                        onClick={() => setAllFiles(!allFiles)}
                    >
                        {allFiles ? "Show fewer" : `Show all ${files.length}`}
                    </button>
                )}
            </div>
        </div>
    )
}
