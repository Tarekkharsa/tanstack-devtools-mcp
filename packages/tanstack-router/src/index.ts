import { fileURLToPath } from 'node:url'
import { routerServerSource } from './server.js'
import type { SourceDescriptor } from '@loopsight/core/server'

export { routerServerSource } from './server.js'
export { ROUTER_MESSAGES, ROUTER_RULES } from './rules.js'
export type { RouteFact, RouterFacts } from './rules.js'

/** TanStack Router as a loopsight source. */
export function tanstackRouter(): SourceDescriptor {
  return {
    key: 'router',
    server: routerServerSource,
    page: fileURLToPath(new URL('./page.js', import.meta.url)),
    detect: [
      '@tanstack/router-core',
      '@tanstack/react-router',
      '@tanstack/solid-router',
      '@tanstack/vue-router',
    ],
  }
}
