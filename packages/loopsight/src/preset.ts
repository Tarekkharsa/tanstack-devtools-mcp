import { otel } from '@loopsight/otel'
import { tanstackDevtools } from '@loopsight/tanstack-devtools'
import { tanstackQuery } from '@loopsight/tanstack-query'
import { tanstackRouter } from '@loopsight/tanstack-router'
import { tanstackStart } from '@loopsight/tanstack-start'
import { viteServerSource } from '@loopsight/vite'
import type { ServerSource, SourceDescriptor } from '@loopsight/core/server'

/**
 * The sources this package turns on by default. Each is left out by a host
 * when the app does not have its library installed. The router comes before
 * Query, which looks for its client in the router's context.
 */
export function tanstack(): Array<SourceDescriptor> {
  return [tanstackRouter(), tanstackQuery(), tanstackStart(), tanstackDevtools()]
}

/**
 * Everything on by default: the libraries above, and the app's own server
 * for as long as it exports OpenTelemetry here. That last one costs nothing
 * until the server sends something.
 */
export function defaults(): Array<SourceDescriptor> {
  return [...tanstack(), otel()]
}

/**
 * The server halves a standalone server uses: the built-in sources', and
 * Vite's rules, since a page Vite serves prints Vite's warnings whether or
 * not the plugin is in the config.
 */
export function serverSources(): Array<ServerSource> {
  return [...defaults().map((source) => source.server), viteServerSource]
}
