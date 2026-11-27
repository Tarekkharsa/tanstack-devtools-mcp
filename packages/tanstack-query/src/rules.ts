import { burst, clip, groups, numbers, where } from '@loopsight/core/server'
import type {
  KnownMessage,
  LogEntry,
  Reference,
  Rule,
  RuleContext,
  SlowKind,
} from '@loopsight/core/server'

/** One query, as the page half reports it for these rules. */
export interface QueryFact {
  queryHash: string
  family: string
  status?: string
  fetchStatus?: string
  stale: boolean
  disabled: boolean
  hasData: boolean
  hasQueryFn: boolean
  failures: number
  /** In the cache before the page connected, as a server render leaves it. */
  preloaded: boolean
  /** Fetches started since the page connected. */
  fetches: number
  /** Pages held, for an infinite query. */
  pages?: number
  options: Record<string, unknown>
  observers: Array<Record<string, unknown>>
}

/** How the QueryClient and its queries are set up. */
export interface QueryFacts {
  defaults: Record<string, unknown>
  queries: Array<QueryFact>
}

/** The Query part of the page overview. */
interface QueryOverview {
  errors?: Array<{ queryHash: string; error: string }>
}

const KEY = 'query'
const facts = (context: RuleContext) => context.facts<QueryFacts>(KEY)
/** A fetch of data the cache already held, as the page half marks it. */
const isRefetch = (entry: LogEntry) =>
  (entry.detail as { refetch?: boolean } | undefined)?.refetch === true

/**
 * Rules from the official TanStack Query v5 guides. Each `fix` restates what
 * the cited page says. The thresholds are this package's; the docs give none.
 */

const guide = (name: string, label: string): Reference => ({
  label: `TanStack Query docs: ${label}`,
  at: `https://tanstack.com/query/latest/docs/framework/react/guides/${name}`,
})
const SSR = guide('ssr', 'Server Rendering & Hydration')
const PREFETCHING = guide('prefetching', 'Prefetching')
const QUERY_FUNCTIONS = guide('query-functions', 'Query Functions')
const QUERY_KEYS = guide('query-keys', 'Query Keys')
const DEFAULTS = guide('important-defaults', 'Important Defaults')
const FOCUS = guide('window-focus-refetching', 'Window Focus Refetching')
const DISABLING = guide('disabling-queries', 'Disabling Queries')
const WATERFALLS = guide('request-waterfalls', 'Request Waterfalls')
const NETWORK_MODE = guide('network-mode', 'Network Mode')
const INFINITE = guide('infinite-queries', 'Infinite Queries')
const SUSPENSE = guide('suspense', 'Suspense')
const DEPENDENT = guide('dependent-queries', 'Dependent Queries')
const CANCELLATION = guide('query-cancellation', 'Query Cancellation')
const STABLE_CLIENT: Reference = {
  label: 'TanStack Query ESLint rule: stable-query-client',
  at: 'https://tanstack.com/query/latest/docs/eslint/stable-query-client',
}

const isZero = (value: unknown) => value === undefined || value === 0

/** True when nothing gives the query a staleTime, so its data is stale at once. */
function staleAtOnce(query: QueryFact, setup: QueryFacts): boolean {
  const defaults = setup.defaults
  if (query.observers.some((observer) => !isZero(observer.staleTime))) return false
  if (!isZero(query.options.staleTime)) return false
  return query.observers.length > 0 || isZero(defaults.staleTime)
}

function factsByHash(setup: QueryFacts | undefined): Map<string, QueryFact> {
  return new Map((setup?.queries ?? []).map((query) => [query.queryHash, query]))
}

/** An invalidation asks for the fetch that follows it. */
function asked(invalidations: Array<LogEntry>, fetch: LogEntry): boolean {
  return invalidations.some(
    (entry) => entry.key === fetch.key && entry.t <= fetch.t && fetch.t - entry.t < 5000,
  )
}

