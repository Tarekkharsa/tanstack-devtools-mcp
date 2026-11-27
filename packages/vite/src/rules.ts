import { clip, numbers } from '@loopsight/core/server'
import type {
  KnownMessage,
  Reference,
  Rule,
  ServerSource,
} from '@loopsight/core/server'

/**
 * Rules about the dev loop itself, from the README of `@vitejs/plugin-react`
 * and from Vite's troubleshooting guide.
 */

const FAST_REFRESH: Reference = {
  label: '@vitejs/plugin-react README: Consistent components exports',
  at: 'https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#consistent-components-exports',
}
const VITE_TROUBLESHOOTING: Reference = {
  label: 'Vite docs: Troubleshooting',
  at: 'https://vite.dev/guide/troubleshooting',
}

export const VITE_RULES: Array<Rule> = [
  {
    id: 'vite/fast-refresh-defeated',
    fix: 'Keep a component file exporting only React components, and move helpers and values that are not constants to another module. An incompatible export makes the plugin invalidate the module, and the update spreads to its importers or reloads the page.',
    docs: FAST_REFRESH,
    check: ({ by }) => {
      // The host records why a module could not be updated in place.
      const failed = by('vite', 'invalidate').filter(
        (entry) => (entry.detail as { fastRefresh?: boolean } | undefined)?.fastRefresh === true,
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
      const rejected = by('network', 'error').filter(
        (entry) => (entry.detail as { status?: number } | undefined)?.status === 431,
      )
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

export const VITE_MESSAGES: Array<KnownMessage> = [
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

/** What the Vite host adds on the server side: rules only, no tools. */
export const viteServerSource: ServerSource = {
  key: 'vite',
  title: 'Vite',
  writes: {
    vite: 'the dev server: a module changed, a hot update, a full reload, a module that could not be updated in place, a build error',
  },
  rules: VITE_RULES,
  messages: VITE_MESSAGES,
}
