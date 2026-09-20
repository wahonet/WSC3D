/** 空白分词（与后端 _search_words 一致），去重保序 */
export function splitWords(q: string): string[] {
  const out: string[] = []
  for (const w of q.trim().split(/\s+/)) if (w && !out.includes(w)) out.push(w)
  return out
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 在纯文本里高亮若干关键词（大小写不敏感，长词优先） */
export function Mark({ text, words }: { text: string; words: string[] }) {
  if (!words.length || !text) return <>{text}</>
  const re = new RegExp(`(${[...words].sort((a, b) => b.length - a.length).map(esc).join('|')})`, 'gi')
  const parts = text.split(re)
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>
}

/** 后端 snippet：命中词用 [[ ]] 包住 */
export function Snippet({ s }: { s: string }) {
  const parts = s.split(/\[\[(.*?)\]\]/g)
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>
}
