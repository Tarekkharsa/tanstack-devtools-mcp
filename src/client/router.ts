import { bounded, brief } from './serialize.js'
import type { Handlers, Recorder } from './types.js'

/**
 * The parts of a TanStack Router instance this package reads. Typed by shape,
 * so it works across `@tanstack/*-router` adapters and versions.
 */
export interface RouterLike {
  state: {
    status: string
    isLoading: boolean
    location: any
    resolvedLocation?: any
    matches: Array<any>
    pendingMatches?: Array<any>
  }
  routesById: Record<string, any>
  subscribe: (eventType: any, fn: (event: any) => void) => () => void
  navigate: (options: any) => Promise<unknown>
  invalidate?: (options?: any) => Promise<unknown>
}

const routerEvents = [
  'onBeforeNavigate',
  'onBeforeLoad',
  'onLoad',
  'onResolved',
] as const

function location(value: any) {
  if (!value) return null
  return {
    href: value.href,
    pathname: value.pathname,
    search: bounded(value.search, { depth: 4 }),
    hash: value.hash,
  }
}

function match(value: any, depth: number | undefined) {
  return {
    id: value.id,
    routeId: value.routeId,
    pathname: value.pathname,
    status: value.status,
    isFetching: value.isFetching,
    params: bounded(value.params, { depth: 3 }),
    search: bounded(value.search, { depth: 4 }),
    ...(value.error ? { error: brief(value.error) } : {}),
    loaderData: bounded(
      value.loaderData,
      depth === undefined ? { depth: 3 } : { depth },
    ),
  }
}

export function routerHandlers(router: RouterLike): Handlers {
  return {
    'router.state': (args) => {
      const state = router.state
      const depth = typeof args.depth === 'number' ? args.depth : undefined
      return {
        status: state.status,
        isLoading: state.isLoading,
        location: location(state.location),
        resolvedLocation: location(state.resolvedLocation),
        matches: state.matches.map((m) => match(m, depth)),
        pendingMatches: (state.pendingMatches ?? []).map((m) =>
          match(m, depth),
        ),
      }
    },
    'router.routes': () => ({
      routes: Object.values(router.routesById).map((route) => ({
        id: route.id,
        fullPath: route.fullPath,
        path: route.path,
        parent: route.parentRoute?.id ?? null,
        hasLoader: typeof route.options?.loader === 'function',
        hasBeforeLoad: typeof route.options?.beforeLoad === 'function',
        validatesSearch: route.options?.validateSearch !== undefined,
      })),
    }),
    'router.navigate': async (args) => {
      if (typeof args.to !== 'string') throw new Error('`to` must be a string')
      await router.navigate({
        to: args.to,
        ...(args.params !== undefined ? { params: args.params } : {}),
        ...(args.search !== undefined ? { search: args.search } : {}),
        ...(args.hash !== undefined ? { hash: args.hash } : {}),
        ...(args.replace !== undefined ? { replace: args.replace } : {}),
      })
      return { location: location(router.state.location) }
    },
    'router.invalidate': async () => {
      if (!router.invalidate) throw new Error('This router cannot invalidate')
      await router.invalidate()
      return { status: router.state.status }
    },
  }
}

export function recordRouter(router: RouterLike, record: Recorder): () => void {
  const stops = routerEvents.map((type) =>
    router.subscribe(type, (event) => {
      const from = event.fromLocation?.href ?? '(initial)'
      const to = event.toLocation?.href ?? '?'
      record({
        source: 'router',
        type,
        key: event.toLocation?.pathname,
        summary: `${from} → ${to}`,
        detail: {
          pathChanged: Boolean(event.pathChanged),
          hrefChanged: Boolean(event.hrefChanged),
        },
      })
    }),
  )
  return () => stops.forEach((stop) => stop())
}

export function routerIdle(router: RouterLike): boolean {
  return router.state.status === 'idle' && !router.state.isLoading
}
