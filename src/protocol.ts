/** The messages a page and the server exchange over the `/bridge` WebSocket. */

export const DEFAULT_PORT = 4777
export const BRIDGE_PATH = '/bridge'
export const MCP_PATH = '/mcp'

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
  has: { query: boolean; router: boolean }
  tools: Array<PageToolInfo>
}

export type EntrySource =
  | 'query'
  | 'mutation'
  | 'router'
  | 'network'
  | 'console'
  | 'bus'
  | 'vite'

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
  /** The query hash, mutation id, pathname or file the entry is about. */
  key?: string
  summary: string
  /** Milliseconds the fetch, request or navigation took. */
  dur?: number
  detail?: unknown
  /** Where in the app's source it came from, most recent call first. */
  at?: Array<string>
}

/** An entry as the page sends it: numbered by the page, frames unresolved. */
export interface PageEntry extends Omit<LogEntry, 'n' | 'at'> {
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
