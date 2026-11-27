import type { Hub, LogEntry, Session } from '@loopsight/core/server'
import type { LogRecord, Span, Value } from './otlp.js'

/** One span of a trace as an entry keeps it: flat, in tree order. */
export interface Node {
  name: string
  ms: number
  /** Milliseconds after the trace began. */
  at: number
  depth: number
  /** Present for a call out of the server: the request it made. */
  call?: string
  /** What else identifies the work: an operation name, a cache key. */
  about?: string
  /** HTTP status of an outbound call, where the span says. */
  status?: number
  error?: string
  /** True when the work was stopped before it finished. */
  cut?: true
  /**
   * True for work recorded in another trace that ran while the step above
   * it waited: a shared load, started once for several requests, is not a
   * child of any of them. Placed here by its timing, not by the server.
   */
  alongside?: true
}

/** The `detail` of a `server` / `trace` entry. */
export interface TraceDetail {
  /** The number of the request entry this work was done for. */
  request: number
  tag: string
  trace: string
  ms: number
  /** Calls out of the server, how many failed, and how many spans were cut short. */
  calls: number
  failed: number
  cut: number
  spans: Array<Node>
  /** Spans left out to keep the entry small. */
  more?: number
}

/** The `detail` of a `server` / `log` entry. */
export interface LogDetail {
  request: number
  tag: string
  level: LogRecord['level']
  /** The span the record was written in, by name, where known. */
  during?: string
  attrs: Record<string, Value>
}

const QUIET_MS = 300
const ROOT_WAIT_MS = 15_000
const FIND_EVERY_MS = 400
const FIND_FOR_MS = 25_000
const KEPT_SPANS = 150
const SAME_LOG = 5
const REMEMBERED = 3000

interface Open {
  spans: Array<Span>
  timer: ReturnType<typeof setTimeout> | undefined
  since: number
}

const quiet = (timer: ReturnType<typeof setTimeout>) => {
  timer.unref?.()
  return timer
}

function about(span: Span): Pick<Node, 'call' | 'about' | 'status'> {
  const attrs = span.attrs
  const out: Pick<Node, 'call' | 'about' | 'status'> = {}
  const method = attrs['http.request.method'] ?? attrs['http.method']
  const full = attrs['url.full'] ?? attrs['http.url']
  if (span.kind === 'client' || (method !== undefined && full !== undefined)) {
    let target = ''
    if (typeof full === 'string') {
      try {
        const url = new URL(full)
        target = url.host + url.pathname
      } catch {
        target = full
      }
    } else if (attrs['server.address'] !== undefined) {
      target = `${attrs['server.address']}${attrs['url.path'] ?? ''}`
    }
    const system = attrs['db.system.name'] ?? attrs['db.system'] ?? attrs['rpc.system'] ?? attrs['messaging.system']
    out.call =
      method !== undefined || target
        ? `${method ?? 'call'} ${target}`.trim()
        : system !== undefined
          ? `${system} ${attrs['db.operation.name'] ?? attrs['db.operation'] ?? attrs['rpc.method'] ?? ''}`.trim()
          : span.name
  }
  const status = attrs['http.response.status_code'] ?? attrs['http.status_code']
  if (typeof status === 'number') out.status = status
  const named =
    attrs['graphql.operation.name'] ??
    attrs['db.query.summary'] ??
    attrs['db.operation.name'] ??
    attrs['rpc.method'] ??
    attrs['cache.key'] ??
    attrs['messaging.destination.name']
  if (named !== undefined) out.about = String(named).slice(0, 120)
  return out
}

/** Whether the runtime says it stopped the work, in the ways runtimes say it. */
function wasCut(span: Span): boolean {
  return (
    span.attrs['effect.fiber.interrupted'] === true ||
    span.attrs['span.cancelled'] === true ||
    /\b(?:interrupt|cancel|abort)/i.test(span.error ?? '')
  )
}

