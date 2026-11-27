import { clip, numbers, where } from '@loopsight/core/server'
import type {
  KnownMessage,
  LogEntry,
  Reference,
  Rule,
  RuleContext,
  SlowKind,
} from '@loopsight/core/server'

/** One matched route, as the page half reports it for these rules. */
export interface RouteFact {
  routeId: string
  status?: string
  cause?: string
  preload?: boolean
  error?: string
  hasLoaderData: boolean
  loaderDepsIsSearch?: boolean
  searchError?: string
  route: Record<string, unknown> & { has: Array<string> }
}

/** How the router and its matched routes are set up. */
export interface RouterFacts {
  options: Record<string, unknown> & { has: Array<string> }
  contextKeys: Array<string>
  routeCount: number
  matches: Array<RouteFact>
  /** Other routers the page has loaded. */
  modules?: Array<string>
}

const KEY = 'router'
const facts = (context: RuleContext) => context.facts<RouterFacts>(KEY)
const detailOf = <T,>(entry: LogEntry) => (entry.detail ?? {}) as T

/**
 * Rules from the agent skills TanStack Router ships inside its packages.
 * Each `fix` restates what the cited skill says; nothing here is advice of
 * this package's own.
 */

const skill = (pkg: string, path: string, label: string): Reference => ({
  label: `TanStack Router skill: ${label}`,
  at: `${pkg}: skills/${path}/SKILL.md`,
})
const ROUTER_QUERY = skill('@tanstack/react-router', 'compositions/router-query', 'Router with Query')
const REACT_ROUTER = skill('@tanstack/react-router', 'react-router', 'React Router bindings')
const MIGRATE = skill('@tanstack/react-router', 'lifecycle/migrate-from-react-router', 'migrating from React Router')
const DATA_LOADING = skill('@tanstack/router-core', 'router-core/data-loading', 'data loading')
const ERRORS = skill('@tanstack/router-core', 'router-core/not-found-and-errors', 'not found and errors')
const GUARDS = skill('@tanstack/router-core', 'router-core/auth-and-guards', 'auth and guards')
const NAVIGATION = skill('@tanstack/router-core', 'router-core/navigation', 'navigation')

/** A navigation is the entries from onBeforeNavigate to its onResolved. */
function navigations(context: Parameters<Rule['check']>[0]) {
  const events = context.by('router', 'onBeforeNavigate', 'onBeforeLoad', 'onLoad', 'onResolved')
  const out: Array<{ start: number; loaded?: number; resolved?: number; end: (typeof events)[number] }> = []
  let start: number | undefined
  let loaded: number | undefined
  for (const event of events) {
    if (event.type === 'onBeforeNavigate') {
      start = event.t
      loaded = undefined
    } else if (event.type === 'onLoad') {
      loaded = event.t
    } else if (event.type === 'onResolved' && start !== undefined) {
      out.push({ start, ...(loaded !== undefined ? { loaded } : {}), resolved: event.t, end: event })
      start = undefined
    }
  }
  return out
}

