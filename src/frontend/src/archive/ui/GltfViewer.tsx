import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three-inventory';
import { OrbitControls } from 'three-inventory/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';

/** 台账模型查看器；扫描模型和照片重建模型共用，后者显示来源说明。 */
export default function GltfViewer({ url, info }: { url: string; info?: { label: string; description: string; view?: [number, number, number] } }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loadText, setLoadText] = useState('');

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    (renderer as any).outputEncoding = (THREE as any).sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const updateBackground = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim() || '#111820';
      scene.background = new THREE.Color(color).convertSRGBToLinear();
    };
    updateBackground();
    const themeObserver = new MutationObserver(updateBackground);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    const ctl = new OrbitControls(cam, renderer.domElement);
    ctl.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x39404a, 0.85));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.15); d1.position.set(3, 5, 4);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.45); d2.position.set(-4, 2, -3);
    scene.add(d1, d2);
    const root = new THREE.Group();
    scene.add(root);

    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      cam.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      cam.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const fit = () => {
      const bb = new THREE.Box3().setFromObject(root);
      if (bb.isEmpty()) return;
      const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
      root.position.sub(c);
      const R = Math.max(s.x, s.y, s.z);
      cam.near = R / 100; cam.far = R * 30;
      const view = info?.view ?? [0.75, 0.45, 1.25];
      const direction = new THREE.Vector3(...view).normalize();
      if (info) {
        const right = new THREE.Vector3().crossVectors(cam.up, direction).normalize();
        const up = new THREE.Vector3().crossVectors(direction, right).normalize();
        const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        const tanX = tanY * cam.aspect;
        let distance = 0;
        for (const x of [-s.x / 2, s.x / 2]) for (const y of [-s.y / 2, s.y / 2]) for (const z of [-s.z / 2, s.z / 2]) {
          const p = new THREE.Vector3(x, y, z);
          distance = Math.max(distance, Math.abs(p.dot(right)) / tanX + p.dot(direction), Math.abs(p.dot(up)) / tanY + p.dot(direction));
        }
        cam.position.copy(direction.multiplyScalar(distance * 1.10));
      } else cam.position.set(R * view[0], R * view[1], R * view[2]);
      cam.updateProjectionMatrix();
      ctl.target.set(0, 0, 0); ctl.update();
    };

    let disposed = false;
    setLoadText('加载三维模型…');
    new GLTFLoader().load(url, g => {
      if (disposed) return;
      root.add(g.scene);
      fit();
      setLoadText('');
    }, xhr => {
      if (disposed) return;
      setLoadText(xhr.total
        ? `加载三维模型… ${Math.round(xhr.loaded / xhr.total * 100)}%`
        : `加载三维模型… ${(xhr.loaded / 1048576).toFixed(1)} MB`);
    }, () => {
      if (disposed) return;
      setLoadText('模型加载失败');
    });

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      ctl.update();
      renderer.render(scene, cam);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      ctl.dispose();
      root.traverse((o: any) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        mats.forEach((mt: any) => {
          for (const k in mt) if (mt[k]?.isTexture) mt[k].dispose();
          mt.dispose();
        });
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);

  return (
    <div className={`gv${info ? ' gv-with-note' : ''}`}>
      {info && <div className="gv-model-note"><b>{info.label}</b><span>{info.description}</span></div>}
      <div className="gv-canvas" ref={hostRef} />
      {loadText && <div className="gv-load">{loadText}</div>}
      {!loadText && <div className="gv-tip">拖动旋转 · 滚轮缩放 · 右键平移</div>}
    </div>
  );
}
