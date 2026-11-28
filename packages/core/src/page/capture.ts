import { noteFailedImage } from './document.js'
import { brief } from './serialize.js'
import { appFrames, here } from './stack.js'
import { TAG_TIMING } from '../protocol.js'
import type { Frame } from '../protocol.js'
import type { RequestAnnotator } from './source.js'
import type { Recorder } from './types.js'

/** A tool a library registered through WebMCP's `registerTool`. */
export interface CapturedTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
  execute: (input: unknown, options: { signal: AbortSignal }) => unknown
}

interface ModelContext {
  registerTool: (tool: any, options?: any) => unknown
  unregisterTool?: (name: string) => unknown
}

function isTool(value: any): value is CapturedTool {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    typeof value.execute === 'function'
  )
}

/**
 * Collects the tools registered with WebMCP (`document.modelContext`), which
 * is where libraries put the tools they offer to agents.
 *
 * A browser with WebMCP keeps its own registry, and its `registerTool` is
 * wrapped so the tools are collected too. A browser without it gets a minimal
 * `document.modelContext`, so the same library code has somewhere to register.
 */
export function captureTools(
  tools: Map<string, CapturedTool>,
  onChange: () => void,
): void {
  const add = (tool: unknown, options: any) => {
    if (!isTool(tool)) return
    const signal: unknown = options?.signal
    if (signal instanceof AbortSignal) {
      if (signal.aborted) return
      signal.addEventListener(
        'abort',
        () => {
          if (tools.get(tool.name) !== tool) return
          tools.delete(tool.name)
          onChange()
        },
        { once: true },
      )
    }
    tools.set(tool.name, tool)
    onChange()
  }
  const remove = (name: string) => {
    if (tools.delete(name)) onChange()
  }

  const hosts: Array<any> = [
    typeof document === 'undefined' ? undefined : document,
    typeof navigator === 'undefined' ? undefined : navigator,
  ]
  const native: ModelContext | undefined = hosts
    .map((host) => host?.modelContext)
    .find((context) => typeof context?.registerTool === 'function')

  if (native) {
    const register = native.registerTool.bind(native)
    native.registerTool = (tool, options) => {
      const result = register(tool, options)
      // Collect it only once the browser has accepted it.
      Promise.resolve(result).then(
        () => add(tool, options),
        () => {},
      )
      return result
    }
    if (typeof native.unregisterTool === 'function') {
      const unregister = native.unregisterTool.bind(native)
      native.unregisterTool = (name) => {
        remove(name)
        return unregister(name)
      }
    }
    return
  }

  if (typeof document === 'undefined') return
  const shim: ModelContext = {
    registerTool(tool, options) {
      if (!isTool(tool)) {
        return Promise.reject(new TypeError('A tool needs name and execute'))
      }
      if (tools.has(tool.name)) {
        return Promise.reject(
          new DOMException(
            `A tool named ${tool.name} is already registered`,
            'InvalidStateError',
          ),
        )
      }
      add(tool, options)
      return Promise.resolve()
    },
    unregisterTool(name) {
      remove(name)
    },
  }
  Object.defineProperty(document, 'modelContext', {
    value: shim,
    configurable: true,
  })
}

/**
 * Records `console.error`, `console.warn` and uncaught errors, with the app
 * code they came from. A message repeated within five seconds is recorded
 * once, then once more with the count.
 */
/** What React says differed when hydration failed, read from its message. */
export interface Mismatch {
  /** The element the difference is on, as React printed its opening. */
  element?: string
  /** What the browser rendered, one changed line each. */
  client: Array<string>
  /** What the server had sent in its place. */
  server: Array<string>
  /** The components around it, outermost first. */
  within: Array<string>
}

const short = (line: string) => (line.length > 180 ? `${line.slice(0, 180)}…` : line)

/**
 * React ends a hydration error with the component tree and marks the lines
 * that differ: `+` for the browser's render, `-` for the server's HTML. A
 * log line cut to a few hundred characters loses exactly that part.
 */