export const ROUTER_RULES: Array<Rule> = [
  {
    id: 'router/match-error',
    check: ({ overview }) => {
      const error = overview<{ error?: string }>(KEY)?.error
      if (!error) return []
      return [
        {
          severity: 'error',
          title: 'A matched route is showing an error',
          evidence: [clip(error)],
        },
      ]
    },
  },
  {
    id: 'router/preload-cache-with-query',
    fix: "Set `defaultPreloadStaleTime: 0` in createRouter. Without it, Router's own preload cache (30 s by default) answers a preloaded route, and Query never gets to decide whether the data is fresh.",
    docs: ROUTER_QUERY,
    check: (context) => {
      const router = facts(context)
      const options = router?.options
      // Only when the app also uses TanStack Query, as that source reports.
      if (!options || context.facts('query') === undefined) return []
      if (options.defaultPreloadStaleTime === 0) return []
      const preloads =
        (options.defaultPreload !== undefined && options.defaultPreload !== false) ||
        router!.matches.some((match) => match.preload)
      if (!preloads) return []
      return [
        {
          severity: 'warning',
          title: "Router's preload cache is on while the app uses TanStack Query",
          evidence: [
            `defaultPreload: ${JSON.stringify(options.defaultPreload)}, defaultPreloadStaleTime: ${options.defaultPreloadStaleTime === undefined ? 'not set (30 s)' : JSON.stringify(options.defaultPreloadStaleTime)}`,
          ],
        },
      ]
    },
  },
  {
    id: 'router/no-not-found-component',
    fix: 'Set `notFoundComponent` on the root route, or `defaultNotFoundComponent` in createRouter.',
    docs: ERRORS,
    check: (context) => {
      const router = facts(context)
      const root = router?.matches.find((match) => match.routeId === '__root__')
      if (!router || !root) return []
      if (router.options.has.includes('defaultNotFoundComponent')) return []
      if (root.route.has.includes('notFoundComponent')) return []
      return [
        {
          severity: 'info',
          title: 'No not-found component: a missing page shows the bare "Not Found" fallback',
          evidence: ['Neither the root route nor the router defines one.'],
        },
      ]
    },
  },
  {
    id: 'router/no-error-component',
    fix: 'Set `errorComponent` on the root route, or `defaultErrorComponent` in createRouter, with a retry that calls `router.invalidate()`.',
    docs: ERRORS,
    check: (context) => {
      const router = facts(context)
      const root = router?.matches.find((match) => match.routeId === '__root__')
      if (!router || !root) return []
      if (router.options.has.includes('defaultErrorComponent')) return []
      if (root.route.has.includes('errorComponent')) return []
      return [
        {
          severity: 'info',
          title: 'No error component at the root or router level',
          evidence: ['A loader or render error with no route boundary falls through to the global one.'],
        },
      ]
    },
  },
  {
    id: 'router/not-found-route',
    fix: 'Remove `notFoundRoute` and put `notFoundComponent` on the root route. While it is present, `notFound()` and `notFoundComponent` do not work.',
    docs: ERRORS,
    check: (context) =>
      facts(context)?.options.has.includes('notFoundRoute')
        ? [
            {
              severity: 'warning',
              title: 'The router is configured with the deprecated `notFoundRoute`',
              evidence: ['router.options.notFoundRoute is set.'],
            },
          ]
        : [],
  },
  {
    id: 'router/loader-deps-whole-search',
    fix: 'Return only the keys the loader uses, for example `loaderDeps: ({ search }) => ({ page: search.page })`. Returning the whole object reloads on every unrelated search change.',
    docs: DATA_LOADING,
    check: (context) =>
      (facts(context)?.matches ?? [])
        .filter((match) => match.loaderDepsIsSearch)
        .map((match) => ({
          severity: 'warning' as const,
          title: 'A route passes its whole search object as `loaderDeps`',
          evidence: [`${match.routeId}: loaderDeps equals the route's full search`],
          hint: 'This is right only if the loader really reads every search param.',
        })),
  },
  {
    id: 'router/recreated',
    fix: "Create the router once with a placeholder context and pass live values through `<RouterProvider router={router} context={{ auth }} />`. Recreating it resets its caches and rebuilds the route tree.",
    docs: REACT_ROUTER,
    check: ({ by, updates: hostUpdates }) => {
      // A hot update or reload legitimately builds a new router.
      const updates = hostUpdates()
      const unexplained = by('router', 'replaced').filter(
        (e) => !updates.some((u) => u.t <= e.t && e.t - u.t < 5000),
      )
      if (unexplained.length === 0) return []
      return [
        {
          severity: 'warning',
          title: `The app created a new router ${unexplained.length === 1 ? 'instance' : `instance ${unexplained.length} times`} during one page load`,
          entries: numbers(unexplained),
          evidence: ['No hot update or reload came before it.'],
        },
      ]
    },
  },
  {
    id: 'router/leftover-react-router',
    fix: 'Import everything from `@tanstack/react-router` and uninstall the React Router packages. Both export `Link`, `useNavigate` and `Outlet`, and the wrong one reads the wrong context.',
    docs: MIGRATE,
    check: (context) =>
      (facts(context)?.modules ?? []).length > 0
        ? [
            {
              severity: 'warning',
              title: 'The page loads React Router next to TanStack Router',
              evidence: [`Loaded: ${facts(context)!.modules!.join(', ')}`],
            },
          ]
        : [],
  },
  {
    id: 'router/redirect-after-render',
    fix: "Throw `redirect({ to: '/login' })` from `beforeLoad`, ideally on a pathless layout route that wraps the protected ones. A check in a component lets the protected page render, and its loaders run, before the redirect.",
    docs: GUARDS,
    check: (context) => {
      const starts = context.by('router', 'onBeforeNavigate')
      const hits = navigations(context).filter(({ end }) => {
        const detail = end.detail as { guarded?: boolean } | undefined
        if (detail?.guarded !== false) return false
        return starts.some(
          (next) => next.t > end.t && next.t - end.t <= 300 && next.key !== end.key,
        )
      })
      return hits.slice(-2).map(({ end }) => ({
        severity: 'info' as const,
        title: 'A page rendered, then the app navigated away within 300 ms',
        entries: [end.n],
        evidence: [
          `${clip(end.summary, 160)}: none of its routes has a beforeLoad`,
        ],
        hint: 'If this is an access check, it ran too late. If the redirect is intended (onboarding, a default tab), ignore this.',
      }))
    },
  },
  {
    id: 'router/fetch-after-render',
    fix: "Start the route's critical queries in its `loader` (`context.queryClient.query({ ...opts, staleTime: 'static' })`) and read them with `useSuspenseQuery` in the component, so the data loads before the route renders. `useQuery` in the component is right for data the page can render without.",
    docs: ROUTER_QUERY,
    check: (context) => {
      const added = context.by('query', 'added')
      const fetched = new Set(context.by('query', 'fetch').map((e) => e.key))
      const findings = []
      for (const { end } of navigations(context).slice(-3)) {
        if (detailOf<{ initial?: boolean }>(end).initial === true) continue
        const late = added.filter(
          (e) => e.t >= end.t && e.t - end.t <= 250 && fetched.has(e.key),
        )
        if (late.length === 0) continue
        findings.push({
          severity: 'info' as const,
          title: `${late.length} ${late.length === 1 ? 'query' : 'queries'} started fetching only after the route had rendered`,
          entries: [end.n, ...numbers(late)],
          evidence: [
            clip(end.summary, 120),
            ...late.slice(0, 4).map((e) => clip(e.key ?? '', 120) + where(e)),
          ],
        })
      }
      return findings.slice(-2)
    },
  },
  {
    id: 'router/loader-refetch-blocks',
    fix: "Pass `staleTime: 'static'` on the loader's `queryClient.query(...)` call so cached data is reused, and let the component's `useSuspenseQuery` refresh it in the background. A stale refetch in the loader holds the navigation until it finishes.",
    docs: ROUTER_QUERY,
    check: (context) => {
      const refetches = context
        .by('query', 'fetch')
        .filter((e) => detailOf<{ refetch?: boolean }>(e).refetch === true)
      const invalidated = context.by('query', 'invalidate')
      const findings = []
      for (const { start, loaded, end } of navigations(context).slice(-3)) {
        if (loaded === undefined) continue
        const during = refetches.filter(
          (e) =>
            e.t >= start &&
            e.t <= loaded &&
            // An invalidation asks for exactly this refetch.
            !invalidated.some((i) => i.key === e.key && i.t <= e.t && e.t - i.t < 5000),
        )
        if (during.length === 0 || loaded - start < 100) continue
        findings.push({
          severity: 'info' as const,
          title: 'A loader refetched data that was already cached, and the navigation waited for it',
          entries: [end.n, ...numbers(during)],
          evidence: [
            `${clip(end.summary, 120)} (${loaded - start} ms in loaders)`,
            ...during.slice(0, 3).map((e) => clip(e.key ?? '', 120) + where(e)),
          ],
        })
      }
      return findings.slice(-2)
    },
  },
  {
    id: 'router/unhandled-background-query',
    fix: 'Append `.catch(noop)` to a query a loader starts without awaiting, with `noop` imported from `@tanstack/react-query`, so a background failure does not become an unhandled rejection.',
    docs: ROUTER_QUERY,
    check: ({ by }) => {
      const failed = by('query', 'error')
      const hits = by('console', 'unhandledrejection').filter((rejection) =>
        failed.some(
          (error) =>
            Math.abs(error.t - rejection.t) <= 50 &&
            error.summary.includes(rejection.summary.slice(0, 80)),
        ),
      )
      if (hits.length === 0) return []
      return [
        {
          severity: 'warning',
          title: 'A query failed with nothing handling its rejection',
          entries: numbers(hits),
          evidence: [clip(hits.at(-1)!.summary) + where(hits.at(-1)!)],
        },
      ]
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
): KnownMessage => ({ id: `router/${id}`, pattern, severity, title, fix, docs })

/** Warnings and errors TanStack Router prints itself, matched on their text. */
export const ROUTER_MESSAGES: Array<KnownMessage> = [
  message(
    'uncaught-by-route',
    /wasn't caught by any route/,
    'error',
    'An error reached the global boundary: no route caught it',
    'Set `errorComponent` on the root route, or `defaultErrorComponent` in createRouter, with a retry that calls `router.invalidate()`.',
    ERRORS,
  ),
  message(
    'generic-not-found',
    /notFoundComponent option was not configured/,
    'warning',
    'A 404 rendered with the generic fallback',
    'Set `notFoundComponent` on the root route, or `defaultNotFoundComponent` in createRouter.',
    ERRORS,
  ),
  message(
    'not-found-route-deprecated',
    /notFoundRoute API is deprecated/,
    'warning',
    'The deprecated `notFoundRoute` is in use',
    'Remove it and put `notFoundComponent` on the root route. While it is present, `notFound()` and `notFoundComponent` do not work.',
    ERRORS,
  ),
  message(
    'route-match-error',
    /Error in route match:/,
    'error',
    "A route's error boundary caught an error",
    "The warning names the match. If the error came from the loader, the error component's retry must call `router.invalidate()`: `reset()` clears the boundary but does not run the loader again.",
    DATA_LOADING,
  ),
  message(
    'outside-provider',
    /useRouter must be used inside a <RouterProvider>/,
    'error',
    'A router hook or Link rendered outside RouterProvider',
    "Mount the router at the top of the React tree. Providers the routes need go in the router's `Wrap` option or above `RouterProvider`.",
    REACT_ROUTER,
  ),
  message(
    'no-active-match',
    /Could not find an active match from|Could not find a nearest match/,
    'error',
    "A hook's `from` names a route that is not matched",
    'In a component shared across routes, pass `strict: false`, or take `from` as a prop typed as a union of the routes that use it.',
    REACT_ROUTER,
  ),
  message(
    'navigate-from',
    /Could not find match for from:/,
    'warning',
    "A navigation's `from` matches neither the current location nor its routes",
    'Pass the route the navigation is relative to, such as `from: Route.fullPath`.',
    NAVIGATION,
  ),
  message(
    'scroll-restoration-deprecated',
    /ScrollRestoration component is deprecated/,
    'info',
    'The deprecated ScrollRestoration component is rendered',
    'Use `createRouter({ scrollRestoration: true })` and remove the component.',
    REACT_ROUTER,
  ),
  message(
    'dangerous-protocol',
    /Blocked (?:Link|navigation) (?:with|to) dangerous protocol|Redirect blocked: unsafe protocol/,
    'warning',
    'A link, navigation or redirect target had a disallowed scheme',
    'This is usually an unsanitised return URL. Store only a relative path and sanitise it in the destination route\'s `validateSearch`.',
    GUARDS,
  ),
]

export const ROUTER_SLOW: Array<SlowKind> = [
  { source: 'router', types: ['onResolved'], floorMs: 1500, label: 'navigation', plural: 'navigations' },
]
