import { bounded, brief } from './serialize.js'
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
 * is where `@tanstack/devtools-webmcp` puts a library's tools.
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

/** Records `console.error`, `console.warn` and uncaught errors. */
export function recordConsole(record: Recorder): () => void {
  const levels = ['error', 'warn'] as const
  const originals = { error: console.error, warn: console.warn }
  for (const level of levels) {
    console[level] = (...args: Array<unknown>) => {
      try {
        record({
          source: 'console',
          type: level,
          summary: args.map((arg) => brief(arg, 400)).join(' ').slice(0, 1200),
        })
      } catch {
        // Recording must never break the app's own logging.
      }
      originals[level].apply(console, args)
    }
  }
  const onError = (event: ErrorEvent) => {
    record({
      source: 'console',
      type: 'uncaught',
      summary: brief(event.error ?? event.message, 800),
      detail: { file: event.filename, line: event.lineno, column: event.colno },
    })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    record({
      source: 'console',
      type: 'unhandledrejection',
      summary: brief(event.reason, 800),
    })
  }
  const target = typeof window === 'undefined' ? undefined : window
  target?.addEventListener('error', onError)
  target?.addEventListener('unhandledrejection', onRejection)
  return () => {
    for (const level of levels) console[level] = originals[level]
    target?.removeEventListener('error', onError)
    target?.removeEventListener('unhandledrejection', onRejection)
  }
}

/**
 * Records the events TanStack Devtools plugins emit on its event bus, when
 * the devtools panel is mounted on the page.
 */
export function recordBus(record: Recorder): () => void {
  if (typeof window === 'undefined') return () => {}
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail ?? {}
    record({
      source: 'bus',
      type: String(detail.type),
      ...(typeof detail.pluginId === 'string' ? { key: detail.pluginId } : {}),
      summary: String(detail.type),
      detail: bounded(detail.payload, { depth: 4, items: 20, chars: 500 }),
    })
  }
  window.addEventListener('tanstack-devtools-global', onEvent)
  return () => window.removeEventListener('tanstack-devtools-global', onEvent)
}
