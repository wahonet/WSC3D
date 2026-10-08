import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createCenterModel, DEFAULT_LAYERS, EXPLODE_LIFT, type CenterLayers, type CenterLevel, type CenterMode, type StoreyLevel } from './centerModel'
import zonesData from './centerZones.json'
import project from './centerProject.json'
import redline from './centerRedline.json'
import exhibition from './centerExhibition.json'

export type Hall = typeof exhibition.halls[number]

/** 传承中心局部米制坐标（X 东、Y 北，Z 相对 ±0.000）→ three 坐标（glTF Y 向上）。 */
const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)
/** below the surroundings' ground (−0.51) and the courtyard's own neutral plane */
const PLINTH_Z = -0.62
/** the red line rides just above the site paving and planting */
const REDLINE_Z = -0.3
const REDLINE_HALF = 0.7
const REDLINE_FENCE = 1.2
const STOREY_Z: Record<StoreyLevel, number> = { B1: zonesData.levels.B1.floor, F1: 0, F2: zonesData.levels.F2.floor }
const EXPLODE_TITLES: { level: CenterLevel; text: string; z: number }[] = [
  { level: 'RF', text: '屋顶', z: 9 },
  { level: 'F2', text: '二层 +5.40', z: 6.6 },
  { level: 'F1', text: '一层 ±0.00', z: 1.6 },
  { level: 'B1', text: '负一层 −4.80', z: -3.2 },
]
/** Small rooms keep their colour but not a label, so the plans stay readable. */
const LABEL_AREA = 24
/** candela per unit of the hall lights in centerExhibition.json */
const HALL_LIGHT = 0.5
const ORBIT_FOV = 40
const HALL_FOV = 62

interface Label {
  el: HTMLElement; level: CenterLevel; x: number; y: number; z: number; kind: 'zone' | 'storey' | 'landmark'; zone?: string
  /** shown only while this layer is on */
  layer?: keyof CenterLayers
  /** larger first when labels collide */
  rank: number; transform: string; w: number; h: number
}

/** 用地红线：地面上的红色带（按转角斜接）加一圈低矮的半透明红色围栏，从低角度看也清楚。 */
function redlineMesh() {
  const pts = redline.points
  const n = pts.length
  const ribbon: number[] = [], fence: number[] = [], index: number[] = [], fenceIndex: number[] = []
  const unit = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l] }
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i], [ax, ay] = pts[(i + n - 1) % n], [bx, by] = pts[(i + 1) % n]
    const [d0x, d0y] = unit(px - ax, py - ay), [d1x, d1y] = unit(bx - px, by - py)
    // the loop runs counter-clockwise, so the left normal points into the plot
    const [mx, my] = unit(-d0y - d1y, d0x + d1x)
    const k = Math.min(3, 1 / Math.max(0.2, mx * -d1y + my * d1x)) * REDLINE_HALF
    for (const s of [k, -k]) { const v = toWorld(px + mx * s, py + my * s, REDLINE_Z); ribbon.push(v.x, v.y, v.z) }
    for (const z of [REDLINE_Z, REDLINE_Z + REDLINE_FENCE]) { const v = toWorld(px, py, z); fence.push(v.x, v.y, v.z) }
    const a = 2 * i, b = 2 * ((i + 1) % n)
    index.push(a, a + 1, b, b, a + 1, b + 1)
    fenceIndex.push(a, b, a + 1, a + 1, b, b + 1)
  }
  const group = new THREE.Group()
  group.name = 'center_redline'
  const make = (positions: number[], indices: number[], material: THREE.Material) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = 3
    group.add(mesh)
  }
  make(ribbon, index, new THREE.MeshBasicMaterial({ color: '#e5322d', toneMapped: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))
  make(fence, fenceIndex, new THREE.MeshBasicMaterial({ color: '#e5322d', toneMapped: false, side: THREE.DoubleSide,
    transparent: true, opacity: 0.22, depthWrite: false }))
  return group
}

export interface StageCallbacks {
  onProgress(loaded: number, total: number): void
  onReady(): void
  onError(error: unknown): void
  onPick(zone: string | null): void
}

