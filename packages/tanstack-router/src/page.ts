import { bounded, brief, here } from '@loopsight/core/page'
import type { Handlers, PageSource, Recorder } from '@loopsight/core/page'

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
    ...(isNotFound(value)
      ? { notFound: true }
      : value.error
        ? { error: brief(value.error) }
        : {}),
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

const ROUTER_SETTINGS = [
  'defaultPreload',
  'defaultPreloadDelay',
  'defaultPreloadStaleTime',
  'defaultPreloadGcTime',
  'defaultStaleTime',
  'defaultGcTime',
  'defaultPendingMs',
  'defaultPendingMinMs',
  'defaultStructuralSharing',
  'defaultViewTransition',
  'scrollRestoration',
  'notFoundMode',
  'trailingSlash',
]
const ROUTER_PARTS = [
  'notFoundRoute',
  'defaultErrorComponent',
  'defaultNotFoundComponent',
  'defaultPendingComponent',
  'defaultOnCatch',
]
const ROUTE_SETTINGS = ['staleTime', 'gcTime', 'preload', 'preloadStaleTime', 'ssr', 'pendingMs']
const ROUTE_PARTS = [
  'loader',
  'beforeLoad',
  'validateSearch',
  'loaderDeps',
  'component',
  'errorComponent',
  'notFoundComponent',
  'pendingComponent',
  'head',
]

function plain(value: unknown): unknown {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) {
    return value === Infinity ? 'Infinity' : value
  }
  return typeof value
}

function pick(source: any, values: Array<string>, parts: Array<string>) {
  const out: Record<string, unknown> = {}
  for (const name of values) {
    if (source?.[name] !== undefined) out[name] = plain(source[name])
  }
  const has = parts.filter((name) => source?.[name] !== undefined)
  return { ...out, has }
}

/** True when a route's loaderDeps hands back the whole search object. */
function depsAreWholeSearch(match: any): boolean {
  const deps = match.loaderDeps
  const search = match.search
  if (deps === null || typeof deps !== 'object') return false
  if (search === null || typeof search !== 'object') return false
  if (Object.keys(search).length < 2) return false
  try {
    return JSON.stringify(deps) === JSON.stringify(search)
  } catch {
    return false
  }
}

/**
 * How the router and its matched routes are configured, for the rules in
 * `diagnose`. This goes to the server only.
 */
export function routerFacts(router: RouterLike) {
  const context = router.options?.context
  return {
    options: pick(router.options, ROUTER_SETTINGS, ROUTER_PARTS),
    contextKeys:
      context !== null && typeof context === 'object' ? Object.keys(context).slice(0, 30) : [],
    routeCount: Object.keys(router.routesById).length,
    matches: router.state.matches.map((m) => ({
      routeId: m.routeId,
      status: m.status,
      ...(m.cause ? { cause: m.cause } : {}),
      ...(m.preload ? { preload: true } : {}),
      ...(m.error ? { error: brief(m.error) } : {}),
      hasLoaderData: m.loaderData !== undefined,
      ...(depsAreWholeSearch(m) ? { loaderDepsIsSearch: true } : {}),
      ...(m.searchError ? { searchError: brief(m.searchError) } : {}),
      route: pick(router.routesById[m.routeId]?.options, ROUTE_SETTINGS, ROUTE_PARTS),
    })),
  }
}

function isNotFound(match: any): boolean {
  return match?.status === 'notFound' || match?.error?.isNotFound === true
}

export function routerOverview(router: RouterLike) {
  const state = router.state
  // "Not found" is an answer a route gives, not a failure of it.
  const missing = state.matches.find((m) => isNotFound(m))
  const failed = state.matches.find((m) => m.error && !isNotFound(m))
  return {
    status: state.status,
    ...(state.isLoading ? { isLoading: true } : {}),
    href: state.location?.href,
    matches: state.matches.map((m) => m.routeId),
    ...(missing ? { notFound: missing.routeId } : {}),
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
        type === 'onResolved'
          ? router.state.matches.find((m) => m.error && !isNotFound(m))
          : undefined
      const missing =
        type === 'onResolved' ? router.state.matches.find((m) => isNotFound(m)) : undefined
      record({
        source: 'router',
        type,
        ...(failed ? { problem: true as const } : {}),
        key: event.toLocation?.pathname,
        summary: `${from} → ${to}${failed ? ` (error in ${failed.routeId}: ${brief(failed.error, 120)})` : ''}${missing ? ` (not found, from ${missing.routeId})` : ''}`,
        ...(dur !== undefined ? { dur } : {}),
        ...(type === 'onBeforeNavigate' ? { frames: here() } : {}),
        ...(type === 'onResolved'
          ? {
              detail: {
                // The first load of the page, not a navigation the app made.
                ...(event.fromLocation ? {} : { initial: true }),
                matches: router.state.matches.map((m) => m.routeId),
                // Whether any matched route checks something before loading.
                guarded: router.state.matches.some(
                  (m) => typeof router.routesById[m.routeId]?.options?.beforeLoad === 'function',
                ),
                // Whether anything would show while a slow loader runs.
                pendingUi:
                  router.options?.defaultPendingComponent !== undefined ||
                  router.state.matches.some(
                    (m) => router.routesById[m.routeId]?.options?.pendingComponent !== undefined,
                  ),
              },
            }
          : {}),
      })
    }),
  )
  return () => stops.forEach((stop) => stop())
}

export function routerIdle(router: RouterLike): boolean {
  return router.state.status === 'idle' && !router.state.isLoading
}

/** Other routers the page has loaded next to TanStack Router. */
function loadedModules(): Array<string> {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return []
  const found = new Set<string>()
  for (const entry of performance.getEntriesByType('resource')) {
    const match = /\/(react-router-dom|react-router)(?:\.js|\/)/.exec(entry.name)
    if (match && !entry.name.includes('@tanstack') && !entry.name.includes('tanstack_')) {
      found.add(match[1]!)
    }
  }
  return [...found]
}

function isRouter(value: any): value is RouterLike {
  return (
    typeof value?.subscribe === 'function' &&
    typeof value?.navigate === 'function' &&
    typeof value?.routesById === 'object'
  )
}

/**
 * TanStack Router, seen from the page. The router puts itself on
 * `window.__TSR_ROUTER__`, so nothing is needed from the app.
 */
const source: PageSource<RouterLike> = {
  key: 'router',
  methods: ['router'],
  instance: {
    label: 'router instance',
    accepts: isRouter,
    globals: ['__TSR_ROUTER__'],
    find: ({ global }) => (isRouter(global.__TSR_ROUTER__) ? global.__TSR_ROUTER__ : undefined),
    missing:
      'This page has no TanStack Router connected. Pass it to connect({ router }).',
  },
  attach: (router, { record }) => ({
    handlers: routerHandlers(router),
    overview: () => routerOverview(router),
    facts: () => ({ ...routerFacts(router), modules: loadedModules() }),
    idle: () => routerIdle(router),
    stop: recordRouter(router, record),
  }),
}

export default source
