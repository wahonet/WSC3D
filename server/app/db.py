# -*- coding: utf-8 -*-
"""数据库引擎与会话。

选型：SQLite + SQLAlchemy ORM。
- 40+ 块石头属于极小数据规模，单文件库零运维，随文件夹拷贝即完成整体备份；
- 大文件（照片/三维/拓片）留在文件系统，库中只存元数据与标注；
- 若未来需要多人协作的服务器部署，把 database_url 换成 PostgreSQL 即可，业务代码不变。
"""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # FastAPI 线程池访问
    echo=False,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
