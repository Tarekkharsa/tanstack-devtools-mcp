import { bounded } from '@loopsight/core/page'
import type { PageSource, Recorder } from '@loopsight/core/page'

/**
 * Records the events TanStack Devtools plugins emit on its event bus, when
 * the devtools panel is mounted on the page.
 */
function recordBus(record: Recorder): () => void {
  if (typeof window === 'undefined') return () => {}
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail ?? {}
    record({
      source: 'bus',
      type: String(detail.type),
      ...(typeof detail.pluginId === 'string' ? { key: detail.pluginId } : {}),
      summary: String(detail.type),
      detail: bounded(detail.payload, { depth: 4, items: 20, chars: 500 }),
    })
  }
  window.addEventListener('tanstack-devtools-global', onEvent)
  return () => window.removeEventListener('tanstack-devtools-global', onEvent)
}

/** The TanStack Devtools event bus, when that panel is mounted on the page. */
const source: PageSource = {
  key: 'bus',
  attach: (_instance, { record }) => ({ stop: recordBus(record) }),
}

export default source
