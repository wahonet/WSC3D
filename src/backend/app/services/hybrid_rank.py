"""Chinese BM25 tokenization and local BGE cross-encoder reranking."""
from __future__ import annotations

from functools import lru_cache
import re
import threading

from ..config import model_path

_lock = threading.RLock()
_reranker = None


def tokens(value: str) -> list[str]:
    # CJK bigrams retain names without requiring a mutable segmentation dictionary.
    # Latin words and catalogue numbers stay whole. One-character terms also work.
    result = []
    for piece in re.findall(r'[\u3400-\u9fff]+|[a-z0-9]+', value.casefold()):
        if re.fullmatch(r'[\u3400-\u9fff]+', piece):
            result.extend(piece[i:i + 2] for i in range(max(1, len(piece) - 1)))
        else:
            result.append(piece)
    return result


def query_expression(terms: list[str]) -> str:
    phrases = ['"' + ' '.join(tokens(term)) + '"' for term in terms if tokens(term)]
    return ' OR '.join(dict.fromkeys(phrases))


def index_text(value: str) -> str:
    # Keep the bigram stream contiguous for phrase queries. A second character
    # stream also allows standalone object names such as 弓、剑、规 and 矩.
    return ' '.join([*tokens(value), *re.findall(r'[\u3400-\u9fff]', value)])


def reranker():
    global _reranker
    with _lock:
        if _reranker is None:
            import torch
            from sentence_transformers import CrossEncoder
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
            _reranker = CrossEncoder(str(model_path('reranker')), device=device, local_files_only=True,
                                     max_length=1024, model_kwargs={'torch_dtype': torch.float16 if device == 'cuda' else torch.float32})
        return _reranker


@lru_cache(maxsize=24)
def _scores(query: str, passages: tuple[str, ...]) -> tuple[float, ...]:
    with _lock:
        import torch
        model = reranker()
        values = model.predict([(query, passage) for passage in passages], batch_size=4, show_progress_bar=False,
                               activation_fn=torch.nn.Identity())
        return tuple(float(value) for value in values)


def rerank(query: str, rows: list[dict], limit: int = 32) -> list[dict]:
    if not rows:
        return rows
    shortlist = rows[:limit]
    # An OCR segment may exceed the model budget; use the best source window,
    # without truncating the original excerpt returned for citation.
    pairs, owners = [], []
    from .embedding_passages import split_document
    model = reranker()
    for index, row in enumerate(shortlist):
        windows = split_document(row['title'], row['text'], model.tokenizer, 900)
        query_terms = tokens(query)
        windows.sort(key=lambda value: -sum(term in value for term in query_terms))
        for window in windows[:3]:
            pairs.append(window); owners.append(index)
    scores = _scores(query, tuple(pairs))
    best = {}
    for owner, score in zip(owners, scores):
        best[owner] = max(score, best.get(owner, float('-inf')))
    selected = [{**row, 'rerank_score': best[index], 'retrieval_methods': [*row.get('retrieval_methods', []), 'rerank']}
                for index, row in enumerate(shortlist) if best[index] >= 0.0]
    selected.sort(key=lambda row: (-row['rerank_score'], -row['score'], row['id']))
    # Do not refill rejected evidence with unranked dense neighbors. Raw logits
    # below zero correspond to relevance probabilities below 0.5 for this model.
    return selected