export function hydrationMismatch(text: string): Mismatch | undefined {
  if (!/hydrat/i.test(text)) return undefined
  const all = text.split('\n')
  // The tree is indented; the list of usual causes above it is not, and its
  // bullets start with a dash too.
  const tree = all.findIndex((line) => /^\s+(?:\.\.\.|<)/.test(line))
  if (tree < 0) return undefined
  const lines = all.slice(tree)
  const first = lines.findIndex((line) => /^[+-]\s{2,}\S/.test(line))
  if (first < 0) return undefined
  const client: Array<string> = []
  const server: Array<string> = []
  for (const line of lines.slice(first)) {
    const mark = /^([+-])\s{2,}(\S.*)$/.exec(line)
    if (!mark) continue
    const list = mark[1] === '+' ? client : server
    if (list.length < 4) list.push(short(mark[2]!.trim()))
  }
  const within: Array<string> = []
  let element: string | undefined
  for (const line of lines.slice(0, first)) {
    const tag = /^\s+<([A-Za-z][\w.]*)/.exec(line)
    if (!tag) continue
    if (/^[A-Z]/.test(tag[1]!)) {
      if (within.at(-1) !== tag[1]) within.push(tag[1]!)
    }
    element = short(line.trim())
  }
  return {
    ...(element !== undefined ? { element } : {}),
    client,
    server,
    within: within.slice(-6),
  }
}

/** The whole text of what was logged, before anything is cut. */
function whole(args: Array<unknown>): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : ''))
    .join(' ')
}

