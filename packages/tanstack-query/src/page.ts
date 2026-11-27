import { ago, bounded, brief, diff, drill, here } from '@loopsight/core/page'
import type { Frame, Handlers, PageSource, Recorder } from '@loopsight/core/page'

/**
 * The parts of TanStack Query's `QueryClient` this package reads. Typed by
 * shape, so it carries no dependency on a specific `@tanstack/query-core`.
 */
export interface QueryClientLike {
  getQueryCache: () => {
    getAll: () => Array<any>
    subscribe: (listener: (event: any) => void) => () => void
    build?: (...args: Array<any>) => any
  }
  getMutationCache: () => {
    getAll: () => Array<any>
    subscribe: (listener: (event: any) => void) => () => void
  }
  isFetching: () => number
  isMutating: () => number
  invalidateQueries: (filters?: any) => Promise<unknown>
  refetchQueries: (filters?: any) => Promise<unknown>
  resetQueries: (filters?: any) => Promise<unknown>
  removeQueries: (filters?: any) => void
  setQueryData: (queryKey: any, updater: any) => unknown
}

const queryActions = ['invalidate', 'refetch', 'reset', 'remove'] as const
type QueryAction = (typeof queryActions)[number]

/** What the recorder remembers about one query, beyond what Query keeps. */
interface Memory {
  fetchStarted?: number
  /** Call sites that created or observed the query, keyed by top frame. */
  sites: Map<string, Array<Frame>>
  /** Stack captures spent on this query; they stop at a small budget. */
  looks: number
  /** In the cache before the page connected, as a server render leaves it. */
  preloaded: boolean
  /** Fetches started since the page connected. */
  fetches: number
  hasData: boolean
  current?: unknown
  previous?: unknown
  changedAt?: number
}

const memories = new WeakMap<object, Memory>()
const MAX_SITES = 5
const MAX_LOOKS = 30

function memoryOf(query: object): Memory {
  let memory = memories.get(query)
  if (!memory) {
    memory = { sites: new Map(), looks: 0, preloaded: false, fetches: 0, hasData: false }
    memories.set(query, memory)
  }
  return memory
}

function noteSite(query: object, frames: Array<Frame>): void {
  const top = frames[0]
  if (!top) return
  const sites = memoryOf(query).sites
  const id = `${top.url}:${top.line}:${top.column}`
  if (sites.has(id) || sites.size >= MAX_SITES) return
  sites.set(id, frames)
}

function noteData(query: any): void {
  const memory = memoryOf(query)
  const data = query.state?.data
  if (data === undefined) return
  if (!memory.hasData) {
    memory.hasData = true
    memory.current = data
    return
  }
  if (data === memory.current) return
  memory.previous = memory.current
  memory.current = data
  memory.changedAt = Date.now()
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** One row per query. Fields at their usual value are left out. */
function row(query: any) {
  const state = query.state ?? {}
  return {
    queryHash: String(query.queryHash),
    status: state.status as string,
    ...(state.fetchStatus !== 'idle' ? { fetch: state.fetchStatus } : {}),
    ...(safe(() => query.isStale(), false) ? { stale: true } : {}),
    ...(state.isInvalidated ? { invalidated: true } : {}),
    ...(safe(() => query.isDisabled(), false) ? { disabled: true } : {}),
    observers: safe(() => query.getObserversCount(), 0),
    ...(state.dataUpdatedAt ? { updated: ago(state.dataUpdatedAt) } : {}),
    ...(state.fetchFailureCount ? { failures: state.fetchFailureCount } : {}),
    ...(state.error ? { error: brief(state.error) } : {}),
  }
}

function matcher(args: { queryHash?: string; keyContains?: string }) {
  return (query: any) => {
    if (args.queryHash !== undefined && query.queryHash !== args.queryHash) {
      return false
    }
    if (
      args.keyContains !== undefined &&
      !String(query.queryHash).includes(args.keyContains)
    ) {
      return false
    }
    return true
  }
}

function tally(values: Array<string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/** The first two segments of a key, which is how apps usually namespace. */
function family(query: any): string {
  const key = Array.isArray(query.queryKey) ? query.queryKey : [query.queryKey]
  return key
    .slice(0, 2)
    .map((part: unknown) => (typeof part === 'string' ? part : '…'))
    .join('/')
}

/** A setting as a rule can compare it: a plain value, or what kind of thing it is. */
function setting(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) {
    return value === Infinity ? 'Infinity' : value
  }
  return typeof value
}

function settings(source: any, names: Array<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const value = setting(source?.[name])
    if (value !== undefined) out[name] = value
  }
  return out
}

