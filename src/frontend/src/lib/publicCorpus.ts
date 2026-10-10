import { listStones, stoneAnnotations } from '../api'
import type { Annotation, StoneNode } from '../types'

/**
 * 画像形象库与故事形象库共用的标注语料：全部石件及其标注。
 *
 * 两个库都要逐石读取约 150 件石头的标注（合计上百 MB，后端约需 8 秒）。这里：
 * - 读取过程中按石号顺序陆续交出已读到的部分，页面不必等全部读完才显示卡片；
 * - 读完后在内存中缓存几分钟，在形象库、故事库之间切换时不必重新等待；
 * - 读取中途离开页面不会中断，结果留给下次进入。页面上的“刷新”按钮强制重新读取。
 */
export interface StoneAnnotations { stone: StoneNode; annotations: Annotation[] }
export interface AnnotationCorpus {
  stones: StoneNode[]
  /** 按石号顺序；读取中只含连续读完的前缀，避免卡片在已显示的卡片之间插入 */
  entries: StoneAnnotations[]
  /** 读取失败的石件，形如“武011：原因” */
  failures: string[]
  /** 有整体、分层、场景或纹带结构标注的石件数 */
  annotatedStones: number
}
/** done/total 为已读取的石件数；partial 为当前可显示的部分语料 */
type Progress = (done: number, total: number, partial: AnnotationCorpus) => void

const FRESH_MS = 5 * 60_000
const CONCURRENCY = 4 // 后端逐石序列化受限于单进程，并发再高反而更慢
const EMPTY: AnnotationCorpus = { stones: [], entries: [], failures: [], annotatedStones: 0 }
let cached: { corpus: AnnotationCorpus; at: number } | null = null
let pending: Promise<AnnotationCorpus> | null = null
let progress: { done: number; total: number; partial: AnnotationCorpus } = { done: 0, total: 0, partial: EMPTY }
const listeners = new Set<Progress>()

const structured = new WeakMap<StoneAnnotations, boolean>()
function hasStructure(entry: StoneAnnotations) {
  let value = structured.get(entry)
  if (value === undefined) {
    value = entry.annotations.some(a => ['whole', 'layer', 'scene', 'band'].includes(a.level) && a.atype !== 'none'
      && ['reviewed', 'candidate', 'approved'].includes(a.review_status))
    structured.set(entry, value)
  }
  return value
}

function report(done: number, total: number, partial: AnnotationCorpus) {
  progress = { done, total, partial }
  listeners.forEach(listener => listener(done, total, partial))
}

async function read(): Promise<AnnotationCorpus> {
  report(0, 0, EMPTY)
  const stones = await listStones()
  const entries: (StoneAnnotations | null)[] = new Array(stones.length).fill(null)
  const settled: boolean[] = new Array(stones.length).fill(false)
  const failures: string[] = []
  let index = 0, done = 0, prefix = 0
  const snapshot = (): AnnotationCorpus => {
    const ready = entries.slice(0, prefix).filter((entry): entry is StoneAnnotations => entry !== null)
    return { stones, entries: ready, failures: [...failures], annotatedStones: ready.filter(hasStructure).length }
  }
  report(0, stones.length, snapshot())
  async function work() {
    while (index < stones.length) {
      const at = index++, stone = stones[at]
      try { entries[at] = { stone, annotations: await stoneAnnotations(stone.id) } }
      catch (reason) { failures.push(`${stone.id}：${(reason as Error).message}`) }
      settled[at] = true
      while (prefix < stones.length && settled[prefix]) prefix++
      report(++done, stones.length, snapshot())
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, work))
  return snapshot()
}

/** 缓存仍新鲜时直接返回；读取进行中时加入同一次读取。force 跳过缓存。 */
export function loadAnnotationCorpus(force = false): Promise<AnnotationCorpus> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.corpus)
  if (!pending) {
    pending = read().then(corpus => {
      // 部分石件失败时不缓存，下次进入会重新尝试
      cached = corpus.failures.length ? null : { corpus, at: Date.now() }
      return corpus
    }).finally(() => { pending = null })
  }
  return pending
}

/** 订阅读取进度与部分语料；订阅时若正在读取，会立即收到当前进度。返回取消订阅函数。 */
export function onCorpusProgress(listener: Progress): () => void {
  listeners.add(listener)
  if (pending) listener(progress.done, progress.total, progress.partial)
  return () => { listeners.delete(listener) }
}

/** 已缓存且新鲜的语料，用于首屏同步渲染，避免闪现“正在读取”。 */
export function freshAnnotationCorpus(): AnnotationCorpus | null {
  return cached && Date.now() - cached.at < FRESH_MS ? cached.corpus : null
}

/** 用户将要进入形象库或故事库（悬停、聚焦或按下导航）时提前开始读取；已缓存或读取中则不重复。 */
export function prefetchAnnotationCorpus() {
  if (freshAnnotationCorpus() || pending) return
  void loadAnnotationCorpus().catch(() => undefined)
}

/** 按语料条目缓存派生结果：条目对象不变时，部分刷新与再次进入都只计算新读到的石件。 */
export function deriveByEntry<T>(cache: WeakMap<StoneAnnotations, T>, entry: StoneAnnotations, compute: (entry: StoneAnnotations) => T): T {
  let value = cache.get(entry)
  if (value === undefined) { value = compute(entry); cache.set(entry, value) }
  return value
}
