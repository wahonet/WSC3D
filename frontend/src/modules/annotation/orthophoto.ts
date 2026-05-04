import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// G-new：从三维模型生成正射图。
//
// 场景：用户手头没有拓片 / 高清原图，但有三维模型；本工具用独立的 offscreen
// Three.js 渲染器把模型正面拍一张正射 PNG，作为标注底图"替代原图"使用。
//
// 为什么独立：直接用 StoneViewer 当前 canvas 截图会打扰用户视角，而且
// StoneViewer 的 canvas 尺寸太小（通常 < 1500 px），不够做后续 SAM / YOLO。
// 这里用独立渲染器 + 可配置长边（默认 3072px）+ 无 grid / 无光照 HUD，纯
// 模型 + 素色背景，贴近"拓片扫描"的视觉。
//
// 技术要点：
//   - OrthographicCamera：frustum 正好裹住模型 AABB，aspect 按目标长宽比
//   - 相机放在 +Z 轴（画像石正面方向），lookAt 模型中心
//   - 白底 / 黑底可选（默认浅灰 "rubbing-like" 更接近拓片视觉）
//   - 光照：ambient + 单光源从上方 30° 打光（浮雕立体感更清晰）
//   - 输出：渲染后读 canvas.toBlob("image/png")

export type OrthoImageOptions = {
  // 输出图像长边像素；默认 3072（SAM / YOLO 下游吃得动，放大缩小都合理）
  maxEdge?: number;
  // 背景色：latin / dark / light
  //   - "light"（默认）= 近拓片纸色，便于 AI 线图叠加
  //   - "dark" = 与 StoneViewer 默认黑底一致
  //   - "transparent" = 输出带 alpha 的 PNG
  background?: "light" | "dark" | "transparent";
  // 正面角度：默认 "front"（+Z），可选 "back" / "top" / "bottom"
  // 画像石浮雕几乎都刻在 +Z 面，默认 front 够用；其他方向留扩展点
  view?: "front" | "back" | "top" | "bottom";
};

export type OrthoImageResult = {
  blob: Blob;
  // 实际输出像素尺寸
  width: number;
  height: number;
  // 模型在 3D 空间的 AABB 尺寸（单位：模型单位），便于外部把像素 ↔ 真实 cm 换算
  modelSize: { width: number; height: number; depth: number };
  // I2 v0.8.0：生成时的相机 frustum 缩放系数（与 AABB 的比例）。默认 1.0 =
  // frustum 严格贴 AABB 无白边。反推 modelBox UV ↔ 正射图 UV：
  //   out_u = model_u * (1 / frustumScale) + (1 - 1/frustumScale) / 2
  frustumScale: number;
  view: "front" | "back" | "top" | "bottom";
  // 生成出的图像坐标系与 modelBox UV 是否完全等价（view="front" +
  // frustumScale=1.0 时满足）。true 则跨 3D ↔ 正射视图共享标注无需变换
  equivalentToModel: boolean;
};

const backgroundColors: Record<NonNullable<OrthoImageOptions["background"]>, number | null> = {
  light: 0xefe7d8,
  dark: 0x141312,
  transparent: null
};

/**
 * 从 modelUrl 加载 GLTF，用正射相机拍一张正面 PNG，返回 Blob + 尺寸。
 * 所有 Three.js 资源在 finally 里销毁，避免 WebGL context 泄漏。
 */
