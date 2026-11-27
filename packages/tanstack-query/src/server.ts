import { z } from 'zod'
import { QUERY_MESSAGES, QUERY_RULES, QUERY_SLOW } from './rules.js'
import type { Frame, ServerSource, SourceTool } from '@loopsight/core/server'

const path = z
  .array(z.union([z.string(), z.number()]))
  .optional()
  .describe('Keys from the root of the data to a subtree, such as ["items", 0].')

const tools: Array<SourceTool> = [
  {
    name: 'list_queries',
    description:
      'TanStack Query cache: one row per query with its hash, status and observer count. A row leaves out what is at its usual value: `fetch` appears when not idle, `stale`, `invalidated` and `disabled` only when true. Past ten queries, `families` counts them by the first two key segments. No data; use get_query for that.',
    input: {
      status: z.enum(['pending', 'error', 'success']).optional(),
      fetchStatus: z.enum(['fetching', 'paused', 'idle']).optional(),
      stale: z.boolean().optional(),
      keyContains: z
        .string()
        .optional()
        .describe('Substring of the query hash, which is the JSON of the key.'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
    },
    run: (args, { call }) => call('query.list', args),
  },
  {
    name: 'get_query',
    description:
      'One query: its key, data and error, and `usedAt`, the places in the source that created or observe it. Large data is cut at `depth` levels, 50 items per container and 2000 characters per string; pass `path` to read a subtree in full.',
    input: {
      queryHash: z.string().describe('From list_queries.'),
      path,
      depth: z.number().int().min(1).max(12).optional(),
    },
    run: async (args, { call, hub }) => {
      const { sites, ...query } = (await call('query.get', args)) as {
        sites: Array<Array<Frame>>
      } & Record<string, unknown>
      const usedAt: Array<string> = []
      for (const frames of sites) {
        const places = await hub.resolveFrames(frames)
        if (places.length > 0) usedAt.push(places.join(' < '))
      }
      return { ...query, usedAt }
    },
  },
  {
    name: 'diff_query',
    description:
      "What the last change to a query's data changed: one row per path, with the value before and after. Covers changes since the page connected.",
    input: { queryHash: z.string() },
    run: (args, { call }) => call('query.diff', args),
  },
  {
    name: 'list_mutations',
    description:
      'TanStack Query mutation cache: the last 100 mutations with status, variables and error.',
    input: {},
    run: (_args, { call }) => call('mutation.list'),
  },
  {
    name: 'query_action',
    action: true,
    description:
      'Invalidates, refetches, resets or removes the queries that match. Pass queryHash, keyContains, or all: true.',
    input: {
      action: z.enum(['invalidate', 'refetch', 'reset', 'remove']),
      queryHash: z.string().optional(),
      keyContains: z.string().optional(),
      all: z.boolean().optional(),
    },
    run: (args, { call }) => call('query.action', args),
  },
  {
    name: 'set_query_data',
    action: true,
    description: "Replaces a query's cached data, as queryClient.setQueryData does.",
    input: { queryHash: z.string(), data: z.unknown() },
    run: (args, { call }) => call('query.setData', args),
  },
]

/** TanStack Query, seen from the server: its tools and the rules that judge it. */
export const queryServerSource: ServerSource = {
  key: 'query',
  title: 'TanStack Query',
  about: 'For TanStack Query, list_queries and get_query read the cache, and get_query says where in the source a query is used.',
  writes: {
    query: 'cache events: added, fetch, success, error, invalidate',
    mutation: 'mutation events: pending, success, error',
  },
  tools,
  rules: QUERY_RULES,
  messages: QUERY_MESSAGES,
  slow: QUERY_SLOW,
}
