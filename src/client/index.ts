import { BRIDGE_PATH, DEFAULT_PORT } from '../protocol.js'
import {
  captureTools,
  recordBus,
  recordConsole,
  recordNetwork,
} from './capture.js'
import { queryHandlers, queryOverview, recordQuery } from './query.js'
import {
  recordRouter,
  routerHandlers,
  routerIdle,
  routerOverview,
} from './router.js'
import { bounded } from './serialize.js'
import type {
  PageEntry,
  PageMessage,
  ServerMessage,
  SessionInfo,
} from '../protocol.js'
import type { CapturedTool, NetworkRecorder } from './capture.js'
import type { QueryClientLike } from './query.js'
import type { RouterLike } from './router.js'
import type { Handlers, Recorder } from './types.js'

export type { QueryClientLike } from './query.js'
export type { RouterLike } from './router.js'

/** The part of `WebSocket` the bridge uses. */
export interface SocketLike {
  send: (data: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

export interface ConnectOptions {
  /** The server's bridge URL. Defaults to the URL the Vite plugin injects. */
  url?: string
  /**
   * When left out, read from the router context (`context.queryClient`) or
   * `window.__TANSTACK_QUERY_CLIENT__`.
   */
  queryClient?: QueryClientLike
  /** Read from `window.__TSR_ROUTER__`, which TanStack Router sets, when left out. */
  router?: RouterLike
  /** Record `console.error`, `console.warn` and uncaught errors. Default true. */
  console?: boolean
  /** Record `fetch` and `XMLHttpRequest` calls. Default true. */
  network?: boolean
  /** Replaces `new WebSocket(url)`, for tests. */
  createSocket?: (url: string) => SocketLike
}

const MAX_UNSENT = 2000
const FLUSH_MS = 25

function isQueryClient(value: any): value is QueryClientLike {
  return (
    typeof value?.getQueryCache === 'function' &&
    typeof value?.getMutationCache === 'function'
  )
}

function isRouter(value: any): value is RouterLike {
  return (
    typeof value?.subscribe === 'function' &&
    typeof value?.navigate === 'function' &&
    typeof value?.routesById === 'object'
  )
}

function randomId(): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

class Bridge {
  readonly id = randomId()
  readonly startedAt = Date.now()
  readonly tools = new Map<string, CapturedTool>()

  #seq = 0
  #unsent: Array<PageEntry> = []
  #network: NetworkRecorder | undefined
  #stops = new Map<string, () => void>()
  #queryClient: QueryClientLike | undefined
  #router: RouterLike | undefined
  #pinned = { query: false, router: false }
  #handlers: Handlers = {}
  #socket: SocketLike | undefined
  #open = false
  #wanted = false
  #url = ''
  #createSocket: (url: string) => SocketLike = (url) =>
    new WebSocket(url) as unknown as SocketLike
  #retryMs = 500
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  #sentMeta = ''

  constructor() {
    captureTools(this.tools, () => this.#scheduleFlush())
    this.#rebuild()
    this.#watch('__TSR_ROUTER__')
    this.#watch('__TANSTACK_QUERY_CLIENT__')
  }

  /**
   * Notices the moment a library puts its instance on `window`, so recording
   * starts before the first loader or query runs, not at the next poll.
   */
  #watch(name: string): void {
    const globals = globalThis as any
    if (globals[name] !== undefined) return
    let value: unknown
    try {
      Object.defineProperty(globals, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next: unknown) => {
          value = next
          // The setter runs inside the instance's constructor; let it finish.
          queueMicrotask(() => {
            if (this.#wanted) this.#discover()
          })
        },
      })
    } catch {
      // Something else defined it first; the timed checks still find it.
    }
  }

  record: Recorder = (entry) => {
    this.#unsent.push({ ...entry, seq: ++this.#seq, t: Date.now() })
    if (this.#unsent.length > MAX_UNSENT) this.#unsent.shift()
    this.#scheduleFlush()
  }

  connect(options: ConnectOptions): () => void {
    if (options.createSocket) this.#createSocket = options.createSocket
    if (options.queryClient) this.#attachQuery(options.queryClient, true)
    if (options.router) this.#attachRouter(options.router, true)
    if (options.console !== false && !this.#stops.has('console')) {
      this.#stops.set('console', recordConsole(this.record))
    }
    if (options.network !== false && !this.#network) {
      const network = recordNetwork(this.record)
      this.#network = network
      this.#stops.set('network', () => {
        network.stop()
        this.#network = undefined
      })
    }
    if (!this.#stops.has('bus')) this.#stops.set('bus', recordBus(this.record))

    this.#discover()
    // The app may create its router or client after this call.
    for (const delay of [250, 1000, 3000]) {
      setTimeout(() => {
        if (this.#wanted) this.#discover()
      }, delay)
    }

    // A later call without a URL keeps the one already in use, so the app's
    // own connect({ queryClient }) does not undo the URL the plugin injected.
    const url =
      options.url ??
      (this.#wanted
        ? this.#url
        : `ws://127.0.0.1:${DEFAULT_PORT}${BRIDGE_PATH}`)
    if (!this.#wanted || url !== this.#url) {
      this.#url = url
      this.#wanted = true
      this.#socket?.close()
      this.#dial()
    }
    return () => this.disconnect()
  }

  disconnect(): void {
    this.#wanted = false
    for (const stop of this.#stops.values()) stop()
    this.#stops.clear()
    this.#queryClient = undefined
    this.#router = undefined
    this.#pinned = { query: false, router: false }
    this.#rebuild()
    this.#socket?.close()
    this.#socket = undefined
    this.#open = false
  }

  #attachQuery(client: QueryClientLike, pinned: boolean): void {
    if (this.#queryClient === client) return
    this.#stops.get('query')?.()
    this.#queryClient = client
    this.#pinned.query = pinned
    this.#stops.set('query', recordQuery(client, this.record))
    this.#rebuild()
  }

  #attachRouter(router: RouterLike, pinned: boolean): void {
    if (this.#router === router) return
    this.#stops.get('router')?.()
    this.#router = router
    this.#pinned.router = pinned
    this.#stops.set('router', recordRouter(router, this.record))
    this.#rebuild()
  }

  /** Picks up the instances the libraries, or the app, put on `window`. */
  #discover(): void {
    const globals = globalThis as any
    if (!this.#pinned.query && isQueryClient(globals.__TANSTACK_QUERY_CLIENT__)) {
      this.#attachQuery(globals.__TANSTACK_QUERY_CLIENT__, false)
    }
    if (!this.#pinned.router && isRouter(globals.__TSR_ROUTER__)) {
      this.#attachRouter(globals.__TSR_ROUTER__, false)
    }
    // The usual Router and Query setup keeps the client in the router context.
    const inContext = this.#router?.options?.context?.queryClient
    if (!this.#pinned.query && !this.#queryClient && isQueryClient(inContext)) {
      this.#attachQuery(inContext, false)
    }
  }

  #rebuild(): void {
    this.#handlers = {
      ...(this.#queryClient ? queryHandlers(this.#queryClient) : {}),
      ...(this.#router ? routerHandlers(this.#router) : {}),
      'page.wait': (args) => this.#wait(args),
      'page.overview': () => this.#overview(),
      'tool.call': (args) => this.#callTool(args),
    }
    this.#scheduleFlush()
  }

  #idle(): boolean {
    const client = this.#queryClient
    if (client && (client.isFetching() > 0 || client.isMutating() > 0)) {
      return false
    }
    if (this.#router && !routerIdle(this.#router)) return false
    return (this.#network?.pending() ?? 0) === 0
  }

  #overview() {
    return {
      url: typeof location === 'undefined' ? '' : location.href,
      title: typeof document === 'undefined' ? '' : document.title,
      idle: this.#idle(),
      router: this.#router ? routerOverview(this.#router) : null,
      query: this.#queryClient ? queryOverview(this.#queryClient) : null,
      pendingRequests: this.#network?.pending() ?? 0,
      tools: this.tools.size,
    }
  }

  /** Resolves once queries, mutations and the router have settled. */
  #wait(args: Record<string, any>) {
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 5000
    const quietMs = typeof args.quietMs === 'number' ? args.quietMs : 100
    const started = Date.now()
    return new Promise((resolve) => {
      let quietSince: number | undefined
      const check = () => {
        const now = Date.now()
        if (this.#idle()) quietSince ??= now
        else quietSince = undefined
        const idle = quietSince !== undefined && now - quietSince >= quietMs
        if (idle || now - started >= timeoutMs) {
          resolve({ idle, waitedMs: now - started, lastSeq: this.#seq })
          return
        }
        setTimeout(check, 20)
      }
      check()
    })
  }

  async #callTool(args: Record<string, any>) {
    const tool = this.tools.get(String(args.name))
    if (!tool) throw new Error(`No registered tool named ${String(args.name)}`)
    const controller = new AbortController()
    const result = await tool.execute(args.input ?? {}, {
      signal: controller.signal,
    })
    return bounded(result, { depth: 8, items: 200, chars: 5000 })
  }

  info(): SessionInfo {
    return {
      id: this.id,
      url: typeof location === 'undefined' ? '' : location.href,
      title: typeof document === 'undefined' ? '' : document.title,
      startedAt: this.startedAt,
      has: {
        query: this.#queryClient !== undefined,
        router: this.#router !== undefined,
      },
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        description: String(tool.description ?? ''),
        ...(tool.inputSchema !== undefined
          ? { inputSchema: bounded(tool.inputSchema, { depth: 10 }) }
          : {}),
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
    }
  }

  #dial(): void {
    if (!this.#wanted) return
    let socket: SocketLike
    try {
      socket = this.#createSocket(this.#url)
    } catch {
      this.#retry()
      return
    }
    this.#socket = socket
    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#open = true
      this.#retryMs = 500
      const session = this.info()
      this.#sentMeta = JSON.stringify(session)
      this.#send({ kind: 'hello', session })
      this.#flush()
    }
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      void this.#onMessage(String(event.data))
    }
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#open = false
      this.#socket = undefined
      this.#retry()
    }
  }