export function recordConsole(record: Recorder): () => void {
  const levels = ['error', 'warn'] as const
  const originals = { error: console.error, warn: console.warn }
  const repeats = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>()

  const note = (type: string, summary: string, frames: Array<Frame>, detail?: unknown) => {
    const id = `${type}\n${summary}`
    const seen = repeats.get(id)
    if (seen) {
      seen.count += 1
      return
    }
    const timer = setTimeout(() => {
      const entry = repeats.get(id)
      repeats.delete(id)
      if (entry && entry.count > 0) {
        record({
          source: 'console',
          type: 'repeat',
          summary: `(repeated ${entry.count} more times in 5 s) ${summary.slice(0, 160)}`,
        })
      }
    }, 5000)
    repeats.set(id, { count: 0, timer })
    record({
      source: 'console',
      type,
      ...(type !== 'warn' ? { problem: true as const } : {}),
      summary,
      ...(frames.length > 0 ? { frames } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  /** An Error among the arguments says more than where console was called. */
  const framesFor = (args: Array<unknown>) => {
    const error = args.find((arg) => arg instanceof Error) as Error | undefined
    const fromError = error ? appFrames(error.stack) : []
    return fromError.length > 0 ? fromError : here()
  }

  for (const level of levels) {
    console[level] = (...args: Array<unknown>) => {
      try {
        const mismatch = hydrationMismatch(whole(args))
        note(
          level,
          args.map((arg) => brief(arg, 400)).join(' ').slice(0, 1200),
          framesFor(args),
          mismatch ? { mismatch } : undefined,
        )
      } catch {
        // Recording must never break the app's own logging.
      }
      originals[level].apply(console, args)
    }
  }
  const onError = (event: ErrorEvent) => {
    const mismatch = hydrationMismatch(whole([event.error ?? event.message]))
    const at = event.filename
      ? { file: event.filename, line: event.lineno, column: event.colno }
      : undefined
    note(
      'uncaught',
      brief(event.error ?? event.message, 800),
      appFrames(event.error?.stack),
      mismatch ? { ...at, mismatch } : at,
    )
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    note('unhandledrejection', brief(event.reason, 800), appFrames(event.reason?.stack))
  }
  const target = typeof window === 'undefined' ? undefined : window
  target?.addEventListener('error', onError)
  target?.addEventListener('unhandledrejection', onRejection)
  return () => {
    for (const level of levels) console[level] = originals[level]
    for (const entry of repeats.values()) clearTimeout(entry.timer)
    repeats.clear()
    target?.removeEventListener('error', onError)
    target?.removeEventListener('unhandledrejection', onRejection)
  }
}

/** FNV-1a, as hex: enough to tell two URLs apart without keeping them. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}.${text.length}`
}

function cut(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…(+${text.length - chars} chars)`
}

/** A request older than this no longer holds up `wait_for_idle`. */
const PENDING_WINDOW_MS = 10_000

export interface NetworkRecorder {
  /** Requests started in the last ten seconds that have not finished. */
  pending: () => number
  /** Requests still in flight, oldest first, and how long each has been. */
  waiting: () => Array<{ request: string; forMs: number }>
  /** Adds a function that renames requests it understands. */
  annotate: (annotator: RequestAnnotator) => () => void
  stop: () => void
}

export interface NetworkOptions {
  /**
   * Same-origin paths to leave out: the dev server's own requests. Given by
   * the host, as regular expression sources.
   */
  ignore?: ReadonlyArray<string>
}

/** The host's tag for a request, from the `Server-Timing` header of its answer. */
function tagIn(header: string | null): string | undefined {
  if (!header) return undefined
  const match = new RegExp(`(?:^|,)\\s*${TAG_TIMING}\\s*;\\s*desc="?([\\w.-]{1,128})"?`).exec(header)
  return match?.[1]
}

const DOCUMENT_RECORDED = Symbol.for('loopsight.document')

/**
 * Records the request for the document itself, once per page load: the one
 * request the page did not make from code, and the one a server render
 * holds up.
 */
function recordDocument(record: Recorder): void {
  try {
    const marks = window as unknown as Record<symbol, boolean>
    if (marks[DOCUMENT_RECORDED]) return
    const navigation = performance.getEntriesByType?.('navigation')[0] as
      | (PerformanceNavigationTiming & { responseStatus?: number })
      | undefined
    if (!navigation || !(navigation.responseStart > 0)) return
    marks[DOCUMENT_RECORDED] = true
    const status = navigation.responseStatus
    const tag = (navigation.serverTiming ?? []).find((timing) => timing.name === TAG_TIMING)
    const wait = Math.round(navigation.responseStart - navigation.requestStart)
    record({
      source: 'network',
      type: 'document',
      key: location.pathname,
      summary: `GET ${cut(location.pathname + location.search, 300)} → ${status || 'loaded'} (the document; first byte after ${wait} ms)`,
      dur: Math.round(navigation.responseEnd - navigation.requestStart),
      detail: {
        kind: 'document',
        ...(status ? { status } : {}),
        wait,
        ...(tag?.description ? { tag: tag.description } : {}),
      },
    })
  } catch {
    // The page works the same without this entry.
  }
}

/**
 * Records `fetch` and `XMLHttpRequest` calls: method, URL, status and time.
 * Bodies are never read, and of the headers only the host's tag for the
 * request, in the answer from the app's own server.
 */
export function recordNetwork(
  record: Recorder,
  options: NetworkOptions = {},
): NetworkRecorder {
  if (typeof window === 'undefined') {
    return { pending: () => 0, waiting: () => [], annotate: () => () => {}, stop: () => {} }
  }
  const open = new Map<number, number>()
  /** What each open request is, for saying what the page still waits on. */
  const labels = new Map<number, string>()
  const ignored = (options.ignore ?? []).map((source) => new RegExp(source))
  const annotators = new Set<RequestAnnotator>()
  let nextId = 1

  const describe = (raw: string) => {
    try {
      const url = new URL(raw, location.href)
      const same = url.origin === location.origin
      if (same && ignored.some((pattern) => pattern.test(url.pathname))) return undefined
      // The whole URL, as a short fingerprint: what is shown is cut short,
      // and two requests are the same only when all of it matches.
      const id = fingerprint(url.href)
      for (const annotate of annotators) {
        const named = annotate(url, same)
        if (named) return { key: named.key, shown: cut(named.shown, 300), id, same }
      }
      return {
        key: url.pathname,
        shown: cut((same ? '' : url.origin) + url.pathname + url.search, 300),
        id,
        same,
      }
    } catch {
      return { key: raw.slice(0, 120), shown: raw.slice(0, 300), id: fingerprint(raw), same: false }
    }
  }

  const begin = (label: string) => {
    const id = nextId++
    open.set(id, performance.now())
    labels.set(id, label)
    return id
  }
  const finish = (
    id: number,
    kind: 'fetch' | 'xhr',
    method: string,
    target: { key: string; shown: string; id: string },
    outcome: { status: number; tag?: string | undefined } | { failure: string; aborted?: boolean },
    frames: Array<Frame>,
  ) => {
    const started = open.get(id)
    open.delete(id)
    labels.delete(id)
    const dur = started === undefined ? undefined : Math.round(performance.now() - started)
    const failed = 'failure' in outcome
    const status = failed ? 0 : outcome.status
    // A cancelled request is the app changing its mind, not a failure.
    const aborted = failed && outcome.aborted === true
    record({
      source: 'network',
      type: aborted ? 'aborted' : failed ? 'failed' : status >= 400 ? 'error' : 'ok',
      ...(!aborted && (failed || status >= 400) ? { problem: true as const } : {}),
      key: target.key,
      summary: `${method} ${target.shown} → ${aborted ? 'aborted' : failed ? outcome.failure : status}`,
      ...(dur !== undefined ? { dur } : {}),
      detail: {
        kind,
        ...(failed ? {} : { status }),
        id: `${method} ${target.id}`,
        // The host's name for this request, which the server's own records
        // of it carry too.
        ...(!failed && outcome.tag ? { tag: outcome.tag } : {}),
      },
      ...(frames.length > 0 ? { frames } : {}),
    })
  }

  recordDocument(record)

  const originalFetch = window.fetch
  const patchedFetch: typeof window.fetch = function (this: unknown, input, init) {
    const promise = originalFetch.call(this as typeof globalThis, input, init)
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const target = describe(raw)
      if (target) {
        const method = (
          init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
        ).toUpperCase()
        const frames = here()
        const id = begin(`${method} ${target.shown}`)
        promise.then(
          (response) =>
            finish(
              id,
              'fetch',
              method,
              target,
              { status: response.status, tag: target.same ? tagIn(response.headers.get('server-timing')) : undefined },
              frames,
            ),
          (error) =>
            finish(
              id,
              'fetch',
              method,
              target,
              { failure: brief(error, 120), aborted: error?.name === 'AbortError' },
              frames,
            ),
        )
      }
    } catch {
      // The app's request goes on untouched whatever happens here.
    }
    return promise
  }
  window.fetch = patchedFetch

  const xhr = typeof XMLHttpRequest === 'undefined' ? undefined : XMLHttpRequest.prototype
  const originalOpen = xhr?.open
  const originalSend = xhr?.send
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  if (xhr && originalOpen && originalSend) {
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: Array<any>) {
      opened.set(this, { method: String(method).toUpperCase(), url: String(url) })
      return (originalOpen as any).call(this, method, url, ...rest)
    } as typeof xhr.open
    xhr.send = function (this: XMLHttpRequest, body?: any) {
      try {
        const info = opened.get(this)
        const target = info ? describe(info.url) : undefined
        if (info && target) {
          const frames = here()
          const id = begin(`${info.method} ${target.shown}`)
          this.addEventListener(
            'loadend',
            () =>
              finish(
                id,
                'xhr',
                info.method,
                target,
                this.status === 0
                  ? { failure: 'no response' }
                  : {
                      status: this.status,
                      // Asked only of the app's own server: for another
                      // origin the browser logs a refusal.
                      tag: target.same ? tagIn(this.getResponseHeader('server-timing')) : undefined,
                    },
                frames,
              ),
            { once: true },
          )
        }
      } catch {
        // As above.
      }
      return originalSend.call(this, body)
    }
  }

  // A script or stylesheet the browser could not load never passes through
  // `fetch`. Its `error` event does not bubble, so it is caught on the way
  // down. A failed image is only remembered, for the page's own account of
  // itself: an app can have many, and they are not requests the code made.
  const onResourceError = (event: Event) => {
    try {
      const element = event.target
      if (!(element instanceof Element)) return
      if (element instanceof HTMLImageElement) {
        noteFailedImage(element)
        return
      }
      const raw =
        element instanceof HTMLScriptElement
          ? element.src
          : element instanceof HTMLLinkElement && /stylesheet|modulepreload/i.test(element.rel)
            ? element.href
            : ''
      if (!raw) return
      const target = describe(raw)
      if (!target) return
      record({
        source: 'network',
        type: 'failed',
        problem: true,
        key: target.key,
        summary: `GET ${target.shown} → the ${element instanceof HTMLScriptElement ? 'script' : 'stylesheet'} did not load`,
        detail: { kind: 'resource', id: `GET ${target.id}` },
      })
    } catch {
      // As above.
    }
  }
  window.addEventListener('error', onResourceError, true)

  return {
    pending: () => {
      const cutoff = performance.now() - PENDING_WINDOW_MS
      let count = 0
      for (const started of open.values()) if (started >= cutoff) count += 1
      return count
    },
    waiting: () => {
      const now = performance.now()
      return [...open.entries()]
        .map(([id, started]) => ({
          request: (labels.get(id) ?? '').slice(0, 200),
          forMs: Math.round(now - started),
        }))
        .sort((a, b) => b.forMs - a.forMs)
        .slice(0, 10)
    },
    annotate: (annotator) => {
      annotators.add(annotator)
      return () => annotators.delete(annotator)
    },
    stop: () => {
      window.removeEventListener('error', onResourceError, true)
      if (window.fetch === patchedFetch) window.fetch = originalFetch
      if (xhr && originalOpen && originalSend) {
        xhr.open = originalOpen
        xhr.send = originalSend
      }
    },
  }
}
