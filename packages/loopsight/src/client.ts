import { connect as connectPage } from '@loopsight/core/page'
import bus from '@loopsight/tanstack-devtools/page'
import query from '@loopsight/tanstack-query/page'
import router from '@loopsight/tanstack-router/page'
import start from '@loopsight/tanstack-start/page'
import { VITE_FRAMES, VITE_REQUESTS } from '@loopsight/vite/page'
import type { ConnectOptions as CoreOptions } from '@loopsight/core/page'
import type { QueryClientLike } from '@loopsight/tanstack-query/page'
import type { RouterLike } from '@loopsight/tanstack-router/page'

export type { PageSource } from '@loopsight/core/page'

export interface ConnectOptions extends CoreOptions {
  /**
   * When left out, read from the router context (`context.queryClient`) or
   * `window.__TANSTACK_QUERY_CLIENT__`.
   */
  queryClient?: QueryClientLike
  /** Read from `window.__TSR_ROUTER__`, which TanStack Router sets, when left out. */
  router?: RouterLike
}

/**
 * Connects this page to the loopsight server with the built-in sources. The
 * Vite plugin does this for you; call it yourself when there is no plugin,
 * or to hand over an instance that cannot be found.
 *
 * Safe to call more than once: later calls add what they pass. Returns a
 * function that disconnects.
 */
export function connect(options: ConnectOptions = {}): () => void {
  const { queryClient, router: routerInstance, ...rest } = options
  return connectPage({
    // This preset is for apps Vite serves. The plugin's own entry passes
    // these too; here they cover an app that connects by itself.
    ignoreFrames: VITE_FRAMES,
    ignoreRequests: VITE_REQUESTS,
    ...rest,
    sources: [router, query, start, bus, ...(rest.sources ?? [])],
    instances: {
      ...rest.instances,
      ...(routerInstance ? { router: routerInstance } : {}),
      ...(queryClient ? { query: queryClient } : {}),
    },
  })
}
