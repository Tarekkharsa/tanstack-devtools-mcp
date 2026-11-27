import { describe, expect, it } from 'vitest'
import { KNOWN_MESSAGES, RULES } from '../src/server/advice.js'
import { diagnose } from '../src/server/diagnose.js'
import type { EntrySource, LogEntry } from '../src/protocol.js'
import type { Facts, QueryFact, RouteFact } from '../src/server/rules.js'

/** Builds a log where each entry sits at an explicit time. */
function log() {
  const entries: Array<LogEntry> = []
  const add = (
    t: number,
    source: EntrySource,
    type: string,
    summary: string,
    extra: Partial<LogEntry> = {},
  ) => {
    entries.push({ n: entries.length + 1, t, source, type, summary, ...extra })
    return add
  }
  return { entries, add }
}

const query = (queryHash: string, over: Partial<QueryFact> = {}): QueryFact => ({
  queryHash,
  family: 'x',
  status: 'success',
  fetchStatus: 'idle',
  stale: true,
  disabled: false,
  hasData: true,
  hasQueryFn: true,
  failures: 0,
  preloaded: false,
  fetches: 0,
  options: {},
  observers: [{}],
  ...over,
})

const match = (
  routeId: string,
  route: Record<string, unknown> = {},
  over: Partial<RouteFact> = {},
): RouteFact => ({
  routeId,
  hasLoaderData: false,
  route: { has: [], ...route } as RouteFact['route'],
  ...over,
})

const routerFacts = (
  options: Record<string, unknown> = {},
  matches: Array<RouteFact> = [],
): NonNullable<Facts['routerFacts']> => ({
  options: { has: [], ...options } as NonNullable<Facts['routerFacts']>['options'],
  contextKeys: [],
  routeCount: matches.length,
  matches,
})

const queryFacts = (
  queries: Array<QueryFact>,
  defaults: Record<string, unknown> = {},
): NonNullable<Facts['queryFacts']> => ({ defaults, queries })

function check(id: string, entries: Array<LogEntry>, facts: Facts | null = null) {
  const rule = RULES.find((candidate) => candidate.id === id)
  if (!rule) throw new Error(`No rule ${id}`)
  return rule.check({
    entries,
    facts,
    by: (source, ...types) =>
      entries.filter((entry) => entry.source === source && types.includes(entry.type)),
  })
}

describe('the catalogue', () => {
  it('gives every rule and message a fix and a source, under a unique id', () => {
    const ids = [...RULES.map((rule) => rule.id), ...KNOWN_MESSAGES.map((message) => message.id)]
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of [...RULES, ...KNOWN_MESSAGES]) {
      expect(item.fix.length, item.id).toBeGreaterThan(40)
      expect(item.docs.label, item.id).not.toBe('')
      expect(item.docs.at, item.id).toMatch(/^(https:\/\/|@[\w-]+\/[\w-]+: )/)
    }
    expect(RULES).toHaveLength(30)
    expect(KNOWN_MESSAGES).toHaveLength(25)
  })
})