const QUERY_SETTINGS = [
  'staleTime',
  'gcTime',
  'retry',
  'networkMode',
  'structuralSharing',
  'maxPages',
]
const OBSERVER_SETTINGS = [
  'enabled',
  'staleTime',
  'refetchInterval',
  'refetchOnWindowFocus',
  'refetchOnMount',
  'refetchOnReconnect',
  'throwOnError',
  'suspense',
]

/**
 * How the client and each query are configured, for the rules in `diagnose`.
 * This goes to the server only; it is never returned to an agent as it is.
 */
export function queryFacts(client: QueryClientLike & { getDefaultOptions?: () => any }) {
  const defaults = safe(() => client.getDefaultOptions?.(), undefined)
  return {
    defaults: settings(defaults?.queries, [...QUERY_SETTINGS, ...OBSERVER_SETTINGS]),
    queries: client
      .getQueryCache()
      .getAll()
      .slice(0, 500)
      .map((query) => {
        const memory = memoryOf(query)
        const observers: Array<any> = Array.isArray(query.observers) ? query.observers : []
        return {
          queryHash: String(query.queryHash),
          family: family(query),
          status: query.state?.status,
          fetchStatus: query.state?.fetchStatus,
          stale: safe(() => query.isStale(), false),
          disabled: safe(() => query.isDisabled(), false),
          hasData: query.state?.data !== undefined,
          hasQueryFn: typeof query.options?.queryFn === 'function',
          failures: query.state?.fetchFailureCount ?? 0,
          preloaded: memory.preloaded,
          fetches: memory.fetches,
          ...(Array.isArray(query.state?.data?.pages) && Array.isArray(query.state?.data?.pageParams)
            ? { pages: query.state.data.pages.length }
            : {}),
          options: settings(query.options, QUERY_SETTINGS),
          observers: observers.slice(0, 20).map((observer) => ({
            ...settings(observer?.options, OBSERVER_SETTINGS),
            ...(typeof observer?.options?.select === 'function' ? { select: true } : {}),
            ...(observer?.options?.placeholderData !== undefined ? { placeholderData: true } : {}),
            ...(observer?.options?.initialData !== undefined ? { initialData: true } : {}),
          })),
        }
      }),
  }
}

export function queryOverview(client: QueryClientLike) {
  const all = client.getQueryCache().getAll()
  const mutations = client.getMutationCache().getAll()
  return {
    total: all.length,
    byStatus: tally(all.map((q) => String(q.state?.status))),
    fetching: all
      .filter((q) => q.state?.fetchStatus === 'fetching')
      .map((q) => String(q.queryHash))
      .slice(0, 20),
    errors: all
      .filter((q) => q.state?.status === 'error')
      .slice(0, 20)
      .map((q) => ({ queryHash: String(q.queryHash), error: brief(q.state.error) })),
    mutations: {
      total: mutations.length,
      pending: mutations.filter((m) => m.state?.status === 'pending').length,
      failed: mutations.filter((m) => m.state?.status === 'error').length,
    },
  }
}

