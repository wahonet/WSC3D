import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three-inventory';
import { OrbitControls } from 'three-inventory/examples/jsm/controls/OrbitControls';
import { buildSite } from './buildSite';
import { createRenderLook, type RenderLook } from './renderLook';
import { createStoneTextures } from './progressiveStoneTextures';
import { createGpuQueue, yieldToBrowser } from './assetScheduling';
import { watchXclLayout } from './xclLayout';
import { watchRearLayout } from './rearHallLayout';
import { createRearExhibition } from './rearExhibition';
import catalogueMap from './catalogueMap.json';
import { applyCatalogue } from './catalogue';
import { createPhotoModels } from './photoModels';
import { setupInteractions } from './interactions';
import { worldToGeographic } from './georeference';
import { createSiteContextLayer } from './siteContext';
import { createWallXray } from './wallXray';
import { createCourtyardArchitecture, type ArchitectureStatus } from './courtyardArchitecture';
import { useStore } from '../store';
import { loadMetric } from './loadDiagnostics';
import { createDoors, type DoorInfo } from './doors';
import { createSceneNavigation } from './sceneNavigation';
import { watchSceneTheme } from './sceneTheme';

/**
 * 持久化三维院落画布: 全程只创建一次(场景/相机/交互不随模块切换销毁),
 * 通过 store.stageSlot 停靠到当前模块的槽位上——
 * 台账模块的右下角小地图与全景模块的主视区共用同一画面, 相机状态无缝延续。
 */
