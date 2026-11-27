import { tanstackDevtools } from '@loopsight/tanstack-devtools'
import { tanstackQuery } from '@loopsight/tanstack-query'
import { tanstackRouter } from '@loopsight/tanstack-router'
import { tanstackStart } from '@loopsight/tanstack-start'
import type { SourceDescriptor } from '@loopsight/core/server'

/**
 * The sources this package turns on by default. Each is left out by a host
 * when the app does not have its library installed. The router comes before
 * Query, which looks for its client in the router's context.
 */
export function tanstack(): Array<SourceDescriptor> {
  return [tanstackRouter(), tanstackQuery(), tanstackStart(), tanstackDevtools()]
}