describe('TanStack Query rules', () => {
  it('hydrated-refetch: server-rendered data fetched again on load', () => {
    const { entries, add } = log()
    add(1000, 'query', 'attached', '1 queries already in the cache: 1 success')
    add(1200, 'query', 'fetch', '["posts"] refetching', { key: '["posts"]' })
    const stale = { queryFacts: queryFacts([query('["posts"]', { preloaded: true })]) }
    expect(check('query/hydrated-refetch', entries, stale)).toMatchObject([
      { severity: 'warning', evidence: ['["posts"]'] },
    ])

    const fresh = {
      queryFacts: queryFacts([
        query('["posts"]', { preloaded: true, observers: [{ staleTime: 60_000 }] }),
      ]),
    }
    expect(check('query/hydrated-refetch', entries, fresh)).toEqual([])

    // A first fetch of a query the server left pending is not a refetch.
    const pending = log()
    pending.add(1000, 'query', 'attached', '1 queries already in the cache: 1 pending')
    pending.add(1200, 'query', 'fetch', '["posts"] fetching', { key: '["posts"]' })
    expect(check('query/hydrated-refetch', pending.entries, stale)).toEqual([])

    // An invalidation asked for it.
    const asked = log()
    asked.add(1000, 'query', 'attached', '1 queries already in the cache: 1 success')
    asked.add(1100, 'query', 'invalidate', '["posts"] invalidated', { key: '["posts"]' })
    asked.add(1200, 'query', 'fetch', '["posts"] refetching', { key: '["posts"]' })
    expect(check('query/hydrated-refetch', asked.entries, stale)).toEqual([])
  })

  it('fetched-twice: a loader fetch followed by a mount refetch', () => {
    const { entries, add } = log()
    add(1000, 'query', 'fetch', '["post",1] fetching', { key: '["post",1]', at: ['loader src/post.tsx:9:1'] })
    add(1080, 'query', 'success', '["post",1] success', { key: '["post",1]', dur: 80 })
    add(1300, 'query', 'fetch', '["post",1] refetching', { key: '["post",1]', at: ['Post src/post.tsx:20:3'] })
    const facts = { queryFacts: queryFacts([query('["post",1]')]) }
    const [finding] = check('query/fetched-twice', entries, facts)
    expect(finding).toMatchObject({ severity: 'warning', entries: [1, 3] })
    expect(finding!.evidence).toEqual([
      '["post",1]',
      'first fetch — from loader src/post.tsx:9:1',
      'second fetch — from Post src/post.tsx:20:3',
    ])

    const withStaleTime = {
      queryFacts: queryFacts([query('["post",1]', { observers: [{ staleTime: 5000 }] })]),
    }
    expect(check('query/fetched-twice', entries, withStaleTime)).toEqual([])

    const late = log()
    late.add(1000, 'query', 'fetch', '["post",1] fetching', { key: '["post",1]' })
    late.add(1080, 'query', 'success', '["post",1] success', { key: '["post",1]', dur: 80 })
    late.add(9000, 'query', 'fetch', '["post",1] refetching', { key: '["post",1]' })
    expect(check('query/fetched-twice', late.entries, facts)).toEqual([])
  })

  it('http-error-cached-as-success: a failed request inside a query that succeeded', () => {
    const { entries, add } = log()
    add(1000, 'query', 'fetch', '["user"] fetching', { key: '["user"]' })
    add(1100, 'network', 'error', 'GET /api/user → 500', { key: '/api/user', dur: 90 })
    add(1105, 'query', 'success', '["user"] success', { key: '["user"]', dur: 105 })
    expect(check('query/http-error-cached-as-success', entries)).toMatchObject([
      { severity: 'warning', entries: [2, 3], evidence: ['GET /api/user → 500', '["user"]'] },
    ])

    // A retry that then succeeded is the library working as designed.
    const retried = log()
    retried.add(1000, 'query', 'fetch', '["user"] fetching', { key: '["user"]' })
    retried.add(1100, 'network', 'error', 'GET /api/user → 500', { key: '/api/user', dur: 90 })
    retried.add(1101, 'query', 'failed', '["user"] failed: Error: 500', { key: '["user"]' })
    retried.add(1160, 'query', 'success', '["user"] success', { key: '["user"]', dur: 160 })
    expect(check('query/http-error-cached-as-success', retried.entries)).toEqual([])

    // Two queries in flight: no way to say whose request it was.
    const two = log()
    two.add(1000, 'query', 'fetch', '["a"] fetching', { key: '["a"]' })
    two.add(1001, 'query', 'fetch', '["b"] fetching', { key: '["b"]' })
    two.add(1100, 'network', 'error', 'GET /api/a → 500', { key: '/api/a', dur: 90 })
    two.add(1105, 'query', 'success', '["a"] success', { key: '["a"]', dur: 105 })
    two.add(1106, 'query', 'success', '["b"] success', { key: '["b"]', dur: 105 })
    expect(check('query/http-error-cached-as-success', two.entries)).toEqual([])

    const threw = log()
    threw.add(1000, 'query', 'fetch', '["user"] fetching', { key: '["user"]' })
    threw.add(1100, 'network', 'error', 'GET /api/user → 500', { key: '/api/user', dur: 90 })
    threw.add(1105, 'query', 'error', '["user"] error: Error: 500', { key: '["user"]', dur: 105 })
    expect(check('query/http-error-cached-as-success', threw.entries)).toEqual([])
  })

  it('refetching-stale-at-once: many fetches with no staleTime', () => {
    const { entries, add } = log()
    for (let index = 0; index < 5; index++) {
      add(1000 + index * 8000, 'query', 'fetch', '["rates"] refetching', { key: '["rates"]' })
    }
    const facts = { queryFacts: queryFacts([query('["rates"]')]) }
    expect(check('query/refetching-stale-at-once', entries, facts)).toMatchObject([
      { title: 'A query with no staleTime fetched 5 times in a minute' },
    ])
    const polling = {
      queryFacts: queryFacts([query('["rates"]', { observers: [{ refetchInterval: 8000 }] })]),
    }
    expect(check('query/refetching-stale-at-once', entries, polling)).toEqual([])
    const fresh = { queryFacts: queryFacts([query('["rates"]', { options: { staleTime: 30_000 }, observers: [] })]) }
    expect(check('query/refetching-stale-at-once', entries, fresh)).toEqual([])
  })

  it('refetch-triggers-off: triggers disabled while staleTime is 0', () => {
    const off = { queryFacts: queryFacts([], { refetchOnWindowFocus: false }) }
    expect(check('query/refetch-triggers-off', [], off)).toMatchObject([{ severity: 'info' }])
    const tuned = { queryFacts: queryFacts([], { refetchOnWindowFocus: false, staleTime: 30_000 }) }
    expect(check('query/refetch-triggers-off', [], tuned)).toEqual([])
    expect(check('query/refetch-triggers-off', [], { queryFacts: queryFacts([]) })).toEqual([])
  })

  it('invalidated-cannot-refetch: invalidating a disabled or static query', () => {
    const { entries, add } = log()
    add(1000, 'query', 'invalidate', '["me"] invalidated', { key: '["me"]' })
    add(3000, 'console', 'warn', 'later')
    const disabled = { queryFacts: queryFacts([query('["me"]', { disabled: true })]) }
    expect(check('query/invalidated-cannot-refetch', entries, disabled)).toMatchObject([
      { evidence: ['["me"]: every observer is disabled'] },
    ])
    const isStatic = { queryFacts: queryFacts([query('["me"]', { options: { staleTime: 'static' } })]) }
    expect(check('query/invalidated-cannot-refetch', entries, isStatic)).toMatchObject([
      { evidence: ['["me"]: staleTime is \'static\''] },
    ])
    expect(check('query/invalidated-cannot-refetch', entries, { queryFacts: queryFacts([query('["me"]')]) })).toEqual([])

    const refetched = log()
    refetched.add(1000, 'query', 'invalidate', '["me"] invalidated', { key: '["me"]' })
    refetched.add(1040, 'query', 'fetch', '["me"] refetching', { key: '["me"]' })
    refetched.add(3000, 'console', 'warn', 'later')
    expect(check('query/invalidated-cannot-refetch', refetched.entries, disabled)).toEqual([])
  })

  it('paused-while-online: paused queries while requests succeed', () => {
    const { entries, add } = log()
    add(1000, 'network', 'ok', 'GET /api/x → 200', { dur: 30 })
    const paused = { queryFacts: queryFacts([query('["sync"]', { fetchStatus: 'paused' })]) }
    expect(check('query/paused-while-online', entries, paused)).toMatchObject([
      { title: '1 query is paused while other requests succeed' },
    ])
    expect(check('query/paused-while-online', [], paused)).toEqual([])
    expect(check('query/paused-while-online', entries, { queryFacts: queryFacts([query('["sync"]')]) })).toEqual([])
  })

  it('infinite-without-max-pages, gc-time-zero-ssr', () => {
    const many = { queryFacts: queryFacts([query('["feed"]', { pages: 12 })]) }
    expect(check('query/infinite-without-max-pages', [], many)).toMatchObject([
      { title: 'An infinite query holds 12 pages with no maxPages' },
    ])
    const capped = { queryFacts: queryFacts([query('["feed"]', { pages: 12, options: { maxPages: 5 } })]) }
    expect(check('query/infinite-without-max-pages', [], capped)).toEqual([])

    const zero = { queryFacts: queryFacts([query('["a"]', { preloaded: true })], { gcTime: 0 }) }
    expect(check('query/gc-time-zero-ssr', [], zero)).toMatchObject([
      { evidence: ['defaultOptions.queries.gcTime is 0'] },
    ])
    // Without a server render, gcTime 0 is a choice, not a hazard.
    const spa = { queryFacts: queryFacts([query('["a"]')], { gcTime: 0 }) }
    expect(check('query/gc-time-zero-ssr', [], spa)).toEqual([])
  })

  it('client-recreated: a new QueryClient with no hot update to explain it', () => {
    const { entries, add } = log()
    add(1000, 'query', 'replaced', 'the app created a new QueryClient')
    expect(check('query/client-recreated', entries)).toHaveLength(1)
    const hot = log()
    hot.add(900, 'vite', 'hmr-update', 'hot update: src/main.tsx')
    hot.add(1000, 'query', 'replaced', 'the app created a new QueryClient')
    expect(check('query/client-recreated', hot.entries)).toEqual([])
  })

  it('restarted-on-mount: a request in flight cancelled and sent again', () => {
    const { entries, add } = log()
    add(1000, 'query', 'fetch', '["offers",7] fetching', { key: '["offers",7]', at: ['prefetch src/lib/prefetch.ts:9:1'] })
    add(1380, 'query', 'fetch', '["offers",7] fetching', { key: '["offers",7]' })
    add(1386, 'network', 'aborted', 'GET /api/offers/7 → aborted', { dur: 385 })
    add(3070, 'network', 'ok', 'GET /api/offers/7 → 200', { dur: 1686 })
    add(3071, 'query', 'success', '["offers",7] success', { key: '["offers",7]', dur: 1694 })
    expect(check('query/restarted-on-mount', entries)).toMatchObject([
      {
        severity: 'info',
        title: '1 query had its request cancelled and sent again as the component mounted',
        entries: [2],
        evidence: [
          '["offers",7]: cancelled after 385 ms — from prefetch src/lib/prefetch.ts:9:1',
          '385 ms of requests thrown away in total',
        ],
      },
    ])

    // A fetch, its result, then a refetch: nothing was cancelled.
    const normal = log()
    normal.add(1000, 'query', 'fetch', '["a"] fetching', { key: '["a"]' })
    normal.add(1200, 'query', 'success', '["a"] success', { key: '["a"]', dur: 200 })
    normal.add(1300, 'query', 'fetch', '["a"] refetching', { key: '["a"]' })
    normal.add(1305, 'network', 'aborted', 'GET /other → aborted', { dur: 5 })
    expect(check('query/restarted-on-mount', normal.entries)).toEqual([])

    // Two fetch events with no cancelled request: a retry, not a restart.
    const retry = log()
    retry.add(1000, 'query', 'fetch', '["a"] fetching', { key: '["a"]' })
    retry.add(1400, 'query', 'fetch', '["a"] fetching', { key: '["a"]' })
    expect(check('query/restarted-on-mount', retry.entries)).toEqual([])
  })

  it('serial-fetches: one query starting as another finishes', () => {
    const { entries, add } = log()
    add(1300, 'query', 'success', '["article"] success', { key: '["article"]', dur: 300 })
    add(1310, 'query', 'added', '["comments"] added', { key: '["comments"]', at: ['Comments src/c.tsx:4:1'] })
    add(1312, 'query', 'fetch', '["comments"] fetching', { key: '["comments"]' })
    expect(check('query/serial-fetches', entries)).toMatchObject([
      {
        severity: 'info',
        evidence: ['["article"] took 300 ms', 'then ["comments"] — from Comments src/c.tsx:4:1'],
      },
    ])
    // Two queries finishing together before the same follower: one finding.
    const together = log()
    together.add(1300, 'query', 'success', '["a"] success', { key: '["a"]', dur: 300 })
    together.add(1301, 'query', 'success', '["b"] success', { key: '["b"]', dur: 300 })
    together.add(1310, 'query', 'added', '["c"] added', { key: '["c"]' })
    together.add(1312, 'query', 'fetch', '["c"] fetching', { key: '["c"]' })
    expect(check('query/serial-fetches', together.entries)).toHaveLength(1)

    const quick = log()
    quick.add(1300, 'query', 'success', '["article"] success', { key: '["article"]', dur: 20 })
    quick.add(1310, 'query', 'added', '["comments"] added', { key: '["comments"]' })
    quick.add(1312, 'query', 'fetch', '["comments"] fetching', { key: '["comments"]' })
    expect(check('query/serial-fetches', quick.entries)).toEqual([])
  })
})