export default function SiteStage() {
  const [architectureStatus, setArchitectureStatus] = useState<ArchitectureStatus>('loading');
  const [textureProgress, setTextureProgress] = useState({ loaded: 0, total: 150 });
  const [initializationError, setInitializationError] = useState(false);
  const [doorList, setDoorList] = useState<DoorInfo[]>([]);
  const [hoveredDoor, setHoveredDoor] = useState<string | null>(null);
  const closeDoors = useRef<() => void>(() => {});
  const hostRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<{ renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; look: RenderLook } | null>(null);
  const slotElRef = useRef<HTMLElement | null>(null);
  const lastRect = useRef({ l: -1, t: -1, w: -1, h: -1 });
  const dirty = useRef(true);
  const select = useStore(s => s.select);
  const setCtrl = useStore(s => s.setCtrl);
  const setWalkState = useStore.setState;
  const selectedId = useStore(s => s.selectedId);
  const ctrl = useStore(s => s.ctrl);
  const stageSlot = useStore(s => s.stageSlot);
  const walkOn = useStore(s => s.walkOn);

  /* 每帧把画布对齐到槽位矩形(位置或尺寸变化才写样式/重设渲染尺寸) */
  const syncDock = () => {
    const slot = slotElRef.current, gl = glRef.current, host = hostRef.current;
    if (!slot || !gl || !host) return;
    const r = slot.getBoundingClientRect();
    const L = lastRect.current;
    if (r.left === L.l && r.top === L.t && r.width === L.w && r.height === L.h) return;
    lastRect.current = { l: r.left, t: r.top, w: r.width, h: r.height };
    dirty.current = true;
    host.style.left = r.left + 'px';
    host.style.top = r.top + 'px';
    host.style.width = r.width + 'px';
    host.style.height = r.height + 'px';
    if (r.width > 1 && r.height > 1 && (r.width !== L.w || r.height !== L.h)) {
      gl.renderer.setSize(r.width, r.height);
      gl.camera.aspect = r.width / r.height;
      gl.camera.updateProjectionMatrix();
      gl.look.setSize(r.width, r.height);
    }
  };

  useEffect(() => {
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const release = () => { cleanup.splice(0).reverse().forEach(fn => fn()); };
    const init = async () => {
      // Let React paint the archive and handle input before beginning WebGL work.
      await yieldToBrowser();
      if (disposed) return;
      loadMetric('start');
      const host = hostRef.current!;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(host.clientWidth || 2, host.clientHeight || 2);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      (renderer as any).outputEncoding = (THREE as any).sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      cleanup.push(() => {
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        const textures = new Set<THREE.Texture>();
        scene.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          geometries.add(o.geometry);
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m));
        });
        materials.forEach(m => {
          Object.values(m).forEach(v => { if (v instanceof THREE.Texture) textures.add(v); });
          m.dispose();
        });
        textures.forEach(t => t.dispose()); geometries.forEach(g => g.dispose());
        scene.traverse(o => { if (o instanceof THREE.DirectionalLight) o.shadow.dispose(); });
        renderer.dispose(); renderer.domElement.remove(); glRef.current = null;
      });
      const gpu = createGpuQueue(renderer);
      cleanup.push(gpu.dispose);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 1500);
      camera.position.set(98, 86, 120);
      const controls = new OrbitControls(camera, renderer.domElement);
      cleanup.push(() => controls.dispose());
      controls.target.set(-2, 0, 2);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI / 2 - 0.03;
      controls.minDistance = 1.2;      /* 允许近距离查看石刻(定位飞行机位2~4米) */
      controls.maxDistance = 640;      /* 可同时纳入北侧传承中心, 仍在天空穹(760)与雾区内 */

      let site: ReturnType<typeof buildSite> | undefined;
      const stoneImages = createStoneTextures(gpu.upload, () => {
        if (!disposed) { site?.refreshStoneTextures(); dirty.current = true; }
      }, (loaded, total) => setTextureProgress({ loaded, total }));
      cleanup.push(stoneImages.dispose);
      loadMetric('buildStart');
      site = buildSite(scene, stoneImages.textures);
      const sceneTheme = watchSceneTheme(scene, () => { dirty.current = true; });
      cleanup.push(sceneTheme.dispose);
      loadMetric('buildEnd');
      applyCatalogue(scene, catalogueMap);
      stoneImages.bind(scene);
      await yieldToBrowser();
      if (disposed) { release(); return; }
      const { ROOFS, WALLS, OPENINGS } = site;
      const doors = createDoors(setDoorList);
      closeDoors.current = doors.closeAll;
      cleanup.push(doors.dispose);
      let sceneReady = false;
      let resolveMain!: () => void;
      const mainReady = new Promise<void>(resolve => { resolveMain = resolve; });
      cleanup.push(resolveMain);
      const architecture = createCourtyardArchitecture(scene, site, status => {
        if (disposed) return;
        if (status !== 'ready') setArchitectureStatus(status);
        if (status === 'ready') {
          sceneTheme.refresh();
          loadMetric('architectureReady');
          wallXray.set(false);
          wallXray.dispose();
          wallXray = createWallXray(WALLS, OPENINGS);
          wallXray.set(useStore.getState().wallsXray, useStore.getState().wallTransparency);
          inter.setRoof(useStore.getState().roofOn);
          inter.setSelected(useStore.getState().selectedId);
          look.refresh();
          renderer.shadowMap.needsUpdate = true;
          dirty.current = true;
        }
      }, gpu.prepare, doors.register);
      cleanup.push(architecture.dispose);
      let wallXray = createWallXray(WALLS, OPENINGS);
      const stoneAnchors = new Map<string, THREE.Object3D>();
      scene.traverse(object => {
        if (object.userData.hps?.id && object.userData.hps.id !== 'QS-B0') {
          stoneAnchors.set(object.userData.hps.id, object);
        }
      });
      loadMetric('lookStart');
      const look = createRenderLook(renderer, scene, camera);
      cleanup.push(look.dispose);
      loadMetric('lookEnd');
      const stopXclLayout = watchXclLayout(scene,()=>{look.refresh();renderer.shadowMap.needsUpdate=true;dirty.current=true;});
      cleanup.push(stopXclLayout);
      const stopRearLayout = watchRearLayout(scene,()=>{
        rearExhibition.syncPedestals();look.refresh();renderer.shadowMap.needsUpdate=true;dirty.current=true;
      });
      cleanup.push(stopRearLayout);
      const rearExhibition = createRearExhibition(scene,ROOFS,WALLS,()=>{
        if(disposed)return;
        wallXray.set(false);wallXray.dispose();wallXray=createWallXray(WALLS,OPENINGS);
        wallXray.set(useStore.getState().wallsXray, useStore.getState().wallTransparency);
        inter.setRoof(useStore.getState().roofOn);inter.setSelected(useStore.getState().selectedId);
        look.refresh();renderer.shadowMap.needsUpdate=true;dirty.current=true;
      }, { after: mainReady, prepare: gpu.prepare });
      cleanup.push(rearExhibition.dispose);
      gpu.configure(scene, camera);
      glRef.current = { renderer, camera, look };

      /* 周边环境与传承中心一起显示，保持院落及石刻的现有坐标。 */
      const context = createSiteContextLayer(scene, status => {
        useStore.getState().setContextStatus(status);
        if (status === 'ready') { look.refresh(); renderer.shadowMap.needsUpdate = true; dirty.current=true; loadMetric('contextReady'); }
      }, gpu.prepare);
      cleanup.push(context.dispose);
      const courtyardFog = scene.fog instanceof THREE.Fog ? { near: scene.fog.near, far: scene.fog.far } : null;
      const showContext = (on: boolean) => {
        context.setVisible(on);
        // The complete north–south site spans 440 m. Courtyard-scale fog would
        // hide its northern half at the regional viewpoint.
        if (courtyardFog && scene.fog instanceof THREE.Fog) {
          scene.fog.near = on ? 820 : courtyardFog.near;
          scene.fog.far = on ? 1450 : courtyardFog.far;
        }
        renderer.shadowMap.needsUpdate = true;
        dirty.current = true;
        if (on && context.status !== 'ready') void context.load();
      };
      // No optional asset request on refresh. Also honour a toggle made before
      // initialization finished; model preparation still yields to browser input.
      void rearExhibition.ready.then(async () => {
        await yieldToBrowser();
        if (!disposed && useStore.getState().contextOn) showContext(true);
      });
      void architecture.ready.then(async () => {
        if (disposed) return;
        await gpu.prepare(scene);
        if (disposed) return;
        sceneReady = true; dirty.current = true;
        setArchitectureStatus(architecture.report.status);
        loadMetric('materialsReady');
        stoneImages.start();
        resolveMain();
      }).catch(error => {
        if (!disposed) { console.error('院落显示准备失败', error); setInitializationError(true); }
      });
      /* 墙体透明: 换材质后墙不再投影、不参与 SSAO 深度, 需刷新阴影贴图与排除列表 */
      const setWallsXray = (on: boolean, transparency = useStore.getState().wallTransparency) => {
        const toggled = wallXray.on !== on;
        wallXray.set(on, transparency);
        if (toggled) {
          look.refresh();
          renderer.shadowMap.needsUpdate = true;
        }
        dirty.current = true;
      };
      if (useStore.getState().wallsXray) setWallsXray(true);
      /* 调试钩子(同 interactions 的 __pickAt): 核对叠加图层位置与配准 */
      (window as any).__wscScene = scene;

      const inter = setupInteractions(scene, camera, renderer, controls, ROOFS, {
        onSelect: id => select(id),
        onWalkChange: on => setWalkState({ walkOn: on }),
        onDoorClick: id => { doors.toggle(id); dirty.current = true; },
        onDoorHover: setHoveredDoor,
      });
      cleanup.push(inter.dispose);
      const navigation = createSceneNavigation(host, camera,
        () => ({ active: useStore.getState().module === 'scene', contextOn: useStore.getState().contextOn }),
        key => {
          if (key === 'center' && !useStore.getState().contextOn) useStore.getState().toggleContext();
          inter.flyToView(key);
          dirty.current = true;
          loadMetric('navigation', { destination: key });
        });
      cleanup.push(navigation.dispose);
      cleanup.push(() => wallXray.dispose());
      const photoModels = createPhotoModels(scene, () => {
        inter.setSelected(useStore.getState().selectedId);
        look.refresh();
        renderer.shadowMap.needsUpdate = true;
        dirty.current = true;
      }, { after: mainReady, prepare: gpu.prepare });
      cleanup.push(photoModels.dispose);
      setCtrl({
        focus: inter.focus,
        flyToView: inter.flyToView,
        setRoof: inter.setRoof,
        setWallsXray,
        setWalk: inter.setWalk,
        setContext: showContext,
        setSelected: id => { inter.setSelected(id); dirty.current = true; },
        hasMesh: inter.hasMesh,
        getCoordinates: id => {
          const anchor = stoneAnchors.get(id);
          if (!anchor || !scene.userData.georeference) return null;
          return worldToGeographic(scene.userData.georeference, anchor.getWorldPosition(new THREE.Vector3()));
        },
      });
      inter.setRoof(useStore.getState().roofOn);
      inter.setSelected(useStore.getState().selectedId);
      if (useStore.getState().selectedId) inter.focus(useStore.getState().selectedId!);
      cleanup.push(() => setCtrl(null));
      const invalidate = () => { dirty.current = true; };
      controls.addEventListener('change', invalidate);
      renderer.domElement.addEventListener('pointermove', invalidate);
      cleanup.push(() => renderer.domElement.removeEventListener('pointermove', invalidate));

      let raf = 0;
      let last = performance.now();
      let roofVisibility = '';
      let firstFrame = true;
      let textureCheck = 0;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        /* 文献/检索模块停靠为空时停止布局查询、漫游与 GPU 渲染。 */
        if (document.hidden || !slotElRef.current || !slotElRef.current.isConnected) return;
        syncDock();
        if (host.clientWidth <= 1 || host.clientHeight <= 1) return;
        // The fallback architecture is CPU-only unless the new asset fails; avoid
        // uploading and compiling an entire obsolete courtyard before replacing it.
        if (!sceneReady) return;
        const roofs = ROOFS.map(o => o.visible ? '1' : '0').join('');
        if (roofs !== roofVisibility) {
          renderer.shadowMap.needsUpdate = true;
          roofVisibility = roofs;
          dirty.current = true;
        }
        if (inter.walkTick(dt)) dirty.current = true; else controls.update();
        if (doors.tick(dt)) { dirty.current = true; renderer.shadowMap.needsUpdate = true; }
        if (now - textureCheck > 500) {
          textureCheck = now;
          stoneImages.update(camera, useStore.getState().selectedId, host.clientHeight);
        }
        if (dirty.current) {
          dirty.current = false;
          look.render();
          navigation.update();
          if (new URLSearchParams(location.search).has('diagnostics')) loadMetric('doors', doors.screenPositions(camera, host.getBoundingClientRect()));
          loadMetric('camera', { position: camera.position.toArray(), target: controls.target.toArray() });
          if (firstFrame) { firstFrame = false; loadMetric('firstFrame'); }
        }
      };
      loop();
      cleanup.push(() => cancelAnimationFrame(raf));
    };
    void init().catch(error => {
      release();
      if (!disposed) { console.error('院落初始化失败', error); setInitializationError(true); }
    });
    return () => { disposed = true; release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 槽位切换: 立即停靠并同步圆角, 之后由渲染循环逐帧跟随 */
  useEffect(() => {
    const host = hostRef.current!;
    slotElRef.current = stageSlot;
    lastRect.current = { l: -1, t: -1, w: -1, h: -1 };
    if (!stageSlot) { host.style.display = 'none'; return; }
    host.style.display = '';
    host.style.borderRadius = getComputedStyle(stageSlot).borderRadius;
    syncDock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSlot]);

  /* 选中状态(含程序化选中)同步到three高亮 */
  useEffect(() => {
    ctrl?.setSelected(selectedId);
  }, [selectedId, ctrl]);

  return <div ref={hostRef} className="stage-host">
    {architectureStatus === 'ready' && doorList.length > 0 && !walkOn && <div className="scene-door-status">
      {hoveredDoor && <span role="status" className="scene-stage-status">
        {`${doorList.find(d => d.id === hoveredDoor)?.label} · 点击${doorList.find(d => d.id === hoveredDoor)?.open ? '关闭' : '打开'}`}
      </span>}
      {doorList.some(d => d.open) && <button style={{fontSize:12}} onClick={() => closeDoors.current()}>关闭全部门</button>}
    </div>}
    {(initializationError || architectureStatus !== 'ready' || textureProgress.loaded < textureProgress.total) && <span role="status" className="scene-stage-status scene-loading-status">
      {initializationError ? '三维场景暂未能载入，请刷新重试'
        : architectureStatus === 'loading' ? '院落模型载入中…'
        : architectureStatus === 'error' ? '更新模型暂未载入，当前显示原院落'
        : `石刻图像载入中 ${textureProgress.loaded}/${textureProgress.total}`}
    </span>}
  </div>;
}
