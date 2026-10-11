import { collectStories, type StoryCutout } from './storyCutouts'
import { deriveByEntry, type StoneAnnotations } from './publicCorpus'

/** 形象库（判断形象是否属于故事）与故事库共用同一份故事派生结果，切换页面时不必重算。 */
const stories = new WeakMap<StoneAnnotations, StoryCutout[]>()
export function storiesOf(entry: StoneAnnotations): StoryCutout[] {
  return deriveByEntry(stories, entry, ({ stone, annotations }) => collectStories(stone, annotations))
}