function byParent(spans: ReadonlyArray<Span>): Map<string | undefined, Array<Span>> {
  const ids = new Set(spans.map((span) => span.spanId))
  const children = new Map<string | undefined, Array<Span>>()
  for (const span of spans) {
    const parent = span.parentId !== undefined && ids.has(span.parentId) ? span.parentId : undefined
    children.set(parent, [...(children.get(parent) ?? []), span])
  }
  return children
}

/** The top-level span that lasted longest: a trace cut into batches can have several. */
const rootOf = (children: Map<string | undefined, Array<Span>>) =>
  [...(children.get(undefined) ?? [])].sort((a, b) => b.ms - a.ms)[0]

const ALONGSIDE_FLOOR_MS = 200
const ALONGSIDE_KEPT = 8

/**
 * The spans of one trace as a flat list in tree order, roots first.
 *
 * `others` are traces tied to no request. One of them is shown under a step
 * that has nothing below it when it ran for most of the time that step
 * took and ended no later: what the step was waiting for.
 */
export function flatten(
  spans: ReadonlyArray<Span>,
  others: ReadonlyArray<ReadonlyArray<Span>> = [],
): { nodes: Array<Node>; root: Span | undefined; start: number } {
  const children = byParent(spans)
  const start = Math.min(...spans.map((span) => span.start))
  const nodes: Array<Node> = []
  const node = (span: Span, depth: number, alongside: boolean): Node => ({
    name: span.name,
    ms: Math.round(span.ms),
    at: Math.round(span.start - start),
    depth,
    ...about(span),
    ...(span.error !== undefined ? { error: span.error } : {}),
    ...(wasCut(span) ? { cut: true as const } : {}),
    ...(alongside ? { alongside: true as const } : {}),
  })
  const waitedOn = (leaf: Span, depth: number) => {
    // A call out of the server waits on the other service, not on this one.
    if (leaf.ms < ALONGSIDE_FLOOR_MS || about(leaf).call !== undefined) return
    const end = leaf.start + leaf.ms
    const near = others
      .map((other) => {
        const tree = byParent(other)
        const top = rootOf(tree)
        if (!top) return undefined
        const topEnd = top.start + top.ms
        const overlap = Math.min(end, topEnd) - Math.max(leaf.start, top.start)
        return overlap >= leaf.ms * 0.5 && topEnd <= end + 30 ? { tree, top, overlap } : undefined
      })
      .filter((item) => item !== undefined)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 2)
    for (const { tree, top } of near) {
      let kept = 0
      const walkOther = (span: Span, at: number) => {
        if (kept++ >= ALONGSIDE_KEPT) return
        nodes.push(node(span, at, true))
        for (const child of (tree.get(span.spanId) ?? []).sort((a, b) => a.start - b.start)) {
          walkOther(child, at + 1)
        }
      }
      walkOther(top, depth + 1)
    }
  }
  const walk = (parent: string | undefined, depth: number) => {
    for (const span of (children.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      nodes.push(node(span, depth, false))
      if ((children.get(span.spanId) ?? []).length === 0) waitedOn(span, depth)
      else walk(span.spanId, depth + 1)
    }
  }
  walk(undefined, 0)
  return { nodes, root: rootOf(children), start }
}

/**
 * What a server sent for one hub: traces still arriving, and the ones
 * waiting for the page to say which request they belong to.
 */
export class Store {
  /** True once anything has been received: a reason to start tagging requests. */
  received = false
  /** Records that could be tied to no page request, newest last. */
  readonly loose: Array<{ t: number; summary: string }> = []
  readonly #hub: Hub
  readonly #open = new Map<string, Open>()
  /** Which request each trace turned out to belong to. */
  readonly #tagOf = new Map<string, string>()
  readonly #spanNames = new Map<string, string>()
  readonly #said = new Map<string, Map<string, number>>()
  /** Whole traces tied to no request, kept for the requests that waited on them. */
  readonly #apart = new Map<string, Array<Span>>()

  constructor(hub: Hub) {
    this.#hub = hub
  }

