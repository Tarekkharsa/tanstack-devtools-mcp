import { fileURLToPath } from 'node:url'
import { queryServerSource } from './server.js'
import type { SourceDescriptor } from '@loopsight/core/server'

export { queryServerSource } from './server.js'
export { QUERY_MESSAGES, QUERY_RULES } from './rules.js'
export type { QueryFact, QueryFacts } from './rules.js'

/** TanStack Query as a loopsight source. */
export function tanstackQuery(): SourceDescriptor {
  return {
    key: 'query',
    server: queryServerSource,
    page: fileURLToPath(new URL('./page.js', import.meta.url)),
    detect: [
      '@tanstack/query-core',
      '@tanstack/react-query',
      '@tanstack/vue-query',
      '@tanstack/solid-query',
      '@tanstack/svelte-query',
      '@tanstack/angular-query-experimental',
    ],
  }
}
