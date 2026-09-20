import * as THREE from 'three-inventory';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';
import type { PrepareModel } from './assetScheduling';

export function rearStoneBounds(stone: THREE.Object3D) {
  stone.updateWorldMatrix(true, true);
  const toHall = stone.parent!.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  stone.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.rearProxy || !object.visible) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox!.clone().applyMatrix4(toHall.clone().multiply(object.matrixWorld)));
  });
  return bounds;
}

/** Blender-built exhibit shell and the two original scanned stones, in the same hall frame. */
export function createRearExhibition(scene: THREE.Scene, roofList: THREE.Object3D[], wallList: THREE.Mesh[], changed: () => void,
  options: { after?: Promise<unknown>; prepare?: PrepareModel } = {}) {
  const hall = scene.getObjectByName('rear_exhibition_hall')!;
  const stones = scene.getObjectByName('HPS_HALL_IN')!;
  const loader = new GLTFLoader();
  let disposed = false;
  const report = { interior: 'loading', scans: 0, errors: [] as string[] };
  const pedestals = new Map<string, THREE.Mesh>();
  const plinthMaterial = new THREE.MeshStandardMaterial({color:0xdedbd4,roughness:.85});
  const shell = new THREE.Group(); shell.name='rear_exhibition_fitout'; hall.add(shell);
  const legacyCases = hall.children.filter(o => o.userData.showcase);
  // Keep the light count stable from the first frame: adding six lights after load
  // otherwise recompiles every lit material throughout the courtyard.
  for(const z of [-7,0,7])for(const x of [-3.8,3.8]) {
    const light=new THREE.PointLight(0xffefd5,.75,9,2);light.position.set(x,3.7,z);shell.add(light);
  }
  const load = async (url: string) => {
    await options.after;
    if (disposed) throw new DOMException('Disposed', 'AbortError');
    const gltf = await loader.loadAsync(url);
    try { await options.prepare?.(gltf.scene); }
    catch (error) { release(gltf.scene); throw error; }
    return gltf;
  };
  function syncPedestals() {
    if (disposed) return;
    const anchors = stones.children.filter(o=>o.userData.hps);
    const bounds = new Map(anchors.map(o=>[o,rearStoneBounds(o)]));
    for (const stone of anchors) {
      const id = stone.userData.hps.catalogue_no;
      const box = bounds.get(stone)!;
      if (box.isEmpty()) continue;
      let plinth = pedestals.get(id);
      if (!plinth) {
        plinth = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),plinthMaterial);
        plinth.name='rear_plinth_'+id;plinth.userData.showcase=true;
        plinth.castShadow=plinth.receiveShadow=true;
        shell.add(plinth);pedestals.set(id,plinth);
      }
      plinth.visible=box.min.y>.831;
      if (!plinth.visible) continue;
      const lower = anchors.some(other=> {
        const b=bounds.get(other)!;
        return other!==stone && !b.isEmpty() && b.min.y<box.min.y-.15 && b.max.y<=box.min.y+.03
          && b.max.x>box.min.x && b.min.x<box.max.x && b.max.z>box.min.z && b.min.z<box.max.z;
      });
      const height = lower ? .07 : box.min.y-.802;
      plinth.scale.set(box.max.x-box.min.x+.015,height,box.max.z-box.min.z+.015);
      plinth.position.set((box.min.x+box.max.x)/2,box.min.y-height/2,(box.min.z+box.max.z)/2);
    }
  }
  function release(root:THREE.Object3D) {
    root.traverse(o=> {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for(const mat of Array.isArray(o.material)?o.material:[o.material]) {
        Object.values(mat).forEach(v=>{if(v instanceof THREE.Texture)v.dispose();});mat.dispose();
      }
    });
  }
  const ready = load('/models/rear-exhibition-20260910.glb?v=2').then(gltf=>{
    if(disposed){release(gltf.scene);return;}
    gltf.scene.traverse(o=>{
      if(!(o instanceof THREE.Mesh))return;
      o.castShadow=o.userData.rear_role!=='glass'&&o.userData.rear_role!=='floor';o.receiveShadow=true;
      if(['ceiling','case_top'].includes(o.userData.rear_role))roofList.push(o);
      if(o.userData.rear_role==='wall')wallList.push(o);
      for(const mat of Array.isArray(o.material)?o.material:[o.material]) {
        const m=mat as THREE.MeshStandardMaterial;m.envMapIntensity=.15;
        if(m.transparent){m.depthWrite=false;m.side=THREE.DoubleSide;}
      }
    });
    shell.add(gltf.scene);legacyCases.forEach(o=>o.visible=false);
    report.interior='ready';syncPedestals();changed();
  }).catch(error=>{if(!disposed){report.interior='error';report.errors.push('展陈');console.error(error);changed();}});
  const scans=['023','024'].map(number=>load(`/models/rear-niche-${number}.glb?v=1`).then(gltf=>{
    if(disposed){release(gltf.scene);return;}
    const anchor=stones.children.find(o=>o.userData.hps?.catalogue_no==='武'+number) as THREE.Mesh;
    if(!anchor){release(gltf.scene);return;}
    // Keep the original pickable anchor and identity. Replace its surface only after successful loading.
    const scan=gltf.scene.getObjectByProperty('type','Mesh') as THREE.Mesh;
    if(!scan)throw new Error('小龛扫描网格缺失');
    const parts:THREE.Mesh[]=[];
    for(const child of anchor.children){child.visible=false;child.userData.superseded=true;}
    anchor.material=new THREE.MeshBasicMaterial({visible:false,transparent:true,opacity:0,depthWrite:false});
    anchor.castShadow=false;anchor.userData.rearProxy=true;
    anchor.add(gltf.scene);
    gltf.scene.traverse(o=>{
      if(!(o instanceof THREE.Mesh))return;
      o.userData.hpsRef=anchor;o.userData._mat0=o.material;o.castShadow=o.receiveShadow=true;
      parts.push(o);
      for(const m of Array.isArray(o.material)?o.material:[o.material]) {
        const mat=m as THREE.MeshStandardMaterial;mat.envMapIntensity=.1;
        if(mat.map)mat.map.anisotropy=8;
      }
    });
    anchor.userData._parts=parts;anchor.userData._glow=-1;
    report.scans++;syncPedestals();changed();
  }).catch(error=>{if(!disposed){report.errors.push('武'+number);console.error(error);changed();}}));
  scene.userData.rearExhibition=report;
  return { ready:Promise.all([ready,...scans]), report, syncPedestals, dispose(){disposed=true;} };
}
