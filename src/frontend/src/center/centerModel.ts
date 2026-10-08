import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import project from './centerProject.json'
import placement from '../archive/three/hanwenhuaCenterPlacement.json'
import context from '../archive/three/siteContextManifest.json'

/** 分层查看：整体、揭顶（去屋顶）、单独一层，或各层分开抬升的爆炸视图。 */
export type CenterMode = 'all' | 'noroof' | 'F2' | 'F1' | 'B1' | 'explode'
/** center_level of every mesh (build_center_blender.py, build_center_project_blender.py). */
export type CenterLevel = 'B1' | 'F1' | 'F2' | 'RF' | 'site'
export type StoreyLevel = 'B1' | 'F1' | 'F2'
export type SystemKey = 'supply' | 'exhaust' | 'smoke' | 'ac' | 'water' | 'drain' | 'rain' | 'sprinkler'
export interface CenterLayers { zones: boolean; exhibit: boolean; structure: boolean; hvac: boolean; plumbing: boolean; landscape: boolean; shrine: boolean; redline: boolean }
export const DEFAULT_LAYERS: CenterLayers = { zones: true, exhibit: true, structure: false, hvac: false, plumbing: false, landscape: true, shrine: true, redline: true }

export const HVAC: SystemKey[] = ['supply', 'exhaust', 'smoke', 'ac']
export const PLUMBING: SystemKey[] = ['water', 'drain', 'rain', 'sprinkler']
/** Storey lifts of the exploded view (m); the basement rises clear of the ground. */
export const EXPLODE_LIFT: Record<CenterLevel, number> = { B1: 10, F1: 34, F2: 58, RF: 80, site: 0 }
const LEVELS = Object.keys(EXPLODE_LIFT) as CenterLevel[]
/** Interior walls, slabs and stairs take the storey's colour family while zones are shown. */
const FAMILY_TINT: Record<StoreyLevel, string> = { B1: '#d3e2ef', F1: '#f1e0cb', F2: '#e2d8ef' }

/** center_part of the fit-out: a hall's ceiling surfaces, and what hangs under them (canopies, trusses, lanterns) */
type FitoutPart = 'ceiling' | 'hung'
interface Part { mesh: THREE.Mesh; level: CenterLevel; role: string; system?: SystemKey; zone?: string; part?: FitoutPart; y: number
  base: THREE.Material | THREE.Material[]; tinted?: THREE.Material | THREE.Material[] }
interface Interior { inside: boolean; ceilings: boolean }

function shown(mode: CenterMode, layers: CenterLayers, interior: Interior, part: Part) {
  const { level, role } = part
  // The ground must leave the sunken courts and garage ramp open in exterior views.
  if (role === 'opening_mask') return mode === 'all' || mode === 'noroof'
  if (role === 'b1_mask') return false
  // the fit-out sits inside the closed building; ceilings and what hangs from them appear only inside a hall,
  // and the ceilings can be taken away to look in from above
  if (role === 'fitout' && (!layers.exhibit || mode === 'all' || part.part && !interior.inside
    || part.part === 'ceiling' && !interior.ceilings)) return false
  // the V2 schematic trees give way to the planting drawings' species when those are shown
  if (role === 'vegetation' && level === 'site') return !layers.landscape && mode !== 'B1' && mode !== 'explode'
  if (role === 'interior_dark') return mode === 'all'
  if (role === 'zone' && (!layers.zones || mode === 'all' || interior.inside)) return false
  if (role === 'structure' && !layers.structure) return false
  if (role === 'mep' && !(HVAC.includes(part.system!) ? layers.hvac : layers.plumbing)) return false
  // the exploded storeys float over bare ground, so the planting does not read as part of the stack
  if (role === 'landscape') return layers.landscape && mode !== 'B1' && mode !== 'explode'
  if (role === 'massing') return layers.shrine && mode !== 'B1' && mode !== 'explode'
  if (level === 'site') return mode !== 'B1'
  if (mode === 'all' || mode === 'explode') return true
  if (mode === 'noroof') return level !== 'RF'
  return level === mode
}

