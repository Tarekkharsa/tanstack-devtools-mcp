import { clip, numbers, where } from './rules.js'
import type { Finding, KnownMessage, Reference, Rule } from './rules.js'

/**
 * Rules from the agent skills TanStack Start ships inside its packages, from
 * the README of `@vitejs/plugin-react`, and from Vite's troubleshooting guide.
 */

const skill = (pkg: string, path: string, label: string): Reference => ({
  label: `TanStack Start skill: ${label}`,
  at: `${pkg}: skills/${path}`,
})
const EXECUTION = skill('@tanstack/start-client-core', 'start-core/execution-model/SKILL.md', 'execution model')
const START_CORE = skill('@tanstack/start-client-core', 'start-core/SKILL.md', 'core workflow')
const SERVER_FNS = skill('@tanstack/start-client-core', 'start-core/server-functions/SKILL.md', 'server functions')
const MIDDLEWARE = skill('@tanstack/start-client-core', 'start-core/middleware/SKILL.md', 'middleware')
const DEPLOYMENT = skill('@tanstack/start-client-core', 'start-core/deployment/SKILL.md', 'deployment and SSR modes')
const LOADING: Reference = skill('@tanstack/react-start', 'react-start/server-components/docs/caching-refresh-ssr.md', 'caching, refresh and SSR')
const PENDING: Reference = {
  label: 'TanStack Router skill: data loading',
  at: '@tanstack/router-core: skills/router-core/data-loading/SKILL.md',
}
const FAST_REFRESH: Reference = {
  label: '@vitejs/plugin-react README: Consistent components exports',
  at: 'https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#consistent-components-exports',
}
const VITE_TROUBLESHOOTING: Reference = {
  label: 'Vite docs: Troubleshooting',
  at: 'https://vite.dev/guide/troubleshooting',
}

/** The documented answer to a hydration mismatch, for the built-in check. */
export const HYDRATION_FIX: Pick<Finding, 'fix' | 'docs'> = {
  fix: 'Make the first client render match the server. Move a client-only value (dates, locale, `window`) into `useEffect` or state, or gate the component with `<ClientOnly fallback>` or `useHydrated()`. State the server must see belongs in search params, not `location.hash`, which is never sent to the server.',
  docs: EXECUTION,
}

const isServerFn = (key: string | undefined) => key?.startsWith('serverFn:') === true

