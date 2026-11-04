// What a recording can hold, as groups the Record options list: the live topics (zenoh keys, recorded raw through
// zenoh_tap.py) and M20 Ctrl's own JSON topics. Defaults: everything, at its own rate, except the cameras (5 fps: a
// 1280×720 JPEG stream at its 30 fps is ~3.5 MB/s per camera).

export type GroupId =
    | "front_camera"
    | "rear_camera"
    | "lidar"
    | "map"
    | "pose"
    | "tf"
    | "drive"
    | "robot_status"
    | "boards"
    | "blueprint"
    | "system_logs"

export type Group = {
    id: GroupId
    label: string
    about: string
    /** the zenoh keys it records (raw); none: one of the backend's own JSON topics */
    keys: string[]
    /** the JSON topics' prefix (when keys is empty) */
    prefix?: string
    default: { on: boolean; maxHz: number | null }
    /** about how much it writes at its full rate (for the options' estimate) */
    fullRate: string
}

export const GROUPS: Group[] = [
    {
        id: "front_camera",
        label: "Front camera",
        about: "front_camera_image (JPEG), or front_camera (H.265) when that's what runs",
        keys: [
            "dimos/front_camera_image/sensor_msgs.CompressedImage",
            "dimos/front_camera/foxglove_msgs.CompressedVideo",
        ],
        default: { on: true, maxHz: 5 },
        fullRate: "~30 fps, ~3.5 MB/s",
    },
    {
        id: "rear_camera",
        label: "Rear camera",
        about: "rear_camera_image (JPEG), or rear_camera (H.265)",
        keys: [
            "dimos/rear_camera_image/sensor_msgs.CompressedImage",
            "dimos/rear_camera/foxglove_msgs.CompressedVideo",
        ],
        default: { on: true, maxHz: 5 },
        fullRate: "~30 fps, ~3.5 MB/s",
    },
    {
        id: "lidar",
        label: "Lidar scan",
        about: "slam_body_points (body frame, every point)",
        keys: ["dimos/slam_body_points/sensor_msgs.PointCloud2"],
        default: { on: true, maxHz: null },
        fullRate: "~10 Hz, ~7 MB/s",
    },
    {
        id: "map",
        label: "Local map",
        about: "local_map (map frame)",
        keys: ["dimos/local_map/sensor_msgs.PointCloud2"],
        default: { on: true, maxHz: null },
        fullRate: "~2 Hz, ~0.5 MB/s",
    },
    {
        id: "pose",
        label: "Odometry / pose",
        about: "slam_odom (Odometry) and odom (PoseStamped)",
        keys: ["dimos/slam_odom/nav_msgs.Odometry", "dimos/odom/geometry_msgs.PoseStamped"],
        default: { on: true, maxHz: null },
        fullRate: "~10 Hz, small",
    },
    {
        id: "tf",
        label: "tf",
        about: "map → base_link and the rest of tf",
        keys: ["dimos/tf/tf2_msgs.TFMessage"],
        default: { on: true, maxHz: null },
        fullRate: "~10 Hz, small",
    },
    {
        id: "drive",
        label: "Driving and commands",
        about: "tele_cmd_vel (this page's sticks and keys), cmd_vel, nav_cmd_vel, command_ready, motion and gait state",
        keys: [
            "dimos/tele_cmd_vel/geometry_msgs.Twist",
            "dimos/cmd_vel/geometry_msgs.Twist",
            "dimos/nav_cmd_vel/geometry_msgs.Twist",
            "dimos/command_ready/std_msgs.Bool",
            "dimos/motion_state/std_msgs.Int32",
            "dimos/gait_state/std_msgs.UInt32",
        ],
        default: { on: true, maxHz: null },
        fullRate: "up to 20 Hz, small",
    },
    {
        id: "robot_status",
        label: "Robot status",
        about: "basic_server's reports: motion, gait, charging, batteries, joint temperatures, errors (/robot/*)",
        keys: [],
        prefix: "/robot/",
        default: { on: true, maxHz: null },
        fullRate: "~12 Hz, small",
    },
    {
        id: "boards",
        label: "Board stats",
        about: "GOS, AOS and NOS: CPU, memory, temperatures, lidar and dimos processes, links (/boards/*)",
        keys: [],
        prefix: "/boards/",
        default: { on: true, maxHz: null },
        fullRate: "1 Hz, small",
    },
    {
        id: "blueprint",
        label: "Blueprint samples",
        about: "the streams ticked in the Streams panel, one sample a second (/blueprint/*)",
        keys: [],
        prefix: "/blueprint/",
        default: { on: true, maxHz: null },
        fullRate: "1 Hz, small",
    },
    {
        id: "system_logs",
        label: "System logs",
        about: "on /logs, for every board: health every 2 s (Wi-Fi link, routes, CPU, memory), new journal / dmesg " +
            "warnings, network-safety and the vendor basic_server log (AOS), dumps when something looks wrong, and M20 " +
            "Ctrl's own log lines (read-only: journalctl -f, tail -F and a 2 s loop over ssh)",
        keys: [],
        default: { on: true, maxHz: null },
        fullRate: "every 2 s, small",
    },
]

