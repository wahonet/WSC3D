import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { StoneListItem } from "../../api/client";
import { ViewCube, type ViewCubeView } from "../shared/ViewCube";

export type ViewerMode = "3d" | "2d" | "ortho";

export type MeasurementResult = {
  modelDistance: number;
  realDistance?: number;
  unit: "cm" | "model";
  pointA: [number, number, number];
  pointB: [number, number, number];
};

type StoneViewerProps = {
  stone: StoneListItem;
  viewMode: ViewerMode;
  background: "black" | "gray" | "white";
  measuring: boolean;
  measureToken: number;
  cubeView: ViewCubeView;
  onCubeViewChange: (view: ViewCubeView) => void;
  onMeasureChange: (result: MeasurementResult | undefined) => void;
};

const backgroundColors: Record<StoneViewerProps["background"], number> = {
  black: 0x141312,
  gray: 0x6f6a62,
  white: 0xf2eee8
};

const tmpVec = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();

export function StoneViewer({
  stone,
  viewMode,
  background,
  measuring,
  measureToken,
  cubeView,
  onCubeViewChange,
  onMeasureChange
}: StoneViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | undefined>(undefined);
  const rendererRef = useRef<THREE.WebGLRenderer | undefined>(undefined);
  const perspectiveCameraRef = useRef<THREE.PerspectiveCamera | undefined>(undefined);
  const orthographicCameraRef = useRef<THREE.OrthographicCamera | undefined>(undefined);
  const activeCameraRef = useRef<THREE.Camera | undefined>(undefined);
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const modelRef = useRef<THREE.Object3D | undefined>(undefined);
  const modelBoxRef = useRef<THREE.Box3>(new THREE.Box3());
  const modelLongEdgeRef = useRef(0);
  const measurementGroupRef = useRef<THREE.Group | undefined>(undefined);
  const measurementPointsRef = useRef<THREE.Vector3[]>([]);
  const clickStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const measuringRef = useRef(measuring);
  const cubeViewRef = useRef(cubeView);
  const viewModeRef = useRef(viewMode);
  const onCubeViewChangeRef = useRef(onCubeViewChange);
  const onMeasureChangeRef = useRef(onMeasureChange);

  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pointCount, setPointCount] = useState(0);

  useEffect(() => {
    measuringRef.current = measuring;
  }, [measuring]);

  useEffect(() => {
    cubeViewRef.current = cubeView;
  }, [cubeView]);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    onCubeViewChangeRef.current = onCubeViewChange;
  }, [onCubeViewChange]);

  useEffect(() => {
    onMeasureChangeRef.current = onMeasureChange;
  }, [onMeasureChange]);

  const realScale = useCallback(() => {
    const dimensions = stone.metadata?.dimensions;
    if (!dimensions) {
      return undefined;
    }
    const realLong = Math.max(dimensions.width ?? 0, dimensions.height ?? 0, dimensions.thickness ?? 0);
    if (!realLong || !modelLongEdgeRef.current) {
      return undefined;
    }
    return { ratio: realLong / modelLongEdgeRef.current, unit: "cm" as const };
  }, [stone.metadata?.dimensions]);

  const emitMeasurement = useCallback(() => {
    const points = measurementPointsRef.current;
    if (points.length < 2) {
      onMeasureChangeRef.current(undefined);
      return;
    }
    const distance = points[0].distanceTo(points[1]);
    const scale = realScale();
    onMeasureChangeRef.current({
      modelDistance: distance,
      realDistance: scale ? distance * scale.ratio : undefined,
      unit: scale ? "cm" : "model",
      pointA: points[0].toArray() as [number, number, number],
      pointB: points[1].toArray() as [number, number, number]
    });
  }, [realScale]);

  const refreshMeasurementVisuals = useCallback(() => {
    const group = measurementGroupRef.current;
    if (!group) {
      return;
    }
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      disposeObject(child);
    }
    const points = measurementPointsRef.current;
    if (points.length === 0) {
      return;
    }
    const radius = Math.max(modelLongEdgeRef.current * 0.008, 0.5);
    points.forEach((point, index) => {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 24, 16),
        new THREE.MeshBasicMaterial({
          color: index === 0 ? 0x2ec4b6 : 0xf3a712,
          depthTest: false,
          transparent: true,
          opacity: 0.9
        })
      );
      sphere.renderOrder = 20;
      sphere.position.copy(point);
      group.add(sphere);
    });
    if (points.length === 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xf3a712, depthTest: false, transparent: true, opacity: 0.9 })
      );
      line.renderOrder = 19;
      group.add(line);
    }
  }, []);

  const clearMeasurement = useCallback(() => {
    measurementPointsRef.current = [];
    refreshMeasurementVisuals();
    setPointCount(0);
    onMeasureChangeRef.current(undefined);
  }, [refreshMeasurementVisuals]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !stone.modelUrl) {
      return;
    }

    let disposed = false;
    setProgress(0);
    setStatus("loading");
    container.innerHTML = "";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(backgroundColors[background]);
    sceneRef.current = scene;

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 700;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const perspectiveCamera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    perspectiveCameraRef.current = perspectiveCamera;

    const orthoSize = 180;
    const orthographicCamera = new THREE.OrthographicCamera(
      (-orthoSize * width) / height,
      (orthoSize * width) / height,
      orthoSize,
      -orthoSize,
      -10000,
      10000
    );
    orthographicCameraRef.current = orthographicCamera;

    const activeCamera: THREE.Camera = viewMode === "3d" ? perspectiveCamera : orthographicCamera;
    activeCameraRef.current = activeCamera;

    const controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;
    applyControlsForMode(controls, viewMode);

    const ambient = new THREE.AmbientLight(0xffffff, 0.52);
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x403a33, 0.9);
    const keyLight = new THREE.DirectionalLight(0xfff6e3, 2.35);
    keyLight.position.set(160, -120, 260);
    const fillLight = new THREE.DirectionalLight(0xaee3df, 0.6);
    fillLight.position.set(-180, 140, 130);
    scene.add(ambient, hemisphere, keyLight, fillLight);

    const grid = new THREE.GridHelper(320, 16, 0x60594f, 0x2b2824);
    grid.position.y = -70;
    grid.visible = viewMode === "3d";
    grid.name = "viewer-grid";
    scene.add(grid);

    const measurementGroup = new THREE.Group();
    measurementGroup.name = "measurement";
    scene.add(measurementGroup);
    measurementGroupRef.current = measurementGroup;
    measurementPointsRef.current = [];

    const loader = new GLTFLoader();
    loader.load(
      stone.modelUrl,
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        const model = gltf.scene;
        model.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            const mesh = node as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        scene.add(model);
        modelRef.current = model;
        fitModel(model, perspectiveCamera, orthographicCamera, controls, viewModeRef.current, modelBoxRef.current);
        modelLongEdgeRef.current = Math.max(
          modelBoxRef.current.max.x - modelBoxRef.current.min.x,
          modelBoxRef.current.max.y - modelBoxRef.current.min.y,
          modelBoxRef.current.max.z - modelBoxRef.current.min.z,
          1
        );
        if (viewModeRef.current === "2d") {
          snapCameraToView("front", perspectiveCamera, orthographicCamera, controls, modelBoxRef.current, "2d");
        }
        setStatus("ready");
      },
      (event) => {
        if (event.lengthComputable) {
          setProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
      () => {
        if (!disposed) {
          setStatus("error");
        }
      }
    );

    const pointerDown = (event: PointerEvent) => {
      clickStartRef.current = { x: event.clientX, y: event.clientY };
    };

    const pointerUp = (event: PointerEvent) => {
      const start = clickStartRef.current;
      clickStartRef.current = undefined;
      if (!measuringRef.current || !start) {
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) {
        return;
      }
      const camera = activeCameraRef.current;
      const model = modelRef.current;
      if (!camera || !model) {
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const [hit] = raycaster.intersectObject(model, true);
      if (!hit) {
        return;
      }
      if (measurementPointsRef.current.length >= 2) {
        measurementPointsRef.current = [];
      }
      measurementPointsRef.current.push(hit.point.clone());
      refreshMeasurementVisuals();
      setPointCount(measurementPointsRef.current.length);
      emitMeasurement();
    };

    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);

    const resize = () => {
      const nextWidth = container.clientWidth || width;
      const nextHeight = container.clientHeight || height;
      renderer.setSize(nextWidth, nextHeight);
      perspectiveCamera.aspect = nextWidth / nextHeight;
      perspectiveCamera.updateProjectionMatrix();
      const halfHeight = (orthographicCamera.top - orthographicCamera.bottom) / 2;
      orthographicCamera.left = (-halfHeight * nextWidth) / nextHeight;
      orthographicCamera.right = (halfHeight * nextWidth) / nextHeight;
      orthographicCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const animate = () => {
      if (disposed) {
        return;
      }
      controls.update();
      const camera = activeCameraRef.current ?? perspectiveCamera;
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      controls.dispose();
      renderer.dispose();
      disposeObject(scene);
      container.innerHTML = "";
      sceneRef.current = undefined;
      rendererRef.current = undefined;
      perspectiveCameraRef.current = undefined;
      orthographicCameraRef.current = undefined;
      activeCameraRef.current = undefined;
      controlsRef.current = undefined;
      modelRef.current = undefined;
      measurementGroupRef.current = undefined;
      measurementPointsRef.current = [];
      modelLongEdgeRef.current = 0;
      modelBoxRef.current.makeEmpty();
    };
  }, [stone.modelUrl, emitMeasurement, refreshMeasurementVisuals]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.background = new THREE.Color(backgroundColors[background]);
    }
  }, [background]);

  useEffect(() => {
    const perspective = perspectiveCameraRef.current;
    const orthographic = orthographicCameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!perspective || !orthographic || !controls || !scene) {
      return;
    }

    const previousCamera = activeCameraRef.current;
    const target = controls.target.clone();
    const nextCamera = viewMode === "3d" ? perspective : orthographic;

    if (previousCamera && previousCamera !== nextCamera) {
      syncCameraState(previousCamera, nextCamera, target, modelBoxRef.current);
    }

    if (viewMode === "2d") {
      snapCameraToView("front", perspective, orthographic, controls, modelBoxRef.current, "2d");
    }

    controls.object = nextCamera;
    activeCameraRef.current = nextCamera;
    applyControlsForMode(controls, viewMode);

    const grid = scene.getObjectByName("viewer-grid");
    if (grid) {
      grid.visible = viewMode === "3d";
    }
    controls.update();
  }, [viewMode]);

  useEffect(() => {
    const perspective = perspectiveCameraRef.current;
    const orthographic = orthographicCameraRef.current;
    const controls = controlsRef.current;
    if (!perspective || !orthographic || !controls || !modelRef.current) {
      return;
    }
    snapCameraToView(cubeView, perspective, orthographic, controls, modelBoxRef.current, viewModeRef.current);
  }, [cubeView]);

  useEffect(() => {
    if (!measuring) {
      return;
    }
    if (measureToken === 0) {
      return;
    }
    clearMeasurement();
  }, [measureToken, measuring, clearMeasurement]);

  useEffect(() => {
    if (!measuring) {
      clearMeasurement();
    }
  }, [measuring, clearMeasurement]);

  const modeLabel = viewMode === "3d" ? "3D 模型" : viewMode === "2d" ? "2D 正投影" : "正射视图";

  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="three-stage" />
      <div className="viewer-hud top-left">
        <strong>{modeLabel}</strong>
        <span>{stone.hasMetadata ? "结构化数据已匹配" : "未匹配结构化数据"}</span>
      </div>
      {viewMode !== "2d" ? <ViewCube activeView={cubeView} onSelect={onCubeViewChange} /> : null}
      {measuring ? (
        <div className="viewer-hud bottom-center measure-hint">
          <span>{pointCount === 0 ? "点击模型采第 1 个点" : pointCount === 1 ? "点击模型采第 2 个点" : "再次点击重新测量"}</span>
        </div>
      ) : null}
      {status === "loading" ? (
        <div className="load-panel">
          <span>正在加载模型</span>
          <div className="progress-track">
            <div style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
        </div>
      ) : null}
      {status === "error" ? <div className="load-panel error">模型加载失败</div> : null}
    </div>
  );
}

