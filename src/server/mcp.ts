import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Hub, Session } from './hub.js'
import type { LogEntry } from '../protocol.js'

export interface McpOptions {
  /**
   * Registers the tools that change the app: `query_action`,
   * `set_query_data`, `navigate`, `invalidate_router`, and lets
   * `call_page_tool` run tools that are not marked read-only. Default false.
   */
  actions?: boolean
}

const instructions = [
  'Inspects a TanStack app running in a browser tab during development.',
  'Start with list_sessions. Tools default to the page connected most recently.',
  'list_events reads the server copy of the log, so it still answers after a reload or a closed tab; every other tool needs an open page.',
  'After changing something, call wait_for_idle with the last entry number you saw, then read the entries it returns.',
].join(' ')

const session = z
  .string()
  .optional()
  .describe(
    'Session id from list_sessions. Defaults to the page connected most recently.',
  )

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }],
  }
}

async function guard(run: () => unknown) {
  try {
    return text(await run())
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}

function row(entry: LogEntry) {
  return {
    n: entry.n,
    at: new Date(entry.t).toISOString(),
    source: entry.source,
    type: entry.type,
    ...(entry.key !== undefined ? { key: entry.key } : {}),
    summary: entry.summary,
  }
}

function lastEntry(target: Session): number {
  return target.entries.at(-1)?.n ?? 0
}

const read = { readOnlyHint: true }
const write = { readOnlyHint: false }

export function createMcpServer(hub: Hub, options: McpOptions = {}): McpServer {
  const actions = options.actions === true
  const server = new McpServer(
    { name: 'tanstack-devtools-mcp', version: '0.0.0' },
    { instructions },
  )

  server.registerTool(
    'list_sessions',
    {
      description:
        'The pages that have connected: URL, whether the page is still open, what it has connected (Query, Router, registered tools) and how many events are recorded.',
      inputSchema: {},
      annotations: read,
    },
    () =>
      guard(() => ({
        actions,
        sessions: [...hub.sessions.values()]
          .sort((a, b) => b.connectedAt - a.connectedAt)
          .map((s) => ({
            id: s.info.id,
            url: s.info.url,
            title: s.info.title,
            connected: s.connected,
            startedAt: new Date(s.info.startedAt).toISOString(),
            has: s.info.has,
            tools: s.info.tools.length,
            entries: s.entries.length,
            lastEntry: lastEntry(s),
          })),
      })),
  )

  server.registerTool(
    'list_queries',
    {
      description:
        'TanStack Query cache: one row per query with its hash, key, status, fetch status, staleness, observer count and error. No data; use get_query for that.',
      inputSchema: {
        session,
        status: z.enum(['pending', 'error', 'success']).optional(),
        fetchStatus: z.enum(['fetching', 'paused', 'idle']).optional(),
        stale: z.boolean().optional(),
        keyContains: z
          .string()
          .optional()
          .describe('Substring of the query hash, which is the JSON of the key.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: read,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'query.list', args)),
  )

  server.registerTool(
    'get_query',
    {
      description:
        'One query with its data and error. Large values are cut at `depth` levels, 50 items per container and 2000 characters per string.',
      inputSchema: {
        session,
        queryHash: z.string().describe('From list_queries.'),
        depth: z.number().int().min(1).max(12).optional(),
      },
      annotations: read,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'query.get', args)),
  )

  server.registerTool(
    'list_mutations',
    {
      description:
        'TanStack Query mutation cache: the last 100 mutations with status, variables and error.',
      inputSchema: { session },
      annotations: read,
    },
    ({ session: id }) =>
      guard(() => hub.call(hub.resolve(id), 'mutation.list')),
  )

  server.registerTool(
    'get_router_state',
    {
      description:
        'TanStack Router state: status, location, and each matched route with its params, search, status, error and loader data.',
      inputSchema: {
        session,
        depth: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Levels of loader data to keep. Default 3.'),
      },
      annotations: read,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'router.state', args)),
  )

  server.registerTool(
    'list_routes',
    {
      description:
        'Every route the router knows: id, full path, parent, and whether it has a loader, beforeLoad or search validation.',
      inputSchema: { session },
      annotations: read,
    },
    ({ session: id }) => guard(() => hub.call(hub.resolve(id), 'router.routes')),
  )

  server.registerTool(
    'list_events',
    {
      description:
        'The recorded log, oldest first: query and mutation cache events, router navigation events, console errors and warnings, and TanStack Devtools bus events. Without `after` it returns the newest `limit` matches; with `after` it returns the first `limit` matches numbered above it. Answers from the server copy, so it works after a reload.',
      inputSchema: {
        session,
        source: z
          .enum(['query', 'mutation', 'router', 'console', 'bus'])
          .optional(),
        type: z
          .string()
          .optional()
          .describe('For example fetch, success, error, onResolved, warn.'),
        key: z
          .string()
          .optional()
          .describe('Exact query hash, mutation id or pathname.'),
        contains: z.string().optional().describe('Substring of the summary.'),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: read,
    },
    ({ session: id, source, type, key, contains, after, limit = 50 }) =>
      guard(() => {
        const target = hub.resolve(id)
        const matches = target.entries.filter(
          (entry) =>
            (source === undefined || entry.source === source) &&
            (type === undefined || entry.type === type) &&
            (key === undefined || entry.key === key) &&
            (contains === undefined || entry.summary.includes(contains)) &&
            (after === undefined || entry.n > after),
        )
        const shown =
          after === undefined ? matches.slice(-limit) : matches.slice(0, limit)
        return {
          session: target.info.id,
          matched: matches.length,
          dropped: target.dropped,
          lastEntry: lastEntry(target),
          entries: shown.map(row),
        }
      }),
  )

  server.registerTool(
    'get_event',
    {
      description: 'One recorded event with its detail.',
      inputSchema: { session, n: z.number().int().min(1) },
      annotations: read,
    },
    ({ session: id, n }) =>
      guard(() => {
        const entry = hub.resolve(id).entries.find((e) => e.n === n)
        if (!entry) throw new Error(`Entry ${n} is not in the log.`)
        return { ...row(entry), detail: entry.detail ?? null }
      }),
  )

  server.registerTool(
    'count_events',
    {
      description: 'Recorded events counted by source and type.',
      inputSchema: { session, after: z.number().int().min(0).optional() },
      annotations: read,
    },
    ({ session: id, after }) =>
      guard(() => {
        const target = hub.resolve(id)
        const counts: Record<string, number> = {}
        for (const entry of target.entries) {
          if (after !== undefined && entry.n <= after) continue
          const name = `${entry.source}/${entry.type}`
          counts[name] = (counts[name] ?? 0) + 1
        }
        return { session: target.info.id, lastEntry: lastEntry(target), counts }
      }),
  )

  server.registerTool(
    'wait_for_idle',
    {
      description:
        'Waits until no query is fetching, no mutation is running and the router is idle, or until the timeout. With `after`, also returns the events recorded since that entry number.',
      inputSchema: {
        session,
        timeoutMs: z.number().int().min(0).max(30_000).optional(),
        after: z.number().int().min(0).optional(),
      },
      annotations: read,
    },
    ({ session: id, timeoutMs = 5000, after }) =>
      guard(async () => {
        const target = hub.resolve(id)
        const result = (await hub.call(
          target,
          'page.wait',
          { timeoutMs },
          timeoutMs + 5000,
        )) as { idle: boolean; waitedMs: number; lastEntry: number }
        if (after === undefined) return result
        // The page's entries arrive in batches; give the last one time to land.
        const deadline = Date.now() + 500
        while (lastEntry(target) < result.lastEntry && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          ...result,
          entries: target.entries.filter((e) => e.n > after).slice(0, 200).map(row),
        }
      }),
  )

  server.registerTool(
    'list_page_tools',
    {
      description:
        'The tools libraries registered in the page through WebMCP, for example with @tanstack/devtools-webmcp. `callable` says whether call_page_tool will run it under the current settings.',
      inputSchema: { session },
      annotations: read,
    },
    ({ session: id }) =>
      guard(() => ({
        tools: hub.resolve(id).info.tools.map((tool) => ({
          ...tool,
          callable: tool.readOnly || actions,
        })),
      })),
  )

  server.registerTool(
    'call_page_tool',
    {
      description:
        'Runs a tool from list_page_tools in the page and returns its result. A tool not marked read-only runs only when the server was started with actions enabled.',
      inputSchema: {
        session,
        name: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: write,
    },
    ({ session: id, name, input }) =>
      guard(() => {
        const target = hub.resolve(id)
        const tool = target.info.tools.find((t) => t.name === name)
        if (!tool) throw new Error(`No registered tool named ${name}.`)
        if (!tool.readOnly && !actions) {
          throw new Error(
            `${name} is not marked read-only, and actions are off. Start the server with actions enabled to run it.`,
          )
        }
        return hub.call(target, 'tool.call', { name, input: input ?? {} })
      }),
  )

  if (!actions) return server

  server.registerTool(
    'query_action',
    {
      description:
        'Invalidates, refetches, resets or removes the queries that match. Pass queryHash, keyContains, or all: true.',
      inputSchema: {
        session,
        action: z.enum(['invalidate', 'refetch', 'reset', 'remove']),
        queryHash: z.string().optional(),
        keyContains: z.string().optional(),
        all: z.boolean().optional(),
      },
      annotations: write,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'query.action', args)),
  )

  server.registerTool(
    'set_query_data',
    {
      description:
        "Replaces a query's cached data, as queryClient.setQueryData does.",
      inputSchema: { session, queryHash: z.string(), data: z.unknown() },
      annotations: write,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'query.setData', args)),
  )

  server.registerTool(
    'navigate',
    {
      description:
        'Navigates with the router, as router.navigate does, and returns the new location once the navigation settles.',
      inputSchema: {
        session,
        to: z.string().describe('A path such as /posts/$postId or /posts/3.'),
        params: z.record(z.string(), z.unknown()).optional(),
        search: z.record(z.string(), z.unknown()).optional(),
        hash: z.string().optional(),
        replace: z.boolean().optional(),
      },
      annotations: write,
    },
    ({ session: id, ...args }) =>
      guard(() => hub.call(hub.resolve(id), 'router.navigate', args)),
  )

  server.registerTool(
    'invalidate_router',
    {
      description: 'Reruns the loaders of the matched routes.',
      inputSchema: { session },
      annotations: write,
    },
    ({ session: id }) =>
      guard(() => hub.call(hub.resolve(id), 'router.invalidate')),
  )

  return server
}
