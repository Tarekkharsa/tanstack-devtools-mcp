import type {
  Frame,
  LogEntry,
  PageEntry,
  PageMessage,
  ServerMessage,
  SessionInfo,
} from '../protocol.js'

/** One end of a page's bridge connection, whatever carries it. */
export interface Connection {
  send: (text: string) => void
  onMessage: (listener: (text: string) => void) => void
  onClose: (listener: () => void) => void
}

export interface Session {
  info: SessionInfo
  connected: boolean
  connectedAt: number
  /** The server's copy of the page's log, which outlives the page. */
  entries: Array<LogEntry>
  /** Entries dropped from the front of `entries` to stay within `size`. */
  dropped: number
  /** The number the next entry gets. */
  nextN: number
  /** The highest page-side sequence number received. */
  pageSeq: number
  connection: Connection | undefined
  /**
   * What the page last said about itself when asked, kept so its findings
   * can still be compared with another page's after it has closed.
   */
  facts?: unknown
}

export interface HubOptions {
  /** Entries kept per session. Default 1000. */
  size?: number
  /** Sessions kept after their page has gone. Default 10. */
  sessions?: number
  /** Milliseconds a page has to answer a call. Default 15000. */
  callTimeoutMs?: number
  /**
   * Turns a browser stack frame into a place in the source, such as
   * `loadPost src/routes/post.tsx:12:5`. The Vite plugin supplies one that
   * reads source maps. Without it, frames keep the served file's positions.
   */
  resolveFrame?: (frame: Frame) => string | undefined | Promise<string | undefined>
}

/** A request a host tagged: enough to recognise it without the page. */
export interface RequestTag {
  method: string
  /** Path and query, as the dev server received it. */
  url: string
  t: number
}

const TAGS = 2000

/** Thirty-two hex characters: also a valid W3C trace id. */
function newTag(): string {
  let out = ''
  for (let index = 0; index < 4; index++) {
    out += Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0')
  }
  return out
}

/** How long a server-side entry stays around to greet a page that reloads. */
const GREETING_MS = 5000
const RECENT = 50

interface Pending {
  sessionId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Holds the sessions pages open, keeps a copy of each one's log, and calls
 * methods on a page. It knows nothing about MCP or WebSockets.
 */
export class Hub {
  readonly sessions = new Map<string, Session>()
  readonly #factTimers = new WeakMap<Session, ReturnType<typeof setTimeout>>()
  readonly #size: number
  readonly #keep: number
  readonly #callTimeoutMs: number
  readonly #pending = new Map<number, Pending>()
  readonly #resolveFrame: HubOptions['resolveFrame']
  /** The latest server-side entries, whichever sessions were open. */
  readonly recent: Array<Omit<LogEntry, 'n'>> = []
  /** Requests a host tagged on their way to the app's server, newest last. */
  readonly tags = new Map<string, RequestTag>()
  #nextCall = 1

  constructor(options: HubOptions = {}) {
    this.#size = options.size ?? 1000
    this.#keep = options.sessions ?? 10
    this.#callTimeoutMs = options.callTimeoutMs ?? 15_000
    this.#resolveFrame = options.resolveFrame
  }

  attach(connection: Connection): void {
    let session: Session | undefined
    connection.onMessage((text) => {
      let message: PageMessage
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message.kind === 'hello') {
        session = this.#hello(message.session, connection)
        return
      }
      if (!session) return
      if (message.kind === 'meta') {
        session.info = { ...session.info, ...message.patch }
      } else if (message.kind === 'entries') {
        this.#ingest(session, message.entries)
        this.#rememberFacts(session)
      } else if (message.kind === 'result') {
        this.#settle(message)
      }
    })
    connection.onClose(() => {
      if (!session || session.connection !== connection) return
      session.connected = false
      session.connection = undefined
      for (const [id, pending] of this.#pending) {
        if (pending.sessionId !== session.info.id) continue
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        pending.reject(new Error('The page closed before it answered.'))
      }
    })
  }