describe('TanStack Router rules', () => {
  it('preload-cache-with-query: preloading on, defaultPreloadStaleTime not 0', () => {
    const facts = (options: Record<string, unknown>, withQuery = true): Facts => ({
      routerFacts: routerFacts(options),
      queryFacts: withQuery ? queryFacts([]) : null,
    })
    expect(check('router/preload-cache-with-query', [], facts({ defaultPreload: 'intent' }))).toMatchObject([
      { evidence: ['defaultPreload: "intent", defaultPreloadStaleTime: not set (30 s)'] },
    ])
    expect(
      check('router/preload-cache-with-query', [], facts({ defaultPreload: 'intent', defaultPreloadStaleTime: 0 })),
    ).toEqual([])
    expect(check('router/preload-cache-with-query', [], facts({ defaultPreload: false }))).toEqual([])
    expect(check('router/preload-cache-with-query', [], facts({ defaultPreload: 'intent' }, false))).toEqual([])
  })

  it('no-not-found-component, no-error-component, not-found-route', () => {
    const bare = { routerFacts: routerFacts({}, [match('__root__')]) }
    expect(check('router/no-not-found-component', [], bare)).toHaveLength(1)
    expect(check('router/no-error-component', [], bare)).toHaveLength(1)
    expect(check('router/not-found-route', [], bare)).toEqual([])

    const onRouter = {
      routerFacts: routerFacts({ has: ['defaultNotFoundComponent', 'defaultErrorComponent'] }, [match('__root__')]),
    }
    expect(check('router/no-not-found-component', [], onRouter)).toEqual([])
    expect(check('router/no-error-component', [], onRouter)).toEqual([])

    const onRoot = {
      routerFacts: routerFacts({}, [match('__root__', { has: ['notFoundComponent', 'errorComponent'] })]),
    }
    expect(check('router/no-not-found-component', [], onRoot)).toEqual([])
    expect(check('router/no-error-component', [], onRoot)).toEqual([])

    const legacy = { routerFacts: routerFacts({ has: ['notFoundRoute'] }, [match('__root__')]) }
    expect(check('router/not-found-route', [], legacy)).toHaveLength(1)
  })

  it('loader-deps-whole-search, leftover-react-router', () => {
    const whole = { routerFacts: routerFacts({}, [match('/list', {}, { loaderDepsIsSearch: true })]) }
    expect(check('router/loader-deps-whole-search', [], whole)).toMatchObject([
      { evidence: ["/list: loaderDeps equals the route's full search"] },
    ])
    expect(check('router/loader-deps-whole-search', [], { routerFacts: routerFacts({}, [match('/list')]) })).toEqual([])

    const mixed = { routerFacts: routerFacts(), modules: ['react-router-dom'] }
    expect(check('router/leftover-react-router', [], mixed)).toMatchObject([
      { evidence: ['Loaded: react-router-dom'] },
    ])
    expect(check('router/leftover-react-router', [], { routerFacts: routerFacts(), modules: [] })).toEqual([])
  })

  it('recreated: a new router with no hot update to explain it', () => {
    const { entries, add } = log()
    add(1000, 'router', 'replaced', 'the app created a new router instance')
    expect(check('router/recreated', entries)).toHaveLength(1)
    const hot = log()
    hot.add(900, 'vite', 'full-reload', 'full reload')
    hot.add(1000, 'router', 'replaced', 'the app created a new router instance')
    expect(check('router/recreated', hot.entries)).toEqual([])
  })

  it('redirect-after-render: a page rendered, then the app left at once', () => {
    const build = (guarded: boolean, nextKey: string, gap: number) => {
      const { entries, add } = log()
      add(1000, 'router', 'onBeforeNavigate', '/ → /admin', { key: '/admin' })
      add(1100, 'router', 'onResolved', '/ → /admin', { key: '/admin', detail: { guarded } })
      add(1100 + gap, 'router', 'onBeforeNavigate', '/admin → /login', { key: nextKey })
      return entries
    }
    expect(check('router/redirect-after-render', build(false, '/login', 80))).toMatchObject([
      { severity: 'info', entries: [2] },
    ])
    expect(check('router/redirect-after-render', build(true, '/login', 80))).toEqual([])
    expect(check('router/redirect-after-render', build(false, '/login', 2000))).toEqual([])
    expect(check('router/redirect-after-render', build(false, '/admin', 80))).toEqual([])
  })

  it('fetch-after-render: a query that starts only once the route is on screen', () => {
    const build = (summary: string) => {
      const { entries, add } = log()
      add(1000, 'router', 'onBeforeNavigate', summary, { key: '/b' })
      add(1100, 'router', 'onResolved', summary, { key: '/b' })
      add(1150, 'query', 'added', '["b"] added', { key: '["b"]', at: ['B src/b.tsx:5:1'] })
      add(1152, 'query', 'fetch', '["b"] fetching', { key: '["b"]' })
      return entries
    }
    expect(check('router/fetch-after-render', build('/a → /b'))).toMatchObject([
      { evidence: ['/a → /b', '["b"] — from B src/b.tsx:5:1'] },
    ])
    // The first load of a page is not a navigation the app controlled.
    expect(check('router/fetch-after-render', build('(initial) → /b'))).toEqual([])

    const inLoader = log()
    inLoader.add(1000, 'router', 'onBeforeNavigate', '/a → /b', { key: '/b' })
    inLoader.add(1010, 'query', 'added', '["b"] added', { key: '["b"]' })
    inLoader.add(1012, 'query', 'fetch', '["b"] fetching', { key: '["b"]' })
    inLoader.add(1100, 'router', 'onResolved', '/a → /b', { key: '/b' })
    expect(check('router/fetch-after-render', inLoader.entries)).toEqual([])
  })

  it('loader-refetch-blocks: a loader waiting on data it already had', () => {
    const build = (invalidatedAt?: number) => {
      const { entries, add } = log()
      if (invalidatedAt !== undefined) {
        add(invalidatedAt, 'query', 'invalidate', '["a"] invalidated', { key: '["a"]' })
      }
      add(1000, 'router', 'onBeforeNavigate', '/ → /a', { key: '/a' })
      add(1010, 'query', 'fetch', '["a"] refetching', { key: '["a"]' })
      add(1300, 'router', 'onLoad', '/ → /a', { key: '/a' })
      add(1310, 'router', 'onResolved', '/ → /a', { key: '/a' })
      return entries
    }
    expect(check('router/loader-refetch-blocks', build())).toMatchObject([
      { evidence: ['/ → /a (300 ms in loaders)', '["a"]'] },
    ])
    expect(check('router/loader-refetch-blocks', build(900))).toEqual([])
  })

  it('unhandled-background-query: a query error that surfaced as an unhandled rejection', () => {
    const build = (gap: number) => {
      const { entries, add } = log()
      add(1000, 'query', 'error', '["stats"] error: Error: boom', { key: '["stats"]' })
      add(1000 + gap, 'console', 'unhandledrejection', 'Error: boom')
      return entries
    }
    expect(check('router/unhandled-background-query', build(5))).toHaveLength(1)
    expect(check('router/unhandled-background-query', build(900))).toEqual([])
  })
})