  #retry(): void {
    if (!this.#wanted) return
    setTimeout(() => this.#dial(), this.#retryMs)
    this.#retryMs = Math.min(this.#retryMs * 2, 5000)
  }

  async #onMessage(text: string): Promise<void> {
    let message: ServerMessage
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.kind !== 'call') return
    this.#discover()
    const handler = this.#handlers[message.method]
    try {
      if (!handler) throw new Error(missing(message.method))
      const value = await handler((message.args ?? {}) as Record<string, any>)
      this.#send({ kind: 'result', id: message.id, ok: true, value })
    } catch (error) {
      this.#send({
        kind: 'result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #send(message: PageMessage): void {
    if (!this.#open || !this.#socket) return
    try {
      this.#socket.send(JSON.stringify(message))
    } catch {
      // The close handler reconnects; unsent entries stay queued.
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      this.#flush()
    }, FLUSH_MS)
  }

  #flush(): void {
    if (!this.#open) return
    const session = this.info()
    const meta = JSON.stringify(session)
    if (meta !== this.#sentMeta) {
      this.#sentMeta = meta
      const { id: _id, startedAt: _startedAt, ...patch } = session
      this.#send({ kind: 'meta', patch })
    }
    if (this.#unsent.length === 0) return
    const entries = this.#unsent
    this.#unsent = []
    this.#send({ kind: 'entries', entries })
  }
}

function missing(method: string): string {
  if (method.startsWith('query.') || method.startsWith('mutation.')) {
    return 'This page has no QueryClient connected. Pass it to connect({ queryClient }) or set window.__TANSTACK_QUERY_CLIENT__.'
  }
  if (method.startsWith('router.')) {
    return 'This page has no TanStack Router connected. Pass it to connect({ router }).'
  }
  return `Unknown method ${method}`
}

const GLOBAL_KEY = '__TANSTACK_DEVTOOLS_MCP__'

/** One bridge per page, even when this module is loaded twice. */
function bridge(): Bridge {
  const globals = globalThis as any
  globals[GLOBAL_KEY] ??= new Bridge()
  return globals[GLOBAL_KEY]
}

/**
 * Connects this page to the `tanstack-devtools-mcp` server, so an agent can
 * read its queries, router and registered tools. Safe to call more than once:
 * later calls add what they pass. Returns a function that disconnects.
 */
export function connect(options: ConnectOptions = {}): () => void {
  return bridge().connect(options)
}

// Loading the module is enough to collect the tools libraries register, even
// the ones registered before `connect` runs.
if (typeof document !== 'undefined') bridge()
