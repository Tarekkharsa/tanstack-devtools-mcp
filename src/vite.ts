import { readFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { startServer } from './server/http.js'
import type { Plugin, ViteDevServer } from 'vite'
import type { Frame } from './protocol.js'
import type { Hub } from './server/hub.js'
import type { RunningServer, ServerOptions } from './server/http.js'

export interface TanStackDevtoolsMcpOptions
  extends Omit<ServerOptions, 'resolveFrame'> {
  /**
   * Connects every page the dev server serves, with no code in the app.
   * Turn it off to call `connect` yourself. Default true.
   */
  inject?: boolean
}

/** The page-side code is served from virtual modules under this prefix. */
const PREFIX = '\0tanstack-devtools-mcp:'
const ENTRY = `${PREFIX}entry`
const ENTRY_URL = '@id/__x00__tanstack-devtools-mcp:entry'
// Vite keeps it at dist/client/client.mjs, Vite+ at dist/vite/client/client.mjs.
const VITE_CLIENT = /[\\/]client[\\/]client\.mjs$/
const dist = dirname(fileURLToPath(import.meta.url))

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '')
const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text

/** The first line that says something: "Transform failed with 1 error:" does not. */
function headline(message: string): string {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  return first.endsWith(':') && lines[1] ? `${first} ${lines[1]}` : first
}

function relativeTo(root: string) {
  return (file: string) => {
    const path = relative(root, file.split('?')[0]!)
    return path.startsWith('..') ? file : path.split(sep).join('/')
  }
}

/**
 * Maps a frame of a browser stack trace to the line the developer wrote,
 * using the source map Vite made when it served that module.
 */
function sourceResolver(server: ViteDevServer) {
  const rel = relativeTo(server.config.root)
  const base = server.config.base
  const traces = new WeakMap<object, TraceMap>()
  return async (frame: Frame): Promise<string | undefined> => {
    let url: URL
    try {
      url = new URL(frame.url)
    } catch {
      return undefined
    }
    let path = decodeURI(url.pathname) + url.search
    if (base !== '/' && path.startsWith(base)) path = `/${path.slice(base.length)}`
    const graph = (server.environments?.client ?? server).moduleGraph
    const module = await graph.getModuleByUrl(path)
    if (!module?.file) return undefined

    let { line, column } = frame
    const map = module.transformResult?.map
    if (map && typeof map === 'object' && 'mappings' in map && map.mappings) {
      let trace = traces.get(map)
      if (!trace) {
        trace = new TraceMap(map as ConstructorParameters<typeof TraceMap>[0])
        traces.set(map, trace)
      }
      const original = originalPositionFor(trace, {
        line: frame.line,
        column: Math.max(0, frame.column - 1),
      })
      if (original.line !== null) {
        line = original.line
        column = (original.column ?? 0) + 1
      }
    }
    return `${frame.fn ? `${frame.fn} ` : ''}${rel(module.file)}:${line}:${column}`
  }
}

/**
 * Puts what Vite does on the same timeline as what the page does: a file
 * changed, a hot update or a full reload went out, a build failed.
 */
