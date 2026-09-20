import { useEffect, useRef, useState } from 'react';
import { locLabel, useStore } from '../store';
import { api } from '../api';
import type { StoneBrief, StoneDetail } from '../types';
import GltfViewer from './GltfViewer';
import Markdown from './Markdown';
import { pageFromLoc } from '../pageloc';
import { goToSection, openExtensionBook } from '../../lib/navigation';
import { useEntranceMotion } from '../../hooks/useEntranceMotion';
import ScanButton from './ScanButton';
import PublishedAnnotations from './PublishedAnnotations';

const SRC_LABEL: Record<string, string> = { measured: '实测', registry: '名录', estimated: '估算' };

export default function LedgerView({ editable = false }: { editable?: boolean }) {
  const { selectedId, stones, detail, stats, openLightbox, mediaTarget } = useStore();
  const brief = stones.find(s => s.id === selectedId);
  const [tab, setTab] = useState('');
  const previewRef = useEntranceMotion<HTMLDivElement>(tab, { duration: 260, skipInitial: true });
  const [photoIdx, setPhotoIdx] = useState(0);
  const versions = detail?.media_versions ?? [];
  const version = versions.find(v => v.id === tab);
  const items = version?.items ?? [];
  const cur = Math.min(photoIdx, Math.max(0, items.length - 1));
  const item = items[cur];
  const filmRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setTab(''); setPhotoIdx(0); }, [selectedId]);
  useEffect(() => {
    if (!detail) return;
    if (mediaTarget) {
      const v = detail.media_versions.find(v => v.id === mediaTarget.version);
      if (v) { setTab(v.id); setPhotoIdx(Math.max(0, v.items.findIndex(i => i.id === mediaTarget.itemId))); return; }
    }
    setTab(detail.model ? 'model' : (detail.media_versions[0]?.id ?? ''));
    setPhotoIdx(0);
  }, [detail?.id, mediaTarget]);
  const step = (dir: number) => setPhotoIdx(i => (i + dir + items.length) % items.length);
  useEffect(() => {
    if (items.length < 2) return;
    const onKey = (ev: KeyboardEvent) => {
      if (useStore.getState().lightbox || (ev.target instanceof HTMLElement && ev.target.closest('input,textarea,select,[contenteditable]'))) return;
      if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
        ev.preventDefault();
        setPhotoIdx(i => (i + (ev.code === 'ArrowLeft' ? -1 : 1) + items.length) % items.length);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [items.length]);
  useEffect(() => { filmRef.current?.querySelector('.film-item.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [cur, tab]);
  const chooseTab = (id: string) => { setTab(id); setPhotoIdx(0); };
  return <div className="ledger">
    <div className="lg-tabs" role="tablist" aria-label="影像版本">
      {brief?.has_model && <button role="tab" aria-selected={tab === 'model'} className={tab === 'model' ? 'on' : ''} onClick={() => chooseTab('model')}>三维模型</button>}
      {versions.map(v => <button key={v.id} role="tab" aria-selected={tab === v.id} className={tab === v.id ? 'on' : ''} onClick={() => chooseTab(v.id)}>{v.label}<span className="version-count">{v.items.length}</span></button>)}
      {brief && !detail && <span className="arch-dim">读取影像版本…</span>}
    </div>
    <div className="lg-body"><div className="lg-stage"><div className="lg-preview" ref={previewRef}>
      {!brief && <div className="lg-empty">{stats && <div className="lg-stats">
        <div><b>{stats.total}</b><span>石刻档案</span></div><div><b>{stats.with_photos}</b><span>有影像</span></div><div><b>{stats.with_model}</b><span>三维模型</span></div>
      </div>}<div className="lg-hint">在左侧选择石刻，查看照片版本与身份卡</div></div>}
      {brief && !detail && <div className="lg-none">读取档案…</div>}
      {brief && detail && !tab && <div className="lg-none">暂无影像资料</div>}
      {tab === 'model' && detail?.model && <GltfViewer key={detail.id} url={detail.model} info={detail.model_info} />}
      {brief && item && <div className="lg-photo-main"><img key={item.id} src={item.url} alt={item.label} onClick={() => openLightbox(items.map(i => i.url), cur, `${brief.name} · ${version?.label}`)} />
        {items.length > 1 && <><button className="ph-nav prev" aria-label="上一张" onClick={() => step(-1)}>‹</button><button className="ph-nav next" aria-label="下一张" onClick={() => step(1)}>›</button></>}
      </div>}
    </div>
    {item && <div className="media-caption"><div><span className="media-index">{cur + 1} / {items.length}</span><span title={item.label}>{decodeURIComponent(item.label)}</span></div>
      <a href={item.original_url} download={item.original_name} title="下载保留的原始文件">下载原图{item.bytes ? ` · ${(item.bytes / 1048576).toFixed(1)} MB` : ''}</a></div>}
    {items.length > 0 && <div className="lg-film" ref={filmRef}>{items.map((p, idx) => <button key={p.id} className={'film-item' + (idx === cur ? ' cur' : '')} title={decodeURIComponent(p.label)} aria-label={`查看第${idx + 1}张`} onClick={() => setPhotoIdx(idx)}><img src={p.thumbnail_url} alt={decodeURIComponent(p.label)} loading="lazy" /></button>)}</div>}
    </div><aside className="lg-arch">{brief ? <ArchPanel key={`${brief.id}:${editable}`} brief={brief} detail={detail} editable={editable} /> : <div className="arch-empty">在左侧选择石刻<br />此处显示档案</div>}<MiniMap location={brief?.location} /></aside></div>
  </div>;
}

function MiniMap({ location }: { location?: string }) {
  const setStageSlot = useStore(s => s.setStageSlot);
  const setModule = useStore(s => s.setModule);
  const slotRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setStageSlot(slotRef.current); return () => setStageSlot(null); }, [setStageSlot]);
  return <div className="mini"><div className="mini-hd"><span className="mini-cap">当前位置：<span className="mini-loc">{locLabel(location)}</span></span><button className="mini-x" title="进入全景" onClick={() => { setModule('scene'); const state = useStore.getState(); if (state.selectedId) state.ctrl?.focus(state.selectedId); }}>⤢</button></div><div className="mini-slot" ref={slotRef} /></div>;
}

function ArchPanel({ brief, detail: d, editable }: { brief: StoneBrief; detail: StoneDetail | null; editable: boolean }) {
  const updateDetail = useStore(s => s.updateDetail);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', condition: '', note: '', intro: '' });
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setEditing(false); scrollRef.current?.scrollTo({ top: 0 }); }, [brief.id]);
  const size = d?.size_cm || brief.size_cm;
  const src = d?.size_source || brief.size_source;
  const grade = d?.grading ?? brief.grading;
  const note = d?.note ?? brief.note;
  const collections = d?.collections ?? brief.collections ?? [];
  const aliases = (d?.aliases ?? brief.aliases).filter(a => a !== brief.legacy_id && !/^\d+\s/.test(a));
  const startEdit = () => { setForm({ name: d?.name || brief.name, condition: d?.condition || '', note: d?.note || '', intro: d?.intro || '' }); setEditing(true); };
  const save = async () => {
    setSaving(true);
    try { const r = await api.patchStone(brief.id, form); updateDetail(r.stone); setEditing(false); }
    catch { alert('保存失败，请检查后端服务'); }
    finally { setSaving(false); }
  };
  if (editing) return <div className="arch-scroll" ref={scrollRef}><div className="if-edit">
    <label>名称<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
    <label>状况<input value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })} /></label>
    <label>备注<textarea rows={3} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></label>
    <label>画像简介（Markdown）<textarea rows={18} value={form.intro} onChange={e => setForm({ ...form, intro: e.target.value })} /></label>
    <div className="if-btns"><button className="pri" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</button><button disabled={saving} onClick={() => setEditing(false)}>取消</button></div>
  </div></div>;
  return <div className="arch-scroll" ref={scrollRef}>
    <section className="identity-card" aria-label="身份卡">
      <div className="identity-eyebrow"><span>文物身份卡</span>{editable && <button className="if-editbtn" onClick={startEdit}>编辑</button>}</div><h2>{d?.name || brief.name}</h2>
      <dl className="identity-fields">
        <div><dt>编号</dt><dd><strong className="catalogue-no">{brief.catalogue_no}</strong><span className="classification-no">{brief.classification_no}</span></dd></div>
        <div><dt>位置</dt><dd>{locLabel(d?.location || brief.location)}</dd></div>
        <div><dt>尺寸</dt><dd>{d?.size_display || brief.size_display || (size ? <>{size.join(' × ')} cm{src && <i className="mtag">{SRC_LABEL[src] || src}</i>}</> : d?.catalogue.size || '待补充')}</dd></div>
        <div><dt>年代</dt><dd>{d?.era || '…'}<span className="identity-material">{d?.material || '石'}</span></dd></div>
        <div><dt>组属</dt><dd>{d?.group || '待考'}</dd></div>
        {collections.length > 0 && <div><dt>专题组合</dt><dd>{collections.join('、')}</dd></div>}
        <div><dt>工艺</dt><dd>{d?.technique || '待考'}</dd></div>
        <div><dt>定级</dt><dd>{grade ? <><span className={grade.confirmed ? 'grade-value' : ''}>{grade.level}</span>{!grade.confirmed && <span className="grade-pending">台账登记 · 依据待核</span>}</> : '本次资料未见定级记录'}</dd></div>
        {aliases.length > 0 && <div className="identity-aliases"><dt>其他名称</dt><dd>{aliases.join('、')}</dd></div>}
      </dl>
      {grade && <details className="grade-source"><summary>{grade.confirmed ? '查看定级依据' : '定级依据待核'}</summary><p>{grade.basis}</p>
        {grade.confirmed && <><p>{grade.document_no}<br />{grade.authority}<br />鉴定日期：{grade.appraisal_date}<br />发文日期：{grade.issued_date}</p>
          <p>报告定名：{grade.report_name}{grade.report_identifier && <><br />报告原编号：{grade.report_identifier}</>}</p>
          {grade.set_name && <p>{grade.set_name} · 1套{grade.set_count}件之一</p>}
          <a href={`/files/imports/20260907/${encodeURIComponent(grade.report!)}#page=${grade.pdf_page}`} target="_blank" rel="noreferrer">查看报告第{grade.printed_page}页（PDF {grade.pdf_page}）· 条目{grade.report_row}</a>
        </>}
      </details>}
      {editable && <div className="identity-actions"><ScanButton stoneId={brief.id} />
        <button className="lg-research" title="在图像研究中打开这块画像石" onClick={() => goToSection('research', { stone: brief.id, p: 'home', manage: null })}>进入研究 →</button></div>}
    </section>
    <section className="arch-sec imagery-intro"><div className="arch-hd">画像简介</div>{d ? (d.intro ? <Markdown src={d.intro} /> : <div className="arch-dim">画像释读待补充</div>) : <div className="arch-dim">读取简介…</div>}</section>
    <PublishedAnnotations stoneId={brief.id} />
    <section className="arch-sec"><div className="arch-hd">著录与研究{d && d.book_refs.length > 0 && <span className="arch-n">{d.book_refs.length}</span>}</div>
      {d && d.book_refs.length > 0 && <div className="ref-list">{d.book_refs.map((r, i) => {
        const page = pageFromLoc(r.book, r.loc);
        return <button key={r.book + i} className="ref-row" title={r.note || '在扩展库中打开'} onClick={() => {
          void openExtensionBook(r.book, page || 1).then(opened => { if (!opened) alert(`《${r.title}》尚未收录 PDF 原文，当前仅有书目记录。`); })
            .catch(() => alert('无法打开扩展库，请检查后端服务'));
        }}><span className="ref-t">《{r.title}》{r.year && <i>{r.year}</i>}{page && <em className="ref-pg">定位原文</em>}</span>{r.loc && <span className="ref-l">{r.loc}</span>}</button>;
      })}</div>}
      {d?.research && <details className="research-dossier"><summary>展开原研究档案与校勘记录</summary><Markdown src={d.research} /></details>}
      {d && !d.research && !d.book_refs.length && <div className="arch-dim">著录与研究资料待补充</div>}
    </section>
    {(note || d?.condition) && <details className="archive-notes"><summary>现状与备注</summary>{d?.condition && <p>{d.condition}</p>}{note && <p>{note}</p>}</details>}
  </div>;
}
