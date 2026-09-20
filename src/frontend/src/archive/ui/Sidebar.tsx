import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Book, StoneBrief } from '../types';
import { LOCATION_GROUPS as TOP, locationKeys as groupKeys } from '../locations';
import ScanButton from './ScanButton';

/* ================= 石刻位置树 ================= */

const byNaturalId = (a: StoneBrief, b: StoneBrief) =>
  a.display_order - b.display_order || a.id.localeCompare(b.id, 'zh-CN', { numeric: true });

/* ================= 文献分类树 ================= */
const BOOK_CATS = ['武氏祠', '武梁祠', '汉画像石', '外文与综合', ''];
const catLabel = (c: string) => c || '其他书目';
const byYear = (a: Book, b: Book) =>
  a.year.localeCompare(b.year, 'zh-CN', { numeric: true }) ||
  a.title.localeCompare(b.title, 'zh-CN');

export default function Sidebar({ editable = false }: { editable?: boolean }) {
  const module = useStore(s => s.module);
  const scanMessage = useStore(s => s.scanMessage);
  const [q, setQ] = useState('');
  return (
    <aside className="side">
      {module === 'ledger' && editable && <div className="archive-scan-tools"><span>文物目录</span><ScanButton /></div>}
      <div className="side-search">
        <input
          placeholder={module === 'books' ? '搜索题名 / 作者…' : '筛选本页文物：编号 / 名称…'}
          value={q} onChange={e => setQ(e.target.value)}
        />
      </div>
      {module === 'ledger' && editable && scanMessage && <p className="archive-scan-result" role="status">{scanMessage}</p>}
      {module === 'books' ? <BookTree kw={q.trim().toLowerCase()} /> : <StoneTree kw={q.trim().toLowerCase()} />}
    </aside>
  );
}

function StoneTree({ kw }: { kw: string }) {
  const { stones, selectedId, select } = useStore();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const bodyRef = useRef<HTMLDivElement>(null);

  const byLoc = useMemo(() => {
    const m = new Map<string, StoneBrief[]>();
    for (const s of stones) {
      const hay = [s.id, s.name, s.catalogue_no, s.classification_no, s.location, ...s.aliases, ...(s.collections ?? []), s.grading?.level, s.is_graded ? '已定级' : ''].join(' ').toLowerCase();
      if (kw && !kw.split(/\s+/).every(term => hay.includes(term))) continue;
      if (!m.has(s.location)) m.set(s.location, []);
      m.get(s.location)!.push(s);
    }
    m.forEach(list => list.sort(byNaturalId));
    return m;
  }, [stones, kw]);

  const count = (locs: string[]) => locs.reduce((n, l) => n + (byLoc.get(l)?.length || 0), 0);
  const isOpen = (key: string) => (kw ? true : !!open[key]);
  const toggle = (key: string) => setOpen(o => ({ ...o, [key]: !o[key] }));

  /* 外部选中(三维点选等)时展开所在分组并滚动到该行 */
  useEffect(() => {
    if (!selectedId) return;
    const s = useStore.getState().stones.find(x => x.id === selectedId);
    if (!s) return;
    const keys = groupKeys(s.location);
    setOpen(o => {
      if (keys.every(k => o[k])) return o;
      const next = { ...o };
      keys.forEach(k => { next[k] = true; });
      return next;
    });
    requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-sid="${CSS.escape(selectedId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, stones.length]);

  const rows = (locs: string[], lv: number) =>
    locs.flatMap(l => byLoc.get(l) || []).sort(byNaturalId).map(s => (
      <div
        key={s.id}
        data-sid={s.id}
        role="button"
        tabIndex={0}
        aria-pressed={s.id === selectedId}
        className={`tree-row lv${lv} ${s.id === selectedId ? 'cur' : ''}`}
        title={`${s.catalogue_no} · ${s.name}${s.aliases.length ? '\n其他名称：' + s.aliases.join('、') : ''}`}
        onClick={() => select(s.id, true)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s.id, true); } }}
      >
        <span className="stone-tree-text"><span className="sid">{s.catalogue_no}</span><span className="nm">{s.name}</span></span>
        {s.is_graded && <span className="graded-tag" title={s.grading?.level}>已定级</span>}
      </div>
    ));

  return (
    <div className="tree" ref={bodyRef}>
      {TOP.map(g => {
        const n = count([...(g.locs || []), ...(g.children || [])]);
        if (kw && n === 0) return null;
        return (
          <div key={g.key}>
            <div className="tree-grp" role="button" tabIndex={0} aria-expanded={isOpen(g.key)} onClick={() => toggle(g.key)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g.key); } }}>
              <span className="tw">{isOpen(g.key) ? '−' : '+'}</span>
              {g.key}
              <span className="cnt">{n}</span>
            </div>
            {isOpen(g.key) && <>
              {rows(g.locs || [], 1)}
              {g.children?.map(loc => {
                  const cn = count([loc]);
                  if (kw && cn === 0) return null;
                  return (
                    <div key={loc}>
                      <div className="tree-grp tree-subgroup" role="button" tabIndex={0} aria-expanded={isOpen(loc)} onClick={() => toggle(loc)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(loc); } }}>
                        <span className="tw">{isOpen(loc) ? '−' : '+'}</span>
                        <span className="tree-group-name" title={loc}>{loc}</span>
                        <span className="cnt">{cn}</span>
                      </div>
                      {isOpen(loc) && rows([loc], 2)}
                    </div>
                  );
                })}
            </>}
          </div>
        );
      })}
    </div>
  );
}