function applyControlsForMode(controls: OrbitControls, viewMode: ViewerMode) {
  controls.enableRotate = viewMode !== "2d";
  controls.enablePan = true;
  controls.enableZoom = true;
  if (viewMode === "2d") {
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.PAN;
  } else {
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
  }
}

function syncCameraState(
  source: THREE.Camera,
  destination: THREE.Camera,
  target: THREE.Vector3,
  modelBox: THREE.Box3
) {
  const direction = source.getWorldDirection(tmpVec).clone();
  const distance = source.position.distanceTo(target) || Math.max(modelBox.getSize(tmpVecB).length(), 1);
  destination.position.copy(target).addScaledVector(direction, -distance);
  destination.up.copy(source.up);
  destination.lookAt(target);

  if ((destination as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = destination as THREE.OrthographicCamera;
    const size = modelBox.isEmpty() ? 180 : Math.max(modelBox.getSize(tmpVecB).length(), 1);
    const halfHeight = (size * 0.65) / 2;
    const aspect = Math.abs(ortho.right - ortho.left) / Math.max(Math.abs(ortho.top - ortho.bottom), 1);
    ortho.top = halfHeight;
    ortho.bottom = -halfHeight;
    ortho.left = -halfHeight * aspect;
    ortho.right = halfHeight * aspect;
    ortho.near = -size * 10;
    ortho.far = size * 10;
    ortho.updateProjectionMatrix();
  } else if ((destination as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (destination as THREE.PerspectiveCamera).updateProjectionMatrix();
  }
}

function snapCameraToView(
  view: ViewCubeView,
  perspective: THREE.PerspectiveCamera,
  orthographic: THREE.OrthographicCamera,
  controls: OrbitControls,
  modelBox: THREE.Box3,
  viewMode: ViewerMode
) {
  const center = modelBox.isEmpty() ? new THREE.Vector3() : modelBox.getCenter(new THREE.Vector3());
  const size = modelBox.isEmpty() ? 180 : Math.max(modelBox.getSize(new THREE.Vector3()).length(), 1);
  const direction = getViewDirection(view);
  const distance = size * 1.6;

  controls.target.copy(center);

  if (viewMode === "3d") {
    perspective.position.copy(center).addScaledVector(direction, distance);
    perspective.up.copy(getViewUp(view));
    perspective.lookAt(center);
    perspective.near = Math.max(distance / 1000, 0.01);
    perspective.far = distance * 20;
    perspective.updateProjectionMatrix();
  } else {
    orthographic.position.copy(center).addScaledVector(direction, distance);
    orthographic.up.copy(getViewUp(view));
    orthographic.lookAt(center);
    const halfHeight = (size * 0.65) / 2;
    const aspect = Math.abs(orthographic.right - orthographic.left) / Math.max(Math.abs(orthographic.top - orthographic.bottom), 1);
    orthographic.top = halfHeight;
    orthographic.bottom = -halfHeight;
    orthographic.left = -halfHeight * aspect;
    orthographic.right = halfHeight * aspect;
    orthographic.near = -distance * 10;
    orthographic.far = distance * 10;
    orthographic.updateProjectionMatrix();
  }
  controls.update();
}

function getViewDirection(view: ViewCubeView) {
  const map: Record<ViewCubeView, [number, number, number]> = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0]
  };
  const [x, y, z] = map[view];
  return new THREE.Vector3(x, y, z);
}

