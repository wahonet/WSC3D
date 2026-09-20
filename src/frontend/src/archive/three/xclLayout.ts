import * as THREE from 'three-inventory';

type Placement = {id:string;wall:'W'|'N'|'S';L:number;H:number;T:number;along:number;off:number;y:number;rotY:number};

/** Change the stone and its attached photograph together. Catalogue sizes stay intact. */
export function applyXclLayout(scene: THREE.Scene, rows: Placement[]) {
  const byNo = new Map(rows.map(row=>[row.id,row]));
  let count=0;
  scene.traverse(object=>{
    const base = object.userData.xclBaseSize;
    const d = byNo.get(object.userData.hps?.catalogue_no);
    if(!base || !d) return;
    object.scale.set(d.L/base[0],d.H/base[1],d.T/base[2]);
    const x=d.wall==='W' ? 45.67+d.along : d.wall==='N' ? 45.67+d.off : 71.57-d.off;
    const z=16.93-(d.wall==='W' ? d.off : d.along);
    object.position.set(x,.21+.48+d.y+d.H/2,z);
    object.rotation.y=(d.wall==='W'?0:d.wall==='N'?Math.PI/2:-Math.PI/2)-d.rotY;
    count++;
  });
  scene.updateMatrixWorld(true);
  return count;
}

export function watchXclLayout(scene:THREE.Scene, changed:()=>void) {
  let disposed=false, pending=false, last='';
  const refresh=async()=>{
    if(disposed||pending) return;
    pending=true;
    try {
      const response=await fetch('/api/layouts/xcl',{cache:'no-store'});
      if(!response.ok) throw new Error('无法读取西长廊摆放');
      const layout=await response.json();
      const signature=JSON.stringify(layout.stones);
      if(!disposed && signature!==last) {
        applyXclLayout(scene,layout.stones); last=signature; changed();
      }
    } catch(error) { if(!disposed) console.warn(error); }
    finally { pending=false; }
  };
  const visible=()=>{if(!document.hidden) void refresh();};
  const message=(event:MessageEvent)=>{if(event.origin===location.origin && event.data?.type==='xcl-layout-applied') void refresh();};
  window.addEventListener('focus',refresh);
  window.addEventListener('message',message);
  document.addEventListener('visibilitychange',visible);
  void refresh();
  return ()=>{disposed=true;window.removeEventListener('focus',refresh);window.removeEventListener('message',message);document.removeEventListener('visibilitychange',visible);};
}
