"""Shared task paths for formal research tools, with historical defaults.

Set WSC_RESEARCH_OUT and WSC_RESEARCH_WORK before starting a Python process.
WSC_RESEARCH_BASELINE names the immutable original-row snapshot independently of
the task's live starting snapshot. No directories or files are created on import.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEGACY_RUN = 'multiversion-20261002'
DEFAULT_OUT = ROOT / 'resources/authoring/research' / LEGACY_RUN
DEFAULT_WORK = ROOT / 'tmp/wsc-multiversion'


def configured_path(name, default):
    value = os.environ.get(name)
    path = Path(value).expanduser() if value else default
    return path.resolve() if path.is_absolute() else (ROOT / path).resolve()


OUT = configured_path('WSC_RESEARCH_OUT', DEFAULT_OUT)
WORK = configured_path('WSC_RESEARCH_WORK', DEFAULT_WORK)
RUN = os.environ.get('WSC_RESEARCH_RUN') or OUT.name
BASELINE = configured_path('WSC_RESEARCH_BASELINE', DEFAULT_OUT / 'baseline.json')
# Accepted old registrations remain available for localization in later tasks.
REVIEWED_RUNS = frozenset((LEGACY_RUN, RUN))
