import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import {
  Hub,
  NAME,
  SAME_SERVER_BRIDGE,
  createBridge,
  isLoopbackName,
  registerOnAgentHost,
  startServer,
} from '@loopsight/core/server'
import { viteServerSource } from './rules.js'
import type { Plugin, ViteDevServer } from 'vite'
import type {
  Frame,
  RunningServer,
  ServerOptions,
  ServerSource,
  SourceDescriptor,
} from '@loopsight/core/server'

export { viteServerSource } from './rules.js'

export interface LoopsightViteOptions
  extends Omit<ServerOptions, 'resolveFrame' | 'hub' | 'sources'> {
  /**
   * The libraries to watch. A source that names the packages it is for
   * (`detect`) is left out when the app has none of them installed.
   */
  sources?: ReadonlyArray<SourceDescriptor>
  /**
   * Connects every page the dev server serves, with no code in the app.
   * Turn it off to call `connect` yourself. Default true.
   */
  inject?: boolean
  /**
   * Run loopsight's own MCP endpoint on its own port. Default true.
   *
   * Set it to false when Vite DevTools is enabled and you want one endpoint
   * only: the tools are then served from Vite DevTools' MCP route alone, and
   * the page connects through the dev server itself, so no second port opens.
   */
  standalone?: boolean
}

/** The page-side code is served from virtual modules under this prefix. */
const PREFIX = `\0${NAME}:`
const ENTRY = `${PREFIX}entry`
const ENTRY_URL = `@id/__x00__${NAME}:entry`
/** How the generated entry names the page halves it imports. */
const CORE_PAGE = '@loopsight/core/page'
const SOURCE = `${NAME}-source:`
// Vite keeps it at dist/client/client.mjs, Vite+ at dist/vite/client/client.mjs.
const VITE_CLIENT = /[\\/]client[\\/]client\.mjs$/

/** Vite's own modules and requests, which are not the app's. */
const VITE_FRAMES = ['/@id/', '/@vite/', '/@fs/', '/\\.vite/']
const VITE_REQUESTS = ['^/(?:@vite|@id|@fs|@react-refresh|__vite|node_modules/\\.vite)']

/** Whether a package is installed where the app can import it. */
function installed(root: string, name: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    if (dirname(dir) === dir) return false
  }
}

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
        problem: true,
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

  const logger = server.config.logger

  // A module that could not be hot-updated in place says why in Vite's log.
  const logInfo = logger.info.bind(logger)
  logger.info = (message, options) => {
    const said = stripAnsi(String(message))
    const match = /hmr invalidate (\S+)\s*(.*)$/.exec(said)
    if (match) {
      const path = match[1]!.replace(/^\//, '')
      hub.recordServer({
        source: 'vite',
        type: 'invalidate',
        key: path,
        summary: clip(`${path} could not be updated in place${match[2] ? `: ${match[2]}` : ''}`, 400),
        // For rules: why, and whether it was the React plugin giving up.
        detail: {
          reason: clip(match[2] ?? '', 400),
          fastRefresh: /Could not Fast Refresh/.test(match[2] ?? ''),
        },
      })
    }
    logInfo(message, options)
  }

  // Errors Vite only logs, such as a failed server render.
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
        problem: true,
        summary: clip(headline(said), 500),
        detail: { message: clip(said, 3000) },
      })
    }, 150)
    logError(message, options)
  }
}

/**
 * Whether a `Host` header names this dev server: a loopback name, or a host
 * the Vite config allows. Vite applies the same rule to its own requests; it
 * is what stops another site, rebound to this machine, from posing as a page.
 */
function servedHost(server: ViteDevServer, host: string | undefined): boolean {
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (isLoopbackName(hostname)) return true
  const allowed = server.config.server.allowedHosts
  if (allowed === true) return true
  return (allowed ?? []).some((entry) =>
    entry.startsWith('.')
      ? hostname === entry.slice(1) || hostname.endsWith(entry)
      : hostname === entry,
  )
}

