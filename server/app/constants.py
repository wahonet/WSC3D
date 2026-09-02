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
