import { BRIDGE_PATH, DEFAULT_PORT, GLOBAL_KEY, PROTOCOL } from '../protocol.js'
import { captureTools, recordConsole, recordNetwork } from './capture.js'
import { documentFacts } from './document.js'
import { bounded, brief } from './serialize.js'
import { ignoreFrames } from './stack.js'
import type {
  PageEntry,
  PageMessage,
  ServerMessage,
  SessionInfo,
} from '../protocol.js'
import type { CapturedTool, NetworkRecorder } from './capture.js'
import type {
  AttachedSource,
  PageSource,
  RequestAnnotator,
  SourceContext,
} from './source.js'
import type { Handlers, Recorder } from './types.js'

export { ago, bounded, brief, diff, drill } from './serialize.js'
export { appFrames, here, parseStack } from './stack.js'
export { documentFacts } from './document.js'
export { hydrationMismatch } from './capture.js'
export type { Mismatch } from './capture.js'
export type { DocumentFacts } from './document.js'
export type { Bounds, Change } from './serialize.js'
export type {
  AttachedSource,
  FindEnv,
  PageSource,
  RequestAnnotator,
  SourceContext,
} from './source.js'
export type { Handler, Handlers, Recorder } from './types.js'
export type { Frame, PageEntry } from '../protocol.js'

