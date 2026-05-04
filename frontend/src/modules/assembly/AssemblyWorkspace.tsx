/**
 * 拼接模块工作区 `AssemblyWorkspace`
 *
 * 把多块画像石（最多 10 块）加载到统一 Three.js 场景里做空间编排，让研究者
 * 可视化复原"原本应该相邻"的画像石组合（如墓葬同一墙面）。
 *
 * 主要功能：
 * - **多模型加载**：每条 `AssemblyItem` 异步 GLTFLoader，内部维护
 *   `LoadedAssemblyObject` 列表
 * - **TransformControls**：选中一块后挂上 gizmo，translate / rotate 双模式
 * - **离散步长调整**：父级提供按钮触发 1 / 5 / 10 cm 平移、5° / 任意角度旋转
 * - **长边等比缩放**：按结构化档案的"高/宽/厚"自动校准模型，所有块同一比例尺
 * - **面对面贴合**：选 A / B 各一面，自动算 quaternion + 平移让两面贴合
 * - **方案保存 / 加载**：JSON 形式持久化到 `data/assembly-plans/`
 *
 * 设计要点：
 * - 父级隐藏（`active = false`）时暂停 render loop 省 GPU；后台不空转
 * - 每块模型用一个 `THREE.Group` 包一层，便于整组应用 transform；加载后再
 *   计算 baseSize 回传父级供尺寸推断
 * - 选中切换时 `BoxHelper` + `TransformControls` 都重新挂在新块上
 * - OrbitControls 与 TransformControls 协同：拖 gizmo 时 OrbitControls 暂停
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AssemblyDimensions, AssemblyItem, AssemblyTransform } from "./types";
import { AssemblyAdjustControls, type AdjustmentAxis, type AdjustmentMode } from "./AssemblyAdjustControls";
import { ViewCube, type ViewCubeView } from "../shared/ViewCube";

type AssemblyWorkspaceProps = {
  // 当父级以 CSS 隐藏工作区时传 false，暂停 Three.js render loop，
  // 避免后台 GPU 空转；重新激活时立刻 resize + render。
  active?: boolean;
  items: AssemblyItem[];
  selectedItemId: string;
  adjustmentStep: number;
  rotationStep: number;
  gizmoMode: AdjustmentMode;
  resetToken: number;
  activeView: AssemblyView;
  cameraState?: AssemblyCameraState;
  onSelectItem: (instanceId: string) => void;
  onClearSelection: () => void;
  onStepChange: (step: number) => void;
  onRotationStepChange: (step: number) => void;
  onGizmoModeChange: (mode: AdjustmentMode) => void;
  onViewChange: (view: AssemblyView) => void;
  onAdjust: (mode: AdjustmentMode, axis: AdjustmentAxis, direction: -1 | 1) => void;
  onResetSelected: () => void;
  onTransformChange: (instanceId: string, transform: AssemblyTransform) => void;
  onDimensionsReady: (instanceId: string, dimensions: AssemblyDimensions) => void;
  onCameraStateChange: (state: AssemblyCameraState) => void;
};

type LoadedAssemblyObject = {
  item: AssemblyItem;
  group: THREE.Group;
  model: THREE.Object3D;
  baseSize: THREE.Vector3;
  selectionBox: THREE.BoxHelper;
  bound: boolean;
};

const tmpBox = new THREE.Box3();
const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();

export type AssemblyView = ViewCubeView;

export type AssemblyCameraState = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
};

const gridGroundY = -80;

export function AssemblyWorkspace({
  active = true,
  items,
  selectedItemId,
  adjustmentStep,
  rotationStep,
  gizmoMode,
  resetToken,
  activeView,
  cameraState,
  onSelectItem,
  onClearSelection,
  onStepChange,
  onRotationStepChange,
  onGizmoModeChange,
  onViewChange,
  onAdjust,
  onResetSelected,
  onTransformChange,
  onDimensionsReady,
  onCameraStateChange
}: AssemblyWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | undefined>(undefined);
  const cameraRef = useRef<THREE.PerspectiveCamera | undefined>(undefined);
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const transformControlsRef = useRef<TransformControls | undefined>(undefined);
  const gizmoSphereRef = useRef<THREE.Mesh | undefined>(undefined);
  const loadedRef = useRef(new Map<string, LoadedAssemblyObject>());
  const loadingIdsRef = useRef(new Set<string>());
  const activeItemIdsRef = useRef(new Set<string>());
  const selectedItemIdRef = useRef(selectedItemId);
  const onSelectItemRef = useRef(onSelectItem);
  const onClearSelectionRef = useRef(onClearSelection);
  const adjustmentStepRef = useRef(adjustmentStep);
  const rotationStepRef = useRef(rotationStep);
  const gizmoModeRef = useRef(gizmoMode);
  const onTransformChangeRef = useRef(onTransformChange);
  const onDimensionsReadyRef = useRef(onDimensionsReady);
  const onCameraStateChangeRef = useRef(onCameraStateChange);
  const cameraStateRef = useRef(cameraState);
  const shouldPreserveLoadedCameraRef = useRef(Boolean(cameraState));
  const pointerStartedOnGizmoRef = useRef(false);
  const isDraggingRef = useRef(false);
  const clickStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const loaderRef = useRef(new GLTFLoader());
  const activeRef = useRef(active);
  const [loadingCount, setLoadingCount] = useState(0);
  const [readyItemIds, setReadyItemIds] = useState<Set<string>>(() => new Set());
  const isModelReady = readyItemIds.has(selectedItemId);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    selectedItemIdRef.current = selectedItemId;
  }, [selectedItemId]);

  useEffect(() => {
    onSelectItemRef.current = onSelectItem;
  }, [onSelectItem]);

  useEffect(() => {
    onClearSelectionRef.current = onClearSelection;
  }, [onClearSelection]);

  useEffect(() => {
    adjustmentStepRef.current = adjustmentStep;
  }, [adjustmentStep]);

  useEffect(() => {
    rotationStepRef.current = rotationStep;
  }, [rotationStep]);

  useEffect(() => {
    gizmoModeRef.current = gizmoMode;
  }, [gizmoMode]);

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange;
  }, [onTransformChange]);

  useEffect(() => {
    onDimensionsReadyRef.current = onDimensionsReady;
  }, [onDimensionsReady]);

  useEffect(() => {
    onCameraStateChangeRef.current = onCameraStateChange;
  }, [onCameraStateChange]);

  useEffect(() => {
    cameraStateRef.current = cameraState;
  }, [cameraState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#141312");
    sceneRef.current = scene;

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 700;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 20000);
    camera.position.set(220, -260, 190);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;
    restoreAssemblyCamera(camera, controls, cameraStateRef.current);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    scene.add(new THREE.HemisphereLight(0xfff8ec, 0x302a24, 0.9));
    const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.4);
    keyLight.position.set(180, -130, 240);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x9edbd7, 0.8);
    fillLight.position.set(-180, 150, 100);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(720, 24, 0x655b50, 0x2c2823);
    grid.position.y = gridGroundY;
    scene.add(grid);

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSpace("world");
    transformControls.setSize(0.82);
    transformControls.setColors("#ff5f57", "#45d483", "#4e9dff", "#f3a712");
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    const draggingChanged = (event: { value: unknown }) => {
      const dragging = Boolean(event.value);
      controls.enabled = !dragging;
      isDraggingRef.current = dragging;
    };
    const objectChanged = () => {
      const instanceId = selectedItemIdRef.current;
      const loaded = instanceId ? loadedRef.current.get(instanceId) : undefined;
      if (!loaded || loaded.item.locked) {
        return;
      }
      if (transformControls.getMode() === "rotate") {
        snapQuaternionToImportantAngles(loaded.group.quaternion, rotationStepRef.current);
      }
      syncGizmoSphere(gizmoSphereRef.current, loaded);
      onTransformChangeRef.current(instanceId, transformFromGroup(loaded.group));
    };
    transformControls.addEventListener("dragging-changed", draggingChanged);
    transformControls.addEventListener("objectChange", objectChanged);

    const gizmoSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.MeshBasicMaterial({
        color: "#f3a712",
        transparent: true,
        opacity: 0.28,
        depthTest: false
      })
    );
    gizmoSphere.renderOrder = 10;
    gizmoSphere.visible = false;
    scene.add(gizmoSphere);
    gizmoSphereRef.current = gizmoSphere;

    const pointerDown = (event: PointerEvent) => {
      clickStartRef.current = { x: event.clientX, y: event.clientY };
      pointerStartedOnGizmoRef.current = transformControls.dragging || transformControls.axis !== null;
    };
    const pointerUp = (event: PointerEvent) => {
      if (pointerStartedOnGizmoRef.current || transformControls.dragging) {
        pointerStartedOnGizmoRef.current = false;
        return;
      }
      const start = clickStartRef.current;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) {
        return;
      }

      const hitId = pickItem(event, renderer.domElement, camera, loadedRef.current);
      if (hitId) {
        onSelectItemRef.current(hitId);
      } else {
        onClearSelectionRef.current();
      }
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);

    const resize = () => {
      const nextWidth = container.clientWidth || width;
      const nextHeight = container.clientHeight || height;
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const animate = () => {
      if (disposed) {
        return;
      }
      // 隐藏工作区时跳过更新与 render，省 GPU；保持 RAF 以便重新激活时立刻响应。
      if (!activeRef.current) {
        requestAnimationFrame(animate);
        return;
      }
      controls.update();
      loadedRef.current.forEach((loaded) => loaded.selectionBox.update());
      syncGizmoSphere(gizmoSphereRef.current, loadedRef.current.get(selectedItemIdRef.current));
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      if (loadedRef.current.size > 0) {
        onCameraStateChangeRef.current(readAssemblyCameraState(camera, controls));
      }
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      transformControls.removeEventListener("dragging-changed", draggingChanged);
      transformControls.removeEventListener("objectChange", objectChanged);
      transformControls.detach();
      scene.remove(transformControls.getHelper());
      transformControls.dispose();
      scene.remove(gizmoSphere);
      gizmoSphere.geometry.dispose();
      disposeMaterial(gizmoSphere.material);
      controls.dispose();
      loadedRef.current.forEach((loaded) => disposeLoaded(loaded));
      loadedRef.current.clear();
      loadingIdsRef.current.clear();
      renderer.dispose();
      container.innerHTML = "";
      sceneRef.current = undefined;
      cameraRef.current = undefined;
      controlsRef.current = undefined;
      transformControlsRef.current = undefined;
      gizmoSphereRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    const currentIds = new Set(items.map((item) => item.instanceId));
    activeItemIdsRef.current = currentIds;
    const removed: string[] = [];
    loadedRef.current.forEach((loaded, instanceId) => {
      if (!currentIds.has(instanceId)) {
        if (selectedItemIdRef.current === instanceId) {
          transformControlsRef.current?.detach();
        }
        scene.remove(loaded.group);
        scene.remove(loaded.selectionBox);
        disposeLoaded(loaded);
        loadedRef.current.delete(instanceId);
        removed.push(instanceId);
      }
    });
    if (removed.length > 0) {
      setReadyItemIds((prev) => {
        const next = new Set(prev);
        removed.forEach((id) => next.delete(id));
        return next;
      });
    }

    for (const item of items) {
      const loaded = loadedRef.current.get(item.instanceId);
      if (loaded) {
        // Avoid clobbering the group being actively dragged by TransformControls.
        const isActiveDragTarget = isDraggingRef.current && item.instanceId === selectedItemIdRef.current;
        if (!isActiveDragTarget) {
          applyTransform(loaded.group, item.transform);
        }
        loaded.item = item;
        continue;
      }
      if (loadingIdsRef.current.has(item.instanceId)) {
        continue;
      }
      loadAssemblyItem({
        item,
        scene,
        loader: loaderRef.current,
        loadedMap: loadedRef.current,
        loadingIds: loadingIdsRef.current,
        activeItemIdsRef,
        isDisposed: () => !sceneRef.current,
        setLoadingCount,
        onDimensionsReady: onDimensionsReadyRef.current,
        onLoaded: (loadedInstanceId) => {
          setReadyItemIds((prev) => {
            if (prev.has(loadedInstanceId)) {
              return prev;
            }
            const next = new Set(prev);
            next.add(loadedInstanceId);
            return next;
          });
          syncTransformControls(transformControlsRef.current, loadedRef.current, selectedItemIdRef.current, gizmoModeRef.current, adjustmentStepRef.current, rotationStepRef.current);
          if (!shouldPreserveLoadedCameraRef.current) {
            fitAssemblyCamera(loadedRef.current, cameraRef.current, controlsRef.current);
            shouldPreserveLoadedCameraRef.current = true;
          }
        }
      });
    }
  }, [items]);

  useEffect(() => {
    syncTransformControls(transformControlsRef.current, loadedRef.current, selectedItemId, gizmoMode, adjustmentStep, rotationStep);
    syncGizmoSphere(gizmoSphereRef.current, loadedRef.current.get(selectedItemId));
  }, [adjustmentStep, gizmoMode, items, loadingCount, readyItemIds, rotationStep, selectedItemId]);

  useEffect(() => {
    fitAssemblyCamera(loadedRef.current, cameraRef.current, controlsRef.current);
  }, [resetToken]);

  const setView = (view: AssemblyView) => {
    onViewChange(view);
    fitAssemblyCamera(loadedRef.current, cameraRef.current, controlsRef.current, view);
  };

  const groundSelectedItem = () => {
    const loaded = loadedRef.current.get(selectedItemIdRef.current);
    if (!loaded || loaded.item.locked || !loaded.bound) {
      return;
    }

    loaded.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(loaded.group);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) {
      return;
    }

    loaded.group.position.y += gridGroundY - box.min.y;
    loaded.group.updateMatrixWorld(true);
    syncGizmoSphere(gizmoSphereRef.current, loaded);
    loaded.selectionBox.update();
    onTransformChangeRef.current(loaded.item.instanceId, transformFromGroup(loaded.group));
  };

  return (
    <div className="assembly-workspace">
      <div ref={containerRef} className="three-stage" />
      <div className="viewer-hud top-left">
        <strong>拼接工作区</strong>
        <span>{selectedItemId ? "拖动中心操作轴调整石块" : "点击画像石进入调整"}</span>
      </div>
      <ViewCube activeView={activeView} onSelect={setView} />
      {loadingCount > 0 ? <div className="load-panel">正在加载 {loadingCount} 块模型</div> : null}
      {isModelReady ? (
        <AssemblyAdjustControls
          item={items.find((item) => item.instanceId === selectedItemId)}
          step={adjustmentStep}
          rotationStep={rotationStep}
          gizmoMode={gizmoMode}
          onGizmoModeChange={onGizmoModeChange}
          onStepChange={onStepChange}
          onRotationStepChange={onRotationStepChange}
          onAdjust={onAdjust}
          onReset={onResetSelected}
          onGroundSelected={groundSelectedItem}
        />
      ) : null}
    </div>
  );
}

function loadAssemblyItem({
  item,
  scene,
  loader,
  loadedMap,
  loadingIds,
  activeItemIdsRef,
  isDisposed,
  setLoadingCount,
  onDimensionsReady,
  onLoaded
}: {
  item: AssemblyItem;
  scene: THREE.Scene;
  loader: GLTFLoader;
  loadedMap: Map<string, LoadedAssemblyObject>;
  loadingIds: Set<string>;
  activeItemIdsRef: React.RefObject<Set<string>>;
  isDisposed: () => boolean;
  setLoadingCount: React.Dispatch<React.SetStateAction<number>>;
  onDimensionsReady: (instanceId: string, dimensions: AssemblyDimensions) => void;
  onLoaded: (instanceId: string) => void;
}) {
  if (!item.stone.modelUrl) {
    return;
  }

  loadingIds.add(item.instanceId);
  setLoadingCount((value) => value + 1);
  loader.load(
    item.stone.modelUrl,
    (gltf) => {
      if (isDisposed() || !activeItemIdsRef.current.has(item.instanceId)) {
        disposeObject(gltf.scene);
        loadingIds.delete(item.instanceId);
        setLoadingCount((value) => Math.max(0, value - 1));
        return;
      }

      const model = gltf.scene;
      normalizeModel(model);
      const baseBox = new THREE.Box3().setFromObject(model);
      const baseSize = baseBox.getSize(new THREE.Vector3());
      if (!item.baseDimensions) {
        onDimensionsReady(item.instanceId, dimensionsFromBox(baseSize));
      }

      const group = new THREE.Group();
      group.name = item.stone.displayName;
      group.add(model);
      applyTransform(group, item.transform);

      scene.add(group);
      group.updateMatrixWorld(true);
      const selectionBox = new THREE.BoxHelper(group, 0xf3a712);
      selectionBox.visible = false;
      scene.add(selectionBox);
      selectionBox.update();
      loadedMap.set(item.instanceId, { item, group, model, baseSize, selectionBox, bound: true });
      loadingIds.delete(item.instanceId);
      setLoadingCount((value) => Math.max(0, value - 1));
      onLoaded(item.instanceId);
    },
    undefined,
    () => {
      loadingIds.delete(item.instanceId);
      setLoadingCount((value) => Math.max(0, value - 1));
    }
  );
}

function normalizeModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
}

function dimensionsFromBox(size: THREE.Vector3): AssemblyDimensions {
  const width = Math.max(size.x, 0.1);
  const length = Math.max(size.y, 0.1);
  const thickness = Math.max(size.z, 0.1);
  return {
    width,
    length,
    thickness,
    longEdge: Math.max(width, length, thickness),
    unit: "model",
    source: "model"
  };
}

function syncTransformControls(
  controls: TransformControls | undefined,
  loadedMap: Map<string, LoadedAssemblyObject>,
  selectedItemId: string,
  mode: AdjustmentMode,
  adjustmentStep: number,
  rotationStep: number
) {
  if (!controls) {
    return;
  }
  controls.setMode(mode);
  controls.setTranslationSnap(mode === "translate" ? adjustmentStep : null);
  controls.setRotationSnap(mode === "rotate" ? THREE.MathUtils.degToRad(Math.max(rotationStep, 0.1)) : null);
  controls.setSpace("world");

  const loaded = loadedMap.get(selectedItemId);
  if (!loaded || loaded.item.locked || !loaded.bound) {
    controls.detach();
    return;
  }
  loaded.group.updateMatrixWorld(true);
  tmpBox.setFromObject(loaded.group);
  if (tmpBox.isEmpty()) {
    controls.detach();
    return;
  }
  controls.attach(loaded.group);
}

function syncGizmoSphere(sphere: THREE.Mesh | undefined, loaded: LoadedAssemblyObject | undefined) {
  if (!sphere) {
    return;
  }
  if (!loaded || loaded.item.locked || !loaded.bound) {
    sphere.visible = false;
    return;
  }

  loaded.group.updateMatrixWorld(true);
  tmpBox.setFromObject(loaded.group);
  if (tmpBox.isEmpty()) {
    sphere.visible = false;
    return;
  }

  tmpBox.getCenter(tmpVecA);
  tmpBox.getSize(tmpVecB);
  const maxDim = Math.max(tmpVecB.x, tmpVecB.y, tmpVecB.z, 1);
  sphere.position.copy(tmpVecA);
  sphere.scale.setScalar(Math.max(5, Math.min(maxDim * 0.075, 14)));
  sphere.visible = true;
}

function pickItem(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  loadedMap: Map<string, LoadedAssemblyObject>
) {
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const models = [...loadedMap.values()].map((loaded) => loaded.model);
  const [hit] = raycaster.intersectObjects(models, true);
  if (!hit) {
    return undefined;
  }

  return [...loadedMap.values()].find((item) => isDescendant(hit.object, item.model))?.item.instanceId;
}

function isDescendant(object: THREE.Object3D, root: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current === root) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function readAssemblyCameraState(camera: THREE.PerspectiveCamera, controls: OrbitControls): AssemblyCameraState {
  return {
    position: camera.position.toArray() as [number, number, number],
    target: controls.target.toArray() as [number, number, number],
    up: camera.up.toArray() as [number, number, number]
  };
}

function restoreAssemblyCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, state: AssemblyCameraState | undefined) {
  if (!state) {
    return;
  }

  camera.position.fromArray(state.position);
  camera.up.fromArray(state.up);
  controls.target.fromArray(state.target);
  camera.lookAt(controls.target);
  camera.updateProjectionMatrix();
  controls.update();
}

function fitAssemblyCamera(
  loadedMap: Map<string, LoadedAssemblyObject>,
  camera: THREE.PerspectiveCamera | undefined,
  controls: OrbitControls | undefined,
  view?: AssemblyView
) {
  if (!camera || !controls || loadedMap.size === 0) {
    return;
  }

  const box = new THREE.Box3();
  loadedMap.forEach((loaded) => {
    loaded.group.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(loaded.group));
  });
  if (box.isEmpty()) {
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.75;
  camera.near = Math.max(maxDim / 1000, 0.05);
  camera.far = maxDim * 20;
  camera.position.copy(center).add(view ? getViewDirection(view).multiplyScalar(distance) : new THREE.Vector3(distance * 0.45, -distance * 0.75, distance * 0.55));
  camera.up.copy(view === "top" || view === "bottom" ? new THREE.Vector3(0, 0, view === "top" ? -1 : 1) : new THREE.Vector3(0, 1, 0));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function getViewDirection(view: AssemblyView) {
  const directions: Record<AssemblyView, THREE.Vector3> = {
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    left: new THREE.Vector3(-1, 0, 0),
    right: new THREE.Vector3(1, 0, 0),
    top: new THREE.Vector3(0, 1, 0),
    bottom: new THREE.Vector3(0, -1, 0)
  };
  return directions[view].clone();
}

function applyTransform(group: THREE.Group, transform: AssemblyTransform) {
  group.position.fromArray(transform.position);
  group.quaternion.fromArray(transform.quaternion);
  group.scale.setScalar(transform.scale ?? 1);
  group.updateMatrixWorld(true);
}

function transformFromGroup(group: THREE.Group): AssemblyTransform {
  return {
    position: group.position.toArray() as [number, number, number],
    quaternion: group.quaternion.toArray() as [number, number, number, number],
    scale: group.scale.x
  };
}

function snapQuaternionToImportantAngles(quaternion: THREE.Quaternion, step: number) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  const threshold = THREE.MathUtils.degToRad(Math.min(3, Math.max(0.5, step * 0.6)));
  const targets = [Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
  let changed = false;

  for (const key of ["x", "y", "z"] as const) {
    const snapped = targets.find((target) => Math.abs(shortAngleDistance(euler[key], target)) <= threshold);
    if (snapped !== undefined) {
      euler[key] = snapped;
      changed = true;
    }
  }

  if (changed) {
    quaternion.setFromEuler(euler).normalize();
  }
}

function shortAngleDistance(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function disposeLoaded(loaded: LoadedAssemblyObject) {
  loaded.selectionBox.parent?.remove(loaded.selectionBox);
  loaded.selectionBox.geometry.dispose();
  disposeMaterial(loaded.selectionBox.material);
  disposeObject(loaded.group);
}

function disposeObject(object3d: THREE.Object3D) {
  object3d.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      disposeMaterial(mesh.material);
    }
  });
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose());
  } else {
    material.dispose();
  }
}
