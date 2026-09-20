import type { AskResult, Book, LlmSettings, RagStatus, SearchResult, StoneBrief, StoneDetail, Stats } from './types';

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const error = await r.json().catch(() => null);
    throw new Error(typeof error?.detail === 'string' ? error.detail : `${r.status} ${r.statusText}`);
  }
  return r.json();
}

export const api = {
  listStones: () => fetch('/api/archive/stones').then(r => j<StoneBrief[]>(r)),
  getStone: (id: string) => fetch(`/api/archive/stones/${encodeURIComponent(id)}`).then(r => j<StoneDetail>(r)),
  getStats: () => fetch('/api/archive/stats').then(r => j<Stats>(r)),
  patchStone: (id: string, patch: Partial<Pick<StoneDetail, 'name' | 'condition' | 'note' | 'intro'>>) =>
    fetch(`/api/archive/stones/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(r => j<{ ok: boolean; stone: StoneDetail }>(r)),
  rescan: (id?: string) => fetch(id ? `/api/archive/stones/${encodeURIComponent(id)}/rescan` : '/api/archive/rescan', { method: 'POST' })
    .then(r => j<{ ok: boolean; report: { stones: number; assets_added: number; archive_added: number; skipped: { file: string; reason: string }[] } }>(r)),
  listBooks: () => fetch('/api/archive/books').then(r => j<Book[]>(r)),
  search: (q: string) => fetch(`/api/archive/search?q=${encodeURIComponent(q)}`).then(r => j<SearchResult>(r)),
  ask: (question: string) =>
    fetch('/api/archive/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }).then(r => j<AskResult>(r)),
  ragStatus: () => fetch('/api/archive/rag/status').then(r => j<RagStatus>(r)),
  llmSettings: () => fetch('/api/archive/llm/settings', { cache: 'no-store' }).then(r => j<LlmSettings>(r)),
  saveLlm: (body: unknown) => fetch('/api/archive/llm/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => j<LlmSettings>(r)),
  testLlm: (body: unknown) => fetch('/api/archive/llm/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => j<{ ok: boolean; message: string; elapsed_ms: number }>(r)),
  ragRebuild: () => fetch('/api/archive/rag/rebuild', { method: 'POST' }).then(r => j<{ ok: boolean }>(r)),
};