/** The part of `WebSocket` the bridge uses. */
export interface SocketLike {
  send: (data: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

export interface ConnectOptions {
  /** The server's bridge URL. Defaults to the standalone server's address. */
  url?: string
  /** The libraries to watch. Later calls add to the ones already known. */
  sources?: ReadonlyArray<PageSource>
  /**
   * Instances handed over by the app, by source key. A source that can find
   * its instance by itself needs none.
   */
  instances?: Record<string, unknown>
  /** Record `console.error`, `console.warn` and uncaught errors. Default true. */
  console?: boolean
  /** Record `fetch` and `XMLHttpRequest` calls. Default true. */
  network?: boolean
  /** Stack frames that are not the app's, as regular expression sources. */
  ignoreFrames?: ReadonlyArray<string>
  /** Same-origin request paths that are not the app's, likewise. */
  ignoreRequests?: ReadonlyArray<string>
  /** Replaces `new WebSocket(url)`, for tests. */
  createSocket?: (url: string) => SocketLike
}

const MAX_UNSENT = 2000
const FLUSH_MS = 25

function randomId(): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A registered source and, once it has what it needs, what it attached. */
interface Slot {
  source: PageSource
  instance: unknown
  /** An instance the app handed over is never replaced by a found one. */
  pinned: boolean
  attached: AttachedSource | undefined
  /** Why `attach` threw, when it did. Kept so it is said, and not retried. */
  failed?: string
}

class Bridge {
  readonly id = randomId()
  readonly startedAt = Date.now()
  readonly tools = new Map<string, CapturedTool>()

  #seq = 0
  #unsent: Array<PageEntry> = []
  #slots = new Map<string, Slot>()
  #watched = new Set<string>()
  #network: NetworkRecorder | undefined
  /** Annotators registered before the network recorder exists. */
  #annotators = new Set<RequestAnnotator>()
  #stops = new Map<string, () => void>()
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
  /** Milliseconds between the page starting to load and this bridge existing. */
  #lateBy = typeof performance === 'undefined' ? 0 : Math.round(performance.now())

  constructor() {
    captureTools(this.tools, () => this.#scheduleFlush())
    this.#rebuild()
  }

  record: Recorder = (entry) => {
    this.#unsent.push({ ...entry, seq: ++this.#seq, t: Date.now() })
    if (this.#unsent.length > MAX_UNSENT) this.#unsent.shift()
    this.#scheduleFlush()
  }

  #context: SourceContext = {
    record: (entry) => this.record(entry),
    instanceOf: (key) => this.#slots.get(key)?.instance,
    network: {
      annotate: (annotator) => {
        this.#annotators.add(annotator)
        const remove = this.#network?.annotate(annotator)
        return () => {
          this.#annotators.delete(annotator)
          remove?.()
        }
      },
    },
  }

  connect(options: ConnectOptions): () => void {
    if (options.createSocket) this.#createSocket = options.createSocket
    if (options.ignoreFrames) ignoreFrames(options.ignoreFrames)

    if (options.console !== false && !this.#stops.has('console')) {
      this.#stops.set('console', recordConsole(this.record))
    }
    if (options.network !== false && !this.#network) {
      const network = recordNetwork(this.record, {
        ...(options.ignoreRequests ? { ignore: options.ignoreRequests } : {}),
      })
      for (const annotator of this.#annotators) network.annotate(annotator)
      this.#network = network
      this.#stops.set('network', () => {
        network.stop()
        this.#network = undefined
      })
    }

    for (const source of options.sources ?? []) this.#register(source)
    // A source that needs no instance starts at once, and starts again when
    // the page reconnects after a disconnect.
    for (const slot of this.#slots.values()) {
      if (!slot.source.instance && !slot.attached && slot.failed === undefined) {
        slot.attached = this.#start(slot, undefined)
      }
    }
    this.#rebuild()
    for (const [key, instance] of Object.entries(options.instances ?? {})) {
      const slot = this.#slots.get(key)
      if (slot && instance !== undefined && slot.source.instance?.accepts(instance)) {
        this.#attach(slot, instance, true)
      }
    }

    this.#discover()
    // The app may create its router or client after this call.
    for (const delay of [250, 1000, 3000]) {
      setTimeout(() => {
        if (this.#wanted) this.#discover()
      }, delay)
    }

    // A later call without a URL keeps the one already in use, so the app's
    // own connect() does not undo the URL the host injected.
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
    for (const slot of this.#slots.values()) {
      slot.attached?.stop?.()
      slot.attached = undefined
      slot.instance = undefined
      slot.pinned = false
      delete slot.failed
    }
    for (const stop of this.#stops.values()) stop()
    this.#stops.clear()
    this.#rebuild()
    this.#socket?.close()
    this.#socket = undefined
    this.#open = false
  }

  #register(source: PageSource): void {
    if (this.#slots.has(source.key)) return
    const slot: Slot = { source, instance: undefined, pinned: false, attached: undefined }
    this.#slots.set(source.key, slot)
    for (const name of source.instance?.globals ?? []) this.#watch(name)
  }

  /**
   * Calls a source's `attach`. A source that throws is left off and the
   * reason recorded: it must not take the page's other sources down with it.
   */
  #start(slot: Slot, instance: unknown): AttachedSource | undefined {
    delete slot.failed
    try {
      return slot.source.attach(instance, this.#context)
    } catch (error) {
      slot.failed = error instanceof Error ? error.message : String(error)
      this.record({
        source: slot.source.key,
        type: 'attach-failed',
        summary: `the ${slot.source.key} source could not start: ${brief(slot.failed, 200)}`,
        problem: true,
      })
      return undefined
    }
  }

  /**
   * Notices the moment a library puts its instance on `window`, so recording
   * starts before the first loader or query runs, not at the next check.
   */
  #watch(name: string): void {
    if (this.#watched.has(name)) return
    this.#watched.add(name)
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

  #attach(slot: Slot, instance: unknown, pinned: boolean): void {
    if (slot.instance === instance) return
    const { source } = slot
    if (slot.attached) {
      // The same page load built a second one. The rules decide whether a
      // hot update explains it.
      this.record({
        source: source.key,
        type: 'replaced',
        summary: `the app created a new ${source.instance?.label ?? source.key}`,
      })
      slot.attached.stop?.()
    }
    slot.instance = instance
    slot.pinned = pinned
    slot.attached = this.#start(slot, instance)
    this.#rebuild()
  }

  /** Lets each source look for the instance its library, or the app, exposed. */
  #discover(): void {
    const env = {
      global: globalThis as Record<string, any>,
      instanceOf: this.#context.instanceOf,
    }
    // One source may find its instance through another's (a client kept in
    // a router's context), whatever order they were listed in. So look again
    // for as long as a pass attached something.
    for (let pass = 0; pass < this.#slots.size; pass++) {
      let attached = false
      for (const slot of this.#slots.values()) {
        const find = slot.source.instance?.find
        if (!find || slot.pinned) continue
        let found: unknown
        try {
          found = find(env)
        } catch {
          found = undefined
        }
        if (found === undefined || found === slot.instance) continue
        this.#attach(slot, found, false)
        attached = true
      }
      if (!attached) break
    }
  }

  #rebuild(): void {
    const fromSources: Handlers = {}
    for (const slot of this.#slots.values()) {
      Object.assign(fromSources, slot.attached?.handlers)
    }
    this.#handlers = {
      ...fromSources,
      'page.wait': (args) => this.#wait(args),
      'page.overview': () => this.#overview(),
      'page.facts': () => this.#facts(),
      'tool.call': (args) => this.#callTool(args),
    }
    this.#scheduleFlush()
  }

  #idle(): boolean {
    for (const slot of this.#slots.values()) {
      if (slot.attached?.idle?.() === false) return false
    }
    return (this.#network?.pending() ?? 0) === 0
  }

  #overview() {
    const sources: Record<string, unknown> = {}
    for (const slot of this.#slots.values()) {
      // A source that wants an instance and has none says so with null.
      if (slot.attached?.overview) sources[slot.source.key] = slot.attached.overview()
      else if (slot.source.instance && !slot.attached) sources[slot.source.key] = null
    }
    return {
      url: typeof location === 'undefined' ? '' : location.href,
      title: typeof document === 'undefined' ? '' : document.title,
      idle: this.#idle(),
      ...sources,
      pendingRequests: this.#network?.pending() ?? 0,
      // Named, so "not idle" can be explained. One open far longer than the
      // rest is no longer counted as pending, and is usually stuck.
      ...(this.#network && this.#network.waiting().length > 0
        ? { waitingOn: this.#network.waiting() }
        : {}),
      tools: this.tools.size,
    }
  }

  /** The overview, plus how each library is set up. For the server's rules. */
  #facts() {
    const facts: Record<string, unknown> = {}
    for (const slot of this.#slots.values()) {
      if (slot.attached?.facts) facts[slot.source.key] = slot.attached.facts()
    }
    // The document's own state, under a key no source may take.
    const page = documentFacts()
    if (page) facts.document = page
    return { ...this.#overview(), facts, connectedAfterLoad: this.#lateBy }
  }

  /** Resolves once every source and the network have settled. */
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
    const has: Record<string, boolean> = {}
    for (const slot of this.#slots.values()) {
      if (slot.source.instance) has[slot.source.key] = slot.attached !== undefined
    }
    return {
      id: this.id,
      url: typeof location === 'undefined' ? '' : location.href,
      title: typeof document === 'undefined' ? '' : document.title,
      startedAt: this.startedAt,
      protocol: PROTOCOL,
      has,
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
    try {
      this.#discover()
      const handler = this.#handlers[message.method]
      if (!handler) throw new Error(this.#missing(message.method))
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

  /** Why a method has no handler: usually its source found no instance. */
  #missing(method: string): string {
    const namespace = method.split('.')[0] ?? ''
    for (const slot of this.#slots.values()) {
      const owns =
        slot.source.methods?.includes(namespace) ?? slot.source.key === namespace
      if (!owns || slot.attached) continue
      if (slot.failed !== undefined) {
        return `The ${slot.source.key} source could not start on this page: ${slot.failed}`
      }
      if (slot.source.instance) return slot.source.instance.missing
    }
    return `Unknown method ${method}`
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

/** One bridge per page, even when this module is loaded twice. */
function bridge(): Bridge {
  const globals = globalThis as any
  globals[GLOBAL_KEY] ??= new Bridge()
  return globals[GLOBAL_KEY]
}

/**
 * Connects this page to the loopsight server, so an agent can read what the
 * given sources see. Safe to call more than once: later calls add what they
 * pass. Returns a function that disconnects.
 */
export function connect(options: ConnectOptions = {}): () => void {
  // A worker has a global scope and can open a socket, but it is not a page.
  if (typeof document === 'undefined' && !options.createSocket) return () => {}
  return bridge().connect(options)
}

// Loading the module is enough to collect the tools libraries register, even
// the ones registered before `connect` runs.
if (typeof document !== 'undefined') bridge()
