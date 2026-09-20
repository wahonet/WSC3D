from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from .workspace import require_workspace
from ..db import get_db
from ..services import video_jobs, video_sources

router = APIRouter(prefix='/videos', tags=['视频'], dependencies=[Depends(require_workspace)])


def existing(job_id):
    try:
        return video_jobs.get(job_id)
    except FileNotFoundError:
        raise HTTPException(404, '未找到生成任务') from None


@router.get('/settings')
def settings():
    return video_jobs.policy()


@router.get('/jobs')
def jobs():
    return [video_jobs.public(record) for record in video_jobs.records()[:100]]


@router.get('/sources')
def sources(db: Session = Depends(get_db)):
    return video_sources.catalogue(db)


@router.get('/source-groups')
def source_groups(response: Response, db: Session = Depends(get_db)):
    response.headers['Cache-Control'] = 'no-store'
    return video_sources.source_groups(db)


@router.get('/source-annotations')
def source_annotations(response: Response, q: str = Query('', max_length=120),
                       stone_id: str = Query('', max_length=64), asset_id: int | None = Query(None, gt=0),
                       offset: int = Query(0, ge=0), limit: int = Query(24, ge=1, le=60),
                       ids: list[int] | None = Query(None, max_length=20), db: Session = Depends(get_db)):
    response.headers['Cache-Control'] = 'no-store'
    return video_sources.browse(db, q, stone_id, asset_id, offset, limit, ids)


@router.post('/prepare')
def prepare(body: video_sources.PrepareRequest, db: Session = Depends(get_db)):
    try:
        return video_sources.public(video_sources.prepare(db, body))
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from None


@router.get('/sources/{source_id}/image')
def source_image(source_id: str):
    try:
        video_sources.load(source_id)
        path = video_sources.source_dir(source_id) / 'base.jpg'
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from None
    return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=3600'})


@router.post('/jobs', status_code=202)
def create(body: video_jobs.VideoRequest):
    try:
        return video_jobs.public(video_jobs.create(body))
    except video_jobs.Conflict as exc:
        raise HTTPException(409, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get('/jobs/{job_id}')
def detail(job_id: UUID):
    return video_jobs.public(existing(job_id))


@router.post('/jobs/{job_id}/refresh')
def refresh(job_id: UUID):
    existing(job_id)
    return video_jobs.public(video_jobs.refresh(job_id))


@router.get('/jobs/{job_id}/file')
def video_file(job_id: UUID):
    record = existing(job_id)
    path = video_jobs.output_root(job_id) / 'video.mp4'
    if record['status'] != 'succeeded' or not path.is_file():
        raise HTTPException(404, '视频尚未保存')
    return FileResponse(path, media_type='video/mp4', headers={'Cache-Control': 'private, max-age=3600'})


@router.get('/jobs/{job_id}/cover')
def cover(job_id: UUID):
    existing(job_id)
    path = video_jobs.output_root(job_id) / 'cover.jpg'
    if not path.is_file():
        raise HTTPException(404, '封面尚未生成')
    return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=3600'})
