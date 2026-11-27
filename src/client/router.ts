import { bounded, brief } from './serialize.js'
import { here } from './stack.js'
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
  options?: any
  subscribe: (eventType: any, fn: (event: any) => void) => () => void
  navigate: (options: any) => Promise<unknown>
  invalidate?: (options?: any) => Promise<unknown>
}

const routerEvents = ['onBeforeNavigate', 'onBeforeLoad', 'onLoad', 'onResolved'] as const

function location(value: any) {
  if (!value) return null
  return {
    href: value.href,
    pathname: value.pathname,
    search: bounded(value.search, { depth: 4 }),
    ...(value.hash ? { hash: value.hash } : {}),
  }
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'object' && Object.keys(value as object).length === 0)
  )
}

function match(value: any, depth: number | undefined) {
  return {
    routeId: value.routeId,
    ...(value.id !== value.routeId ? { id: value.id } : {}),
    pathname: value.pathname,
    status: value.status,
    ...(value.isFetching ? { isFetching: value.isFetching } : {}),
    ...(isEmpty(value.params) ? {} : { params: bounded(value.params, { depth: 3 }) }),
    ...(isEmpty(value.search) ? {} : { search: bounded(value.search, { depth: 4 }) }),
    ...(value.error ? { error: brief(value.error) } : {}),
    ...(value.loaderData === undefined
      ? {}
      : {
          loaderData: bounded(
            value.loaderData,
            depth === undefined ? { depth: 3 } : { depth },
          ),
        }),
  }
}

export function routerOverview(router: RouterLike) {
  const state = router.state
  const failed = state.matches.find((m) => m.error)
  return {
    status: state.status,
    ...(state.isLoading ? { isLoading: true } : {}),
    href: state.location?.href,
    matches: state.matches.map((m) => m.routeId),
    ...(failed ? { error: `${failed.routeId}: ${brief(failed.error)}` } : {}),
  }
}

export function routerHandlers(router: RouterLike): Handlers {
  return {
    'router.state': (args) => {
      const state = router.state
      const depth = typeof args.depth === 'number' ? args.depth : undefined
      const pending = state.pendingMatches ?? []
      return {
        status: state.status,
        isLoading: state.isLoading,
        location: location(state.location),
        matches: state.matches.map((m) => match(m, depth)),
        ...(pending.length > 0
          ? { pendingMatches: pending.map((m) => match(m, depth)) }
          : {}),
      }
    },
    'router.routes': (args) => {
      const contains = typeof args.contains === 'string' ? args.contains : undefined
      const all = Object.values(router.routesById)
      const routes = all
        .filter(
          (route) =>
            contains === undefined ||
            String(route.id).includes(contains) ||
            String(route.fullPath).includes(contains),
        )
        .map((route) => {
          const has = [
            typeof route.options?.loader === 'function' ? 'loader' : '',
            typeof route.options?.beforeLoad === 'function' ? 'beforeLoad' : '',
            route.options?.validateSearch !== undefined ? 'search' : '',
          ].filter(Boolean)
          return {
            id: route.id,
            ...(route.fullPath !== route.id ? { fullPath: route.fullPath } : {}),
            ...(has.length > 0 ? { has } : {}),
          }
        })
      const limit = typeof args.limit === 'number' ? args.limit : 100
      return {
        total: all.length,
        matched: routes.length,
        routes: routes.slice(0, limit),
        ...(routes.length > limit ? { more: routes.length - limit } : {}),
      }
    },
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
  record({
    source: 'router',
    type: 'attached',
    key: router.state.location?.pathname,
    summary: `at ${router.state.location?.href} (${
      router.state.matches.map((m) => m.routeId).join(' > ') || 'not loaded yet'
    })`,
  })
  let started: number | undefined
  const stops = routerEvents.map((type) =>
    router.subscribe(type, (event) => {
      const from = event.fromLocation?.href ?? '(initial)'
      const to = event.toLocation?.href ?? '?'
      if (type === 'onBeforeNavigate') started = performance.now()
      const dur =
        type === 'onResolved' && started !== undefined
          ? Math.round(performance.now() - started)
          : undefined
      if (type === 'onResolved') started = undefined
      const failed =
        type === 'onResolved' ? router.state.matches.find((m) => m.error) : undefined
      record({
        source: 'router',
        type,
        key: event.toLocation?.pathname,
        summary: `${from} → ${to}${failed ? ` (error in ${failed.routeId}: ${brief(failed.error, 120)})` : ''}`,
        ...(dur !== undefined ? { dur } : {}),
        ...(type === 'onBeforeNavigate' ? { frames: here() } : {}),
        ...(type === 'onResolved'
          ? { detail: { matches: router.state.matches.map((m) => m.routeId) } }
          : {}),
      })
    }),
  )
  return () => stops.forEach((stop) => stop())
}

export function routerIdle(router: RouterLike): boolean {
  return router.state.status === 'idle' && !router.state.isLoading
}