function BookTree({ kw }: { kw: string }) {
  const { books, selectedBookId, selectBook } = useStore();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const bodyRef = useRef<HTMLDivElement>(null);

  const byCat = useMemo(() => {
    const m = new Map<string, Book[]>();
    for (const b of books) {
      if (kw && !(b.title + b.author + b.theme + b.kind + b.year).toLowerCase().includes(kw)) continue;
      const c = b.category.trim();
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(b);
    }
    m.forEach(list => list.sort(byYear));
    return m;
  }, [books, kw]);

  const categories = [...byCat.keys()].sort((a, b) => {
    const rank = (c: string) => c === '' ? 100 : BOOK_CATS.includes(c) ? BOOK_CATS.indexOf(c) : 50;
    return rank(a) - rank(b) || a.localeCompare(b, 'zh-CN');
  });

  const isOpen = (key: string) => (kw ? true : !!open[key]);

  /* 外部选中时展开所在分类并滚动到该行 */
  useEffect(() => {
    if (!selectedBookId) return;
    const b = useStore.getState().books.find(x => x.id === selectedBookId);
    if (!b) return;
    const c = b.category.trim();
    setOpen(o => (o[c] ? o : { ...o, [c]: true }));
    requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-bid="${CSS.escape(selectedBookId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBookId, books.length]);

  return (
    <div className="tree" ref={bodyRef}>
      {categories.map(c => {
        const items = byCat.get(c) || [];
        if (items.length === 0) return null;
        return (
          <div key={c || '_'}>
            <div className="tree-grp" role="button" tabIndex={0} aria-expanded={isOpen(c)}
              onClick={() => setOpen(o => ({ ...o, [c]: !o[c] }))}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => ({ ...o, [c]: !o[c] })); } }}>
              <span className="tw">{isOpen(c) ? '−' : '+'}</span>
              {catLabel(c)}
              <span className="cnt">{items.length}</span>
            </div>
            {isOpen(c) && items.map(b => (
              <div
                key={b.id}
                data-bid={b.id}
                role="button"
                tabIndex={0}
                aria-pressed={b.id === selectedBookId}
                className={`tree-row lv1 ${b.id === selectedBookId ? 'cur' : ''}`}
                onClick={() => selectBook(b.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBook(b.id); } }}
              >
                <span className="nm">{b.title}</span>
                <span className="sid">{b.year}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