export function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value) })
      material.dispose()
    }
  })
  textures.forEach(texture => texture.dispose())
}

const url = (entry: { glb: string; revision: string }) => './' + entry.glb + '?v=' + encodeURIComponent(entry.revision)

/** The courtyard's surroundings (roads, fields, village, trees) in the centre frame:
 * courtyard scene = Ry(θ) · centre + t, so the model is moved by −t and turned by −θ. */
function surroundings(root: THREE.Object3D) {
  const turn = new THREE.Group()
  turn.name = 'surrounding_environment'
  turn.rotation.y = -THREE.MathUtils.degToRad(placement.transform.rotationYDeg)
  const [tx, ty, tz] = placement.transform.translation
  root.position.set(-tx, -ty, -tz)
  turn.add(root)
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.raycast = () => {}
    mesh.castShadow = mesh.userData.context_role !== 'ground'
    mesh.receiveShadow = true
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      material.envMapIntensity = 0.35
      if (material.map) material.map.anisotropy = 4
    }
  })
  return turn
}

/** 传承中心建筑（带功能分区地面、V2 总图场地）、项目附属模型（景观、结构、机电、武氏祠白模及院落地面）
 * 与展陈装修模型（各展厅的装修、展项与吊顶），同一局部坐标系；外加院落场景的周边环境，反算到该坐标系，
 * 使场地布局与院落全景一致。 */
