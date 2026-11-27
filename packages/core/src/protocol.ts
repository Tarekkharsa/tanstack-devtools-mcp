/** The messages a page and the server exchange over the bridge WebSocket. */

export const NAME = 'loopsight'
export const DEFAULT_PORT = 4777
export const BRIDGE_PATH = '/bridge'
export const MCP_PATH = '/mcp'
/** Where the page connects when the bridge lives on the dev server itself. */
export const SAME_SERVER_BRIDGE = '__loopsight/bridge'
/** The page keeps its one bridge here, even when the page code loads twice. */
export const GLOBAL_KEY = '__LOOPSIGHT__'
export const PROTOCOL = 2

export interface PageToolInfo {
  name: string
  title?: string
  description: string
  inputSchema?: unknown
  /** True only when the tool declared `readOnlyHint: true`. */
  readOnly: boolean
}

export interface SessionInfo {
  id: string
  url: string
  title: string
  startedAt: number
  protocol?: number
  /**
   * Which sources found the instance they need, by source key: for example
   * `{ query: true, router: false }`. A source that needs no instance is not
   * listed.
   */
  has: Record<string, boolean>
  tools: Array<PageToolInfo>
}

/** The name a source writes its entries under. Any string: sources are open. */
export type EntrySource = string

/** One frame of a browser stack trace, as the browser reports it. */
export interface Frame {
  fn?: string
  url: string
  line: number
  column: number
}

export interface LogEntry {
  /** Position in the session's log, starting at 1. The server assigns it. */
  n: number
  /** Milliseconds since the epoch. */
  t: number
  source: EntrySource
  type: string
  /** What the entry is about: a query hash, a pathname, a file. */
  key?: string
  /** One line for a reader. Rules never parse it; they read `detail`. */
  summary: string
  /** Milliseconds the fetch, request or navigation took. */
  dur?: number
  detail?: unknown
  /** Where in the app's source it came from, most recent call first. */
  at?: Array<string>
  /** Set by whoever recorded it when the entry is an error or a failure. */
  problem?: true
  /** `host` for entries the dev server recorded, not a page. */
  scope?: 'host'
}

/** An entry as the page sends it: numbered by the page, frames unresolved. */
export interface PageEntry extends Omit<LogEntry, 'n' | 'at' | 'scope'> {
  seq: number
  frames?: Array<Frame>
}

export type PageMessage =
  | { kind: 'hello'; session: SessionInfo }
  | { kind: 'meta'; patch: Partial<Omit<SessionInfo, 'id' | 'startedAt'>> }
  | { kind: 'entries'; entries: Array<PageEntry> }
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }

export interface ServerMessage {
  kind: 'call'
  id: number
  method: string
  args: unknown
}