function recordVite(server: ViteDevServer, hub: Hub): void {
  const rel = relativeTo(server.config.root)
  let lastBuildError = 0

  // The watcher sees every file under the root, logs and all. Only a file
  // some environment has loaded as a module is part of the app.
  const isModule = (file: string) => {
    const graphs = server.environments
      ? Object.values(server.environments).map((environment) => environment.moduleGraph)
      : [server.moduleGraph]
    return graphs.some((graph) => (graph.getModulesByFile(file)?.size ?? 0) > 0)
  }
  server.watcher.on('change', (file) => {
    if (!isModule(file)) return
    const path = rel(file)
    hub.recordServer({ source: 'vite', type: 'change', key: path, summary: `${path} changed` })
  })

  const onPayload = (payload: any) => {
    if (payload === null || typeof payload !== 'object') return
    if (payload.type === 'update' && Array.isArray(payload.updates)) {
      const files = [
        ...new Set<string>(
          payload.updates.map((update: any) => String(update.path).replace(/^\//, '')),
        ),
      ]
      if (files.length === 0) return
      hub.recordServer({
        source: 'vite',
        type: 'hmr-update',
        key: files[0]!,
        summary: `hot update: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` and ${files.length - 6} more` : ''}`,
      })
    } else if (payload.type === 'full-reload') {
      const by = typeof payload.triggeredBy === 'string' ? rel(payload.triggeredBy) : undefined
      hub.recordServer({
        source: 'vite',
        type: 'full-reload',
        ...(by ? { key: by } : {}),
        summary: `full reload${by ? ` triggered by ${by}` : ''}`,
      })
    } else if (payload.type === 'error' && payload.err) {
      lastBuildError = Date.now()
      const err = payload.err
      const message = stripAnsi(String(err.message ?? ''))
      const file = typeof err.id === 'string' ? rel(err.id) : undefined
      const place = file
        ? ` in ${file}${err.loc ? `:${err.loc.line}:${err.loc.column}` : ''}`
        : ''
      hub.recordServer({
        source: 'vite',
        type: 'error',
        ...(file ? { key: file } : {}),
        summary: clip(`build error${place}: ${headline(message)}`, 500),
        detail: {
          message: clip(message, 3000),
          ...(err.frame ? { frame: clip(stripAnsi(String(err.frame)), 2000) } : {}),
          ...(err.plugin ? { plugin: err.plugin } : {}),
        },
      })
    }
  }

  // `server.ws` and the client environment's channel can be the same pipe.
  const seen = new WeakSet<object>()
  const tap = (channel: any) => {
    if (!channel || typeof channel.send !== 'function') return
    const send = channel.send.bind(channel)
    channel.send = (...args: Array<any>) => {
      const payload = args[0]
      if (payload !== null && typeof payload === 'object' && !seen.has(payload)) {
        seen.add(payload)
        try {
          onPayload(payload)
        } catch {
          // Recording must never get in the way of the update itself.
        }
      }
      return send(...args)
    }
  }
  tap(server.environments?.client?.hot)
  tap(server.ws)

  // Errors Vite only logs, such as a failed server render.
  const logger = server.config.logger
  const logError = logger.error.bind(logger)
  logger.error = (message, options) => {
    const said = stripAnsi(String(message))
    // Vite can echo the browser's console here; the page records those itself.
    const echoed = /^\[(?:console\.\w+|Unhandled error|Unhandled rejection)\]/i.test(said.trim())
    if (!echoed) setTimeout(() => {
      // The browser was told about this one; it is recorded as a build error.
      if (Date.now() - lastBuildError < 400) return
      hub.recordServer({
        source: 'vite',
        type: 'server-error',
        summary: clip(headline(said), 500),
        detail: { message: clip(said, 3000) },
      })
    }, 150)
    logError(message, options)
  }
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
 *
 * The page is connected two ways, so it works with or without an
 * `index.html`: a script in `index.html` for single-page apps, and an import
 * added to Vite's own client, which every dev page loads, for frameworks that
 * render the document on the server.
 */
export function tanstackDevtoolsMcp(
  options: TanStackDevtoolsMcpOptions = {},
): Plugin {
  const { inject = true, ...serverOptions } = options
  let running: RunningServer | undefined
  let base = '/'

  return {
    name: 'tanstack-devtools-mcp',
    apply: 'serve',

    configResolved(config) {
      base = config.base
    },

    async configureServer(server) {
      try {
        running = await startServer({
          ...serverOptions,
          resolveFrame: sourceResolver(server),
        })
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
      recordVite(server, running.hub)
      const print = server.printUrls.bind(server)
      const mcpUrl = running.mcpUrl
      server.printUrls = () => {
        print()
        server.config.logger.info(`  ➜  TanStack MCP: ${mcpUrl}`)
      }
    },

    // The page-side modules are served from memory, read from this package's
    // own files. The app does not need to resolve this package, and Vite's
    // file-serving allow list and dependency optimizer are left alone.
    resolveId(source, importer) {
      if (source === ENTRY) return ENTRY
      if (importer?.startsWith(PREFIX) && source.startsWith('.')) {
        const from = importer.slice(PREFIX.length)
        return PREFIX + posix.join(posix.dirname(from), source)
      }
      return undefined
    },

    load(id) {
      if (!id.startsWith(PREFIX)) return undefined
      if (id === ENTRY) {
        if (!running) return ''
        return `import { connect } from './client/index.js'\nconnect({ url: ${JSON.stringify(running.bridgeUrl)} })\n`
      }
      const file = join(dist, id.slice(PREFIX.length))
      if (!file.startsWith(dist + sep) || !file.endsWith('.js')) return undefined
      return readFileSync(file, 'utf8')
    },

    transform(code, id) {
      if (!inject || !running) return undefined
      if (!VITE_CLIENT.test(id.split('?')[0]!)) return undefined
      if (!code.includes('createHotContext')) return undefined
      // Not awaited and not a static import: if this fails, the app and its
      // hot updates carry on as if the plugin were not there.
      const url = JSON.stringify(base + ENTRY_URL)
      return {
        code: `${code}\n;(() => { const url = ${url}; import(/* @vite-ignore */ url).catch(() => {}) })()\n`,
        map: null,
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (!inject || !running) return undefined
        // Earlier than the import above: it runs before the app's modules, so
        // tools a library registers while loading are collected too.
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: base + ENTRY_URL },
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}

export default tanstackDevtoolsMcp