export function createCenterModel(scene: THREE.Scene, onProgress: (loaded: number, total: number) => void) {
  const group = new THREE.Group()
  group.name = 'hanwenhua_center_project'
  scene.add(group)
  const parts: Part[] = []
  const zoneMaterials = new Map<string, THREE.MeshStandardMaterial[]>()
  const tints = new Map<string, THREE.Material>()
  let mode: CenterMode = 'all'
  let layers: CenterLayers = { ...DEFAULT_LAYERS }
  const interior: Interior = { inside: false, ceilings: true }
  let environment: THREE.Object3D | null = null
  const lifts = Object.fromEntries(LEVELS.map(level => [level, 0])) as Record<CenterLevel, number>
  let from = { ...lifts }
  let progress = 1
  let highlighted = new Set<string>()

  const tinted = (material: THREE.Material, level: StoreyLevel) => {
    const key = material.uuid + level
    let copy = tints.get(key)
    if (!copy) {
      copy = material.clone()
      const m = copy as THREE.MeshStandardMaterial
      m.color = new THREE.Color(FAMILY_TINT[level])
      m.map = null
      tints.set(key, copy)
    }
    return copy
  }
  const place = () => { for (const part of parts) part.mesh.position.y = part.y + lifts[part.level] }
  const show = () => {
    for (const part of parts) {
      part.mesh.visible = shown(mode, layers, interior, part)
      if (part.tinted) part.mesh.material = layers.zones && mode !== 'all' && !interior.inside ? part.tinted : part.base
    }
    // the basement view lifts the whole ground off, surroundings included
    if (environment) environment.visible = mode !== 'B1'
  }

  function prepare(root: THREE.Object3D) {
    root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      // a multi-material node loads as a group of primitives; its extras stay on the group
      let tagged: THREE.Object3D | null = mesh
      while (tagged && tagged.userData.center_level === undefined) tagged = tagged.parent
      const data = tagged?.userData ?? mesh.userData
      const part: Part = { mesh, level: data.center_level ?? 'F1', role: data.center_role ?? 'shell', system: data.center_system,
        zone: data.zone_id, part: data.center_part, y: mesh.position.y, base: mesh.material }
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]
      // the V2 ground carries its trees' trunks as one of its primitives; they go with the V2 trees
      if (part.role === 'site' && materials.some(m => m.name.startsWith('树木枝干'))) part.role = 'vegetation'
      for (const material of materials) {
        material.side = THREE.DoubleSide
        if (part.role === 'opening_mask') {
          Object.assign(material, { colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
            stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp })
          mesh.renderOrder = -1
        }
        const physical = material as THREE.MeshPhysicalMaterial
        // plain alpha glass reads better from the orbiting viewpoints than a transmission pass
        if ((physical.transmission ?? 0) > 0.1) {
          physical.transmission = 0
          material.transparent = true
          material.opacity = /低铁|超白/.test(material.name) ? 0.1 : 0.28
          material.depthWrite = false
        }
        if (material.metalness > 0.8) material.metalness = 0.65
        // murals and case graphics are mostly seen along the walls
        if ((part.role === 'fitout' || material.name.startsWith('效果图_')) && material.map) material.map.anisotropy = 8
      }
      if (part.role === 'zone' && part.zone) {
        zoneMaterials.set(part.zone, materials)
        mesh.renderOrder = 1
      }
      if (part.role === 'interior' && (part.level === 'B1' || part.level === 'F1' || part.level === 'F2')) {
        const level = part.level
        part.tinted = Array.isArray(mesh.material) ? mesh.material.map(m => tinted(m, level)) : tinted(mesh.material, level)
      }
      const castless = part.role === 'zone' || part.role === 'yard' || part.part === 'ceiling' || part.role === 'landscape' && /绿地|铺装/.test((tagged ?? mesh).name)
      mesh.castShadow = !castless && part.role !== 'mep' && part.role !== 'opening_mask' && part.role !== 'b1_mask'
      mesh.receiveShadow = true
      parts.push(part)
    })
  }

  async function load() {
    const entries = [project.models.building, project.models.project, project.models.exhibition, { glb: context.asset, revision: context.version }]
    let done = 0
    onProgress(0, entries.length)
    const loader = new GLTFLoader()
    const roots = await Promise.all(entries.map(async entry => {
      const gltf = await loader.loadAsync(url(entry))
      onProgress(++done, entries.length)
      return gltf.scene
    }))
    const around = roots.pop()!
    for (const root of roots) {
      root.traverse(object => { if ((object as THREE.Camera).isCamera) object.removeFromParent() })
      prepare(root)
      group.add(root)
    }
    environment = surroundings(around)
    group.add(environment)
    show(); place()
  }

  function paintZones() {
    for (const [id, materials] of zoneMaterials) {
      for (const material of materials) {
        material.emissive.copy(material.color)
        material.emissiveIntensity = highlighted.has(id) ? 0.55 : 0
      }
    }
  }

  return {
    group,
    load,
    get mode() { return mode },
    setMode(next: CenterMode) {
      if (next === mode) return
      mode = next
      from = { ...lifts }
      progress = 0
      show()
    },
    setLayers(next: CenterLayers) { layers = next; show() },
    /** inside a hall: its storey's ceilings close the rooms and the zone plates and tint give way to the finishes */
    setInterior(on: boolean) { if (on !== interior.inside) { interior.inside = on; show() } },
    /** the halls' ceilings, while inside; off to look into a hall from above */
    setCeilings(on: boolean) { if (on !== interior.ceilings) { interior.ceilings = on; show() } },
    highlight(ids: string[]) { highlighted = new Set(ids); paintZones() },
    tick(dt: number) {
      if (progress >= 1) return false
      progress = Math.min(1, progress + dt / 0.9)
      const k = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
      for (const level of LEVELS) {
        const target = mode === 'explode' ? EXPLODE_LIFT[level] : 0
        lifts[level] = from[level] + (target - from[level]) * k
      }
      place()
      return true
    },
    lift: (level: CenterLevel) => lifts[level],
    /** zone id of a picked mesh, if any */
    zoneOf: (object: THREE.Object3D) => parts.find(p => p.mesh === object && p.role === 'zone')?.zone ?? null,
    dispose() {
      group.removeFromParent()
      disposeTree(group)
      tints.forEach(material => material.dispose())
    },
  }
}
export type CenterModel = ReturnType<typeof createCenterModel>
