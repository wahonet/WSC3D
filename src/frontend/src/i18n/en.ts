/**
 * English for the public exhibition interface. Lookups use the trimmed rendered text;
 * digits are matched through `#`. Research content (inscriptions, documents, annotation
 * text) is not translated and stays in its source language.
 */
import { EN_TEXT } from './enText'

const CJK = /[\u3400-\u9fff]/
const NUMBER = /\d+(?:[.,:]\d+)*/g
const CN_DIGITS = '〇一二三四五六七八九'
/** Stone catalogue codes such as 武037, 武037-2 or the poster form 武〇一一. */
const STONE = /^武([\d〇一二三四五六七八九]+)([-A-Za-z\d]*)$/

/** Building parts that make up stone locations, e.g. 左石室后壁小龛西侧. */
const PLACE: [string, string][] = [
  ['武梁祠', 'Wu Liang Shrine'], ['前石室', 'Front Chamber'], ['左石室', 'Left Chamber'], ['后石室', 'Rear Chamber'],
  ['武氏祠', 'Wu Family Shrines'], ['西阙', 'West Pillar-gate'], ['东阙', 'East Pillar-gate'], ['阙身', 'pillar body'],
  ['后壁', 'back wall'], ['东壁', 'east wall'], ['西壁', 'west wall'], ['前壁', 'front wall'], ['隔梁', 'partition beam'],
  ['小龛', 'niche'], ['龛', 'niche'], ['西侧', 'west side'], ['东侧', 'east side'], ['横额', 'lintel'],
  ['屋顶', 'roof'], ['前坡', 'front slope'], ['后坡', 'back slope'], ['东段', 'east section'], ['西段', 'west section'],
  ['中段', 'middle section'], ['下石', 'lower stone'], ['上石', 'upper stone'], ['承檐枋', 'eave beam'], ['画像', 'carving'],
  ['东面', 'east face'], ['西面', 'west face'], ['南面', 'south face'], ['北面', 'north face'], ['顶部', 'top'],
  ['第一石', 'stone 1'], ['第二石', 'stone 2'], ['第三石', 'stone 3'], ['第四石', 'stone 4'], ['第五石', 'stone 5'],
].sort((a, b) => b[0].length - a[0].length) as [string, string][]

function place(text: string): string | undefined {
  const parts: string[] = []
  for (let i = 0; i < text.length;) {
    const hit = PLACE.find(([zh]) => text.startsWith(zh, i))
    if (!hit) return undefined
    parts.push(hit[1]); i += hit[0].length
  }
  if (parts.length < 2) return undefined
  const [first, ...rest] = parts
  return first.charAt(0).toUpperCase() + first.slice(1) + ', ' + rest.join(' ')
}

const PUNCT: [RegExp, string][] = [[/：$/, ': '], [/…$/, '…'], [/？$/, '?'], [/！$/, '!'], [/。$/, '.']]

const missing = new Set<string>()
;(globalThis as { __wscI18nMissing?: Set<string> }).__wscI18nMissing = missing

function lookup(core: string): string | undefined {
  const direct = EN_TEXT[core]
  if (direct !== undefined) return direct
  const numbers: string[] = []
  const key = core.replace(NUMBER, value => { numbers.push(value); return '#' })
  if (numbers.length) {
    const template = EN_TEXT[key]
    if (template !== undefined) { let i = 0; return template.replace(/#/g, () => numbers[i++] ?? '#') }
  }
  for (const [pattern, suffix] of PUNCT) {
    if (pattern.test(core)) { const inner = lookup(core.replace(pattern, '')); if (inner !== undefined) return inner + suffix.trimEnd() }
  }
  const stone = STONE.exec(core)
  if (stone) return 'Wu ' + stone[1].replace(/[〇一二三四五六七八九]/g, digit => String(CN_DIGITS.indexOf(digit))) + stone[2]
  const located = place(core)
  if (located) return located
  for (const separator of [' · ', '·', '、', ' / ', '　']) {
    if (!core.includes(separator)) continue
    const parts = core.split(separator).map(part => part.trim())
    const translated = parts.map(part => !CJK.test(part) ? part : lookup(part))
    if (translated.some((part, i) => part !== undefined && CJK.test(parts[i]))) return translated.map((part, i) => part ?? parts[i]).join(separator === '、' ? ', ' : separator === '　' ? ' · ' : separator)
  }
  return undefined
}

export function translateEn(text: string): string {
  if (!CJK.test(text)) return text
  const core = text.trim()
  const hit = lookup(core)
  if (hit === undefined) {
    if (missing.size < 5000) missing.add(core)
    return text
  }
  const start = text.indexOf(core)
  return text.slice(0, start) + hit + text.slice(start + core.length)
}
