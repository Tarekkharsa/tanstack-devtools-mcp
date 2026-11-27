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

export type EntrySource = 'query' | 'mutation' | 'router' | 'console' | 'bus'

export interface LogEntry {
  /** Position in the page's log, starting at 1. */
  n: number
  /** Milliseconds since the epoch. */
  t: number
  source: EntrySource
  type: string
  /** The query hash, mutation id or pathname the entry is about. */
  key?: string
  summary: string
  detail?: unknown
}

export type PageMessage =
  | { kind: 'hello'; session: SessionInfo }
  | { kind: 'meta'; patch: Partial<Omit<SessionInfo, 'id' | 'startedAt'>> }
  | { kind: 'entries'; entries: Array<LogEntry> }
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }

export interface ServerMessage {
  kind: 'call'
  id: number
  method: string
  args: unknown
}
