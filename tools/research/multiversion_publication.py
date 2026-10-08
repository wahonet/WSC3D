"""Separate segmentation boundary acceptance from inherited research metadata."""
from __future__ import annotations


def publication_fields(source, decision=None):
    """Keep canonical quality and semantic scope without granting expert approval.

    Explicit fields are consistency assertions, not permission to promote a weak
    reading or change its semantic extent because a new boundary was inspected.
    """
    decision = decision or {}
    quality = source['quality']
    intent = source['geometry_intent']
    if quality not in ('', 'weak', 'silver', 'gold'):
        raise ValueError('Unexpected canonical quality')
    if intent not in ('', 'visible_trace', 'semantic_extent', 'reconstructed_extent'):
        raise ValueError('Unexpected canonical geometry intent')
    if decision.get('publication_quality', quality) != quality:
        raise ValueError('Explicit publication quality must preserve its canonical record')
    if decision.get('publication_geometry_intent', intent) != intent:
        raise ValueError('Explicit publication intent must preserve its canonical record')
    status = 'reviewed' if source['review_status'] in ('reviewed', 'approved') else 'candidate'
    return {'quality': quality, 'geometry_intent': intent, 'review_status': status}
