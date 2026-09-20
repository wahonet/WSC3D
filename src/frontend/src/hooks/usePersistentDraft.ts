import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/** Keep an unsaved form per stable record, including failed saves and reloads. */
export function usePersistentDraft<T>(record: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const key = 'wsc-unified.draft.' + record
  const [value, setValue] = useState<T>(() => {
    try { const saved = localStorage.getItem(key); return saved == null ? initial : JSON.parse(saved) as T }
    catch { return initial }
  })
  useEffect(() => {
    try {
      if (JSON.stringify(value) === JSON.stringify(initial)) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(value))
    } catch { /* The in-memory draft still survives a failed request. */ }
  }, [key, value, initial])
  return [value, setValue]
}
