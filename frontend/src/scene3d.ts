// The 3D view (G1 Ctrl's lidar scene, scenes.ts, grown into a map view): the local map (map frame, faint), the live
// lidar scan (slam_body_points, body frame, placed at the robot's pose), the robot as a box with a heading arrow, and its
// recent trail. z up. Follow mode keeps the camera on the robot. Colors are theme tokens, re-read on `dim-theme`.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Cloud, Pose } from "./live.ts"

const MAX_SCAN = 40_000
const MAX_MAP = 150_000
const TRAIL = 600

const colorProbe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!

function tokenColor(name: string, fallback = "#7aa2ff") {
    colorProbe.clearRect(0, 0, 1, 1)
    colorProbe.fillStyle = getComputedStyle(document.body).getPropertyValue(name).trim() || fallback
    colorProbe.fillRect(0, 0, 1, 1)
    const [r, g, b] = colorProbe.getImageData(0, 0, 1, 1).data
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
}

function pointLayer(max: number, size: number, opacity: number) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3))
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * 3), 3))
    geometry.setDrawRange(0, 0)
    const material = new THREE.PointsMaterial({
        size,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: opacity < 1,
        opacity,
    })
    return { points: new THREE.Points(geometry, material), geometry, max }
}

/** heights low → high as `low` → `high` */
function fill(
    layer: ReturnType<typeof pointLayer>,
    cloud: Cloud,
    low: THREE.Color,
    high: THREE.Color,
    zLow: number,
    zHigh: number,
) {
    const n = Math.min(cloud.count, layer.max)
    const positions = layer.geometry.attributes.position.array as Float32Array
    const colors = layer.geometry.attributes.color.array as Float32Array
    positions.set(cloud.xyz.subarray(0, n * 3))
    for (let i = 0; i < n; i++) {
        const t = Math.max(0, Math.min(1, (cloud.xyz[i * 3 + 2] - zLow) / (zHigh - zLow)))
        colors[i * 3] = low.r + (high.r - low.r) * t
        colors[i * 3 + 1] = low.g + (high.g - low.g) * t
        colors[i * 3 + 2] = low.b + (high.b - low.b) * t
    }
    layer.geometry.attributes.position.needsUpdate = true
    layer.geometry.attributes.color.needsUpdate = true
    layer.geometry.setDrawRange(0, n)
    layer.geometry.computeBoundingSphere()
}

export type Scene3D = ReturnType<typeof createScene3D>

export function createScene3D(canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 400)
    camera.up.set(0, 0, 1)
    camera.position.set(-5, -5, 4.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.target.set(0, 0, 0.3)

    const map = pointLayer(MAX_MAP, 0.05, 0.55)
    const scan = pointLayer(MAX_SCAN, 0.04, 1)
    // the scan is in the body frame: it rides on the robot's pose
    const body = new THREE.Group()
    body.add(scan.points)
    scene.add(map.points, body)

    // the M20: a 0.82 × 0.43 × 0.3 m body and a heading arrow
    const robotMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 })
    const robot = new THREE.Group()
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.43, 0.3), robotMaterial)
    box.position.z = 0.0
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial())
    box.add(edges)
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 12), new THREE.MeshBasicMaterial())
    arrow.rotation.z = -Math.PI / 2
    arrow.position.set(0.62, 0, 0)
    robot.add(box, arrow)
    body.add(robot)

    const trailGeometry = new THREE.BufferGeometry()
    trailGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3))
    trailGeometry.setDrawRange(0, 0)
    const trailMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 })
    scene.add(new THREE.Line(trailGeometry, trailMaterial))
    const trail: number[] = []

    let grid: THREE.GridHelper | null = null
    let colors = {
        low: new THREE.Color(),
        high: new THREE.Color(),
        mapLow: new THREE.Color(),
        mapHigh: new THREE.Color(),
    }
    let lastScan: Cloud | null = null
    let lastMap: Cloud | null = null
    const theme = () => {
        const primary = tokenColor("--primary")
        const info = tokenColor("--info", "#7fd4ff")
        const muted = tokenColor("--muted-fg", "#8a93a6")
        robotMaterial.color.copy(primary)
        ;(edges.material as THREE.LineBasicMaterial).color.copy(tokenColor("--fg", "#e6eaf2"))
        ;(arrow.material as THREE.MeshBasicMaterial).color.copy(info)
        trailMaterial.color.copy(info)
        colors = { low: primary, high: info, mapLow: muted.clone().multiplyScalar(0.6), mapHigh: muted }
        if (grid) {
            scene.remove(grid)
            grid.dispose()
        }
        grid = new THREE.GridHelper(
            40,
            40,
            tokenColor("--scene-grid-major", "#2a3142"),
            tokenColor("--scene-grid", "#1a1f2b"),
        )
        grid.rotation.x = Math.PI / 2
        scene.add(grid)
        lastScan && fill(scan, lastScan, colors.low, colors.high, -0.5, 1.5)
        lastMap && fill(map, lastMap, colors.mapLow, colors.mapHigh, -0.5, 2.5)
    }

    let follow = true
    const pose = new THREE.Vector3()
    const resize = () => {
        const box = canvas.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) {
            return
        }
        renderer.setSize(box.width, box.height, false)
        camera.aspect = box.width / box.height
        camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    let frame = 0
    const loop = () => {
        if (follow) {
            // keep the camera's offset from the robot, moving both with it
            const shift = pose.clone().setZ(pose.z + 0.3).sub(controls.target)
            controls.target.add(shift)
            camera.position.add(shift)
        }
        controls.update()
        renderer.render(scene, camera)
        frame = requestAnimationFrame(loop)
    }
    addEventListener("dim-theme", theme)
    theme()
    resize()
    frame = requestAnimationFrame(loop)

    return {
        setPose(p: Pose) {
            body.position.set(p.x, p.y, p.z)
            body.quaternion.set(p.qx, p.qy, p.qz, p.qw)
            pose.set(p.x, p.y, p.z)
            const last = trail.length ? trail.slice(-3) : null
            if (!last || Math.hypot(last[0] - p.x, last[1] - p.y) > 0.05) {
                trail.push(p.x, p.y, p.z + 0.02)
                if (trail.length > TRAIL * 3) {
                    trail.splice(0, 3)
                }
                ;(trailGeometry.attributes.position.array as Float32Array).set(trail)
                trailGeometry.attributes.position.needsUpdate = true
                trailGeometry.setDrawRange(0, trail.length / 3)
            }
        },
        setScan(cloud: Cloud) {
            lastScan = cloud
            fill(scan, cloud, colors.low, colors.high, -0.5, 1.5)
        },
        setMap(cloud: Cloud) {
            lastMap = cloud
            fill(map, cloud, colors.mapLow, colors.mapHigh, -0.5, 2.5)
        },
        setFollow(on: boolean) {
            follow = on
        },
        /** back behind the robot */
        recenter() {
            controls.target.copy(pose).setZ(pose.z + 0.3)
            camera.position.copy(pose).add(new THREE.Vector3(-5, -5, 4.5))
        },
        resize,
        dispose() {
            cancelAnimationFrame(frame)
            observer.disconnect()
            removeEventListener("dim-theme", theme)
            controls.dispose()
            renderer.dispose()
        },
    }
}
