import type { LogEntry } from '../protocol.js'

/** A page-side method the server can call. Arguments arrive as parsed JSON. */
export type Handler = (args: Record<string, any>) => unknown | Promise<unknown>
export type Handlers = Record<string, Handler>

/** Appends an entry to the page's log; `n` and `t` are filled in. */
export type Recorder = (entry: Omit<LogEntry, 'n' | 't'>) => void
