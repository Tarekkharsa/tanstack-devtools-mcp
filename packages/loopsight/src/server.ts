import { startServer as startCore } from '@loopsight/core/server'
import { tanstack } from './preset.js'
import type { RunningServer, ServerOptions } from '@loopsight/core/server'

export { tanstack } from './preset.js'
export type { RunningServer, ServerOptions } from '@loopsight/core/server'

/**
 * Starts the loopsight server by itself, with the built-in sources unless
 * `sources` says otherwise. For apps with no bundler plugin: the page then
 * calls `connect` from `loopsight/client`.
 */
export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  return startCore({
    ...options,
    sources: options.sources ?? tanstack().map((source) => source.server),
  })
}