export function createCenterStage(host: HTMLElement, callbacks: StageCallbacks) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.className = 'center-canvas'
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment
  scene.environmentIntensity = 0.35
  const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.5, 3000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  controls.minDistance = 6
  controls.maxDistance = 900

  const hemi = new THREE.HemisphereLight('#e8eef5', '#8c826f', 1.25)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight('#fff4e2', 2.4)
  sun.position.set(-120, 220, 160)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 700 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.6
  sun.target.position.set(0, 0, -40)
  scene.add(sun, sun.target)
  // a quiet plinth beyond the drawings' extent; it drops under the basement when the ground is lifted off
  const plinth = new THREE.Mesh(new THREE.CircleGeometry(1400, 96), new THREE.MeshStandardMaterial({
    color: '#cfc9bd', roughness: 1,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
  }))
  plinth.rotation.x = -Math.PI / 2
  plinth.position.y = PLINTH_Z
  plinth.receiveShadow = true
  scene.add(plinth)

  const model = createCenterModel(scene, callbacks.onProgress)
  const red = redlineMesh()
  scene.add(red)

  // ---------------------------------------------------------------- labels
  const labelRoot = document.createElement('div')
  labelRoot.className = 'center-labels'
  labelRoot.setAttribute('aria-hidden', 'true')
  host.appendChild(labelRoot)
  const labels: Label[] = []
  const addLabel = (text: string, className: string, entry: Omit<Label, 'el' | 'transform' | 'w' | 'h'>) => {
    const el = document.createElement('span')
    el.className = className
    el.textContent = text
    el.hidden = true
    labelRoot.appendChild(el)
    labels.push({ ...entry, el, transform: '', w: 0, h: 0 })
  }
  const MAJOR = ['exhibit', 'perform', 'collection']
  for (const [level, data] of Object.entries(zonesData.levels) as [StoreyLevel, typeof zonesData.levels.B1][]) {
    for (const zone of data.zones) {
      const major = MAJOR.includes(zone.function)
      if (!major && zone.area < LABEL_AREA) continue
      addLabel(zone.name, 'center-label', { level, x: zone.p[0], y: zone.p[1], z: zone.z + 1.5, kind: 'zone', zone: zone.id, rank: zone.area + (major ? 1e4 : 0) })
    }
  }
  for (const title of EXPLODE_TITLES) addLabel(title.text, 'center-label storey', { level: title.level, x: -66, y: 40, z: title.z, kind: 'storey', rank: 1e6 })
  for (const mark of project.landmarks) addLabel(mark.name, 'center-label landmark', { level: 'site', x: mark.p[0], y: mark.p[1], z: mark.z, kind: 'landmark', rank: 1e6 })
  const [redX, redY] = redline.points.reduce((a, p) => (p[0] - p[1] > a[0] - a[1] ? p : a))
  addLabel(`用地红线 · 约 ${(redline.areaM2 / 1e4).toFixed(2)} 公顷`, 'center-label landmark redline', { level: 'site', x: redX, y: redY, z: 2, kind: 'landmark', layer: 'redline', rank: 1e6 })
  labels.sort((a, b) => b.rank - a.rank)

  let layers: CenterLayers = { ...DEFAULT_LAYERS }
  let selected: string | null = null
  let inside: Hall | null = null
  const hallLights = new THREE.Group()
  hallLights.name = 'center_hall_lights'
  scene.add(hallLights)
  const showRedline = () => { red.visible = layers.redline && model.mode !== 'B1' && !inside }
  const labelShown = (label: Label) => {
    const mode = model.mode
    if (inside) return false
    if (label.layer && !layers[label.layer]) return false
    if (label.kind === 'storey') return mode === 'explode'
    if (label.kind === 'landmark') return mode === 'all' || mode === 'noroof'
    return layers.zones && (mode === label.level || (label.zone === selected && mode !== 'all'))
  }
  const view = new THREE.Vector3()
  const ANCHOR = { zone: [0.5, 0.5], storey: [1, 0.5], landmark: [0.5, 1] } as const
  function updateLabels() {
    const width = host.clientWidth, height = host.clientHeight
    const placed: number[][] = []
    const ordered = selected ? [...labels.filter(l => l.zone === selected), ...labels.filter(l => l.zone !== selected)] : labels
    for (const label of ordered) {
      let visible = labelShown(label)
      if (visible) {
        const point = toWorld(label.x, label.y, label.z + model.lift(label.level))
        view.copy(point).applyMatrix4(camera.matrixWorldInverse)
        point.project(camera)
        visible = view.z < -camera.near && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1
        let sx = (point.x + 1) * width / 2
        const sy = (1 - point.y) * height / 2
        if (visible) {
          if (!label.w) { label.el.hidden = false; label.w = label.el.offsetWidth; label.h = label.el.offsetHeight }
          if (label.kind === 'storey') sx = Math.max(sx, label.w + 10)
          const [ax, ay] = ANCHOR[label.kind]
          const box = [sx - ax * label.w - 2, sy - ay * label.h - 2, sx + (1 - ax) * label.w + 2, sy + (1 - ay) * label.h + 2]
          visible = !placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])
          if (visible) placed.push(box)
        }
        const transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`
        if (visible && label.transform !== transform) { label.el.style.transform = transform; label.transform = transform }
      }
      label.el.classList.toggle('selected', label.zone !== undefined && label.zone === selected)
      if (label.el.hidden === visible) label.el.hidden = !visible
    }
  }

  // ---------------------------------------------------------------- camera
  let flight: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number } | null = null
  function flyTo(position: THREE.Vector3, target: THREE.Vector3, instant = false) {
    if (instant) { camera.position.copy(position); controls.target.copy(target); controls.update(); return }
    flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1: position, t1: target, k: 0 }
  }
  /** View from the south-east over (x, y, z) of the centre frame. */
  function orbitView(x: number, y: number, z: number, elevation: number, distance: number, instant = false) {
    // the views are framed for a landscape canvas; back off on narrow ones
    distance *= Math.max(1, 1.5 / camera.aspect)
    const run = Math.cos(elevation) * distance
    flyTo(toWorld(x + 0.5 * run, y - 0.86 * run, z + Math.sin(elevation) * distance), toWorld(x, y, z), instant)
  }
  function viewFor(mode: CenterMode, instant = false) {
    // the plot and the shrine south-west of it
    if (mode === 'all') orbitView(0, 42, 0, 0.60, 245, instant)
    else if (mode === 'noroof') orbitView(0, 52, 0, 0.78, 205, instant)
    else if (mode === 'explode') orbitView(0, 48, 42, 0.2, 235, instant)
    else orbitView(0, 52, STOREY_Z[mode], 1.02, 175, instant)
  }

  // ---------------------------------------------------------------- picking
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let down: { x: number; y: number } | null = null
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY } }
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) { down = null; return }
    down = null
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(model.group, true).find(h => h.object.visible && isShown(h.object))
    callbacks.onPick(hit ? model.zoneOf(hit.object) : null)
  }
  const isShown = (object: THREE.Object3D) => {
    for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false
    const material = (object as THREE.Mesh).material as THREE.Material
    return material.colorWrite && !(material.transparent && material.opacity < 0.5)
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)

  // ---------------------------------------------------------------- theme, size and loop
  function applyTheme() {
    const light = document.documentElement.dataset.theme !== 'dark'
    const sky = new THREE.Color(inside ? '#0c0b0a' : light ? '#e7ebee' : '#1f2328')
    scene.background = sky
    // inside a hall the daylight gives way to the hall's own lights, murals and light boxes
    scene.fog = inside ? null : new THREE.Fog(sky, 700, 1900)
    ;(plinth.material as THREE.MeshStandardMaterial).color.set(light ? '#d2ccc0' : '#6f6a60')
    hemi.color.set(inside ? '#ffe6c8' : '#e8eef5')
    hemi.groundColor.set(inside ? '#3a2e24' : '#8c826f')
    hemi.intensity = inside ? 0.3 : light ? 1.25 : 0.95
    sun.visible = !inside
    scene.environmentIntensity = inside ? 0.12 : 0.35
    dirty = true
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  let dirty = true
  let active = true
  let size = { w: 0, h: 0 }
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight
    if (w < 2 || h < 2 || (w === size.w && h === size.h)) return
    size = { w, h }
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    dirty = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  controls.addEventListener('change', () => { dirty = true })

  let raf = 0
  let last = performance.now()
  const loop = () => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (!active || document.hidden) return
    if (flight) {
      flight.k = Math.min(1, flight.k + dt / 1.1)
      const k = flight.k < 0.5 ? 4 * flight.k ** 3 : 1 - (-2 * flight.k + 2) ** 3 / 2
      camera.position.lerpVectors(flight.p0, flight.p1, k)
      controls.target.lerpVectors(flight.t0, flight.t1, k)
      if (flight.k >= 1) flight = null
      dirty = true
    }
    if (model.tick(dt)) { dirty = true; renderer.shadowMap.needsUpdate = true }
    controls.update()
    if (!dirty) return
    dirty = false
    renderer.render(scene, camera)
    updateLabels()
  }

  applyTheme()
  resize()
  viewFor('all', true)
  loop()
  model.load().then(() => { dirty = true; callbacks.onReady() }).catch(callbacks.onError)

  function applyMode(mode: CenterMode) {
    model.setMode(mode)
    plinth.position.y = mode === 'B1' ? Math.min(STOREY_Z.B1, -5.1) - 0.35 : PLINTH_Z
    showRedline()
    dirty = true
  }
  const hallView = (hall: Hall) => flyTo(toWorld(...(hall.eye as [number, number, number])), toWorld(...(hall.target as [number, number, number])))
  function enterHall(id: string) {
    const hall = exhibition.halls.find(h => h.id === id)
    if (!hall) return
    inside = hall
    applyMode(hall.level as StoreyLevel)
    model.setInterior(true)
    hallLights.clear()
    for (const [x, y, z, power, color] of hall.lights as [number, number, number, number, string][]) {
      const lamp = new THREE.PointLight(color, power * HALL_LIGHT, 0, 2)
      lamp.position.copy(toWorld(x, y, z))
      hallLights.add(lamp)
    }
    // halls are seen like the design renders, through a wide lens from inside the room
    camera.fov = HALL_FOV
    camera.near = 0.05
    camera.updateProjectionMatrix()
    Object.assign(controls, { minDistance: 0.5, maxDistance: 45, maxPolarAngle: Math.PI - 0.15 })
    applyTheme()
    showRedline()
    hallView(hall)
  }
  function leaveHall() {
    if (!inside) return
    inside = null
    hallLights.clear()
    model.setInterior(false)
    camera.fov = ORBIT_FOV
    camera.near = 0.5
    camera.updateProjectionMatrix()
    Object.assign(controls, { minDistance: 6, maxDistance: 900, maxPolarAngle: Math.PI / 2 - 0.02 })
    applyTheme()
    showRedline()
  }

  return {
    setMode(mode: CenterMode) {
      leaveHall()
      applyMode(mode)
      viewFor(mode)
    },
    /** walk into an exhibition hall (centerExhibition.json) */
    enterHall,
    leaveHall() { leaveHall(); viewFor(model.mode) },
    /** the halls' ceilings while inside; hung trusses, canopies and lanterns stay */
    setCeilings(on: boolean) { model.setCeilings(on); dirty = true },
    setLayers(next: CenterLayers) { layers = next; model.setLayers(next); showRedline(); dirty = true },
    select(zone: string | null) { selected = zone; model.highlight(zone ? [zone] : []); dirty = true },
    highlight(zones: string[]) { model.highlight(selected ? [...zones, selected] : zones); dirty = true },
    focusZone(level: StoreyLevel, x: number, y: number) {
      const z = STOREY_Z[level] + (model.mode === 'explode' ? EXPLODE_LIFT[level] : 0)
      orbitView(x, y, z, 1.0, 62)
    },
    resetView() { if (inside) hallView(inside); else viewFor(model.mode) },
    setActive(on: boolean) { active = on; if (on) { resize(); dirty = true } },
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      themeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      controls.dispose()
      model.dispose()
      plinth.geometry.dispose(); (plinth.material as THREE.Material).dispose()
      red.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
      environment.dispose(); pmrem.dispose()
      sun.shadow.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      labelRoot.remove()
    },
  }
}
export type CenterStage = ReturnType<typeof createCenterStage>