export function queryHandlers(client: QueryClientLike): Handlers {
  const all = () => client.getQueryCache().getAll()
  const find = (hash: unknown) => {
    const query = all().find((q) => q.queryHash === hash)
    if (!query) throw new Error(`No query with hash ${String(hash)}`)
    return query
  }
  return {
    'query.list': (args) => {
      const candidates = all().filter(matcher(args))
      const matches = candidates
        .map(row)
        .filter(
          (query) =>
            (args.status === undefined || query.status === args.status) &&
            (args.fetchStatus === undefined ||
              (query.fetch ?? 'idle') === args.fetchStatus) &&
            (args.stale === undefined || (query.stale ?? false) === args.stale),
        )
      const limit = typeof args.limit === 'number' ? args.limit : 50
      return {
        total: matches.length,
        byStatus: tally(matches.map((q) => q.status)),
        fetching: client.isFetching(),
        ...(candidates.length > 10 ? { families: tally(candidates.map(family)) } : {}),
        queries: matches.slice(0, limit),
        ...(matches.length > limit ? { more: matches.length - limit } : {}),
      }
    },
    'query.get': (args) => {
      const query = find(args.queryHash)
      const depth = typeof args.depth === 'number' ? args.depth : undefined
      const path = Array.isArray(args.path) ? args.path : []
      const data = path.length > 0 ? drill(query.state.data, path) : query.state.data
      return {
        ...row(query),
        queryKey: bounded(query.queryKey, { depth: 5, items: 30, chars: 300 }),
        ...(path.length > 0 ? { path } : {}),
        data: bounded(data, depth === undefined ? {} : { depth }),
        error: query.state.error ? bounded(query.state.error) : null,
        sites: [...memoryOf(query).sites.values()],
      }
    },
    'query.diff': (args) => {
      const query = find(args.queryHash)
      const memory = memoryOf(query)
      if (memory.changedAt === undefined) {
        return {
          queryHash: query.queryHash,
          note: 'The data has not changed since this page connected.',
          changes: [],
        }
      }
      return {
        queryHash: query.queryHash,
        changed: ago(memory.changedAt),
        ...diff(memory.previous, memory.current),
      }
    },
    'mutation.list': () => {
      const mutations = client.getMutationCache().getAll()
      return {
        total: mutations.length,
        mutating: client.isMutating(),
        mutations: mutations.slice(-100).map((mutation) => ({
          mutationId: mutation.mutationId,
          mutationKey: bounded(mutation.options?.mutationKey ?? null),
          status: mutation.state?.status,
          ...(mutation.state?.isPaused ? { paused: true } : {}),
          ...(mutation.state?.submittedAt
            ? { submitted: ago(mutation.state.submittedAt) }
            : {}),
          ...(mutation.state?.failureCount
            ? { failures: mutation.state.failureCount }
            : {}),
          variables: bounded(mutation.state?.variables, { depth: 3 }),
          ...(mutation.state?.error
            ? { error: brief(mutation.state.error) }
            : {}),
        })),
      }
    },
    'query.action': async (args) => {
      const action = args.action as QueryAction
      if (!queryActions.includes(action)) {
        throw new Error(`Unknown action ${String(args.action)}`)
      }
      if (args.queryHash === undefined && args.keyContains === undefined) {
        if (args.all !== true) {
          throw new Error('Pass queryHash, keyContains, or all: true')
        }
      }
      const predicate = matcher(args)
      const matched = all().filter(predicate).length
      const filters = { predicate }
      if (action === 'invalidate') await client.invalidateQueries(filters)
      else if (action === 'refetch') await client.refetchQueries(filters)
      else if (action === 'reset') await client.resetQueries(filters)
      else client.removeQueries(filters)
      return { action, matched }
    },
    'query.setData': (args) => {
      const query = find(args.queryHash)
      client.setQueryData(query.queryKey, args.data)
      return row(query)
    },
  }
}

