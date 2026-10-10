/** Simplified → Traditional with OpenCC's s2t dictionaries (longest phrase first, then characters). */
export type Convert = (text: string) => string

let loading: Promise<Convert> | null = null

export function loadHant(): Promise<Convert> {
  loading ??= fetch(import.meta.env.BASE_URL + 'i18n/s2t.json')
    .then(response => { if (!response.ok) throw new Error('繁体字典载入失败'); return response.json() })
    .then(build)
    .catch(error => { loading = null; throw error })
  return loading
}

export function build({ chars, phrases }: { chars: string; phrases: string }): Convert {
  const single = new Map<string, string>(), multi = new Map<string, string>(), longest = new Map<string, number>()
  for (const entry of chars.split('|')) {
    const [key, value] = entry.split(' ')
    if (key && value) single.set(key, value)
  }
  for (const entry of phrases.split('|')) {
    const [key, value] = entry.split(' ')
    if (!key || !value) continue
    multi.set(key, value)
    const points = Array.from(key), head = points[0]
    longest.set(head, Math.max(longest.get(head) ?? 0, points.length))
  }
  const cache = new Map<string, string>()
  return text => {
    const hit = cache.get(text)
    if (hit !== undefined) return hit
    const points = Array.from(text)
    let out = ''
    next: for (let i = 0; i < points.length;) {
      const max = longest.get(points[i])
      if (max) for (let n = Math.min(max, points.length - i); n >= 2; n--) {
        const phrase = multi.get(points.slice(i, i + n).join(''))
        if (phrase) { out += phrase; i += n; continue next }
      }
      out += single.get(points[i]) ?? points[i]
      i++
    }
    if (cache.size > 20000) cache.clear()
    cache.set(text, out)
    return out
  }
}
