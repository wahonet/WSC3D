/**
 * Translates rendered text in place and remembers each original, so React updates and
 * switching back to Simplified Chinese always start from the source text.
 */
export type Translate = (text: string) => string

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip', 'aria-roledescription']
const ATTR_SELECTOR = ATTRS.map(name => `[${name}]`).join(',')
const SKIP = 'script,style,textarea,noscript,[contenteditable="true"],[contenteditable=""],[data-i18n-skip],[translate="no"]'
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

interface Record { src: string; out: string }

export function createDomTranslator(root: Element) {
  let translate: Translate | null = null
  let texts = new WeakMap<Text, Record>()
  let attrs = new WeakMap<Element, Map<string, Record>>()

  function text(node: Text, checked = false) {
    const value = node.nodeValue ?? '', record = texts.get(node)
    if (!translate && !record) return
    const src = record && value === record.out ? record.src : value
    if (!CJK.test(src) || (!checked && node.parentElement?.closest(SKIP))) { texts.delete(node); return }
    const out = translate ? translate(src) : src
    texts.set(node, { src, out })
    if (out !== value) node.nodeValue = out
  }

  function attribute(element: Element, name: string) {
    const value = element.getAttribute(name)
    let records = attrs.get(element)
    const record = records?.get(name)
    if (value == null || (!translate && !record)) return
    const src = record && value === record.out ? record.src : value
    if (!CJK.test(src)) { records?.delete(name); return }
    const out = translate ? translate(src) : src
    if (!records) attrs.set(element, records = new Map())
    records.set(name, { src, out })
    if (out !== value) element.setAttribute(name, out)
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) return text(node as Text)
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (element.closest(SKIP)) return
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: item => item.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT
        : (item as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
    })
    for (let item = walker.nextNode(); item; item = walker.nextNode()) text(item as Text, true)
    const elements = element.matches(ATTR_SELECTOR) ? [element] : []
    element.querySelectorAll(ATTR_SELECTOR).forEach(item => elements.push(item))
    for (const item of elements) if (!item.closest(SKIP)) for (const name of ATTRS) if (item.hasAttribute(name)) attribute(item, name)
  }

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') mutation.addedNodes.forEach(walk)
      else if (mutation.type === 'characterData') text(mutation.target as Text)
      else if (mutation.attributeName) {
        const element = mutation.target as Element
        if (!element.closest(SKIP)) attribute(element, mutation.attributeName)
      }
    }
  })

  return {
    set(next: Translate | null) {
      if (next === translate) return
      translate = next
      observer.disconnect()
      walk(root)
      if (next) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
      else { texts = new WeakMap(); attrs = new WeakMap() }
    },
  }
}
