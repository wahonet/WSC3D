import { useCallback, useLayoutEffect } from 'react'
import { create } from 'zustand'
import { createDomTranslator } from './dom'
import { translateEn } from './en'
import { loadHant, type Convert } from './hant'

export type Lang = 'zh-Hans' | 'zh-Hant' | 'en'
export const LANGS: readonly { id: Lang; label: string; html: string }[] = [
  { id: 'zh-Hans', label: '简体中文', html: 'zh-CN' },
  { id: 'zh-Hant', label: '繁體中文', html: 'zh-Hant' },
  { id: 'en', label: 'English', html: 'en' },
]
const KEY = 'stonelab.lang'
const stored = (): Lang => { const value = localStorage.getItem(KEY); return value === 'zh-Hant' || value === 'en' ? value : 'zh-Hans' }

interface LangState {
  lang: Lang
  /** Only the public exhibition is translated; the research workspace keeps the source text. */
  active: boolean
  hant: Convert | null
  setLang: (lang: Lang) => void
}
export const useLang = create<LangState>(set => ({
  lang: stored(), active: true, hant: null,
  setLang: lang => { localStorage.setItem(KEY, lang); set({ lang }) },
}))
const effective = (state: LangState): Lang => state.active ? state.lang : 'zh-Hans'
export const useEffectiveLang = () => useLang(effective)

/** For text drawn outside the DOM (canvas charts). */
export function useText() {
  const lang = useEffectiveLang(), hant = useLang(state => state.hant)
  return useCallback((text: string) => lang === 'en' ? translateEn(text) : lang === 'zh-Hant' && hant ? hant(text) : text, [lang, hant])
}

let translator: ReturnType<typeof createDomTranslator> | null = null

export function useDomTranslation(active: boolean) {
  useLayoutEffect(() => { useLang.setState({ active }) }, [active])
  const lang = useEffectiveLang(), hant = useLang(state => state.hant)
  // Before paint, so the first frame is already in the chosen language.
  useLayoutEffect(() => {
    document.documentElement.lang = LANGS.find(item => item.id === lang)!.html
    document.documentElement.dataset.lang = lang
    translator ??= createDomTranslator(document.documentElement)
    if (lang === 'zh-Hant' && !hant) {
      let cancelled = false
      loadHant().then(convert => { if (!cancelled) useLang.setState({ hant: convert }) })
        .catch(() => { if (!cancelled) useLang.getState().setLang('zh-Hans') })
      return () => { cancelled = true }
    }
    translator.set(lang === 'en' ? translateEn : lang === 'zh-Hant' ? hant : null)
  }, [lang, hant])
}
