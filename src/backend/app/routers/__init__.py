# -*- coding: utf-8 -*-
from fastapi import APIRouter

from . import alignment, annotations, assets, concepts, creative, knowledge_graph, library, segment, stones, system, videos, workspace

api = APIRouter(prefix="/api")
api.include_router(system.router)
api.include_router(stones.router)
api.include_router(assets.router)
api.include_router(annotations.router)
api.include_router(concepts.router)
api.include_router(library.router)
api.include_router(segment.router)
api.include_router(alignment.router)
api.include_router(knowledge_graph.router)
api.include_router(workspace.router)
api.include_router(videos.router)
api.include_router(creative.router)
