import { loopsightVite } from '@loopsight/vite'
import { tanstack } from './preset.js'
import type { LoopsightViteOptions } from '@loopsight/vite'
import type { Plugin } from 'vite'

export { tanstack } from './preset.js'
export type { LoopsightViteOptions } from '@loopsight/vite'
export type { SourceDescriptor } from '@loopsight/core/server'

/**
 * loopsight for Vite, with nothing to configure.
 *
 * ```ts
 * import { loopsight } from 'loopsight/vite'
 *
 * export default defineConfig({ plugins: [loopsight()] })
 * ```
 *
 * Then point the agent at `http://127.0.0.1:4777/mcp`. Pass `sources` to
 * choose the libraries yourself; without it, the built-in ones are used for
 * whichever of their libraries the app has installed.
 */
export function loopsight(options: LoopsightViteOptions = {}): Plugin {
  return loopsightVite({ ...options, sources: options.sources ?? tanstack() })
}

export default loopsight
