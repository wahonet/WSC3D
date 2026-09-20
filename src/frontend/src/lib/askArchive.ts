interface IndexStatus {
  ready: boolean; building: boolean; error: string; dense_ready: boolean;
  dense_building: boolean; dense_pending: boolean; dense_done: number; dense_n: number; dense_error: string;
}

export async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '请求失败，请重试。')
  return data
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const cancel = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, 1500)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** An index update is preparation, not a failed model call. Only resubmit once
 * the index is ready; changing the question or unmounting cancels polling. */
export async function askWhenReady<T extends { route: string }>(
  question: string, includeExtension: boolean, signal: AbortSignal,
  onProgress: (message: string) => void, onIndexReady: () => void,
): Promise<T> {
  const started = Date.now()
  const ask = () => fetch('/api/archive/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, include_extension: includeExtension }), signal,
  }).then(response => readResponse<T>(response))
  let result = await ask()
  while (result.route === 'retrieval_pending') {
    for (;;) {
      signal.throwIfAborted()
      const status = await fetch('/api/archive/rag/status', { signal }).then(response => readResponse<IndexStatus>(response))
      if (status.error || status.dense_error) throw new Error('本地文献索引准备失败，请点击“重新回答”重试。')
      if (status.ready && status.dense_ready && !status.building) break
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('文献索引仍在准备，已暂停本次等待。稍后点击“重新回答”即可继续。')
      const progress = status.dense_building && status.dense_n > 0 && !status.building
        ? `（${Math.min(100, Math.round(status.dense_done / status.dense_n * 100))}%）` : ''
      onProgress(`正在准备文献索引${progress}，完成后自动回答…`)
      await pause(signal)
    }
    signal.throwIfAborted()
    onProgress('资料已就绪，正在整理回答…')
    onIndexReady()
    result = await ask()
  }
  return result
}