/** Records cache events. Observer bookkeeping is left out as noise. */
export function recordQuery(
  client: QueryClientLike,
  record: Recorder,
): () => void {
  // What the cache already holds, such as queries a server render sent along.
  const existing = client.getQueryCache().getAll()
  for (const query of existing) {
    noteData(query)
    memoryOf(query).preloaded = true
  }
  if (existing.length > 0) {
    const counts = Object.entries(tally(existing.map((q) => String(q.state?.status))))
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')
    record({
      source: 'query',
      type: 'attached',
      summary: `${existing.length} queries already in the cache: ${counts}`,
    })
  }

  // A component reaches its query through `build` while it renders, which is
  // the one moment the component is on the stack. Each query gets a small
  // budget of looks, so a hot render path pays next to nothing.
  const cache = client.getQueryCache()
  const build = cache.build
  let patched: typeof build
  if (typeof build === 'function') {
    patched = function (this: unknown, ...args: Array<any>) {
      const query = build.apply(this, args)
      try {
        const memory = memoryOf(query)
        if (memory.looks < MAX_LOOKS && memory.sites.size < MAX_SITES) {
          memory.looks += 1
          noteSite(query, here())
        }
      } catch {
        // Finding the call site must never get in the way of the query.
      }
      return query
    }
    cache.build = patched
  }

  const stopQueries = cache.subscribe((event) => {
    const query = event.query
    if (!query) return
    const key = String(query.queryHash)
    if (event.type === 'added') {
      const frames = here()
      noteSite(query, frames)
      record({ source: 'query', type: 'added', key, summary: `${key} added`, frames })
      return
    }
    if (event.type === 'removed') {
      record({ source: 'query', type: 'removed', key, summary: `${key} removed` })
      return
    }
    if (event.type !== 'updated') return
    const action = event.action ?? {}
    const type = String(action.type)
    if (type === 'setState') return
    const memory = memoryOf(query)
    const now = performance.now()

    if (type === 'fetch') {
      memory.fetchStarted = now
      memory.fetches += 1
      record({
        source: 'query',
        type,
        key,
        summary: `${key} ${memory.hasData ? 'refetching' : 'fetching'}`,
        // For rules: a fetch of data the cache already holds.
        ...(memory.hasData ? { detail: { refetch: true } } : {}),
        frames: here(),
      })
      return
    }
    const dur =
      (type === 'success' && !action.manual) || type === 'error'
        ? memory.fetchStarted === undefined
          ? undefined
          : Math.round(now - memory.fetchStarted)
        : undefined
    if (dur !== undefined) memory.fetchStarted = undefined
    if (type === 'success') noteData(query)

    record({
      source: 'query',
      type,
      key,
      ...(type === 'error' ? { problem: true as const } : {}),
      summary:
        type === 'error' || type === 'failed'
          ? `${key} ${type}: ${brief(action.error)}`
          : type === 'success'
            ? `${key} success${action.manual ? ' (set by hand)' : ''}`
            : type === 'invalidate'
              ? `${key} invalidated`
              : `${key} ${type}`,
      ...(dur !== undefined ? { dur } : {}),
      ...(type === 'success' && action.manual ? { detail: { manual: true } } : {}),
      ...(type === 'invalidate' ? { frames: here() } : {}),
    })
  })

  const started = new Map<number, number>()
  const stopMutations = client.getMutationCache().subscribe((event) => {
    const mutation = event.mutation
    if (!mutation) return
    const id = Number(mutation.mutationId)
    const key = String(id)
    const name = brief(mutation.options?.mutationKey ?? `mutation #${key}`, 80)
    if (event.type === 'added') {
      record({ source: 'mutation', type: 'added', key, summary: `${name} added`, frames: here() })
      return
    }
    if (event.type === 'removed') {
      started.delete(id)
      record({ source: 'mutation', type: 'removed', key, summary: `${name} removed` })
      return
    }
    if (event.type !== 'updated') return
    const type = String(event.action?.type)
    if (type === 'pending') started.set(id, performance.now())
    const done = type === 'success' || type === 'error'
    const begun = started.get(id)
    if (done) started.delete(id)
    record({
      source: 'mutation',
      type,
      key,
      ...(type === 'error' ? { problem: true as const } : {}),
      summary:
        type === 'error'
          ? `${name} error: ${brief(event.action.error)}`
          : `${name} ${type}`,
      ...(done && begun !== undefined
        ? { dur: Math.round(performance.now() - begun) }
        : {}),
    })
  })
  return () => {
    if (patched && cache.build === patched) cache.build = build
    stopQueries()
    stopMutations()
  }
}

function isQueryClient(value: any): value is QueryClientLike {
  return (
    typeof value?.getQueryCache === 'function' &&
    typeof value?.getMutationCache === 'function'
  )
}

/**
 * TanStack Query, seen from the page. The client is found on
 * `window.__TANSTACK_QUERY_CLIENT__`, or in the context of a TanStack Router
 * when that source is present (`context.queryClient`), or handed over by the
 * app.
 */
const source: PageSource<QueryClientLike> = {
  key: 'query',
  methods: ['query', 'mutation'],
  instance: {
    label: 'QueryClient',
    accepts: isQueryClient,
    globals: ['__TANSTACK_QUERY_CLIENT__'],
    find: ({ global, instanceOf }) => {
      if (isQueryClient(global.__TANSTACK_QUERY_CLIENT__)) {
        return global.__TANSTACK_QUERY_CLIENT__
      }
      // The usual Router and Query setup keeps the client in the router context.
      const inContext = (instanceOf('router') as any)?.options?.context?.queryClient
      return isQueryClient(inContext) ? inContext : undefined
    },
    missing:
      'This page has no QueryClient connected. Pass it to connect({ queryClient }) or set window.__TANSTACK_QUERY_CLIENT__.',
  },
  attach: (client, { record }) => ({
    handlers: queryHandlers(client),
    overview: () => queryOverview(client),
    facts: () => queryFacts(client),
    idle: () => client.isFetching() === 0 && client.isMutating() === 0,
    stop: recordQuery(client, record),
  }),
}

export default source
