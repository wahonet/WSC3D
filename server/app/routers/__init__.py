# -*- coding: utf-8 -*-
from fastapi import APIRouter

from . import alignment, annotations, assets, concepts, library, segment, stones, system

api = APIRouter(prefix="/api")
api.include_router(system.router)
api.include_router(stones.router)
api.include_router(assets.router)
api.include_router(annotations.router)
api.include_router(concepts.router)
api.include_router(library.router)
api.include_router(segment.router)
api.include_router(alignment.router)