/**
 * Runs loopsight with `vite dev` and connects the page to it.
 *
 * ```ts
 * import { loopsightVite } from '@loopsight/vite'
 * import { tanstackQuery } from '@loopsight/tanstack-query'
 *
 * export default defineConfig({
 *   plugins: [loopsightVite({ sources: [tanstackQuery()] })],
 * })
 * ```
 *
 * Then point the agent at `http://127.0.0.1:4777/mcp`.
 *
 * The page is connected two ways, so it works with or without an
 * `index.html`: a script in `index.html` for single-page apps, and an import
 * added to Vite's own client, which every dev page loads, for frameworks that
 * render the document on the server.
 */
export function loopsightVite(options: LoopsightViteOptions = {}): Plugin {
  const { inject = true, standalone = true, sources: wanted = [], ...rest } = options
  let running: RunningServer | undefined
  let base = '/'
  /** A JavaScript expression for the bridge URL, once there is a bridge. */
  let bridgeUrl: string | undefined
  let onDevtools = false
  /** The sources that apply to this app, decided once its root is known. */
  let active: Array<SourceDescriptor> = [...wanted]
  // One array, filled in when the config is resolved, so the endpoint and
  // the Vite DevTools route below describe the same set of sources.
  const serverSources: Array<ServerSource> = []
  const serverOptions = { ...rest, sources: serverSources }
  // Made here, before any server exists, so both ways of serving the tools
  // share the same sessions and the same log.
  let resolveFrame: ((frame: Frame) => Promise<string | undefined>) | undefined
  const hub = new Hub({ ...rest, resolveFrame: (frame) => resolveFrame?.(frame) })

  const corePage = fileURLToPath(import.meta.resolve(CORE_PAGE))
  /** Folders page code may be served from: the core's and each source's. */
  const servable = () => [
    dirname(dirname(corePage)),
    ...active.flatMap((source) => (source.page ? [dirname(source.page)] : [])),
  ]

  const plugin: Plugin = {
    name: NAME,
    apply: 'serve',

    configResolved(config) {
      base = config.base
      active = wanted.filter(
        (source) =>
          source.detect === undefined ||
          source.detect.some((name) => installed(config.root, name)),
      )
      serverSources.length = 0
      serverSources.push(...active.map((source) => source.server), viteServerSource)
    },

    async configureServer(server) {
      const logger = server.config.logger
      resolveFrame = sourceResolver(server)

      if (standalone) {
        try {
          running = await startServer({ ...serverOptions, hub })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          logger.warn(
            `[${NAME}] not started: ${reason}. Set \`port\` to use another one.`,
          )
          return
        }
        const stop = () => {
          void running?.close()
          running = undefined
        }
        server.httpServer?.once('close', stop)
        bridgeUrl = JSON.stringify(running.bridgeUrl)
        const print = server.printUrls.bind(server)
        const mcpUrl = running.mcpUrl
        server.printUrls = () => {
          print()
          logger.info(`  ➜  ${NAME} MCP: ${mcpUrl}`)
        }
      } else {
        // No port of our own: the page reaches the hub through the dev
        // server it was served from, and agents through Vite DevTools.
        // In middleware mode Vite has no HTTP server of its own. The app's
        // server is known to it only when passed as `server.hmr.server`,
        // which is also where Vite puts its own WebSocket.
        const hmr = server.config.server.hmr
        const http = server.httpServer ?? (typeof hmr === 'object' ? hmr.server : undefined)
        if (!http) {
          logger.warn(
            `[${NAME}] \`standalone: false\` has no HTTP server to put the page connection on. In middleware mode, pass your server as \`server.hmr.server\`. Nothing is connected.`,
          )
          return
        }
        const path = base + SAME_SERVER_BRIDGE
        const bridge = createBridge(hub, {
          path,
          sameOrigin: true,
          hostAllowed: (host) => servedHost(server, host),
          ...(serverOptions.origins ? { origins: serverOptions.origins } : {}),
        })
        http.on('upgrade', bridge.handle)
        http.once('close', () => bridge.close())
        bridgeUrl = `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(path)}`
        const warnIfUnserved = () => {
          // The DevTools hook has run by now if it was going to.
          setTimeout(() => {
            if (onDevtools) return
            logger.warn(
              `[${NAME}] \`standalone: false\`, but Vite DevTools did not ask for the tools, so no agent can reach them. Enable \`devtools\` in the Vite config and install @vitejs/devtools and @devframes/agentic, or remove \`standalone: false\`.`,
            )
          }, 3000).unref()
        }
        // An app's own server may be listening already.
        if (http.listening) warnIfUnserved()
        else http.once('listening', warnIfUnserved)
      }
      recordVite(server, hub)
    },

    // The page-side modules are served from memory, read from the built
    // files of the core and of each source. The app does not need to resolve
    // any of these packages, and Vite's file-serving allow list and
    // dependency optimizer are left alone.
    resolveId(source, importer) {
      if (source === ENTRY) return ENTRY
      if (!importer?.startsWith(PREFIX)) return undefined
      if (source === CORE_PAGE) return PREFIX + corePage.split(sep).join('/')
      if (source.startsWith(SOURCE)) {
        const page = active[Number(source.slice(SOURCE.length))]?.page
        return page ? PREFIX + page.split(sep).join('/') : undefined
      }
      if (source.startsWith('.')) {
        const from = importer.slice(PREFIX.length)
        return PREFIX + posix.join(posix.dirname(from), source)
      }
      return undefined
    },

    load(id) {
      if (!id.startsWith(PREFIX)) return undefined
      if (id === ENTRY) {
        if (bridgeUrl === undefined) return ''
        const pages = active.flatMap((source, index) => (source.page ? [index] : []))
        return [
          `import { connect } from ${JSON.stringify(CORE_PAGE)}`,
          ...pages.map((index) => `import source${index} from ${JSON.stringify(SOURCE + index)}`),
          `connect({`,
          `  url: ${bridgeUrl},`,
          `  sources: [${pages.map((index) => `source${index}`).join(', ')}],`,
          `  ignoreFrames: ${JSON.stringify(VITE_FRAMES)},`,
          `  ignoreRequests: ${JSON.stringify(VITE_REQUESTS)},`,
          `})`,
          '',
        ].join('\n')
      }
      // Resolved first, so `..` in a requested id cannot reach outside.
      const file = resolve(id.slice(PREFIX.length).split('/').join(sep))
      const allowed = servable().some((folder) => file.startsWith(folder + sep))
      if (!allowed || !file.endsWith('.js')) return undefined
      return readFileSync(file, 'utf8')
    },

    transform(code, id) {
      if (!inject || bridgeUrl === undefined) return undefined
      if (!VITE_CLIENT.test(id.split('?')[0]!)) return undefined
      if (!code.includes('createHotContext')) return undefined
      // Not awaited and not a static import: if this fails, the app and its
      // hot updates carry on as if the plugin were not there.
      const url = JSON.stringify(base + ENTRY_URL)
      return {
        // Workers load Vite's client too; only a document is a page.
        code: `${code}\n;(() => { if (typeof document === 'undefined') return; const url = ${url}; import(/* @vite-ignore */ url).catch(() => {}) })()\n`,
        map: null,
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (!inject || bridgeUrl === undefined) return undefined
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

  // When Vite DevTools is enabled it calls this hook, and the same tools are
  // also served from its MCP route, next to its own and other plugins'.
  return Object.assign(plugin, {
    devtools: {
      async setup(context: { agent?: Parameters<typeof registerOnAgentHost>[0] }) {
        if (!context.agent) return
        await registerOnAgentHost(context.agent, hub, serverOptions)
        onDevtools = true
      },
    },
  })
}

export default loopsightVite