  #hello(info: SessionInfo, connection: Connection): Session {
    const existing = this.sessions.get(info.id)
    if (existing) {
      // The same page load reconnecting, for example after a server restart.
      existing.info = info
      existing.connected = true
      existing.connectedAt = Date.now()
      existing.connection = connection
      return existing
    }
    const session: Session = {
      info,
      connected: true,
      connectedAt: Date.now(),
      entries: [],
      dropped: 0,
      nextN: 1,
      pageSeq: 0,
      connection,
    }
    this.sessions.set(info.id, session)
    // What the dev server did just before this page loaded, such as the
    // reload that caused it.
    const cutoff = Date.now() - GREETING_MS
    for (const entry of this.recent) {
      if (entry.t >= cutoff) this.#append(session, entry)
    }
    this.#evict()
    return session
  }

  #evict(): void {
    for (const [id, session] of this.sessions) {
      if (this.sessions.size <= this.#keep) return
      if (!session.connected) this.sessions.delete(id)
    }
  }

  #ingest(session: Session, entries: Array<PageEntry>): void {
    if (!Array.isArray(entries)) return
    for (const { seq, frames, ...entry } of entries) {
      const stored = this.#append(session, entry)
      if (typeof seq === 'number' && seq > session.pageSeq) session.pageSeq = seq
      if (frames && frames.length > 0) {
        void this.resolveFrames(frames).then((at) => {
          if (at.length > 0) stored.at = at
        })
      }
    }
  }

  #append(session: Session, entry: Omit<LogEntry, 'n'>): LogEntry {
    const stored: LogEntry = { ...entry, n: session.nextN++ }
    session.entries.push(stored)
    const extra = session.entries.length - this.#size
    if (extra > 0) {
      session.entries.splice(0, extra)
      session.dropped += extra
    }
    return stored
  }

  /**
   * Names a request the host is about to pass to the app's server. The host
   * sends the tag both ways: to the server, and back to the page with the
   * answer. Pass `id` to keep one the client already sent.
   */
  tag(request: Omit<RequestTag, 't'>, id: string = newTag()): string {
    this.tags.set(id, { ...request, t: Date.now() })
    if (this.tags.size > TAGS) this.tags.delete(this.tags.keys().next().value!)
    return id
  }

  /**
   * Adds an entry to one session's log from the server side: what a source
   * learned about that page from somewhere other than the page.
   */
  add(session: Session, entry: Omit<LogEntry, 'n'>): LogEntry {
    return this.#append(session, entry)
  }

  /**
   * Adds an entry that comes from the dev server, not from a page, to every
   * open session's log.
   */
  recordServer(entry: Omit<LogEntry, 'n' | 't' | 'scope'>): void {
    const stamped = { ...entry, scope: 'host' as const, t: Date.now() }
    this.recent.push(stamped)
    if (this.recent.length > RECENT) this.recent.shift()
    for (const session of this.sessions.values()) {
      if (session.connected) this.#append(session, stamped)
    }
  }

  /** Each frame as a place in the source, most recent call first. */
  async resolveFrames(frames: Array<Frame>): Promise<Array<string>> {
    const out: Array<string> = []
    for (const frame of frames) {
      let place: string | undefined
      try {
        place = await this.#resolveFrame?.(frame)
      } catch {
        place = undefined
      }
      if (place === undefined) {
        let path = frame.url
        try {
          path = new URL(frame.url).pathname.replace(/^\//, '')
        } catch {
          // Keep the raw URL.
        }
        place = `${frame.fn ? `${frame.fn} ` : ''}${path}:${frame.line}:${frame.column} (served code)`
      }
      out.push(place)
    }
    return out
  }

  /** Resolves once the page's entries up to `seq` have arrived, or in 500 ms. */
  async caughtUp(session: Session, seq: number): Promise<void> {
    const deadline = Date.now() + 500
    while (session.pageSeq < seq && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  #settle(message: Extract<PageMessage, { kind: 'result' }>): void {
    const pending = this.#pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error))
  }

  /**
   * The session an id names. Without an id: the page connected most recently,
   * or the newest closed one when no page is open.
   */
  resolve(id?: string): Session {
    if (id !== undefined) {
      const session = this.sessions.get(id)
      if (!session) throw new Error(`No session ${id}. Call list_sessions.`)
      return session
    }
    const all = [...this.sessions.values()]
    const newest = (list: Array<Session>) =>
      list.reduce<Session | undefined>(
        (best, s) => (!best || s.connectedAt >= best.connectedAt ? s : best),
        undefined,
      )
    const open = all.filter((s) => s.connected)
    // A page with something to inspect comes before one with nothing.
    const useful = (s: Session) =>
      Object.values(s.info.has).some(Boolean) || s.info.tools.length > 0
    const session = newest(open.filter(useful)) ?? newest(open) ?? newest(all)
    if (!session) {
      throw new Error(
        'No page has connected yet. Open the app in a browser with the dev server running.',
      )
    }
    return session
  }

  /**
   * Asks a page what it says about itself once it has been quiet for a
   * moment, and keeps the answer. A page that has closed cannot be asked, and
   * comparing two pages needs both.
   */
  #rememberFacts(session: Session): void {
    const timers = this.#factTimers
    clearTimeout(timers.get(session))
    const timer = setTimeout(() => {
      timers.delete(session)
      if (!session.connected) return
      this.call(session, 'page.facts', {}, 5000).then(
        (facts) => {
          session.facts = facts
        },
        () => {},
      )
    }, 2500)
    timer.unref?.()
    timers.set(session, timer)
  }

  /** Calls a method on a session's page and resolves with its answer. */
  call(
    session: Session,
    method: string,
    args: unknown = {},
    timeoutMs = this.#callTimeoutMs,
  ): Promise<unknown> {
    const connection = session.connection
    if (!session.connected || !connection) {
      return Promise.reject(
        new Error(
          `Session ${session.info.id} has no open page, so only its recorded events can be read.`,
        ),
      )
    }
    const id = this.#nextCall++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`The page did not answer ${method} in ${timeoutMs} ms.`))
      }, timeoutMs)
      this.#pending.set(id, {
        sessionId: session.info.id,
        resolve,
        reject,
        timer,
      })
      const message: ServerMessage = { kind: 'call', id, method, args }
      try {
        connection.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