describe('TanStack Start and Vite rules', () => {
  it('ssr-loosened-by-child', () => {
    const branch = (child: unknown) => ({
      routerFacts: routerFacts({}, [match('__root__'), match('/app', { ssr: false }), match('/app/x', { ssr: child })]),
    })
    expect(check('start/ssr-loosened-by-child', [], branch(true))).toMatchObject([
      { evidence: ['/app/x has ssr: true; /app has ssr: false'] },
    ])
    expect(check('start/ssr-loosened-by-child', [], branch(false))).toEqual([])
    expect(check('start/ssr-loosened-by-child', [], branch(undefined))).toEqual([])
  })

  it('loader-self-fetch: only in an app that has server functions', () => {
    const build = (withServerFn: boolean, requestEnd: number) => {
      const { entries, add } = log()
      if (withServerFn) add(500, 'network', 'ok', 'GET serverFn getMe → 200', { key: 'serverFn:getMe', dur: 20 })
      add(1000, 'router', 'onBeforeNavigate', '/ → /items', { key: '/items' })
      add(requestEnd, 'network', 'ok', 'GET /api/items → 200', { key: '/api/items', dur: 100 })
      add(1200, 'router', 'onLoad', '/ → /items', { key: '/items' })
      return entries
    }
    expect(check('start/loader-self-fetch', build(true, 1120))).toMatchObject([
      { severity: 'info', evidence: ['GET /api/items'] },
    ])
    expect(check('start/loader-self-fetch', build(false, 1120))).toEqual([])
    // Started after the loaders had finished: an event handler's fetch.
    expect(check('start/loader-self-fetch', build(true, 5000))).toEqual([])
  })

  it('serial-server-functions: calls that never overlap', () => {
    const { entries, add } = log()
    add(1100, 'network', 'ok', 'GET serverFn getUser → 200', { key: 'serverFn:getUser', dur: 100 })
    add(1210, 'network', 'ok', 'GET serverFn getOrders → 200', { key: 'serverFn:getOrders', dur: 100 })
    expect(check('start/serial-server-functions', entries)).toMatchObject([
      { title: '2 server functions ran one after another, 210 ms in total' },
    ])
    const parallel = log()
    parallel.add(1100, 'network', 'ok', 'GET serverFn getUser → 200', { key: 'serverFn:getUser', dur: 100 })
    parallel.add(1110, 'network', 'ok', 'GET serverFn getOrders → 200', { key: 'serverFn:getOrders', dur: 100 })
    expect(check('start/serial-server-functions', parallel.entries)).toEqual([])
  })

  it('slow-navigation-no-pending', () => {
    const build = (dur: number, pendingUi: boolean) => {
      const { entries, add } = log()
      add(3000, 'router', 'onResolved', '/ → /report', { dur, detail: { pendingUi } })
      return entries
    }
    expect(check('start/slow-navigation-no-pending', build(1800, false))).toMatchObject([
      { title: 'A navigation took 1800 ms with no pending component to show' },
    ])
    expect(check('start/slow-navigation-no-pending', build(1800, true))).toEqual([])
    expect(check('start/slow-navigation-no-pending', build(400, false))).toEqual([])
  })

  it('fast-refresh-defeated, full-reload-for-component, header-too-large', () => {
    const refresh = log()
    refresh.add(1000, 'vite', 'invalidate', 'src/Card.tsx could not be updated in place: Could not Fast Refresh ("useCard" export is incompatible).', { key: 'src/Card.tsx' })
    expect(check('vite/fast-refresh-defeated', refresh.entries)).toMatchObject([
      { severity: 'warning', title: 'Fast Refresh could not update a module in place' },
    ])
    expect(check('vite/fast-refresh-defeated', [])).toEqual([])

    const reloads = log()
    reloads.add(1000, 'vite', 'full-reload', 'full reload triggered by src/Menu.tsx', { key: 'src/Menu.tsx' })
    expect(check('vite/full-reload-for-component', reloads.entries)).toEqual([])
    reloads.add(9000, 'vite', 'full-reload', 'full reload triggered by src/Menu.tsx', { key: 'src/Menu.tsx' })
    expect(check('vite/full-reload-for-component', reloads.entries)).toMatchObject([
      { evidence: ['src/Menu.tsx: 2 full reloads'] },
    ])
    const data = log()
    data.add(1000, 'vite', 'full-reload', 'full reload triggered by src/config.ts', { key: 'src/config.ts' })
    data.add(2000, 'vite', 'full-reload', 'full reload triggered by src/config.ts', { key: 'src/config.ts' })
    expect(check('vite/full-reload-for-component', data.entries)).toEqual([])

    const big = log()
    big.add(1000, 'network', 'error', 'GET /api/me → 431', { dur: 5 })
    expect(check('vite/header-too-large', big.entries)).toHaveLength(1)
    const other = log()
    other.add(1000, 'network', 'error', 'GET /api/me → 500', { dur: 5 })
    expect(check('vite/header-too-large', other.entries)).toEqual([])
  })
})