function getViewUp(view: ViewCubeView) {
  if (view === "top") {
    return new THREE.Vector3(0, 0, -1);
  }
  if (view === "bottom") {
    return new THREE.Vector3(0, 0, 1);
  }
  return new THREE.Vector3(0, 1, 0);
}

function fitModel(
  model: THREE.Object3D,
  perspectiveCamera: THREE.PerspectiveCamera,
  orthographicCamera: THREE.OrthographicCamera,
  controls: OrbitControls,
  viewMode: ViewerMode,
  outBox: THREE.Box3
) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);

  model.position.sub(center);
  outBox.setFromObject(model);
  controls.target.set(0, 0, 0);

  perspectiveCamera.near = Math.max(maxDim / 1000, 0.01);
  perspectiveCamera.far = maxDim * 20;
  perspectiveCamera.position.set(maxDim * 0.25, -maxDim * 0.45, maxDim * 1.55);
  perspectiveCamera.lookAt(0, 0, 0);
  perspectiveCamera.updateProjectionMatrix();

  const aspect = Math.abs(orthographicCamera.right - orthographicCamera.left) / Math.max(Math.abs(orthographicCamera.top - orthographicCamera.bottom), 1);
  const margin = 1.25;
  orthographicCamera.left = (-maxDim * aspect * margin) / 2;
  orthographicCamera.right = (maxDim * aspect * margin) / 2;
  orthographicCamera.top = (maxDim * margin) / 2;
  orthographicCamera.bottom = (-maxDim * margin) / 2;
  orthographicCamera.near = -maxDim * 10;
  orthographicCamera.far = maxDim * 10;
  orthographicCamera.position.set(0, 0, maxDim * 2);
  orthographicCamera.lookAt(0, 0, 0);
  orthographicCamera.updateProjectionMatrix();

  if (viewMode === "2d") {
    controls.update();
  }
}

function disposeObject(object3d: THREE.Object3D) {
  object3d.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => material.dispose());
    } else if (mesh.material) {
      mesh.material.dispose();
    }
  });
}