export type StreamChoice = { on: boolean; maxHz: number | null }

export type RecordOptions = {
    streams: Record<GroupId, StreamChoice>
    /** added to the file name (letters, digits, - and _) */
    label: string
    /** a folder inside the recordings folder's m20/ ("" = m20/ itself) */
    folder: string
    /** start a new file (…_part2.mcap) after this many minutes / megabytes; null: never */
    splitMinutes: number | null
    splitMb: number | null
}

export const DEFAULT_RECORD_OPTIONS: RecordOptions = {
    streams: Object.fromEntries(GROUPS.map((g) => [g.id, { ...g.default }])) as Record<GroupId, StreamChoice>,
    label: "",
    folder: "",
    splitMinutes: null,
    splitMb: 2000,
}

/** A stream's name in the file: the key's topic part (dimos/front_camera_image/sensor_msgs.CompressedImage → front_camera_image). */
export const streamName = (key: string) => key.split("/").slice(1, -1).join("/")

/** dimos' payload type for a key's message type: sensor_msgs.CompressedImage → dimos.msgs.sensor_msgs.CompressedImage.CompressedImage */
export function payloadType(key: string) {
    const type = key.split("/").pop()!
    const [pkg, name] = type.split(".")
    return `dimos.msgs.${pkg}.${name}.${name}`
}

/** The group a recorded JSON topic belongs to (null: always recorded, e.g. /logs). */
export function groupOfTopic(topic: string): GroupId | null {
    return GROUPS.find((g) => g.prefix && topic.startsWith(g.prefix))?.id ?? null
}

/** Checks and fills an options object (a missing stream gets its default). */
export function validRecordOptions(value: unknown): RecordOptions {
    const given = (value ?? {}) as Partial<RecordOptions>
    const streams = {} as Record<GroupId, StreamChoice>
    for (const group of GROUPS) {
        const choice = (given.streams as Record<string, Partial<StreamChoice>> | undefined)?.[group.id] ?? {}
        const maxHz = choice.maxHz === undefined ? group.default.maxHz : choice.maxHz
        if (maxHz !== null && !(typeof maxHz === "number" && maxHz > 0 && maxHz <= 1000)) {
            throw new Error(`${group.label}: the rate cap must be a number of Hz (0-1000], or none`)
        }
        streams[group.id] = { on: typeof choice.on === "boolean" ? choice.on : group.default.on, maxHz }
    }
    const label = String(given.label ?? "")
    if (!/^[\w-]{0,40}$/.test(label)) {
        throw new Error("the file label can only have letters, digits, - and _ (up to 40)")
    }
    const folder = String(given.folder ?? "")
    if (!/^[\w-]{0,40}$/.test(folder)) {
        throw new Error("the folder is one name inside m20/: letters, digits, - and _ (up to 40)")
    }
    const limit = (v: unknown, what: string) => {
        if (v === null || v === undefined || v === "") {
            return null
        }
        if (typeof v !== "number" || !(v >= 1)) {
            throw new Error(`${what} must be at least 1, or none`)
        }
        return v
    }
    return {
        streams,
        label,
        folder,
        splitMinutes: limit(given.splitMinutes, "split minutes"),
        splitMb: limit(given.splitMb === undefined ? DEFAULT_RECORD_OPTIONS.splitMb : given.splitMb, "split MB"),
    }
}