  spans(spans: ReadonlyArray<Span>): void {
    this.received = true
    for (const span of spans) {
      this.#remember(this.#spanNames, span.spanId, span.name)
      const open = this.#open.get(span.traceId) ?? { spans: [], timer: undefined, since: Date.now() }
      open.spans.push(span)
      this.#open.set(span.traceId, open)
    }
    for (const traceId of new Set(spans.map((span) => span.traceId))) this.#schedule(traceId)
  }

  logs(records: ReadonlyArray<LogRecord>): void {
    this.received = true
    for (const record of records) {
      if (record.level !== 'warn' && record.level !== 'error') continue
      this.#find(
        () => this.#tagFor(record.attrs, record.traceId),
        (session, request, tag) => this.#addLog(session, request, tag, record),
        () => this.#keepLoose(record.t, `${record.level.toUpperCase()} ${record.body}`),
      )
    }
  }

  /** A trace is whole once its root has come; the root ends last. */
  #schedule(traceId: string): void {
    const open = this.#open.get(traceId)
    if (!open) return
    if (open.timer) clearTimeout(open.timer)
    const ids = new Set(open.spans.map((span) => span.spanId))
    const tag = this.#tagFor(undefined, traceId, open.spans)
    const whole = open.spans.some(
      (span) =>
        span.parentId === undefined ||
        // The parent a host made up when it tagged the request.
        (tag !== undefined && span.parentId === tag.slice(0, 16)) ||
        // A trace continued from another service: its parent never comes.
        (span.kind === 'server' && !ids.has(span.parentId)),
    )
    const wait = whole ? QUIET_MS : Math.max(QUIET_MS, ROOT_WAIT_MS - (Date.now() - open.since))
    open.timer = quiet(setTimeout(() => this.#settle(traceId), wait))
  }

  #settle(traceId: string): void {
    const open = this.#open.get(traceId)
    if (!open) return
    this.#open.delete(traceId)
    const spans = open.spans
    const tag = this.#tagFor(undefined, traceId, spans)
    if (tag === undefined) {
      const { root, start } = flatten(spans)
      if (!root) return
      this.#apart.set(traceId, spans)
      if (this.#apart.size > 400) this.#apart.delete(this.#apart.keys().next().value!)
      this.#keepLoose(start, `${root.name} ${Math.round(root.ms)} ms (${spans.length} spans)`)
      return
    }
    // Traces of their own that have come so far, settled or still arriving.
    const others = [
      ...this.#apart.values(),
      ...[...this.#open.entries()]
        .filter(([id, other]) => id !== traceId && this.#tagFor(undefined, id, other.spans) === undefined)
        .map(([, other]) => other.spans),
    ]
    const { nodes, root, start } = flatten(spans, others)
    if (!root) return
    this.#remember(this.#tagOf, traceId, tag)
    this.#find(
      () => tag,
      (session, request) => {
        const calls = nodes.filter((node) => node.call !== undefined)
        const failed = calls.filter((node) => node.error !== undefined || (node.status ?? 0) >= 400).length
        const cut = nodes.filter((node) => node.cut).length
        const detail: TraceDetail = {
          request: request.n,
          tag,
          trace: traceId,
          ms: Math.round(root.ms),
          calls: calls.length,
          failed,
          cut,
          spans: nodes.slice(0, KEPT_SPANS),
          ...(nodes.length > KEPT_SPANS ? { more: nodes.length - KEPT_SPANS } : {}),
        }
        const did = [
          calls.length > 0
            ? `${calls.length} outbound ${calls.length === 1 ? 'call' : 'calls'}${failed > 0 ? `, ${failed} failed` : ''}`
            : `${nodes.length} ${nodes.length === 1 ? 'span' : 'spans'}`,
          ...(cut > 0 ? [`${cut} cut short`] : []),
        ].join(', ')
        this.#hub.add(session, {
          t: Math.round(root.start + root.ms),
          source: 'server',
          type: 'trace',
          key: root.name,
          summary: `${root.name} took ${Math.round(root.ms)} ms on the server: ${did} (for #${request.n})`,
          dur: Math.round(root.ms),
          detail,
          ...(root.error !== undefined ? { problem: true as const } : {}),
        })
      },
      () => this.#keepLoose(start, `${root.name} ${Math.round(root.ms)} ms (${spans.length} spans)`),
    )
  }

  #addLog(session: Session, request: LogEntry, tag: string, record: LogRecord): void {
    const said = this.#said.get(session.info.id) ?? new Map<string, number>()
    this.#said.set(session.info.id, said)
    if (this.#said.size > 50) this.#said.delete(this.#said.keys().next().value!)
    const count = (said.get(record.body) ?? 0) + 1
    said.set(record.body, count)
    // A message a server repeats on every request would fill the log.
    if (count > SAME_LOG) return
    const during = record.spanId !== undefined ? this.#spanNames.get(record.spanId) : undefined
    const detail: LogDetail = {
      request: request.n,
      tag,
      level: record.level,
      ...(during !== undefined ? { during } : {}),
      attrs: record.attrs,
    }
    this.#hub.add(session, {
      t: Math.round(record.t),
      source: 'server',
      type: 'log',
      key: record.body.slice(0, 120),
      summary: `${record.level.toUpperCase()} ${record.body}${count === SAME_LOG ? ' (further copies are not recorded)' : ''} (for #${request.n})`,
      detail,
      ...(record.level === 'error' ? { problem: true as const } : {}),
    })
  }

  /** The tag of the request some record belongs to, if it names one. */
  #tagFor(
    attrs: Record<string, Value> | undefined,
    traceId: string | undefined,
    spans: ReadonlyArray<Span> = [],
  ): string | undefined {
    const tags = this.#hub.tags
    if (traceId !== undefined) {
      if (tags.has(traceId)) return traceId
      const known = this.#tagOf.get(traceId)
      if (known !== undefined) return known
    }
    // A server that does not take the trace id may still record the request
    // id it was sent, under whatever attribute name it uses.
    for (const bag of [attrs, ...spans.map((span) => span.attrs)]) {
      if (!bag) continue
      for (const value of Object.values(bag)) {
        if (typeof value === 'string' && tags.has(value)) return value
      }
    }
    return undefined
  }

  /** The page's own entry for a tagged request, in whichever session has it. */
  #request(tag: string): { session: Session; request: LogEntry } | undefined {
    const sessions = [...this.#hub.sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt)
    for (const session of sessions) {
      for (let index = session.entries.length - 1; index >= 0; index--) {
        const entry = session.entries[index]!
        if (entry.source === 'network' && (entry.detail as { tag?: string } | undefined)?.tag === tag) {
          return { session, request: entry }
        }
      }
    }
    return undefined
  }

  /**
   * Runs `found` once the page has reported the request. The server often
   * tells first: a document is rendered before the page that reports it
   * exists.
   */
  #find(
    tag: () => string | undefined,
    found: (session: Session, request: LogEntry, tag: string) => void,
    lost: () => void,
  ): void {
    const started = Date.now()
    const attempt = () => {
      const name = tag()
      const hit = name === undefined ? undefined : this.#request(name)
      if (hit && name !== undefined) {
        found(hit.session, hit.request, name)
        return
      }
      if (Date.now() - started >= FIND_FOR_MS) {
        lost()
        return
      }
      quiet(setTimeout(attempt, FIND_EVERY_MS))
    }
    attempt()
  }

  #keepLoose(t: number, summary: string): void {
    this.loose.push({ t: Math.round(t), summary })
    if (this.loose.length > 200) this.loose.shift()
  }

  #remember(map: Map<string, string>, key: string, value: string): void {
    map.set(key, value)
    if (map.size > REMEMBERED) map.delete(map.keys().next().value!)
  }
}

const stores = new WeakMap<Hub, Store>()

export function storeFor(hub: Hub): Store {
  let store = stores.get(hub)
  if (!store) {
    store = new Store(hub)
    stores.set(hub, store)
  }
  return store
}
