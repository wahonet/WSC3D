import { useEffect, useRef, useState } from 'react'
import type { StoneNode } from '../types'
import { freshAnnotationCorpus, loadAnnotationCorpus, onCorpusProgress, type AnnotationCorpus } from './publicCorpus'

export interface CorpusView<T> {
  /** 由语料派生的页面数据；首次读取时随石件陆续到达而增长 */
  value: T | null
  stones: StoneNode[]
  errors: string[]
  annotatedStones: number
  loading: boolean
  /** 已读取 / 全部石件数 */
  done: number
  total: number
}

const PARTIAL_INTERVAL_MS = 300

/**
 * 形象库与故事库的共同读取流程。第一次读取时先显示已读到的石件，之后约每 300 毫秒更新一次；
 * reload 增加时强制重新读取，期间保留当前结果，读完再整体替换，避免网格清空重排。
 */
export function useAnnotationCorpus<T>(reload: number, derive: (corpus: AnnotationCorpus) => T): CorpusView<T> {
  const deriveRef = useRef(derive)
  deriveRef.current = derive
  const [view, setView] = useState<CorpusView<T>>(() => {
    const corpus = freshAnnotationCorpus()
    return corpus
      ? { value: derive(corpus), stones: corpus.stones, errors: [], annotatedStones: corpus.annotatedStones, loading: false, done: corpus.stones.length, total: corpus.stones.length }
      : { value: null, stones: [], errors: [], annotatedStones: 0, loading: true, done: 0, total: 0 }
  })
  const hasValue = useRef(view.value !== null)
  hasValue.current = view.value !== null
  const skipInitial = useRef(!view.loading)
  useEffect(() => {
    if (reload === 0 && skipInitial.current) return
    let active = true, timer = 0, latest: AnnotationCorpus | null = null
    const progressive = !hasValue.current
    const apply = (corpus: AnnotationCorpus, extra: Partial<CorpusView<T>> = {}) => setView(current => ({
      ...current, value: deriveRef.current(corpus), stones: corpus.stones, annotatedStones: corpus.annotatedStones, ...extra,
    }))
    const flush = () => {
      timer = 0
      if (!active || !latest) return
      const corpus = latest
      latest = null
      apply(corpus)
    }
    setView(current => ({ ...current, loading: true, errors: [], done: 0 }))
    const unsubscribe = onCorpusProgress((done, total, partial) => {
      if (!active) return
      setView(current => current.done === done && current.total === total ? current : { ...current, done, total,
        stones: current.stones.length ? current.stones : partial.stones })
      if (!progressive || !partial.entries.length) return
      latest = partial
      // 第一批立即显示，之后合并为定时刷新，避免每读到一件石头就重算整个网格
      if (!hasValue.current) { hasValue.current = true; flush() }
      else if (!timer) timer = window.setTimeout(flush, PARTIAL_INTERVAL_MS)
    })
    void loadAnnotationCorpus(reload > 0).then(corpus => {
      if (!active) return
      window.clearTimeout(timer); timer = 0; latest = null
      apply(corpus, { errors: corpus.failures, loading: false, done: corpus.stones.length, total: corpus.stones.length })
    }).catch(reason => {
      if (active) setView(current => ({ ...current, errors: [(reason as Error).message], loading: false }))
    })
    return () => { active = false; window.clearTimeout(timer); unsubscribe() }
  }, [reload])
  return view
}
