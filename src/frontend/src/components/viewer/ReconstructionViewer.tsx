import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { reconstructionFile, type ReconstructionCase } from '../../lib/reconstruction'

export type ReconstructionView = 'iso' | 'front' | 'east' | 'plan' | 'focus'
type Props = {
  data: ReconstructionCase; visible: string[]; exploded: number; colored: boolean;
  selected: string; cut: number | null; grid: boolean;
  view: { name: ReconstructionView; revision: number }; onSelect: (id: string) => void;
  transforms?: Record<string, number[]>;
}
type Controls = { update: (props: Props) => void; view: (name: ReconstructionView, selected: string) => void }

function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return
    geometries.add(object.geometry)
    for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(mat)
      Object.values(mat).forEach(value => { if (value instanceof THREE.Texture) textures.add(value) })
    }
  })
  textures.forEach(t => { t.dispose(); if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close() })
  materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose())
}

export default function ReconstructionViewer(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null), controlsRef = useRef<Controls | null>(null), latest = useRef(props)
  latest.current = props
  const [state, setState] = useState('正在载入构件…'), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const { data } = props
  useEffect(() => {
    const host = hostRef.current!
    let disposed = false, raf = 0, root: THREE.Group | null = null, lost = false
    const abort = new AbortController()
    setState('正在载入构件…'); setError('')
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true }) }
    catch { setError('当前浏览器无法创建三维画布，可先查看下方保存的视图。'); return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3
    renderer.localClippingEnabled = true
    renderer.domElement.setAttribute('aria-label', '复原三维画布：拖动旋转，滚轮缩放，点击选择构件')
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, .01, 100)
    let span = 4.2
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true; orbit.dampingFactor = .12; orbit.minZoom = .2; orbit.maxZoom = 18
    const draw = () => { raf = 0; if (disposed || lost) return; orbit.update(); renderer.render(scene, camera) }
    const invalidate = () => { if (!disposed && !lost && !raf) raf = requestAnimationFrame(draw) }
    orbit.addEventListener('change', invalidate)
    scene.add(new THREE.HemisphereLight(0xfff3df, 0x8a969c, 2.4))
    const key = new THREE.DirectionalLight(0xfff6e7, 2.8); key.position.set(3, 6, -4); scene.add(key)
    const fill = new THREE.DirectionalLight(0xe3ebff, 1.7); fill.position.set(-4, 3, 3); scene.add(fill)
    const gridSize = data.parts.some(p => p.group === 'residual') ? 18 : 8
    const grid = new THREE.GridHelper(gridSize, gridSize * 2, 0x8f8171, 0x5a5750); grid.position.y = -.012; scene.add(grid)
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2)
    const groups = new Map<string, THREE.Object3D>(), origins = new Map<string, THREE.Vector3>()
    const mats: { partId: string; mat: THREE.MeshStandardMaterial; map: THREE.Texture | null; color: THREE.Color }[] = []
    const resize = () => {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight)
      renderer.setSize(w, h); camera.left = -span * w / h / 2; camera.right = span * w / h / 2
      camera.top = span / 2; camera.bottom = -span / 2; camera.updateProjectionMatrix(); invalidate()
    }
    const frame = (name: ReconstructionView, selected: string) => {
      const bounds = new THREE.Box3()
      const focus = name === 'focus' && groups.get(selected)
      if (focus) bounds.setFromObject(focus)
      else groups.forEach(g => { if (g.visible) bounds.expandByObject(g) })
      if (bounds.isEmpty()) bounds.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(3, 2, 3))
      const target = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
      const directions: Record<ReconstructionView, THREE.Vector3> = {
        iso: new THREE.Vector3(3.4, 2.2, -5), front: new THREE.Vector3(0, 0, -1),
        east: new THREE.Vector3(1, 0, 0), plan: new THREE.Vector3(0, 1, .00001), focus: camera.position.clone().sub(orbit.target),
      }
      camera.up.set(0, 1, 0); if (name === 'plan') camera.up.set(0, 0, -1)
      const dir = directions[name].normalize()
      const right = new THREE.Vector3().crossVectors(camera.up, dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right).normalize()
      const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight)
      const projectedWidth = Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z
      const projectedHeight = Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z
      span = Math.max(.4, projectedHeight, projectedWidth / aspect) * 1.18
      camera.position.copy(target).addScaledVector(dir, 12); camera.zoom = 1; orbit.target.copy(target); orbit.update(); resize()
    }
    const update = (p: Props) => {
      groups.forEach((g, id) => {
        const part = p.data.parts.find(part => part.id === id)!
        g.visible = p.visible.includes(id)
        const transform = p.transforms?.[id]
        if (transform) new THREE.Matrix4().fromArray(transform).decompose(g.position, g.quaternion, g.scale)
        else g.position.copy(origins.get(id)!)
        g.position.addScaledVector(new THREE.Vector3(...part.explodeGltf), p.exploded)
        g.updateMatrixWorld(true)
      })
      for (const item of mats) {
        const part = p.data.parts.find(part => part.id === item.partId)!
        const map = p.colored ? null : item.map
        if (item.mat.map !== map) { item.mat.map = map; item.mat.needsUpdate = true }
        item.mat.color.copy(p.colored ? new THREE.Color(part.color) : item.color)
        item.mat.emissive.set(part.id === p.selected ? part.color : '#000000')
        item.mat.emissiveIntensity = part.id === p.selected ? .13 : 0
      }
      grid.visible = p.grid
      cutPlane.constant = p.cut ?? 10; renderer.clippingPlanes = p.cut === null ? [] : [cutPlane]
      invalidate()
    }
    const updateTheme = () => {
      scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim() || '#121110')
      invalidate()
    }
    const observer = new ResizeObserver(resize); observer.observe(host)
    const themeObserver = new MutationObserver(updateTheme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    updateTheme(); resize()
    const onLost = (event: Event) => { event.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; setError('三维画布已被浏览器回收，请重新载入。') }
    renderer.domElement.addEventListener('webglcontextlost', onLost)
    const raycaster = new THREE.Raycaster(); let pointerStart = [0, 0]
    const onDown = (event: PointerEvent) => { pointerStart = [event.clientX, event.clientY] }
    const onUp = (event: PointerEvent) => {
      if (!root || event.button !== 0 || Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 5) return
      const rect = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera)
      for (const hit of raycaster.intersectObject(root, true)) {
        if (latest.current.cut !== null && hit.point.y > latest.current.cut) continue
        let obj: THREE.Object3D | null = hit.object, id = '', shown = true
        while (obj) { shown &&= obj.visible; if (obj.userData.partId) id = String(obj.userData.partId); obj = obj.parent }
        if (shown && id) { latest.current.onSelect(id); return }
      }
    }
    renderer.domElement.addEventListener('pointerdown', onDown); renderer.domElement.addEventListener('pointerup', onUp)
    controlsRef.current = { update, view: frame }
    void (async () => {
      try {
        const response = await fetch(reconstructionFile(data.id, data.sceneFile), { signal: abort.signal })
        if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新进入工作台。' : `模型文件读取失败（${response.status}）`)
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let loaded = 0
        if (!reader) throw new Error('浏览器无法读取模型文件')
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          chunks.push(value); loaded += value.length
          if (!disposed) setState(`载入 ${data.parts.length} 件构件 · ${Math.min(100, Math.round(loaded / data.sceneBytes * 100))}%`)
        }
        if (disposed) return
        setState('正在解析模型与贴图…')
        const buffer = new Uint8Array(loaded); let offset = 0
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
        const gltf = await new GLTFLoader().parseAsync(buffer.buffer, '')
        if (disposed) { disposeTree(gltf.scene); return }
        root = gltf.scene
        root.traverse(object => {
          if (object.userData.partId) { const id = String(object.userData.partId); groups.set(id, object); origins.set(id, object.position.clone()) }
        })
        if (data.parts.some(p => !groups.has(p.id))) throw new Error('模型构件与研究清单不一致')
        groups.forEach((group, partId) => group.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const mat of materials) if (mat instanceof THREE.MeshStandardMaterial) {
            mats.push({ partId, mat, map: mat.map, color: mat.color.clone() })
            mat.map && (mat.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()))
            mat.side = THREE.DoubleSide
          }
        }))
        scene.add(root); update(latest.current); frame(latest.current.view.name, latest.current.selected); invalidate(); setState('')
      } catch (reason) {
        if (!disposed && !(reason instanceof DOMException && reason.name === 'AbortError')) setError((reason as Error).message || '模型载入失败')
      }
    })()
    return () => {
      disposed = true; abort.abort(); controlsRef.current = null; cancelAnimationFrame(raf)
      observer.disconnect(); themeObserver.disconnect(); orbit.removeEventListener('change', invalidate); orbit.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('pointerup', onUp)
      // Map-free color mode still owns the original textures.
      mats.forEach(item => { item.mat.map = item.map })
      if (root && !root.parent) disposeTree(root)
      disposeTree(scene); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    }
  }, [data.id, data.sceneFile, data.sceneBytes, retry])
  useEffect(() => { controlsRef.current?.update(props) }, [props.visible, props.exploded, props.colored, props.selected, props.cut, props.grid, props.transforms])
  useEffect(() => { controlsRef.current?.view(props.view.name, props.selected) }, [props.view])
  return <div className="rc-viewer">
    <div className="rc-canvas" ref={hostRef} />
    {(state || error) && <div className="rc-loading"><img src={reconstructionFile(data.id, data.previewFile)} alt="首次配置保存视图" /><div role={error ? 'alert' : 'status'}><span>{error || state}</span>{error && <button onClick={() => setRetry(n => n + 1)}>重新载入</button>}</div></div>}
    <div className="rc-viewport-label"><span>{props.exploded > 0 ? '构件分解' : '组合查看'}</span><small>正交视图 · {data.parts.length} 件现存模型</small></div>
    <div className="rc-viewport-footer"><span>拖动旋转 · 滚轮缩放 · 右键平移 · 点击石件查看依据</span><span>{props.cut === null ? `网格 0.5 ${data.unitLabel || '工作米'}` : `水平截取 ${props.cut.toFixed(2)} ${data.unitLabel || '工作米'} · 切口未封面`}</span></div>
  </div>
}