export const START_RULES: Array<Rule> = [
  {
    id: 'start/ssr-loosened-by-child',
    fix: "Loosen the parent instead. A child inherits its parent's SSR mode and can only be more restrictive: `true` to `'data-only'` to `false`. A child's `ssr: true` under a parent with `false` is ignored.",
    docs: DEPLOYMENT,
    check: ({ facts }) => {
      const matches = facts?.routerFacts?.matches ?? []
      const findings = []
      let strictest: { routeId: string; ssr: unknown } | undefined
      for (const match of matches) {
        const ssr = match.route.ssr
        if (ssr === true && strictest) {
          findings.push({
            severity: 'warning' as const,
            title: 'A route sets `ssr: true` under a parent that turned server rendering down',
            evidence: [`${match.routeId} has ssr: true; ${strictest.routeId} has ssr: ${JSON.stringify(strictest.ssr)}`],
          })
        }
        if (ssr === false || ssr === 'data-only') strictest = { routeId: match.routeId, ssr }
      }
      return findings
    },
  },
  {
    id: 'start/loader-self-fetch',
    fix: 'Put the logic behind `createServerFn` and call it directly from the route loader. The skill is explicit: do not self-fetch a relative `/api/...` URL from a loader. If an HTTP endpoint is needed too, have both call one server-only function.',
    docs: SERVER_FNS,
    check: (context) => {
      const requests = context.by('network', 'ok', 'error')
      // Only an app that uses server functions has the better option.
      if (!requests.some((entry) => isServerFn(entry.key))) return []
      const events = context.by('router', 'onBeforeNavigate', 'onLoad')
      const during = requests.filter((entry) => {
        if (!entry.key?.startsWith('/api/') || entry.dur === undefined) return false
        const began = entry.t - entry.dur
        const start = events.findLast((e) => e.type === 'onBeforeNavigate' && e.t <= began)
        if (!start) return false
        const loaded = events.find((e) => e.type === 'onLoad' && e.n > start.n)
        return loaded !== undefined && began <= loaded.t
      })
      if (during.length === 0) return []
      return [
        {
          severity: 'info',
          title: "A route's loading phase fetched the app's own API over HTTP",
          entries: numbers(during),
          evidence: [...new Set(during.map((entry) => clip(entry.summary.replace(/ → .*$/, ''), 140) + where(entry)))].slice(0, 4),
          hint: 'A relative fetch from an event handler is fine. This is about fetches a loader makes.',
        },
      ]
    },
  },
  {
    id: 'start/serial-server-functions',
    fix: 'Fetch independent data with separate server functions and `Promise.all`, or return data that always loads together from one server function. The skill states this for fragments that do not share data; it applies to any calls where the second does not need the first one\'s result.',
    docs: LOADING,
    check: (context) => {
      const calls = context
        .by('network', 'ok', 'error')
        .filter((entry) => isServerFn(entry.key) && (entry.dur ?? 0) >= 50)
        .map((entry) => ({ entry, start: entry.t - (entry.dur ?? 0), end: entry.t }))
        .sort((a, b) => a.start - b.start)
      const chains: Array<typeof calls> = []
      let chain: typeof calls = []
      for (const call of calls) {
        const previous = chain.at(-1)
        if (previous && call.start >= previous.end && call.start - previous.end <= 30) {
          chain.push(call)
        } else {
          if (chain.length >= 2) chains.push(chain)
          chain = [call]
        }
      }
      if (chain.length >= 2) chains.push(chain)
      return chains.slice(-2).map((run) => ({
        severity: 'info' as const,
        title: `${run.length} server functions ran one after another, ${run.at(-1)!.end - run[0]!.start} ms in total`,
        entries: run.map((call) => call.entry.n),
        evidence: run.slice(0, 5).map((call) => `${call.entry.dur} ms ${clip(call.entry.key ?? '', 100)}${where(call.entry)}`),
        hint: 'Right as it is if each call needs the result of the one before.',
      }))
    },
  },
  {
    id: 'start/slow-navigation-no-pending',
    fix: 'Return slow, non-critical data from the loader as an unawaited promise and render it with `<Await>`, and give the route a `pendingComponent`. By default a pending component shows after 1 second (`pendingMs: 1000`).',
    docs: PENDING,
    check: (context) =>
      context
        .by('router', 'onResolved')
        .filter((entry) => {
          const detail = entry.detail as { pendingUi?: boolean } | undefined
          return (entry.dur ?? 0) > 1000 && detail?.pendingUi === false
        })
        .slice(-2)
        .map((entry) => ({
          severity: 'info' as const,
          title: `A navigation took ${entry.dur} ms with no pending component to show`,
          entries: [entry.n],
          evidence: [clip(entry.summary, 160)],
        })),
  },
  {
    id: 'vite/fast-refresh-defeated',
    fix: 'Keep a component file exporting only React components, and move helpers and values that are not constants to another module. An incompatible export makes the plugin invalidate the module, and the update spreads to its importers or reloads the page.',
    docs: FAST_REFRESH,
    check: ({ by }) => {
      const failed = by('vite', 'invalidate').filter((entry) =>
        entry.summary.includes('Could not Fast Refresh'),
      )
      if (failed.length === 0) return []
      const files = [...new Set(failed.map((entry) => entry.key ?? ''))]
      return [
        {
          severity: 'warning',
          title: `Fast Refresh could not update ${files.length === 1 ? 'a module' : `${files.length} modules`} in place`,
          entries: numbers(failed),
          evidence: files.slice(0, 4).map((file) => clip(failed.findLast((entry) => entry.key === file)!.summary, 220)),
        },
      ]
    },
  },
  {
    id: 'vite/full-reload-for-component',
    fix: 'A full reload happens when nothing accepts the update, or when the module sits in an import cycle; breaking the cycle restores hot updates (`vite --debug hmr` logs the path). For a component file, check that it exports only components.',
    docs: VITE_TROUBLESHOOTING,
    check: ({ by }) => {
      const explained = new Set(by('vite', 'invalidate').map((entry) => entry.key))
      const reloads = by('vite', 'full-reload').filter(
        (entry) => entry.key !== undefined && /\.[jt]sx$/.test(entry.key) && !explained.has(entry.key),
      )
      // Once can be an entry file; twice for one file is a pattern.
      const counts = new Map<string, number>()
      for (const entry of reloads) counts.set(entry.key!, (counts.get(entry.key!) ?? 0) + 1)
      const repeated = [...counts].filter(([, count]) => count >= 2)
      if (repeated.length === 0) return []
      return [
        {
          severity: 'info',
          title: 'Editing a component file reloads the whole page instead of hot-updating',
          entries: numbers(reloads),
          evidence: repeated.slice(0, 4).map(([file, count]) => `${file}: ${count} full reloads`),
          hint: 'Expected for the file that mounts the app. Not expected for a file that only defines components.',
        },
      ]
    },
  },
  {
    id: 'vite/header-too-large',
    fix: 'Reduce the request header size. The usual cause is a long cookie: delete it, or raise Node\'s limit with `--max-http-header-size`.',
    docs: VITE_TROUBLESHOOTING,
    check: ({ by }) => {
      const rejected = by('network', 'error').filter((entry) => / → 431$/.test(entry.summary))
      if (rejected.length === 0) return []
      return [
        {
          severity: 'error',
          title: 'The dev server rejected a request with 431: its headers are too large',
          entries: numbers(rejected),
          evidence: [clip(rejected.at(-1)!.summary, 160)],
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
): KnownMessage => ({ id, pattern, severity, title, fix, docs })

/** Messages TanStack Start and Vite print themselves, matched on their text. */
export const START_MESSAGES: Array<KnownMessage> = [
  message(
    'start/server-import-on-client',
    /\[import-protection\] Mocked import used in dev client/,
    'error',
    'Server-only code was imported and used in the browser',
    'Move the logic behind `createServerFn().handler(...)`, split it with `createIsomorphicFn().client(...).server(...)`, or keep the import in a `.server.ts` file that no client code imports. Dev only mocks the import; the production build fails on it.',
    EXECUTION,
  ),
  message(
    'start/env-only-fn-wrong-side',
    /create(?:Server|Client)OnlyFn\(\) functions can only be called on the (?:server|client)/,
    'error',
    'A server-only or client-only function was called on the wrong side',
    'Use `createServerFn` when the client needs the result over RPC, or `createIsomorphicFn().client(...).server(...)` when one symbol should behave differently per environment.',
    EXECUTION,
  ),
  message(
    'start/form-data-get',
    /FormData is not supported with GET requests/,
    'error',
    'FormData was passed to a server function that uses GET',
    "Declare the server function with `createServerFn({ method: 'POST' })`. GET is the default when `method` is left out.",
    SERVER_FNS,
  ),
  message(
    'start/middleware-no-next',
    /User middleware returned undefined\. You must call next\(\)/,
    'error',
    'A middleware returned nothing',
    'Return `next()` from the middleware, or return a result.',
    MIDDLEWARE,
  ),
  message(
    'start/missing-scripts',
    /requires the React Refresh runtime, but \/@react-refresh could not be resolved/,
    'error',
    'The React plugin is missing from the Vite config',
    'Add `@vitejs/plugin-react` to the Vite plugins, after `tanstackStart()`.',
    START_CORE,
  ),
  message(
    'vite/node-builtin-in-browser',
    /has been externalized for browser compatibility/,
    'error',
    'A Node built-in module reached the browser',
    'Move the work that needs it into a server function and call that from the loader. Vite recommends avoiding Node modules in browser code; a loader runs in the browser too.',
    VITE_TROUBLESHOOTING,
  ),
  message(
    'vite/header-too-large-message',
    /Server responded with status code 431/,
    'error',
    'A request was rejected with 431: its headers are too large',
    "Reduce the request header size. The usual cause is a long cookie: delete it, or raise Node's limit with `--max-http-header-size`.",
    VITE_TROUBLESHOOTING,
  ),
]
