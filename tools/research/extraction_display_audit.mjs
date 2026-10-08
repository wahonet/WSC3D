import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import vm from 'node:vm';
const req = createRequire(process.env.WSC_NODE_MODULES + '/package.json');
const { build } = req('esbuild');
(async () => {
 const root = fileURLToPath(new URL('../../', import.meta.url));
 const out = root + '/resources/authoring/research/rear46-execution-20261003';
 const bundle = await build({ stdin: { contents: "export {collectStories} from './src/frontend/src/lib/storyCutouts'; export {collectMotifs} from './src/frontend/src/lib/motifCutouts'; export {imageVersion, associatedImageVersions, displayImageVersions} from './src/frontend/src/lib/imageVersions';", resolveDir: root, loader: 'ts' }, nodePaths:[process.env.WSC_NODE_MODULES], bundle: true, write: false, platform:'node', format:'cjs', logLevel:'silent' });
 const ctx = vm.createContext({ module: { exports: {} }, URL });
 vm.runInContext(bundle.outputFiles[0].text, ctx);
 const lib = ctx.module.exports;
 const get = async path => { const response = await fetch('http://127.0.0.1:8030/api' + path); if (!response.ok) throw new Error(path + ': ' + response.status); return await response.json(); };
 const stones = await get('/stones');
 const results = [];
 const issues = [];
 for (let n = 11; n <= 53; n++) {
  const id = '武' + String(n).padStart(3,'0');
  const stone = stones.find(s => s.id === id);
  const annotations = await get('/stones/' + encodeURIComponent(id) + '/annotations');
  const native = annotations.filter(a => a.geometry.image_version?.segmentation?.review_policy === 'object-level-extraction-20261004');
  const motifs = lib.collectMotifs(stone, annotations), stories = lib.collectStories(stone, annotations);
  const visible = new Set([...lib.displayImageVersions(motifs), ...lib.displayImageVersions(stories)].map(i => i.annotation.id));
  const ineligible = native.filter(a => !visible.has(a.id));
  const sourceGroups = new Map();
  for (const item of [...motifs, ...stories].filter(i => i.annotation.geometry.image_version?.segmentation?.review_policy === 'object-level-extraction-20261004')) {
   const meta = item.annotation.geometry.image_version, key = item.annotation.level + ':' + meta.canonical_annotation_id;
   const group = sourceGroups.get(key) || []; group.push(item); sourceGroups.set(key,group);
  }
  let linkedGroups = 0;
  for (const group of sourceGroups.values()) {
   const current = group[0], items = current.annotation.level === 'scene' ? stories : motifs;
   const linked = lib.associatedImageVersions(current, items);
   const ids = new Set(linked.map(i=>i.annotation.id));
   const missing = group.filter(i=>!ids.has(i.annotation.id));
   if(missing.length) issues.push({stone:id, issue:'native source gallery association', canonical_id:current.annotation.geometry.image_version.canonical_annotation_id, missing_native_ids:missing.map(i=>i.annotation.id)});
   else linkedGroups++;
  }
  for (const a of ineligible) issues.push({stone:id, annotation_id:a.id, level:a.level,tool:a.tool,atype:a.atype,label:a.label,references:a.references.filter(r=>r.kind==='segment'&&!r.source_missing).length,status:a.review_status,parent_id:a.parent_id});
  results.push({stone_id:id,native_versions:native.length,motif_cards:lib.displayImageVersions(motifs).length,story_cards:lib.displayImageVersions(stories).length,ineligible_native_count:ineligible.length,source_groups_checked:sourceGroups.size,source_groups_linked:linkedGroups});
 }
 const result = {format:'wsc-extraction-display-data-audit-1',scope:'武011—武053',updated_at:new Date().toISOString(),native_versions_checked:results.reduce((a,r)=>a+r.native_versions,0),source_groups_checked:results.reduce((a,r)=>a+r.source_groups_checked,0),checks:'Real read-only API data run through gallery eligibility and source grouping; no image rendering or browser-state access.',stones:results,issues};
 fs.writeFileSync(out + '/display-data-audit.json', JSON.stringify(result),'utf8');
 console.log(JSON.stringify({native:results.reduce((a,r)=>a+r.native_versions,0),ineligible:issues.length,breakdown:issues.reduce((a,r)=>{const k=r.level+':'+r.tool+':'+r.atype+':refs'+r.references;a[k]=(a[k]||0)+1;return a;},{})}));
})().catch(e=>{console.error(e);process.exitCode=1;});
