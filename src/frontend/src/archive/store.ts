import { create } from 'zustand';
import type { Book, ModuleKey, StoneBrief, StoneDetail, Stats, ViewKey } from './types';
import type { ContextStatus } from './three/siteContext';
import { api } from './api';
import { useApp } from '../store/useApp';

/** three 场景控制器接口(由 SiteStage 装配注入) */
export interface SiteController {
  focus(id: string): boolean;
  flyToView(v: ViewKey): void;
  setRoof(on: boolean): void;
  /** 透明度0–100；100时墙体及轮廓线完全隐藏 */
  setWallsXray(on: boolean, transparency?: number): void;
  setWalk(on: boolean): void;
  /** 周边环境及传承中心统一开关；首次开启时按需加载 */
  setContext(on: boolean): void;
  setSelected(id: string | null): void;
  hasMesh(id: string): boolean;
  getCoordinates?(id: string): { latitudeDeg: number; longitudeDeg: number; modelYMetres: number } | null;
}

interface AppState {
  stones: StoneBrief[];
  stats: Stats | null;
  books: Book[];
  module: ModuleKey;                 // 当前模块: 台账 / 全景 / 文献 / 检索
  searchQ: string;                   // 全局搜索词(顶栏提交 -> 检索模块执行)
  selectedId: string | null;
  selectedBookId: string | null;
  /** 文献PDF定位目标(著录/检索片段点击带入): 页码+说明标签+页内高亮词 */
  bookTarget: { page: number; label: string; search?: string; nonce: number } | null;
  detail: StoneDetail | null;        // 当前选中的档案详情
  mediaTarget: { version: string; itemId: string } | null;
  lightbox: { photos: string[]; index: number; title: string } | null;
  roofOn: boolean;
  wallsXray: boolean;                // 墙体透明查看模式
  wallTransparency: number;          // 0–100，默认50
  walkOn: boolean;
  contextOn: boolean;                // 每次刷新默认关闭，仅显示武氏祠
  contextStatus: ContextStatus;      // 周边环境与传承中心的共同加载状态
  ctrl: SiteController | null;
  stageSlot: HTMLElement | null;     // 三维画布当前停靠的槽位(小地图 / 全景主区)

  load(): Promise<void>;
  scanning: string | null;
  scanMessage: string;
  rescan(id?: string): Promise<void>;
  setModule(m: ModuleKey): void;
  /** 顶栏提交搜索: 切到检索模块并执行 */
  submitSearch(q: string): void;
  /** 选中石刻; fly=true 时相机飞行定位 */
  select(id: string | null, fly?: boolean): void;
  selectMedia(id: string, version: string, itemId: string): void;
  /** 选中文献; target 给出时打开后定位到该PDF页并显示标识条(search词页内高亮) */
  selectBook(id: string | null, target?: { page: number; label: string; search?: string }): void;
  refreshDetail(): Promise<void>;
  openLightbox(photos: string[], index: number, title: string): void;
  closeLightbox(): void;
  toggleRoof(): void;
  toggleWallsXray(): void;
  setWallTransparency(value: number): void;
  setWalk(on: boolean): void;
  toggleContext(): void;
  setContextStatus(s: ContextStatus): void;
  setCtrl(c: SiteController | null): void;
  setStageSlot(el: HTMLElement | null): void;
  updateDetail(d: StoneDetail): void;
}

export const useStore = create<AppState>((set, get) => ({
  stones: [],
  stats: null,
  books: [],
  module: 'ledger',
  searchQ: '',
  selectedId: null,
  selectedBookId: null,
  bookTarget: null,
  detail: null,
  mediaTarget: null,
  lightbox: null,
  roofOn: true,
  wallsXray: false,
  wallTransparency: 50,
  walkOn: false,
  contextOn: false,
  contextStatus: 'idle',
  ctrl: null,
  stageSlot: null,
  scanning: null,
  scanMessage: '',

  async rescan(id) {
    if (get().scanning) return;
    set({ scanning: id || 'all', scanMessage: '' });
    try {
      const { report } = await api.rescan(id);
      await get().load();
      await get().refreshDetail();
      const research = useApp.getState();
      await Promise.all([research.loadStones(), research.loadStats()]);
      set({ scanMessage: `${id ? id : `全部 ${report.stones} 件`}：${report.assets_added ? `新增 ${report.assets_added} 个资源，${report.archive_added} 张影像已加入档案` : '没有新增文件'}${report.skipped.length ? `；${report.skipped.length} 个文件暂不可读，请复制完成后重试` : ''}` });
    } catch (error) {
      set({ scanMessage: `扫描未完成：${error instanceof Error ? error.message : '请重试'}` });
    } finally { set({ scanning: null }); }
  },

  async load() {
    const [stones, stats, books] = await Promise.all([
      api.listStones(), api.getStats(), api.listBooks(),
    ]);
    set({ stones, stats, books });
    const selected = get().selectedId;
    const match = stones.find(s => s.id === selected || s.legacy_id === selected || s.catalogue_no === selected);
    if (match && selected !== match.id) get().select(match.id, true);
  },

  setModule(m) {
    if (m !== 'scene' && get().walkOn) get().setWalk(false);
    set({ module: m });
  },

  submitSearch(q) {
    if (get().walkOn) get().setWalk(false);
    set({ module: 'search', searchQ: q });
  },

  select(id, fly = false) {
    const match = get().stones.find(s => s.id === id || s.legacy_id === id || s.catalogue_no === id);
    id = match?.id ?? id;
    if (id !== get().selectedId) set({ selectedId: id, detail: null, mediaTarget: null });
    if (id) {
      get().refreshDetail();
      if (fly) get().ctrl?.focus(id);
    }
  },

  selectMedia(id, version, itemId) {
    get().select(id, true);
    set({ mediaTarget: { version, itemId }, module: 'ledger' });
  },

  selectBook(id, target) {
    set({
      selectedBookId: id,
      bookTarget: id && target ? { ...target, nonce: Date.now() } : null,
    });
  },

  async refreshDetail() {
    const id = get().selectedId;
    if (!id) return;
    try {
      const detail = await api.getStone(id);
      if (get().selectedId === id) set({ detail });
    } catch { /* 档案缺失时界面回退到基础信息 */ }
  },

  openLightbox(photos, index, title) { set({ lightbox: { photos, index, title } }); },
  closeLightbox() { set({ lightbox: null }); },

  toggleRoof() {
    const on = !get().roofOn;
    set({ roofOn: on });
    get().ctrl?.setRoof(on);
  },
  toggleWallsXray() {
    const on = !get().wallsXray;
    set({ wallsXray: on });
    get().ctrl?.setWallsXray(on, get().wallTransparency);
  },
  setWallTransparency(value) {
    if (!Number.isFinite(value)) return;
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    set({ wallTransparency: percent });
    get().ctrl?.setWallsXray(get().wallsXray, percent);
  },
  setWalk(on) {
    set({ walkOn: on });
    get().ctrl?.setWalk(on);
  },
  toggleContext() {
    const on = !get().contextOn;
    set({ contextOn: on });
    get().ctrl?.setContext(on);
  },
  setContextStatus(s) { set({ contextStatus: s }); },
  setCtrl(c) { set({ ctrl: c }); },
  setStageSlot(el) { set({ stageSlot: el }); },
  updateDetail(d) {
    set({ detail: d, stones: get().stones.map(s => (s.id === d.id ? { ...s, ...{
      name: d.name, condition: d.condition, note: d.note, has_intro: !!d.intro,
    } } : s)) });
  },
}));

export { locLabel } from './locations';
