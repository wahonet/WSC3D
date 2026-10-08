import { layoutGraph, type LayoutGraph } from '../lib/graphLayout'

self.onmessage = (event: MessageEvent<LayoutGraph>) => {
  self.postMessage(layoutGraph(event.data))
}
