import { startServer } from './server/http.js'
import type { Plugin } from 'vite'
import type { RunningServer, ServerOptions } from './server/http.js'

export interface TanStackDevtoolsMcpOptions extends ServerOptions {
  /**
   * Adds a script to `index.html` that connects the page. Turn it off when
   * the app has no `index.html` (an SSR framework) or calls `connect` itself.
   * Default true.
   */
  inject?: boolean
}

/**
 * Runs the MCP server with `vite dev` and connects the page to it.
 *
 * ```ts
 * import { tanstackDevtoolsMcp } from 'tanstack-devtools-mcp/vite'
 *
 * export default defineConfig({ plugins: [tanstackDevtoolsMcp()] })
 * ```
 *
 * Then point the agent at `http://127.0.0.1:4777/mcp`.
 */
export function tanstackDevtoolsMcp(
  options: TanStackDevtoolsMcpOptions = {},
): Plugin {
  const { inject = true, ...serverOptions } = options
  let running: RunningServer | undefined

  return {
    name: 'tanstack-devtools-mcp',
    apply: 'serve',

    async configureServer(server) {
      try {
        running = await startServer(serverOptions)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        server.config.logger.warn(
          `[tanstack-devtools-mcp] not started: ${reason}. Set \`port\` to use another one.`,
        )
        return
      }
      const stop = () => {
        void running?.close()
        running = undefined
      }
      server.httpServer?.once('close', stop)
      const print = server.printUrls.bind(server)
      const mcpUrl = running.mcpUrl
      server.printUrls = () => {
        print()
        server.config.logger.info(`  ➜  TanStack MCP: ${mcpUrl}`)
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (!inject || !running) return
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: `import { connect } from 'tanstack-devtools-mcp/client'\nconnect({ url: ${JSON.stringify(running.bridgeUrl)} })`,
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}

export default tanstackDevtoolsMcp