/** Each fetch of a query paired with how it ended. */
function fetchWindows(context: RuleContext) {
  const ends = context.by('query', 'success', 'error')
  const retried = context.by('query', 'failed')
  return context.by('query', 'fetch').flatMap((start) => {
    const end = ends.find((entry) => entry.key === start.key && entry.n > start.n)
    if (!end) return []
    return [
      {
        key: start.key ?? '',
        start,
        end,
        retried: retried.some(
          (entry) => entry.key === start.key && entry.n > start.n && entry.n < end.n,
        ),
      },
    ]
  })
}

export const QUERY_RULES: Array<Rule> = [
  {
    id: 'query/in-error',
    check: ({ overview }) => {
      const failed = overview<QueryOverview>(KEY)?.errors ?? []
      if (failed.length === 0) return []
      return [
        {
          severity: 'error',
          title: `${failed.length} ${failed.length === 1 ? 'query is' : 'queries are'} in the error state`,
          evidence: failed.slice(0, 5).map((q) => `${clip(q.queryHash, 120)}: ${clip(q.error, 160)}`),
          hint: 'get_query shows the full error and where the query is used.',
        },
      ]
    },
  },
  {
    id: 'query/failed-mutations',
    check: ({ by }) => {
      const failed = by('mutation', 'error')
      if (failed.length === 0) return []
      return [
        {
          severity: 'error',
          title: `${failed.length} failed ${failed.length === 1 ? 'mutation' : 'mutations'}`,
          entries: numbers(failed),
          evidence: failed.slice(-3).map((entry) => clip(entry.summary)),
        },
      ]
    },
  },
  {
    // Four fetches of one query inside ten seconds is a loop, not a user.
    id: 'query/fetch-loop',
    check: ({ by }) => {
      const findings = []
      for (const [key, list] of groups(by('query', 'fetch'), (entry) => entry.key ?? '')) {
        const run = burst(list, 10_000)
        if (run.length < 4) continue
        findings.push({
          severity: 'warning' as const,
          title: `A query fetched ${run.length} times within 10 s`,
          entries: numbers(run),
          evidence: [clip(key, 160) + where(run.at(-1)!)],
          hint: 'Common causes: a query key that changes on every render, an effect that invalidates on each update, or staleTime 0 with many mounts.',
        })
      }
      return findings
    },
  },
  {
    id: 'query/hydrated-refetch',
    fix: 'Set a default `staleTime` above 0 on the QueryClient (the docs use `60 * 1000`). With the default of 0, data the server just rendered counts as stale and is fetched again on page load.',
    docs: SSR,
    check: (context) => {
      const setup = facts(context)
      if (!setup) return []
      const known = factsByHash(setup)
      const attached = context.by('query', 'attached')[0]
      if (!attached) return []
      const invalidations = context.by('query', 'invalidate')
      const again = context.by('query', 'fetch').filter((fetch) => {
        const query = known.get(fetch.key ?? '')
        return (
          query?.preloaded === true &&
          isRefetch(fetch) &&
          fetch.t - attached.t <= 3000 &&
          !asked(invalidations, fetch) &&
          staleAtOnce(query, setup)
        )
      })
      if (again.length === 0) return []
      return [
        {
          severity: 'warning',
          title: `${again.length} ${again.length === 1 ? 'query' : 'queries'} sent by the server render fetched again as the page loaded`,
          entries: numbers(again),
          evidence: again.slice(0, 5).map((entry) => clip(entry.key ?? '', 140) + where(entry)),
        },
      ]
    },
  },
  {
    id: 'query/fetched-twice',
    fix: 'Set `staleTime` on the `useQuery` call, or as a client default, as well as on the loader or prefetch call. A `staleTime` passed to a prefetch applies to that fetch only, so the component fetches the same data again when it mounts.',
    docs: PREFETCHING,
    check: (context) => {
      const setup = facts(context)
      if (!setup) return []
      const known = factsByHash(setup)
      const invalidations = context.by('query', 'invalidate')
      const fetches = context.by('query', 'fetch')
      const pairs: Array<{ first: LogEntry; second: LogEntry }> = []
      for (const done of context.by('query', 'success')) {
        if (done.dur === undefined) continue
        const query = known.get(done.key ?? '')
        if (!query || query.preloaded || !staleAtOnce(query, setup)) continue
        const second = fetches.find(
          (fetch) =>
            fetch.key === done.key &&
            fetch.n > done.n &&
            fetch.t - done.t <= 2000 &&
            !asked(invalidations, fetch),
        )
        const first = fetches.findLast((fetch) => fetch.key === done.key && fetch.n < done.n)
        if (second && first) pairs.push({ first, second })
      }
      return pairs.slice(-2).map(({ first, second }) => ({
        severity: 'warning' as const,
        title: 'A query fetched, then fetched again within 2 s with nothing invalidating it',
        entries: [first.n, second.n],
        evidence: [
          clip(second.key ?? '', 140),
          `first fetch${where(first) || ' — source unknown'}`,
          `second fetch${where(second) || ' — source unknown'}`,
        ],
      }))
    },
  },
  {
    id: 'query/http-error-cached-as-success',
    fix: 'Throw inside the `queryFn` when the response is not ok, for example `if (!response.ok) throw new Error(...)`. `fetch` does not reject on an error status, so without the check the error body is cached as data.',
    docs: QUERY_FUNCTIONS,
    check: (context) => {
      const windows = fetchWindows(context)
      const findings = []
      for (const request of context.by('network', 'error')) {
        if (request.dur === undefined) continue
        const began = request.t - request.dur
        const during = windows.filter(
          (window) => window.start.t <= began + 20 && window.end.t >= request.t - 5,
        )
        // Only when one query can own the request, and it did not retry.
        const [only] = during
        if (during.length !== 1 || !only || only.retried) continue
        if (only.end.type !== 'success' || only.end.dur === undefined) continue
        if (only.end.t - request.t > 100) continue
        findings.push({
          severity: 'warning' as const,
          title: 'A request failed, and the query that made it ended as a success',
          entries: [request.n, only.end.n],
          evidence: [clip(request.summary, 160) + where(request), clip(only.key, 140)],
          hint: 'If the query function turns this status into a value on purpose (a 404 into null), ignore this.',
        })
      }
      return findings.slice(-2)
    },
  },
  {
    id: 'query/refetching-stale-at-once',
    supersedes: ['query/fetch-loop'],
    fix: 'Set `staleTime` on the query or in `defaultOptions.queries`. The docs call it the recommended way to avoid excessive refetches: with the default of 0, every mount and window focus fetches again.',
    docs: DEFAULTS,
    check: (context) => {
      const setup = facts(context)
      if (!setup) return []
      const known = factsByHash(setup)
      const invalidations = context.by('query', 'invalidate')
      const byKey = new Map<string, Array<LogEntry>>()
      for (const fetch of context.by('query', 'fetch')) {
        if (asked(invalidations, fetch)) continue
        const list = byKey.get(fetch.key ?? '') ?? []
        list.push(fetch)
        byKey.set(fetch.key ?? '', list)
      }
      const findings = []
      for (const [key, list] of byKey) {
        const query = known.get(key)
        if (!query || !staleAtOnce(query, setup)) continue
        if (query.observers.some((observer) => observer.refetchInterval !== undefined && observer.refetchInterval !== false)) continue
        const recent = list.filter((fetch) => list.at(-1)!.t - fetch.t <= 60_000)
        if (recent.length < 4) continue
        findings.push({
          severity: 'warning' as const,
          title: `A query with no staleTime fetched ${recent.length} times in a minute`,
          entries: numbers(recent),
          evidence: [clip(key, 140) + where(recent.at(-1)!)],
        })
      }
      return findings.slice(0, 3)
    },
  },
  {
    id: 'query/refetch-triggers-off',
    fix: 'Keep the refetch triggers on and control freshness with `staleTime`. With the triggers off and `staleTime` at 0, data on screen is never refreshed in the background.',
    docs: FOCUS,
    check: (context) => {
      const defaults = facts(context)?.defaults
      if (!defaults || !isZero(defaults.staleTime)) return []
      const off = ['refetchOnWindowFocus', 'refetchOnMount', 'refetchOnReconnect'].filter(
        (name) => defaults[name] === false,
      )
      if (off.length === 0) return []
      return [
        {
          severity: 'info',
          title: 'Refetch triggers are switched off by default while staleTime is 0',
          evidence: [`defaultOptions.queries: ${off.map((name) => `${name}: false`).join(', ')}; staleTime not set`],
          hint: 'The docs allow turning these off. They recommend staleTime as the way to control refetching.',
        },
      ]
    },
  },
  {
    id: 'query/invalidated-cannot-refetch',
    fix: "Enable the query through a real condition instead of `enabled: false`, and use `staleTime: Infinity` in place of `'static'` where a manual invalidation must work. A disabled query ignores `invalidateQueries`, and so does one with `staleTime: 'static'`.",
    docs: DISABLING,
    check: (context) => {
      const known = factsByHash(facts(context))
      const fetches = context.by('query', 'fetch')
      const latest = context.entries.at(-1)?.t ?? 0
      const ignored = context.by('query', 'invalidate').filter((entry) => {
        const query = known.get(entry.key ?? '')
        if (!query || query.observers.length === 0) return false
        const cannot =
          query.disabled ||
          query.options.staleTime === 'static' ||
          query.observers.every((observer) => observer.staleTime === 'static')
        if (!cannot || latest - entry.t < 1000) return false
        return !fetches.some(
          (fetch) => fetch.key === entry.key && fetch.t >= entry.t && fetch.t - entry.t <= 1000,
        )
      })
      if (ignored.length === 0) return []
      return [
        {
          severity: 'warning',
          title: 'A query was invalidated but cannot refetch, so its data stays as it was',
          entries: numbers(ignored),
          evidence: [...new Set(ignored.map((entry) => entry.key ?? ''))]
            .slice(0, 4)
            .map((key) => `${clip(key, 140)}: ${known.get(key)?.disabled ? 'every observer is disabled' : "staleTime is 'static'"}`),
        },
      ]
    },
  },
  {
    id: 'query/paused-while-online',
    fix: "Set `networkMode: 'always'` for queries that do not need the network, or where the browser's online and offline events are unreliable. In the default mode a query waits in `paused` whenever the library believes the app is offline.",
    docs: NETWORK_MODE,
    check: (context) => {
      const { entries, by } = context
      const paused = (facts(context)?.queries ?? []).filter(
        (query) => query.fetchStatus === 'paused',
      )
      if (paused.length === 0) return []
      const latest = entries.at(-1)?.t ?? 0
      const working = by('network', 'ok').filter((entry) => latest - entry.t <= 5000)
      if (working.length === 0) return []
      return [
        {
          severity: 'warning',
          title: `${paused.length} ${paused.length === 1 ? 'query is' : 'queries are'} paused while other requests succeed`,
          entries: numbers(working),
          evidence: paused.slice(0, 4).map((query) => clip(query.queryHash, 140)),
        },
      ]
    },
  },
  {
    id: 'query/infinite-without-max-pages',
    fix: 'Set `maxPages` together with `getNextPageParam` and `getPreviousPageParam`. Without it, every refetch of the query requests all of its pages one after another.',
    docs: INFINITE,
    check: (context) =>
      (facts(context)?.queries ?? [])
        .filter((query) => (query.pages ?? 0) >= 10 && query.options.maxPages === undefined)
        .slice(0, 3)
        .map((query) => ({
          severity: 'info' as const,
          title: `An infinite query holds ${query.pages} pages with no maxPages`,
          evidence: [clip(query.queryHash, 140)],
        })),
  },
  {
    id: 'query/gc-time-zero-ssr',
    fix: 'Do not set `gcTime` to 0 in a server-rendered app. The docs warn that it may result in a hydration error.',
    docs: SSR,
    check: (context) => {
      const setup = facts(context)
      const queries = setup?.queries ?? []
      const preloaded = queries.filter((query) => query.preloaded)
      if (preloaded.length === 0) return []
      const defaultZero = setup!.defaults.gcTime === 0
      const zero = preloaded.filter((query) => query.options.gcTime === 0)
      if (!defaultZero && zero.length === 0) return []
      return [
        {
          severity: 'warning',
          title: 'gcTime is 0 on queries the server render sent',
          evidence: defaultZero
            ? ['defaultOptions.queries.gcTime is 0']
            : zero.slice(0, 4).map((query) => clip(query.queryHash, 140)),
        },
      ]
    },
  },
  {
    id: 'query/client-recreated',
    fix: 'Create the QueryClient once, at module level or with `useState(() => new QueryClient())`. The client holds the cache, so a new one on a render discards everything fetched so far.',
    docs: STABLE_CLIENT,
    check: ({ by, updates: hostUpdates }) => {
      const updates = hostUpdates()
      const unexplained = by('query', 'replaced').filter(
        (e) => !updates.some((u) => u.t <= e.t && e.t - u.t < 5000),
      )
      if (unexplained.length === 0) return []
      return [
        {
          severity: 'warning',
          title: 'The app created a new QueryClient during one page load',
          entries: numbers(unexplained),
          evidence: ['No hot update or reload came before it.'],
        },
      ]
    },
  },
  {
    id: 'query/restarted-on-mount',
    fix: "Nothing to fix if this is development only. A query function that passes `signal` on is cancelled when the query loses its last observer, and React's StrictMode mounts every component twice in development, so a request in flight is aborted and sent again. Production mounts once. If it also happens in a production build, something really is unmounting and remounting the component that reads the query.",
    docs: CANCELLATION,
    check: (context) => {
      const fetches = context.by('query', 'fetch')
      const ends = context.by('query', 'success', 'error')
      const aborted = context.by('network', 'aborted')
      const restarts: Array<{ first: LogEntry; second: LogEntry; request: LogEntry }> = []
      for (const second of fetches) {
        const first = fetches.findLast((entry) => entry.key === second.key && entry.n < second.n)
        if (!first || second.t - first.t > 5000) continue
        // The first fetch never finished: it was replaced, not followed.
        if (ends.some((end) => end.key === second.key && end.n > first.n && end.n < second.n)) continue
        const request = aborted.find((entry) => entry.t >= second.t - 20 && entry.t - second.t <= 100)
        if (request) restarts.push({ first, second, request })
      }
      if (restarts.length === 0) return []
      const wasted = restarts.reduce((sum, restart) => sum + (restart.request.dur ?? 0), 0)
      return [
        {
          severity: 'info',
          title: `${restarts.length} ${restarts.length === 1 ? 'query had its request' : 'queries had their requests'} cancelled and sent again as the component mounted`,
          entries: numbers(restarts.map((restart) => restart.second)),
          evidence: [
            ...restarts
              .slice(-4)
              .map((restart) => `${clip(restart.second.key ?? '', 110)}: cancelled after ${restart.request.dur ?? '?'} ms${where(restart.first)}`),
            `${wasted} ms of requests thrown away in total`,
          ],
          hint: 'Timings measured in development include this. Do not read them as production numbers.',
        },
      ]
    },
  },
  {
    id: 'query/serial-fetches',
    fix: 'If the second query does not need the first one\'s result, hoist it to the parent or prefetch both in the route loader so they run together. If it does need it, the docs suggest an API that returns both, since a dependent query is a request waterfall by definition.',
    docs: WATERFALLS,
    check: (context) => {
      const added = context.by('query', 'added')
      const fetched = context.by('query', 'fetch')
      const chains: Array<{ first: LogEntry; next: LogEntry }> = []
      for (const first of context.by('query', 'success')) {
        if ((first.dur ?? 0) < 100) continue
        const next = added.find(
          (entry) =>
            entry.key !== first.key &&
            entry.t >= first.t &&
            entry.t - first.t <= 50 &&
            fetched.some((fetch) => fetch.key === entry.key && fetch.t - entry.t <= 50 && fetch.n > entry.n),
        )
        // Several queries can finish together; the one that follows is one finding.
        if (next && !chains.some((chain) => chain.next.key === next.key)) {
          chains.push({ first, next })
        }
      }
      return chains.slice(-2).map(({ first, next }) => ({
        severity: 'info' as const,
        title: 'A query started only when another one finished',
        entries: [first.n, next.n],
        evidence: [
          `${clip(first.key ?? '', 110)} took ${first.dur} ms`,
          `then ${clip(next.key ?? '', 110)}${where(next)}`,
        ],
      }))
    },
  },
]

