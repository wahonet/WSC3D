/**
 * 汉画像石标注 SOP v0.3 §1 类别体系 + §1.6 motif 受控词表的 TypeScript 实装
 *
 * 这一份是 SOP 与代码之间的"单一事实源"——SOP 升级一次，本文件同步一次。
 * UI 渲染（AnnotationPanel）/ 训练池准入（training.ts）/ 未来 A2 数据集导出
 * 都从这里读 category enum 与 motif 建议。
 *
 * 关联：
 * - docs/han-stone-annotation-SOP.md §1 类别体系（13 + unknown = 14 值）
 * - docs/han-stone-annotation-SOP.md 附录 A 母题速查表（130+ motif）
 * - docs/han-stone-annotation-SOP.md §1.7 决策树 / §1.8 边界判决
 */

import type { IimlHanStoneCategory } from "../../api/client";

export type HanStoneCategoryOption = {
  value: IimlHanStoneCategory;
  /** 中文短标签（dropdown 显示） */
  label: string;
  /** 学界三大类归属（神话祥瑞 / 历史故事 / 现实生活 / 元层），UI 可作分组使用 */
  supercategory: "mythic" | "historic" | "daily-life" | "meta" | "unknown";
  /** 简短解释（dropdown title 提示） */
  description: string;
};

// 顺序按 SOP §1.1 类别表，与 §14.1 COCO categories 映射 id 1..14 一致
export const hanStoneCategoryOptions: HanStoneCategoryOption[] = [
  {
    value: "figure-deity",
    label: "创世主神",
    supercategory: "mythic",
    description: "伏羲、女娲、西王母、东王公等四大主神"
  },
  {
    value: "figure-immortal",
    label: "仙人异士",
    supercategory: "mythic",
    description: "羽人、雷公、风伯、雨师、河伯、嫦娥、太一帝君等"
  },
  {
    value: "figure-mythic-ruler",
    label: "神话帝王 / 圣贤",
    supercategory: "historic",
    description: "三皇五帝、孔子见老子、周公辅成王、秦始皇捞鼎等"
  },
  {
    value: "figure-loyal-assassin",
    label: "忠臣 / 义士 / 刺客",
    supercategory: "historic",
    description: "荆轲、二桃杀三士、蔺相如、专诸、要离、聂政、苏武等"
  },
  {
    value: "figure-filial-son",
    label: "孝子",
    supercategory: "historic",
    description: "董永、老莱子、丁兰、邢渠、伯瑜、闵子骞等"
  },
  {
    value: "figure-virtuous-woman",
    label: "烈女",
    supercategory: "historic",
    description: "楚昭贞姜、鲁义姑姊、秋胡妻、梁高行、贞夫韩朋等"
  },
  {
    value: "figure-music-dance",
    label: "乐舞百戏",
    supercategory: "daily-life",
    description: "长袖舞、建鼓舞、七盘舞、寻橦、跳丸、倒立等"
  },
  {
    value: "chariot-procession",
    label: "车马出行",
    supercategory: "daily-life",
    description: "墓主出行、谒见车马、胡汉战争、献俘、导骑等"
  },
  {
    value: "mythic-creature",
    label: "神兽祥瑞",
    supercategory: "mythic",
    description: "四神（青龙白虎朱雀玄武）、麒麟、九尾狐、应龙、飞廉等"
  },
  {
    value: "celestial",
    label: "天象日月",
    supercategory: "mythic",
    description: "日轮、月轮、北斗、星宿、扶桑、桂树等"
  },
  {
    value: "daily-life-scene",
    label: "现实生活场景",
    supercategory: "daily-life",
    description: "庖厨、宴饮、牛耕、纺织、采桑、六博、献俘、讲经等"
  },
  {
    value: "architecture",
    label: "建筑",
    supercategory: "daily-life",
    description: "双阙、单阙、楼阁、屋宇、亭榭、桥梁、藻井、斗拱等"
  },
  {
    value: "inscription",
    label: "题刻榜题",
    supercategory: "meta",
    description: "人物榜题、故事榜题、纪年题记、造作题记、赞辞等"
  },
  {
    value: "pattern-border",
    label: "纹饰边框",
    supercategory: "meta",
    description: "云气纹、卷草纹、菱形纹、连弧纹、双菱纹、锯齿纹等"
  },
  {
    value: "unknown",
    label: "未识别",
    supercategory: "unknown",
    description: "残损 / 风化 / 主题待考无法判读时使用"
  }
];

export const hanStoneCategories: IimlHanStoneCategory[] = hanStoneCategoryOptions.map(
  (option) => option.value
);

export const hanStoneCategoryValueSet: Set<string> = new Set(hanStoneCategories);

/**
 * §11 一致性约束：故事类 category 缺 motif 时 A2 导出会 warning 但不阻塞
 */
export const narrativeCategoriesNeedMotif: ReadonlySet<IimlHanStoneCategory> = new Set([
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman"
] as const);

/**
 * Motif 建议词表：按 category 分组，对应 SOP 附录 A 速查表。
 * 这是"建议值"——`<datalist>` 提示用，但 `motif` 字段是自由字符串，不限于此。
 *
 * 维护原则：
 * - 增减 motif 必须同步改 SOP 附录 A
 * - 一条 motif 在多个 category 出现时（如"周公辅成王"）以 §1.8 判决归一
 * - motif 名采用 SOP 用的中文，与学界既有命名一致（"董永侍父"而非"董永卖身葬父"）
 */
