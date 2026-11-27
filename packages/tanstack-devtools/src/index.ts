import { fileURLToPath } from 'node:url'
import type { ServerSource, SourceDescriptor } from '@loopsight/core/server'

/** The TanStack Devtools event bus, seen from the server: it only names its entries. */
export const devtoolsServerSource: ServerSource = {
  key: 'bus',
  title: 'TanStack Devtools',
  writes: { bus: 'events TanStack Devtools plugins emit, when that panel is mounted' },
}

/** The TanStack Devtools event bus as a loopsight source. */
export function tanstackDevtools(): SourceDescriptor {
  return {
    key: 'bus',
    server: devtoolsServerSource,
    page: fileURLToPath(new URL('./page.js', import.meta.url)),
    detect: [
      '@tanstack/devtools',
      '@tanstack/react-devtools',
      '@tanstack/solid-devtools',
      '@tanstack/vue-devtools',
      '@tanstack/devtools-event-client',
    ],
  }
}
