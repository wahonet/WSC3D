# -*- coding: utf-8 -*-
"""启动播种：概念词表。只补库中不存在的名称，不覆盖人工修改。"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from ..knowledge import SEED_CONCEPTS
from ..models import Concept

log = logging.getLogger("stonelab.seeds")


def seed_concepts(db: Session) -> int:
    have = {c.name for c in db.query(Concept.name).all()}
    have_alias: set[str] = set()
    for (aliases,) in db.query(Concept.aliases).all():
        have_alias.update(aliases or [])
    added = 0
    for item in SEED_CONCEPTS:
        name = item["name"]
        if name in have or name in have_alias:
            continue
        db.add(Concept(name=name, category_id=item["category_id"],
                       aliases=list(item.get("aliases") or []), description=item.get("description", "")))
        have.add(name)
        added += 1
    if added:
        db.commit()
        log.info("seeded %d concepts", added)
    return added
