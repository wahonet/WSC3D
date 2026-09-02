import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { modelUrl } from '../../api'
import { useApp } from '../../store/useApp'
import type { AssetBrief } from '../../types'
import { Range, Spinner } from '../ui'

const AMBER = 0xe8a33d
const BLUE = 0x2b8ac9
const SELECT = 0xff5a45

interface Stash {
  scene?: THREE.Scene; camera?: THREE.PerspectiveCamera; renderer?: THREE.WebGLRenderer
  controls?: OrbitControls; model?: THREE.Object3D; markers: Map<number, THREE.Object3D>
  lights: { light: THREE.Light; base: number }[]
  measureA?: THREE.Vector3 | null; tempObjs: THREE.Object3D[]; raf: number; diag: number
  center?: THREE.Vector3
  drawSaved?: () => void
  resetCamera?: () => void
  dolly?: (f: number) => void
}

export default function Viewer3D({ asset }: { asset: AssetBrief }) {
  const tool = useApp(s => s.tool)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const viewerCmd = useApp(s => s.viewerCmd)
  const select = useApp(s => s.select)
  const createShape = useApp(s => s.createShape)

  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | string>('loading')
  const [brightness, setBrightness] = useState(1.2)
  const S = useRef<Stash>({ markers: new Map(), lights: [], tempObjs: [], raf: 0, diag: 1 })

  const toolRef = useRef(tool); toolRef.current = tool
  const annosRef = useRef(annos); annosRef.current = annos
  const selRef = useRef<number | null>(selectedId); selRef.current = selectedId
  const createRef = useRef(createShape); createRef.current = createShape
  const selectRef = useRef(select); selectRef.current = select

  useEffect(() => {
    for (const { light, base } of S.current.lights) light.intensity = base * brightness
  }, [brightness])

  useEffect(() => {
    const host = hostRef.current!
    const st = S.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x121110)
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    // 光照组合：半球光给石面均匀基础亮度，两盏平行光保留浮雕立体感
    const mk = (light: THREE.Light, base: number) => {
      light.intensity = base * 1.2
      scene.add(light)
      st.lights.push({ light, base })
      return light
    }
    mk(new THREE.HemisphereLight(0xfff6e8, 0x5f574b, 1.0), 1.0)
    mk(new THREE.AmbientLight(0xffffff, 0.5), 0.5)
    ;(mk(new THREE.DirectionalLight(0xffffff, 1.1), 1.1) as THREE.DirectionalLight).position.set(1, 2, 3)
    ;(mk(new THREE.DirectionalLight(0xffffff, 0.45), 0.45) as THREE.DirectionalLight).position.set(-2, -1, -2)
    Object.assign(st, { scene, camera, renderer, controls })

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(host)
    const loop = () => { st.raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera) }
    loop()

    // MTL 的 Kd=0.588 会把贴图亮度乘到六成，这里统一置白
    const fixMaterials = (obj: THREE.Object3D) => {
      obj.traverse(o => {
        const mesh = o as THREE.Mesh
        if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of mats) {
          const pm = mat as THREE.MeshPhongMaterial
          if (pm.map) pm.map.colorSpace = THREE.SRGBColorSpace
          if (pm.color) pm.color.set(0xffffff)
          if (pm.specular) pm.specular.set(0x0a0a0a)
          if ('shininess' in pm) pm.shininess = 6
          pm.needsUpdate = true
        }
      })
    }

    st.resetCamera = () => {
      if (!st.center) return
      camera.position.set(st.center.x, st.center.y, st.center.z + st.diag * 0.9)
      controls.target.copy(st.center); controls.update()
    }
    st.dolly = (f: number) => {
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target)
      dir.multiplyScalar(f)
      camera.position.copy(controls.target).add(dir)
      controls.update()
    }

    const mtlName = asset.extra?.mtl
    const objUrl = modelUrl(asset.id, asset.filename)
    const onObj = (obj: THREE.Object3D) => {
      fixMaterials(obj)
      const box = new THREE.Box3().setFromObject(obj)
      const c = box.getCenter(new THREE.Vector3())
      st.diag = box.getSize(new THREE.Vector3()).length()
      st.center = c
      camera.near = st.diag / 1000; camera.far = st.diag * 40; camera.updateProjectionMatrix()
      st.resetCamera?.()
      scene.add(obj)
      st.model = obj
      setStatus('ready')
      drawSaved()
    }
    const fail = (e: unknown) => setStatus(`模型加载失败：${String(e)}`)
    if (mtlName) {
      new MTLLoader().load(modelUrl(asset.id, mtlName), materials => {
        materials.preload()
        const l = new OBJLoader(); l.setMaterials(materials); l.load(objUrl, onObj, undefined, fail)
      }, undefined, () => new OBJLoader().load(objUrl, onObj, undefined, fail))
    } else {
      new OBJLoader().load(objUrl, onObj, undefined, fail)
    }

    // 射线拾取
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const setNdc = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
    }
    const pick = (e: PointerEvent): THREE.Vector3 | null => {
      if (!st.model) return null
      setNdc(e)
      const hit = ray.intersectObject(st.model, true)[0]
      return hit ? hit.point.clone() : null
    }
    const pickMarker = (e: PointerEvent): number | null => {
      setNdc(e)
      for (const [id, obj] of st.markers) if (ray.intersectObject(obj, true).length > 0) return id
      return null
    }
    function markerMesh(color: number) {
      return new THREE.Mesh(
        new THREE.SphereGeometry(st.diag / 260, 18, 18),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }))
    }

    let downAt = 0
    const onDown = () => { downAt = Date.now() }
    const onUp = (e: PointerEvent) => {
      if (Date.now() - downAt > 260 || e.button !== 0) return
      const t = toolRef.current
      if (t === 'select') {
        selectRef.current(pickMarker(e))
      } else if (t === 'annotate') {
        const p = pick(e)
        if (p) createRef.current({ atype: 'point3d', geometry: { p: [p.x, p.y, p.z] } })
      } else if (t === 'measure') {
        const p = pick(e)
        if (!p) return
        if (!st.measureA) {
          st.measureA = p
          const m = markerMesh(AMBER); m.position.copy(p)
          scene.add(m); st.tempObjs.push(m)
        } else {
          const a = st.measureA; st.measureA = null
          st.tempObjs.forEach(o => scene.remove(o)); st.tempObjs = []
          createRef.current({
            atype: 'line3d', geometry: { p1: [a.x, a.y, a.z], p2: [p.x, p.y, p.z] },
            value: a.distanceTo(p), unit: 'model_unit',
          })
        }
      }
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    function drawSaved() {
      st.markers.forEach(o => scene.remove(o)); st.markers.clear()
      for (const a of annosRef.current) {
        const g = a.geometry as Record<string, number[]>
        const grp = new THREE.Group()
        if (a.atype === 'point3d' && g.p) {
          const m = markerMesh(AMBER); m.position.fromArray(g.p); grp.add(m)
        } else if (a.atype === 'line3d' && g.p1 && g.p2) {
          const p1 = new THREE.Vector3().fromArray(g.p1), p2 = new THREE.Vector3().fromArray(g.p2)
          const m1 = markerMesh(BLUE); m1.position.copy(p1)
          const m2 = markerMesh(BLUE); m2.position.copy(p2)
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]),
            new THREE.LineBasicMaterial({ color: BLUE, depthTest: false }))
          grp.add(m1, m2, line)
        } else continue
        scene.add(grp)
        st.markers.set(a.id, grp)
      }
      highlight()
    }
    function highlight() {
      for (const [id, obj] of st.markers) {
        const base = annosRef.current.find(x => x.id === id)?.atype === 'line3d' ? BLUE : AMBER
        obj.traverse(o => {
          const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial | undefined
          if (mat && 'color' in mat) mat.color.setHex(id === selRef.current ? SELECT : base)
        })
      }
    }
    st.drawSaved = drawSaved

    return () => {
      cancelAnimationFrame(st.raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.dispose()
      host.innerHTML = ''
      S.current = { markers: new Map(), lights: [], tempObjs: [], raf: 0, diag: 1 }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id])

  useEffect(() => { S.current.drawSaved?.() }, [annos, selectedId])

  useEffect(() => {
    if (!viewerCmd) return
    if (viewerCmd.cmd === 'fit') S.current.resetCamera?.()
    else S.current.dolly?.(viewerCmd.cmd === 'zoomIn' ? 1 / 1.4 : 1.4)
  }, [viewerCmd])

  return (
    <div className="viewport">
      <div className="three-host" ref={hostRef} />
      {status !== 'ready' && (
        <div className="loading-mask">
          {status === 'loading' ? <><Spinner />载入三维低模…</> : status}
        </div>
      )}
      <div className="vp-float bl">
        <span><b>三维 · {asset.kind_label}</b></span>
        <span className="muted">拖拽旋转 / 滚轮缩放 / 右键平移 · 测量为<b>模型单位</b>（未标定，不得当作厘米）</span>
      </div>
      <div className="vp-float tr" style={{ gap: 10 }}>
        <span className="muted">亮度 {brightness.toFixed(1)}x</span>
        <Range min={0.4} max={2.6} step={0.1} value={brightness} style={{ width: 120 }}
          onChange={e => setBrightness(Number(e.target.value))} />
      </div>
    </div>
  )
}
