import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZodRawShape } from 'zod'
import type { Hub, Session } from './hub.js'
import type { KnownMessage, Rule, SlowKind } from './rules.js'

/** What a source's tool gets when an agent calls it. */
export interface ToolContext {
  /** Calls a method on the page of the session the agent named. */
  call: (method: string, args?: unknown, timeoutMs?: number) => Promise<unknown>
  session: Session
  hub: Hub
  /** Whether the server was started with actions enabled. */
  actions: boolean
}

/**
 * A tool a source offers to agents. The `session` argument is added and
 * resolved by the core; `run` gets the remaining arguments.
 */
export interface SourceTool {
  /** Unique across sources. Prefix it with the library's noun: `list_queries`. */
  name: string
  /** Say when to call it, not only what it returns. */
  description: string
  input: ZodRawShape
  /** True for a tool that changes the app. Registered only with actions on. */
  action?: boolean
  run: (args: any, context: ToolContext) => unknown
}

/**
 * One library, seen from the server: the tools it offers, the rules that
 * judge it, and how its entries read. The page half records; this half
 * explains.
 */
export interface ServerSource {
  /** The same key as the page half: `query`, `router`. */
  key: string
  title: string
  /** One sentence for the server's instructions to the agent. */
  about?: string
  /** The entry sources it writes, each with a line for `list_events`. */
  writes?: Record<string, string>
  tools?: ReadonlyArray<SourceTool>
  rules?: ReadonlyArray<Rule>
  messages?: ReadonlyArray<KnownMessage>
  slow?: ReadonlyArray<SlowKind>
  /**
   * Takes an HTTP request made to the tool's own port, for a source that is
   * sent data by something other than a page: a server exporting its traces.
   * Returns false, having touched nothing, when the request is not its own.
   * Requests from a browser origin never reach it.
   */
  http?: (request: IncomingMessage, response: ServerResponse, hub: Hub) => boolean
  /**
   * Whether the host should tag the requests it passes to the app's server
   * (see `Hub.tag`). Asked per request, so a source can wait until it has
   * something to tie the tags to.
   */
  tagRequests?: (hub: Hub) => boolean
}

/** Both halves of a source, as a host needs them to wire it up. */
export interface SourceDescriptor {
  key: string
  server: ServerSource
  /**
   * Absolute path of the built page half: an ES module whose default export
   * is a `PageSource`. Left out by a source that only adds rules.
   */
  page?: string
  /**
   * npm packages whose presence in the app means this source applies. A host
   * that can see the app's dependencies skips the source when none is there.
   */
  detect?: ReadonlyArray<string>
}

/** The rules, messages and slow kinds of a set of sources, in their order. */
export function collect(sources: ReadonlyArray<ServerSource>) {
  return {
    rules: sources.flatMap((source) => source.rules ?? []),
    messages: sources.flatMap((source) => source.messages ?? []),
    slow: sources.flatMap((source) => source.slow ?? []),
  }
}