export async function generateOrthoImage(
  modelUrl: string,
  options: OrthoImageOptions = {}
): Promise<OrthoImageResult> {
  const maxEdge = Math.max(512, Math.min(options.maxEdge ?? 3072, 4096));
  const background = options.background ?? "light";
  const view = options.view ?? "front";

  // 先加载 GLTF，拿到 AABB 后再决定 canvas 比例
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.load(
      modelUrl,
      (result) => resolve(result),
      undefined,
      (error) => reject(error)
    );
  });

  const model = gltf.scene;
  // 先把模型加进一个临时场景计算 bbox（不加光照）
  const bboxHelper = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  bboxHelper.getSize(size);
  const center = new THREE.Vector3();
  bboxHelper.getCenter(center);

  // 按 view 决定画面的 "width" / "height"（即正射平面的两个分量）
  // view === "front" | "back"：画面宽 = X，画面高 = Y
  // view === "top"  | "bottom"：画面宽 = X，画面高 = Z
  let planeWidth: number;
  let planeHeight: number;
  switch (view) {
    case "top":
    case "bottom":
      planeWidth = Math.max(size.x, 1e-3);
      planeHeight = Math.max(size.z, 1e-3);
      break;
    default:
      planeWidth = Math.max(size.x, 1e-3);
      planeHeight = Math.max(size.y, 1e-3);
      break;
  }

  // 输出图像的像素尺寸，等比按模型 AABB 取值；长边 = maxEdge
  const aspect = planeWidth / planeHeight;
  let outWidth: number;
  let outHeight: number;
  if (aspect >= 1) {
    outWidth = maxEdge;
    outHeight = Math.round(maxEdge / aspect);
  } else {
    outHeight = maxEdge;
    outWidth = Math.round(maxEdge * aspect);
  }
  // 保证最小 256，避免极端比例导致 1px 的输出
  outWidth = Math.max(256, outWidth);
  outHeight = Math.max(256, outHeight);

  // 建 offscreen canvas + renderer
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: background === "transparent",
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(1);
  renderer.setSize(outWidth, outHeight, false);

  const clearColor = backgroundColors[background];
  if (clearColor === null) {
    renderer.setClearColor(0x000000, 0);
  } else {
    renderer.setClearColor(clearColor, 1);
  }

  const scene = new THREE.Scene();
  scene.add(model);

  // frustumScale = 1.0：frustum 严格裹住 AABB，画面无白边。
  // 这样 modelBox UV (u, v) ↔ 正射图 UV (u', v') 直接 1:1 对齐（都是 AABB
  // 归一化坐标），让跨资源标注投影最简化、误差最小。
  // 如果将来真的需要留白防止抗锯齿边缘截断，可在此改回 1.01 左右并同步更新
  // resource.transform.frustumScale 让下游投影计算保持一致。
  const frustumScale = 1.0;
  const frustumHalfW = (planeWidth / 2) * frustumScale;
  const frustumHalfH = (planeHeight / 2) * frustumScale;
  const maxDim = Math.max(size.x, size.y, size.z);
  const cameraDistance = Math.max(maxDim * 3, 100);
  const camera = new THREE.OrthographicCamera(
    -frustumHalfW,
    frustumHalfW,
    frustumHalfH,
    -frustumHalfH,
    0.01,
    cameraDistance * 4
  );

  switch (view) {
    case "back":
      camera.position.set(center.x, center.y, center.z - cameraDistance);
      camera.up.set(0, 1, 0);
      break;
    case "top":
      camera.position.set(center.x, center.y + cameraDistance, center.z);
      camera.up.set(0, 0, -1);
      break;
    case "bottom":
      camera.position.set(center.x, center.y - cameraDistance, center.z);
      camera.up.set(0, 0, 1);
      break;
    default:
      camera.position.set(center.x, center.y, center.z + cameraDistance);
      camera.up.set(0, 1, 0);
      break;
  }
  camera.lookAt(center);

  // 光照：环境光保证阴影不全黑 + 斜上方 45° 方向光让浮雕立体
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  // 相对于相机方向，斜上 30° + 左偏 30°，模拟拓片摄影棚单灯
  keyLight.position.copy(camera.position).add(new THREE.Vector3(maxDim * 0.5, maxDim * 0.8, 0));
  scene.add(ambient, keyLight);

  try {
    renderer.render(scene, camera);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
    return {
      blob,
      width: outWidth,
      height: outHeight,
      modelSize: { width: size.x, height: size.y, depth: size.z },
      frustumScale,
      view,
      equivalentToModel: view === "front" && Math.abs(frustumScale - 1.0) < 1e-6
    };
  } finally {
    // 销毁顺序：先移除模型、释放资源，再 dispose renderer
    scene.remove(model);
    disposeObject(model);
    scene.remove(ambient, keyLight);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose?.());
      } else {
        (material as THREE.Material | undefined)?.dispose?.();
      }
    }
  });
}
