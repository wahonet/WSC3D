import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { StoneListItem } from "../../api/client";

type StoneViewerProps = {
  stone: StoneListItem;
  viewMode: "3d" | "2d";
  background: "black" | "gray" | "white";
};

const backgroundColors = {
  black: 0x141312,
  gray: 0x6f6a62,
  white: 0xf2eee8
};

export function StoneViewer({ stone, viewMode, background }: StoneViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

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

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 700;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const perspectiveCamera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    const orthoSize = 180;
    const orthographicCamera = new THREE.OrthographicCamera(
      (-orthoSize * width) / height,
      (orthoSize * width) / height,
      orthoSize,
      -orthoSize,
      -10000,
      10000
    );
    const activeCamera = viewMode === "2d" ? orthographicCamera : perspectiveCamera;

    const controls = new OrbitControls(activeCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.enableRotate = viewMode === "3d";
    controls.enablePan = true;
    controls.enableZoom = true;
    if (viewMode === "2d") {
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.PAN;
    }

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
    scene.add(grid);

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
        fitModel(model, perspectiveCamera, orthographicCamera, controls, viewMode);
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

    const resize = () => {
      const nextWidth = container.clientWidth || width;
      const nextHeight = container.clientHeight || height;
      renderer.setSize(nextWidth, nextHeight);
      perspectiveCamera.aspect = nextWidth / nextHeight;
      perspectiveCamera.updateProjectionMatrix();
      orthographicCamera.left = (-orthoSize * nextWidth) / nextHeight;
      orthographicCamera.right = (orthoSize * nextWidth) / nextHeight;
      orthographicCamera.top = orthoSize;
      orthographicCamera.bottom = -orthoSize;
      orthographicCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const animate = () => {
      if (disposed) {
        return;
      }
      controls.update();
      renderer.render(scene, activeCamera);
      requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      disposeObject(scene);
      container.innerHTML = "";
    };
  }, [stone.modelUrl, viewMode, background]);

  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="three-stage" />
      <div className="viewer-hud top-left">
        <strong>{viewMode === "3d" ? "3D 模型" : "2D 正投影"}</strong>
        <span>{stone.hasMetadata ? "结构化数据已匹配" : "未匹配结构化数据"}</span>
      </div>
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

function fitModel(
  model: THREE.Object3D,
  perspectiveCamera: THREE.PerspectiveCamera,
  orthographicCamera: THREE.OrthographicCamera,
  controls: OrbitControls,
  viewMode: "3d" | "2d"
) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);

  model.position.sub(center);
  controls.target.set(0, 0, 0);

  perspectiveCamera.near = Math.max(maxDim / 1000, 0.01);
  perspectiveCamera.far = maxDim * 20;
  perspectiveCamera.position.set(maxDim * 0.25, -maxDim * 0.45, maxDim * 1.55);
  perspectiveCamera.lookAt(0, 0, 0);
  perspectiveCamera.updateProjectionMatrix();

  const aspect = Math.abs(orthographicCamera.right - orthographicCamera.left) / Math.abs(orthographicCamera.top - orthographicCamera.bottom);
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
