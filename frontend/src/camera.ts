// A camera onto a canvas: JPEG CompressedImage frames through createImageBitmap (a frame still decoding makes the next
// one wait, then only the newest is drawn), H.265 / H.264 CompressedVideo (Annex B) through WebCodecs, starting at a
// keyframe. Returns the stats the HUD shows.
import type { CameraFrame } from "./live.ts"

export type CameraStats = {
    fps: number
    width: number
    height: number
    kind: "jpeg" | "video" | null
    error: string | null
}

/** NAL unit types in an Annex B buffer (4- or 3-byte start codes) */
function nalTypes(data: Uint8Array, hevc: boolean): number[] {
    const types: number[] = []
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
            const at = data[i + 2] === 1 ? i + 3 : i + 4
            if (at < data.length) {
                types.push(hevc ? (data[at] >> 1) & 0x3f : data[at] & 0x1f)
            }
            i = at
        }
    }
    return types
}

/** a keyframe: HEVC IRAP (16-23) or VPS/SPS; H.264 IDR (5) or SPS (7) */
const isKey = (data: Uint8Array, hevc: boolean) =>
    nalTypes(data, hevc).some((t) => hevc ? (t >= 16 && t <= 23) || t === 32 || t === 33 : t === 5 || t === 7)

export class CameraCanvas {
    stats: CameraStats = { fps: 0, width: 0, height: 0, kind: null, error: null }
    #frames: number[] = []
    #pending: CameraFrame | null = null
    #decoding = false
    #decoder: VideoDecoder | null = null
    #codec = ""
    #needKey = true
    #timestamp = 0
    #closed = false

    constructor(readonly canvas: HTMLCanvasElement, readonly onStats: (stats: CameraStats) => void) {}

    push(frame: CameraFrame) {
        if (this.#closed) {
            return
        }
        if (frame.kind === "jpeg") {
            this.#pending = frame
            if (!this.#decoding) {
                this.#drawJpeg()
            }
        } else {
            this.#video(frame)
        }
    }

    #drew(width: number, height: number, kind: "jpeg" | "video") {
        const now = performance.now()
        this.#frames.push(now)
        while (this.#frames.length && now - this.#frames[0] > 2000) {
            this.#frames.shift()
        }
        const fps = Math.round(this.#frames.length / 2)
        if (fps !== this.stats.fps || width !== this.stats.width || kind !== this.stats.kind || this.stats.error) {
            this.stats = { fps, width, height, kind, error: null }
            this.onStats(this.stats)
        }
    }

    #fail(error: string) {
        if (error !== this.stats.error) {
            this.stats = { ...this.stats, error }
            this.onStats(this.stats)
        }
    }

    #draw(image: CanvasImageSource, width: number, height: number) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width
            this.canvas.height = height
        }
        this.canvas.getContext("2d")?.drawImage(image, 0, 0)
    }

    async #drawJpeg() {
        this.#decoding = true
        while (this.#pending && !this.#closed) {
            const frame = this.#pending
            this.#pending = null
            try {
                const bitmap = await createImageBitmap(new Blob([frame.data as BlobPart], { type: "image/jpeg" }))
                if (!this.#closed) {
                    this.#draw(bitmap, bitmap.width, bitmap.height)
                    this.#drew(bitmap.width, bitmap.height, "jpeg")
                }
                bitmap.close()
            } catch (error) {
                this.#fail(`JPEG decode: ${(error as Error).message}`)
            }
        }
        this.#decoding = false
    }

    #video(frame: Extract<CameraFrame, { kind: "video" }>) {
        if (typeof VideoDecoder === "undefined") {
            return this.#fail("this browser has no WebCodecs VideoDecoder for the H.265 camera stream")
        }
        const hevc = frame.format.includes("265") || frame.format.includes("hevc")
        const codec = hevc ? "hev1.1.6.L120.90" : "avc1.640028"
        if (codec !== this.#codec || !this.#decoder || this.#decoder.state === "closed") {
            this.#codec = codec
            this.#newDecoder(codec)
        }
        const key = isKey(frame.data, hevc)
        if (this.#needKey && !key) {
            return
        }
        this.#needKey = false
        try {
            this.#timestamp += 33_333
            this.#decoder!.decode(
                new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: this.#timestamp, data: frame.data }),
            )
        } catch (error) {
            this.#fail(`video decode: ${(error as Error).message}`)
            this.#newDecoder(codec)
        }
    }

    #newDecoder(codec: string) {
        if (this.#decoder && this.#decoder.state !== "closed") {
            this.#decoder.close()
        }
        this.#needKey = true
        this.#decoder = new VideoDecoder({
            output: (videoFrame) => {
                if (!this.#closed) {
                    this.#draw(videoFrame, videoFrame.displayWidth, videoFrame.displayHeight)
                    this.#drew(videoFrame.displayWidth, videoFrame.displayHeight, "video")
                }
                videoFrame.close()
            },
            error: (error) => {
                this.#fail(`${codec.startsWith("hev") ? "H.265" : "H.264"}: ${error.message}`)
                if (!this.#closed) {
                    setTimeout(() => this.#newDecoder(codec), 500)
                }
            },
        })
        this.#decoder.configure({ codec, optimizeForLatency: true })
    }

    close() {
        this.#closed = true
        if (this.#decoder && this.#decoder.state !== "closed") {
            this.#decoder.close()
        }
    }
}
