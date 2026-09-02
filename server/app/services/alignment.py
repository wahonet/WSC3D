# -*- coding: utf-8 -*-
"""对齐提交、主图管理与跨图标注投影。

- commit_alignment：保存对齐记录，并把配对双方接入"主图坐标链"。
  对齐求解给出 T: 右图像素 -> 左图像素。
  若左图已连主图（M_L 已知）：M_R = M_L * T
  若右图已连主图（M_R 已知）：M_L = M_R * T^{-1}
  两边都没连：仅保存记录，提示先与主图对齐。

- set_master：手动指定主图。若新主图已连旧主图，则把全部既有坐标链
  重定基到新主图（X->旧主 变换左乘 新主->旧主 的逆）；若尚无任何坐标链，
  直接切换；否则拒绝并提示先对齐。

- project_annotations：把同一块石头上其他 2D 资产的标注，
  经 源图 -> 主图 -> 目标图 投影到目标资产的归一化坐标。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Annotation, Asset
from ..schemas import AlignCommitOut, ProjectedItem, ProjectedOut, SetMasterOut
from . import transforms as tf
from .serialize import annotation_out

ALIGN_COLOR = "#3d8ae0"


def _set_chain(asset: Asset, sim: dict, master_id: int, via: str, rmse: float | None) -> None:
    asset.extra = {**(asset.extra or {}),
                   "align_to_master": {**sim, "master_asset_id": master_id,
                                       "via": via, "rmse_px": rmse}}


def _clear_chain(asset: Asset) -> None:
    extra = dict(asset.extra or {})
    extra.pop("align_to_master", None)
    extra.pop("is_master", None)
    asset.extra = extra


def commit_alignment(db: Session, stone_id: int, left: Asset, right: Asset,
                     geom: dict) -> AlignCommitOut:
    """geom 为前端求解结果（AlignGeometry），T: 右图像素 -> 左图像素。"""
    t_r2l = {"s": float(geom["s"]), "theta_deg": float(geom["theta_deg"]),
             "tx": float(geom["tx"]), "ty": float(geom["ty"])}
    rmse = float(geom.get("rmse_px") or 0)

    anno = Annotation(
        stone_id=stone_id, asset_id=left.id, tool="align", atype="align",
        geometry=geom, label=f"对齐 -> {right.filename}", note="",
        color=ALIGN_COLOR, value=rmse, unit="px")
    db.add(anno)

    chain_l, chain_r = left.chain, right.chain
    updates: list[str] = []
    warning = ""

    if chain_l is not None:
        m_r = tf.compose(chain_l, t_r2l)
        _set_chain(right, m_r, chain_l["master_asset_id"], f"align#{left.id}", rmse)
        updates.append(f"{right.filename} 已接入主图坐标链")
    elif chain_r is not None:
        m_l = tf.compose(chain_r, tf.invert(t_r2l))
        _set_chain(left, m_l, chain_r["master_asset_id"], f"align#{right.id}", rmse)
        updates.append(f"{left.filename} 已接入主图坐标链")
    else:
        warning = "两张图都还没有连到主图；请先让其中一张与主图对齐，再做本次对齐即可自动入链"

    db.commit()
    return AlignCommitOut(annotation=annotation_out(anno), chain_updates=updates, warning=warning)


def set_master(db: Session, stone_id: int, new_master: Asset) -> SetMasterOut:
    """手动指定主图，必要时重定基全部坐标链。"""
    if new_master.is_model:
        return SetMasterOut(ok=False, message="三维资产不能作为主图")

    two_d = [a for a in db.query(Asset).filter(Asset.stone_id == stone_id).all() if not a.is_model]
    old_master = next((a for a in two_d if a.is_master), None)

    if old_master is not None and old_master.id == new_master.id:
        return SetMasterOut(ok=True, message="该图已是主图", rebased=0)

    chain_new = new_master.chain      # 新主图 -> 旧主图 的变换（若已对齐）
    others_chained = [a for a in two_d
                      if a.id not in (new_master.id, old_master.id if old_master else -1)
                      and a.chain is not None]

    rebased = 0
    if old_master is None:
        pass                                    # 尚无主图：直接指定
    elif chain_new is not None:
        # 新主图已连旧主图：全链重定基  M'_X = inv(M_N) * M_X
        inv_n = tf.invert(chain_new)
        for a in two_d:
            if a.id == new_master.id or a.chain is None:
                continue
            old = a.chain
            _set_chain(a, tf.compose(inv_n, old), new_master.id,
                       f"rebase({old.get('via', '')})", old.get("rmse_px"))
            extra = dict(a.extra or {})
            extra.pop("is_master", None)
            a.extra = extra
            rebased += 1
    elif not others_chained:
        _clear_chain(old_master)                # 没有其他资产在链上：自由切换
    else:
        return SetMasterOut(
            ok=False,
            message=f"已有 {len(others_chained)} 张图挂在当前主图坐标链上，"
                    f"而「{new_master.filename}」尚未与当前主图对齐，无法换算。"
                    f"请先用对齐工具把它与当前主图对齐，再切换主图。")

    _set_chain(new_master, tf.identity(), new_master.id, "self", None)
    new_master.extra = {**(new_master.extra or {}), "is_master": True}
    db.commit()
    return SetMasterOut(
        ok=True, rebased=rebased,
        message=f"主图已切换为 {new_master.filename}" + (f"，{rebased} 条坐标链已重定基" if rebased else ""))


def _project_geometry(atype: str, geom: dict, src: Asset, dst: Asset,
                      m_src: dict, m_dst_inv: dict) -> tuple[str, dict] | None:
    """把一条标注几何从 src 归一化坐标投影到 dst 归一化坐标。
    旋转下矩形不再与轴对齐，统一转成多边形输出。"""
    def to_dst(p):
        mx, my = tf.apply(m_src, p[0] * src.width, p[1] * src.height)
        qx, qy = tf.apply(m_dst_inv, mx, my)
        return [qx / dst.width, qy / dst.height]

    if atype == "rect":
        x, y, w, h = geom["x"], geom["y"], geom["w"], geom["h"]
        corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        return "polygon", {"points": [to_dst(p) for p in corners]}
    if atype == "polygon":
        return "polygon", {"points": [to_dst(p) for p in geom["points"]]}
    if atype == "point":
        return "point", {"p": to_dst(geom["p"])}
    if atype == "line":
        return "line", {"p1": to_dst(geom["p1"]), "p2": to_dst(geom["p2"])}
    return None


def project_annotations(db: Session, target: Asset) -> ProjectedOut:
    chain_t = target.chain
    if chain_t is None:
        return ProjectedOut(ok=False, reason="本图尚未接入主图坐标链（先用对齐工具与主图对齐）")
    m_dst_inv = tf.invert(chain_t)

    siblings = {a.id: a for a in db.query(Asset)
                .filter(Asset.stone_id == target.stone_id, Asset.id != target.id).all()}

    items: list[ProjectedItem] = []
    skipped = 0
    rows = (db.query(Annotation)
            .filter(Annotation.stone_id == target.stone_id, Annotation.asset_id != target.id)
            .order_by(Annotation.id).all())
    for x in rows:
        if x.atype in ("align", "point3d", "line3d"):
            continue
        src = siblings.get(x.asset_id)
        if src is None or src.is_model:
            continue
        m_src = src.chain
        if m_src is None:
            skipped += 1
            continue
        out = _project_geometry(x.atype, x.geometry, src, target, m_src, m_dst_inv)
        if out is None:
            continue
        ptype, pgeom = out
        items.append(ProjectedItem(
            id=x.id, label=x.label, color=x.color, tool=x.tool,
            atype=ptype, geometry=pgeom,
            source_asset_id=src.id, source_filename=src.filename,
            value=x.value, unit=x.unit or ""))
    return ProjectedOut(ok=True, items=items, skipped_unaligned=skipped)
