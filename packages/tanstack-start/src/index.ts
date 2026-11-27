import { fileURLToPath } from 'node:url'
import { START_MESSAGES, START_RULES } from './rules.js'
import type { ServerSource, SourceDescriptor } from '@loopsight/core/server'

export { START_MESSAGES, START_RULES } from './rules.js'

/** TanStack Start, seen from the server: rules only. Its page half names server functions. */
export const startServerSource: ServerSource = {
  key: 'start',
  title: 'TanStack Start',
  about: 'Requests to TanStack Start server functions are shown by function name.',
  rules: START_RULES,
  messages: START_MESSAGES,
}

/** TanStack Start as a loopsight source. Some of its rules read the router source's facts. */
export function tanstackStart(): SourceDescriptor {
  return {
    key: 'start',
    server: startServerSource,
    page: fileURLToPath(new URL('./page.js', import.meta.url)),
    detect: ['@tanstack/react-start', '@tanstack/solid-start', '@tanstack/start-client-core'],
  }
}