describe('messages the libraries print', () => {
  // The texts are the ones in the libraries' installed source.
  const samples: Array<[id: string, text: string]> = [
    ['query/data-undefined', 'Query data cannot be undefined. Please make sure to return a value other than undefined from your query function. Affected query key: ["todos"]'],
    ['query/key-not-array', "As of v4, queryKey needs to be an Array. If you are using a string like 'repoData', please change it to an Array, e.g. ['repoData']"],
    ['query/structural-sharing', 'Structural sharing requires data to be JSON serializable. To fix this, turn off structuralSharing or return JSON-serializable data from your queryFn. [["a"]]: Error'],
    ['query/skip-token-refetch', "Attempted to invoke queryFn when set to skipToken. This is likely a configuration error. Query hash: '[\"a\"]'"],
    ['query/no-query-fn', '[["a"]]: No queryFn was passed as an option, and no default queryFn was found. The queryFn parameter is only optional when using a default queryFn.'],
    ['query/suspense-skip-token', 'skipToken is not allowed for useSuspenseQuery'],
    ['query/enabled-not-boolean', 'Error: Expected enabled to be a boolean or a callback that returns a boolean'],
    ['query/no-query-client', 'Error: No QueryClient set, use QueryClientProvider to set one'],
    ['query/dehydrated-pending-rejected', 'A query that was dehydrated as pending ended up rejecting. [["a"]]: Error: x; The error will be redacted in production builds'],
    ['router/uncaught-by-route', "Warning: The following error wasn't caught by any route! At the very least, consider setting an 'errorComponent' in your RootRoute!"],
    ['router/generic-not-found', 'Warning: A notFoundError was encountered on the route with ID "/x", but a notFoundComponent option was not configured, nor was a router level defaultNotFoundComponent configured.'],
    ['router/not-found-route-deprecated', 'The notFoundRoute API is deprecated and will be removed in the next major version.'],
    ['router/route-match-error', 'Warning: Error in route match: /posts/$postId/posts/99'],
    ['router/outside-provider', 'Warning: useRouter must be used inside a <RouterProvider> component!'],
    ['router/no-active-match', 'Invariant failed: Could not find an active match from "/posts"'],
    ['router/navigate-from', 'Could not find match for from: /posts'],
    ['router/scroll-restoration-deprecated', "The ScrollRestoration component is deprecated. Use createRouter's `scrollRestoration` option instead."],
    ['router/dangerous-protocol', 'Blocked Link with dangerous protocol: javascript:alert(1)'],
    ['start/server-import-on-client', '[import-protection] Mocked import used in dev client'],
    ['start/env-only-fn-wrong-side', 'Error: createServerOnlyFn() functions can only be called on the server!'],
    ['start/form-data-get', 'Error: FormData is not supported with GET requests'],
    ['start/middleware-no-next', 'User middleware returned undefined. You must call next() or return a result in your middlewares.'],
    ['start/missing-scripts', 'TanStack Start React dev mode requires the React Refresh runtime, but /@react-refresh could not be resolved.'],
    ['vite/node-builtin-in-browser', 'Module "fs" has been externalized for browser compatibility. Cannot access "fs.readFile" in client code.'],
    ['vite/header-too-large-message', 'Server responded with status code 431.'],
  ]

  it('has a sample for every known message', () => {
    expect(samples.map(([id]) => id).sort()).toEqual(KNOWN_MESSAGES.map((m) => m.id).sort())
  })

  it.each(samples)('%s is recognised, by that rule only', (id, text) => {
    const hits = KNOWN_MESSAGES.filter((message) => message.pattern.test(text)).map((m) => m.id)
    expect(hits).toEqual([id])
  })

  it('replaces the plain console finding with the documented one', () => {
    const { entries, add } = log()
    add(1000, 'console', 'error', samples[0]![1], { at: ['loadTodos src/todos.ts:4:9'] })
    const { ok, findings } = diagnose(entries, null)
    expect(ok).toBe(false)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'query/data-undefined',
      severity: 'error',
      title: 'A query function resolved to undefined',
      entries: [1],
      docs: {
        label: 'TanStack Query docs: Query Functions',
        at: 'https://tanstack.com/query/latest/docs/framework/react/guides/query-functions',
      },
    })
    expect(findings[0]!.fix).toMatch(/resolve `null`/)
    expect(findings[0]!.evidence[0]).toMatch(/ — from loadTodos src\/todos\.ts:4:9$/)
  })

  it('keeps the plain console finding for messages it does not know', () => {
    const { entries, add } = log()
    add(1000, 'console', 'error', 'socket closed')
    add(1100, 'console', 'error', samples[0]![1])
    const titles = diagnose(entries, null).findings.map((finding) => finding.title)
    expect(titles).toEqual([
      'A query function resolved to undefined',
      'console.error called with 2 distinct messages',
    ])
  })

  it('gives a hydration mismatch its documented fix', () => {
    const { entries, add } = log()
    add(1000, 'console', 'error', "Hydration failed because the server rendered HTML didn't match the client.")
    const [finding] = diagnose(entries, null).findings
    expect(finding).toMatchObject({
      rule: 'start/hydration-mismatch',
      docs: { at: '@tanstack/start-client-core: skills/start-core/execution-model/SKILL.md' },
    })
    expect(finding!.fix).toMatch(/useHydrated\(\)/)
  })

  it('lets the documented cause stand in for the plain loop finding', () => {
    const { entries, add } = log()
    for (let index = 0; index < 5; index++) {
      add(1000 + index * 1000, 'query', 'fetch', '["rates"] refetching', { key: '["rates"]' })
    }
    const facts = { queryFacts: queryFacts([query('["rates"]')]) }
    const titles = diagnose(entries, facts).findings.map((finding) => finding.title)
    expect(titles).toEqual(['A query with no staleTime fetched 5 times in a minute'])
    // With no facts about the query, the plain finding is all there is.
    expect(diagnose(entries, null).findings.map((finding) => finding.title)).toEqual([
      'A query fetched 5 times within 10 s',
    ])
  })
})