export const motifSuggestionsByCategory: Record<IimlHanStoneCategory, string[]> = {
  "figure-deity": [
    "西王母",
    "东王公",
    "伏羲女娲交尾",
    "伏羲",
    "女娲"
  ],
  "figure-immortal": [
    "羽人",
    "嫦娥奔月",
    "雷公",
    "风伯",
    "雨师",
    "河伯",
    "太一帝君",
    "仙人"
  ],
  "figure-mythic-ruler": [
    "孔子见老子",
    "周公辅成王",
    "三皇五帝",
    "夏禹",
    "夏桀",
    "秦始皇泗水捞鼎",
    "蚩尤"
  ],
  "figure-loyal-assassin": [
    "荆轲刺秦王",
    "二桃杀三士",
    "蔺相如完璧归赵",
    "专诸刺吴王",
    "要离刺庆忌",
    "豫让刺赵襄子",
    "聂政刺韩王",
    "范雎受袍",
    "信陵君迎侯嬴",
    "管仲射小白",
    "苏武牧羊",
    "伯夷叔齐",
    "义人赵宣",
    "王陵母伏剑",
    "季札挂剑",
    "赵氏孤儿",
    "曹子劫桓",
    "鸿门宴",
    "申生愚孝"
  ],
  "figure-filial-son": [
    // §A.5.1 侍亲
    "董永侍父",
    "老莱子娱亲",
    "伯瑜悲亲",
    "邢渠哺父",
    "赵徇哺父",
    // §A.5.2 祭亲
    "丁兰刻木事亲",
    "金日磾拜母",
    // §A.5.3 谏亲
    "闵子骞御车失棰",
    "孝孙原毂",
    // §A.5.4 葬亲
    "孝乌",
    // §A.5.5 护亲
    "魏汤护亲",
    // §A.5.6 泛化
    "曾母投杼",
    "李善抚孤",
    "朱明孝行",
    "三州孝人",
    "羊公孝行",
    // §A.5.7 元代二十四孝里汉画偶见的
    "孝感动天",
    "啮指痛心",
    "百里负米",
    "怀橘遗亲",
    "埋儿奉母",
    "扇枕温衾"
  ],
  "figure-virtuous-woman": [
    "楚昭贞姜",
    "鲁义姑姊",
    "秋胡妻",
    "梁高行",
    "齐义继母",
    "京师节女",
    "梁节姑姊",
    "齐桓卫姬",
    "齐管妾婧",
    "钟离春自荐",
    "贞夫韩朋",
    "杞梁妻",
    "罗敷采桑",
    "曹娥投江",
    "七女为父报仇"
  ],
  "figure-music-dance": [
    "长袖舞",
    "巾舞",
    "建鼓舞",
    "七盘舞",
    "寻橦",
    "跳丸",
    "飞剑",
    "倒立",
    "鼓吹乐",
    "庖厨乐舞"
  ],
  "chariot-procession": [
    "墓主出行",
    "谒见车马",
    "胡汉战争",
    "献俘车马",
    "导骑"
  ],
  "mythic-creature": [
    "四神",
    "青龙",
    "白虎",
    "朱雀",
    "玄武",
    "麒麟",
    "应龙",
    "九尾狐",
    "三足乌",
    "捣药玉兔",
    "蟾蜍",
    "飞廉",
    "辟邪",
    "天禄",
    "独角兽",
    "舍利",
    "阳遂鸟"
  ],
  celestial: [
    "日轮",
    "月轮",
    "北斗",
    "星宿",
    "日月并明",
    "扶桑树",
    "桂树",
    "彗星",
    "流星"
  ],
  "daily-life-scene": [
    // §A.11.1 生产劳动
    "牛耕",
    "纺织",
    "采桑",
    "舂米",
    "冶铁",
    "盐井",
    "捕鱼",
    "狩猎",
    "田猎",
    // §A.11.2 日常生活
    "庖厨",
    "宴饮",
    "六博",
    "斗鸡",
    "射雀",
    // §A.11.3 社交礼仪
    "谒见",
    "讲经",
    "献俘",
    // §A.11.4 战争
    "水陆攻战"
  ],
  architecture: [
    "双阙",
    "单阙",
    "楼阁",
    "屋宇",
    "亭榭",
    "桥梁",
    "藻井",
    "斗拱"
  ],
  inscription: [
    "人物榜题",
    "故事榜题",
    "纪年题记",
    "造作题记",
    "赞辞"
  ],
  "pattern-border": [
    "云气纹",
    "卷草纹",
    "菱形纹",
    "连弧纹",
    "双菱纹",
    "锯齿纹",
    "绞索纹",
    "垂幔纹",
    "兽面纹"
  ],
  unknown: []
};

/**
 * 全部 motif 平铺集合（去重），用于不限定 category 的 datalist 后备。
 */
export const allMotifSuggestions: string[] = Array.from(
  new Set(
    hanStoneCategories.flatMap((cat) => motifSuggestionsByCategory[cat] ?? [])
  )
).sort((a, b) => a.localeCompare(b, "zh-Hans"));

export function getCategoryOption(value?: string): HanStoneCategoryOption | undefined {
  if (!value) return undefined;
  return hanStoneCategoryOptions.find((option) => option.value === value);
}

export function getCategoryLabel(value?: string): string {
  return getCategoryOption(value)?.label ?? "";
}

export function isHanStoneCategory(value: unknown): value is IimlHanStoneCategory {
  return typeof value === "string" && hanStoneCategoryValueSet.has(value);
}