const message = (
  id: string,
  pattern: RegExp,
  severity: KnownMessage['severity'],
  title: string,
  fix: string,
  docs: Reference,
): KnownMessage => ({ id: `query/${id}`, pattern, severity, title, fix, docs })

/** Warnings and errors TanStack Query prints itself, matched on their text. */
export const QUERY_MESSAGES: Array<KnownMessage> = [
  message(
    'data-undefined',
    /Query data cannot be undefined|data is undefined$/,
    'error',
    'A query function resolved to undefined',
    'Return the data from the `queryFn`. To cache "nothing" as a successful result, resolve `null`: a query that resolves to `undefined` is treated as failed.',
    QUERY_FUNCTIONS,
  ),
  message(
    'key-not-array',
    /queryKey needs to be an Array/,
    'error',
    'A query key is not an array',
    "Query keys have to be an array at the top level, such as `['repoData']`.",
    QUERY_KEYS,
  ),
  message(
    'structural-sharing',
    /Structural sharing requires data to be JSON serializable/,
    'warning',
    'Query data is not JSON-compatible, which structural sharing needs',
    'Return JSON-compatible data from the `queryFn`, pass a custom `structuralSharing` function, or set `structuralSharing: false`.',
    DEFAULTS,
  ),
  message(
    'skip-token-refetch',
    /Attempted to invoke queryFn when set to skipToken/,
    'error',
    'A query that uses skipToken was asked to fetch',
    'Use `enabled: false` for a query that is fetched by hand with `refetch()`. A `skipToken` query has no function to run.',
    DISABLING,
  ),
  message(
    'no-query-fn',
    /No queryFn was passed as an option, and no default queryFn was found/,
    'error',
    'A query hook was called without a queryFn',
    'Pass a `queryFn`, or configure a default query function on the QueryClient.',
    guide('default-query-function', 'Default Query Function'),
  ),
  message(
    'suspense-skip-token',
    /skipToken is not allowed for useSuspense/,
    'error',
    'skipToken passed to a suspense query',
    'A suspense query cannot be disabled. Use `useQuery`, or render the component only when the query should run.',
    SUSPENSE,
  ),
  message(
    'enabled-not-boolean',
    /Expected enabled to be a boolean or a callback that returns a boolean/,
    'error',
    '`enabled` received a value that is not a boolean',
    'Coerce it, as the docs do with `enabled: !!userId`.',
    DEPENDENT,
  ),
  message(
    'no-query-client',
    /No QueryClient set, use QueryClientProvider to set one/,
    'error',
    'A query hook rendered outside QueryClientProvider',
    'Wrap the app in `<QueryClientProvider client={queryClient}>`.',
    guide('../quick-start', 'Quick Start'),
  ),
  message(
    'dehydrated-pending-rejected',
    /A query that was dehydrated as pending ended up rejecting/,
    'warning',
    'A query the server started without awaiting it then failed',
    'Await the prefetches the page cannot render without, and handle the errors of the ones that are streamed.',
    SSR,
  ),
]

export const QUERY_SLOW: Array<SlowKind> = [
  { source: 'query', types: ['success', 'error'], floorMs: 1000, label: 'query', plural: 'queries' },
]
