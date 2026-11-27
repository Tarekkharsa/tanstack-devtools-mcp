import { bounded, brief } from './serialize.js'
import type { Handlers, Recorder } from './types.js'

/**
 * The parts of TanStack Query's `QueryClient` this package reads. Typed by
 * shape, so it carries no dependency on a specific `@tanstack/query-core`.
 */
export interface QueryClientLike {
  getQueryCache: () => {
    getAll: () => Array<any>
    subscribe: (listener: (event: any) => void) => () => void
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

function summarize(query: any) {
  const state = query.state ?? {}
  return {
    queryHash: String(query.queryHash),
    queryKey: bounded(query.queryKey, { depth: 4, items: 20, chars: 200 }),
    status: state.status,
    fetchStatus: state.fetchStatus,
    stale: safe(() => query.isStale(), false),
    invalidated: Boolean(state.isInvalidated),
    observers: safe(() => query.getObserversCount(), 0),
    disabled: safe(() => query.isDisabled(), false),
    dataUpdatedAt: state.dataUpdatedAt || null,
    errorUpdatedAt: state.errorUpdatedAt || null,
    failureCount: state.fetchFailureCount ?? 0,
    ...(state.error ? { error: brief(state.error) } : {}),
  }
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
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

export function queryHandlers(client: QueryClientLike): Handlers {
  const all = () => client.getQueryCache().getAll()
  return {
    'query.list': (args) => {
      const matches = all()
        .filter(matcher(args))
        .map(summarize)
        .filter(
          (query) =>
            (args.status === undefined || query.status === args.status) &&
            (args.fetchStatus === undefined ||
              query.fetchStatus === args.fetchStatus) &&
            (args.stale === undefined || query.stale === args.stale),
        )
      const limit = typeof args.limit === 'number' ? args.limit : 100
      return {
        total: matches.length,
        fetching: client.isFetching(),
        queries: matches.slice(0, limit),
      }
    },
    'query.get': (args) => {
      const query = all().find((q) => q.queryHash === args.queryHash)
      if (!query) throw new Error(`No query with hash ${args.queryHash}`)
      const depth = typeof args.depth === 'number' ? args.depth : undefined
      return {
        ...summarize(query),
        data: bounded(query.state.data, depth === undefined ? {} : { depth }),
        error: query.state.error ? bounded(query.state.error) : null,
        fetchMeta: bounded(query.state.fetchMeta ?? null),
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
          isPaused: Boolean(mutation.state?.isPaused),
          submittedAt: mutation.state?.submittedAt || null,
          failureCount: mutation.state?.failureCount ?? 0,
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
      const query = all().find((q) => q.queryHash === args.queryHash)
      if (!query) throw new Error(`No query with hash ${args.queryHash}`)
      client.setQueryData(query.queryKey, args.data)
      return summarize(query)
    },
  }
}

/** Records cache events. Observer bookkeeping is left out as noise. */
export function recordQuery(
  client: QueryClientLike,
  record: Recorder,
): () => void {
  const stopQueries = client.getQueryCache().subscribe((event) => {
    const key = String(event.query?.queryHash)
    if (event.type === 'added' || event.type === 'removed') {
      record({ source: 'query', type: event.type, key, summary: key })
      return
    }
    if (event.type !== 'updated') return
    const action = event.action ?? {}
    if (action.type === 'setState') return
    const state = event.query?.state ?? {}
    record({
      source: 'query',
      type: String(action.type),
      key,
      summary:
        action.type === 'error' || action.type === 'failed'
          ? `${key}: ${brief(action.error)}`
          : `${key} → ${state.status}/${state.fetchStatus}`,
      ...(action.type === 'success' && action.manual
        ? { detail: { manual: true } }
        : {}),
    })
  })
  const stopMutations = client.getMutationCache().subscribe((event) => {
    const mutation = event.mutation
    if (!mutation) return
    const key = String(mutation.mutationId)
    const name = brief(mutation.options?.mutationKey ?? `#${key}`, 80)
    if (event.type === 'added' || event.type === 'removed') {
      record({ source: 'mutation', type: event.type, key, summary: name })
      return
    }
    if (event.type !== 'updated') return
    const action = event.action ?? {}
    record({
      source: 'mutation',
      type: String(action.type),
      key,
      summary:
        action.type === 'error'
          ? `${name}: ${brief(action.error)}`
          : `${name} → ${mutation.state?.status}`,
    })
  })
  return () => {
    stopQueries()
    stopMutations()
  }
}
