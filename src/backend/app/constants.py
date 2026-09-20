# -*- coding: utf-8 -*-
"""跨模块共享的常量。"""
from __future__ import annotations

KIND_LABEL: dict[str, str] = {
    "photo": "高清照片", "photo_part": "局部", "rubbing": "拓片",
    "model_high": "三维·高模", "model_mid": "三维·中模", "model_low": "三维·低模",
}

TWO_D_KINDS = ("photo", "photo_part", "rubbing")

# 列表中展示的三维档位：只有低模。高模/中模仍在库中登记，但绝不进列表，
# 防止 700+MB OBJ 被点开导致浏览器卡死。
TREE_MODEL_KINDS = {"model_low"}

GROUPS: list[tuple[str, str]] = [
    ("model", "三维模型"),
    ("photo", "高清照片"),
    ("photo_part", "局部"),
    ("rubbing", "拓片"),
]

IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}

# ---------------------------------------------------------------- 结构化标注（沿用 WSC3D 标注 SOP v0.3）
# 结构层级：整石 -> 花纹带 / 层 -> 场景（一则故事） -> 人物·物象 -> 部件；榜题、刻线、残损为旁支
LEVELS: dict[str, str] = {
    "whole": "整石", "band": "花纹带", "layer": "层", "scene": "场景",
    "figure": "人物·物象", "component": "部件", "inscription": "榜题",
    "trace": "刻线", "damage": "残损",
}
# 层级的自然嵌套顺序：新建子节点、按几何包含推断层级时使用
LEVEL_RANK: dict[str, int] = {
    "whole": 0, "band": 1, "layer": 1, "scene": 2, "figure": 3, "component": 4,
    "inscription": 3, "trace": 4, "damage": 3,
}
# 某层级节点的子节点默认层级
CHILD_LEVEL: dict[str, str] = {
    "whole": "layer", "band": "component", "layer": "scene", "scene": "figure",
    "figure": "component", "component": "component", "inscription": "component",
    "trace": "trace", "damage": "damage", "": "figure",
}
# 各层级允许的父级层级（空字符串 = 尚未定层级）
PARENT_LEVELS: dict[str, tuple[str, ...]] = {
    "whole": (),
    "band": ("whole",),
    "layer": ("whole",),
    "scene": ("layer", "whole"),
    "figure": ("scene", "layer", "whole"),
    "component": ("figure", "scene", "band", "layer"),
    "inscription": ("scene", "figure", "layer", "whole"),
    "trace": ("figure", "component", "scene", "band", "layer"),
    "damage": ("figure", "scene", "layer", "band", "whole"),
    "": ("figure", "scene", "layer", "whole"),
}

# SOP 一层类别（13 类 + 题刻/纹饰 + unknown）：跨石头互斥大类，未来给检测模型做训练池
CATEGORIES: dict[str, str] = {
    "figure-deity": "创世主神", "figure-immortal": "仙人异士",
    "figure-mythic-ruler": "神话帝王 / 圣贤", "figure-loyal-assassin": "忠臣义士 / 刺客",
    "figure-filial-son": "孝子", "figure-virtuous-woman": "烈女",
    "figure-music-dance": "乐舞百戏", "chariot-procession": "车马出行",
    "mythic-creature": "神兽祥瑞", "celestial": "天象日月",
    "daily-life-scene": "现实生活场景", "architecture": "建筑",
    "inscription": "题刻榜题", "pattern-border": "纹饰边框", "unknown": "未识别",
}

REVIEW_STATUSES: dict[str, str] = {
    "candidate": "候选", "reviewed": "已审", "approved": "已核定", "rejected": "已否决",
}
QUALITIES: dict[str, str] = {"weak": "弱标注", "silver": "银", "gold": "金"}
GEOMETRY_INTENTS: dict[str, str] = {
    "visible_trace": "可见刻痕", "semantic_extent": "语义范围", "reconstructed_extent": "复原范围",
}

# 服务端批量建节点（骨架）时循环使用的调色板，与前端 PALETTE 一致
PALETTE: list[str] = [
    "#e8a33d", "#4a90e2", "#4caf7a", "#f06292", "#a06be0", "#39c2d7",
    "#ff8a65", "#9ccc65", "#ba68c8", "#ffd54f", "#26a69a", "#7986cb",
    "#d4a373", "#64b5f6", "#c0ca33", "#ec407a", "#00acc1", "#ab47bc",
]
