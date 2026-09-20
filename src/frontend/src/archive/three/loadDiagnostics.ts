/** Opt-in DOM diagnostics for repeatable refresh/interactivity checks (?diagnostics=1). */
const enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('diagnostics');
const values: Record<string, unknown> = { phases: {}, longTasks: [], revision: 'progressive-20260911' };
let output: HTMLOutputElement | null = null;
function publish() {
  if (!enabled) return;
  output ??= document.body.appendChild(Object.assign(document.createElement('output'), {
    id: 'load-diagnostics', hidden: true,
  }));
  output.textContent = JSON.stringify(values);
}
export function loadMetric(name: string, value: unknown = Math.round(performance.now())) {
  if (!enabled) return;
  (values.phases as Record<string, unknown>)[name] = value;
  publish();
}
if (enabled) {
  publish();
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) (values.longTasks as unknown[]).push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
      publish();
    }).observe({ type: 'longtask', buffered: true });
  }
}
