/**
 * BVH 加速拾取（P5 Assembly 2.0）
 *
 * 为 GLTF mesh 建立 three-mesh-bvh 包围体层次，加速 Raycaster 拾取。
 * 在模块加载时一次性 patch THREE.Mesh.raycast，加载模型后调用
 * `accelerateObjectMeshes` 即可。
 */

import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

type BoundsGeometry = THREE.BufferGeometry & {
  boundsTree?: unknown;
  computeBoundsTree?: typeof computeBoundsTree;
  disposeBoundsTree?: typeof disposeBoundsTree;
};

let patched = false;

function ensureRaycastPatch() {
  if (patched) {
    return;
  }
  patched = true;
  const geometryProto = THREE.BufferGeometry.prototype as BoundsGeometry;
  geometryProto.computeBoundsTree = computeBoundsTree;
  geometryProto.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

/** 为 Object3D 子树里所有 Mesh 构建 BVH（幂等：已有 boundsTree 则跳过）。 */
export function accelerateObjectMeshes(root: THREE.Object3D): void {
  ensureRaycastPatch();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const geometry = mesh.geometry as BoundsGeometry;
    if (!geometry?.isBufferGeometry || geometry.boundsTree) {
      return;
    }
    geometry.computeBoundsTree?.();
  });
}

/** 释放 BVH 树（卸载模型时调用，避免内存泄漏）。 */
export function disposeObjectMeshesBvh(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const geometry = mesh.geometry as BoundsGeometry;
    geometry.disposeBoundsTree?.();
  });
}
