import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NAME } from '../protocol.js'
import { diagnose, isProblem } from './diagnose.js'
import { collect } from './source.js'
import type { Hub, Session } from './hub.js'
import type { ServerSource } from './source.js'
import type { LogEntry } from '../protocol.js'

export interface McpOptions {
  /**
   * Registers the tools that change the app, which the sources mark as
   * actions, and lets `call_page_tool` run tools that are not marked
   * read-only. Default false.
   */
  actions?: boolean
  /** The libraries this server knows: their tools and their rules. */
  sources?: ReadonlyArray<ServerSource>
}

/** What the server tells an agent about itself, for a given set of sources. */
export function instructionsFor(sources: ReadonlyArray<ServerSource> = []): string {
  const about = sources.map((source) => source.about).filter(Boolean)
  return [GENERAL[0], ...about, ...GENERAL.slice(1)].join(' ')
}

const GENERAL = [
  'Inspects a web app running in a browser tab during development: what its libraries did, network calls, console errors and what the dev server did with each edit, on one numbered timeline.',
  'Start with overview. After you edit a file, call wait_for_update: it tells you whether the edit compiled and applied, and what the page did next.',
  'After you change the app with a tool, call wait_for_idle with the last entry number you saw.',
  'diagnose lists what is wrong and what the libraries document as a mistake, each with the documented fix and its source. Entries carry `from`, the place in the source they came from.',
  'list_events, get_event, count_events and diagnose read the server copy of the log, so they still answer after a reload or a closed tab.',
]

/** The instructions with no sources, for callers that have none to name. */
export const instructions = instructionsFor()

const session = z
  .string()
  .optional()
  .describe(
    'Session id from list_sessions. Defaults to the page connected most recently.',
  )

function text(value: unknown) {
  // A tool that returns nothing, as an action on a library often does, still
  // owes the agent an answer; `undefined` has no JSON form.
  const shown = value === undefined ? { ok: true } : value
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(shown, null, 1) }],
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

const ROW_CHARS = 200

/**
 * An entry as a row: no detail, only the fields that say something, and a
 * summary short enough that fifty rows stay readable. get_event has it whole.
 */
export function row(entry: LogEntry) {
  return shape(entry, shorten(entry.summary))
}

/** Cuts the middle, so the outcome at the end (`→ 404`) is never lost. */
function shorten(summary: string): string {
  if (summary.length <= ROW_CHARS) return summary
  const arrow = summary.lastIndexOf(' → ')
  const tail = arrow > 0 && summary.length - arrow <= 60 ? summary.slice(arrow) : ''
  return `${summary.slice(0, ROW_CHARS - tail.length)}…${tail}`
}

function shape(entry: LogEntry, summary: string) {
  return {
    n: entry.n,
    time: new Date(entry.t).toISOString().slice(11, 23),
    source: entry.source,
    type: entry.type,
    ...(entry.key !== undefined && !summary.includes(entry.key)
      ? { key: entry.key }
      : {}),
    summary,
    ...(entry.dur !== undefined ? { ms: entry.dur } : {}),
    ...(entry.at?.[0] !== undefined ? { from: entry.at[0] } : {}),
  }
}

function lastEntry(target: Session): number {
  return target.entries.at(-1)?.n ?? 0
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const UPDATE_TYPES = new Set(['hmr-update', 'full-reload', 'error'])
const isUpdate = (entry: Pick<LogEntry, 'scope' | 'type'>) =>
  entry.scope === 'host' && UPDATE_TYPES.has(entry.type)

const read = { readOnlyHint: true }
const write = { readOnlyHint: false }

/** The entry sources a server knows, each with what its entries are. */
function eventSources(sources: ReadonlyArray<ServerSource>): string {
  const writes: Record<string, string> = {}
  for (const source of sources) Object.assign(writes, source.writes)
  Object.assign(writes, {
    network: 'fetch and XHR calls with their status',
    console: 'errors, warnings and uncaught errors',
    host: 'what the dev server did, under its own name such as vite: file changes, hot updates, reloads, build errors',
  })
  return Object.entries(writes)
    .map(([name, what]) => `${name} (${what})`)
    .join(', ')
}

export function createMcpServer(hub: Hub, options: McpOptions = {}): McpServer {
  const actions = options.actions === true
  const sources = options.sources ?? []
  const parts = collect(sources)
  const server = new McpServer(
    { name: NAME, version: '0.0.0' },
    { instructions: instructionsFor(sources) },
  )

  /** Waits for the page to settle and for its entries to reach the server. */
  const settle = async (target: Session, timeoutMs: number) => {
    const result = (await hub.call(
      target,
      'page.wait',
      { timeoutMs },
      timeoutMs + 5000,
    )) as { idle: boolean; waitedMs: number; lastSeq: number }
    await hub.caughtUp(target, result.lastSeq)
    return { idle: result.idle, waitedMs: result.waitedMs }
  }

  server.registerTool(
    'list_sessions',
    {
      description:
        'The pages that have connected: URL, whether the page is still open, which libraries were found on it and how many events are recorded.',
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
    'overview',
    {
      description:
        'The page in one call: URL, whether it is idle, a short summary from each library found on it, pending requests, and the latest problems from the log. Start here.',
      inputSchema: { session },
      annotations: read,
    },
    ({ session: id }) =>
      guard(async () => {
        const target = hub.resolve(id)
        const live = target.connected
          ? ((await hub.call(target, 'page.overview')) as Record<string, unknown>)
          : {
              url: target.info.url,
              title: target.info.title,
              note: 'The page is closed. This is its recorded log only.',
            }
        const problems = target.entries.filter(isProblem)
        const bySource: Record<string, number> = {}
        for (const entry of target.entries) {
          bySource[entry.source] = (bySource[entry.source] ?? 0) + 1
        }
        return {
          session: target.info.id,
          connected: target.connected,
          ...live,
          log: { lastEntry: lastEntry(target), bySource },
          problems: {
            total: problems.length,
            latest: problems.slice(-5).map(row),
          },
        }
      }),
  )

  server.registerTool(
    'diagnose',
    {
      description:
        "Reads the log and the live page for things that are wrong (build errors, uncaught errors, failed requests, the same request sent twice at once, the slowest calls) and for mistakes the libraries' own documentation names, such as data fetched twice, request waterfalls or settings that defeat themselves. A finding with `fix` and `docs` restates the recommended way from that source: `docs.at` is a URL, or `package: path` of a skill file shipped in node_modules that you can open. Findings of severity info are judgment calls; read their hint.",
      inputSchema: {
        session,
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only look at entries numbered above this.'),
      },
      annotations: read,
    },
    ({ session: id, after }) =>
      guard(async () => {
        const target = hub.resolve(id)
        const live = target.connected
          ? await hub.call(target, 'page.facts').catch(() => null)
          : null
        const entries =
          after === undefined
            ? target.entries
            : target.entries.filter((entry) => entry.n > after)
        return {
          session: target.info.id,
          lastEntry: lastEntry(target),
          ...diagnose(entries, live as any, target.dropped, parts),
        }
      }),
  )

  server.registerTool(
    'list_events',
    {
      description:
        `The recorded timeline, oldest first. Sources: ${eventSources(sources)}. \`ms\` is how long a finished fetch, request or navigation took, and \`from\` is the place in the source an entry came from. Without \`after\` it returns the newest \`limit\` matches; with \`after\` it returns the first \`limit\` matches numbered above it.`,
      inputSchema: {
        session,
        source: z.string().optional().describe('One of the sources named above.'),
        type: z
          .string()
          .optional()
          .describe(
            'For example fetch, success, error, onResolved, failed, warn, uncaught, hmr-update.',
          ),
        key: z
          .string()
          .optional()
          .describe('Exactly what the entry is about: a cache key, a pathname, a file.'),
        contains: z.string().optional().describe('Substring of the summary.'),
        problems: z
          .boolean()
          .optional()
          .describe('Only errors and failures, from every source.'),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: read,
    },
    ({ session: id, source, type, key, contains, problems, after, limit = 50 }) =>
      guard(() => {
        const target = hub.resolve(id)
        const matches = target.entries.filter(
          (entry) =>
            (source === undefined || entry.source === source) &&
            (type === undefined || entry.type === type) &&
            (key === undefined || entry.key === key) &&
            (contains === undefined || entry.summary.includes(contains)) &&
            (problems !== true || isProblem(entry)) &&
            (after === undefined || entry.n > after),
        )
        const shown =
          after === undefined ? matches.slice(-limit) : matches.slice(0, limit)
        return {
          session: target.info.id,
          matched: matches.length,
          ...(target.dropped > 0 ? { dropped: target.dropped } : {}),
          lastEntry: lastEntry(target),
          entries: shown.map(row),
        }
      }),
  )

  server.registerTool(
    'get_event',
    {
      description:
        'One recorded event in full: its detail, and `at`, the app frames it came from, most recent call first.',
      inputSchema: { session, n: z.number().int().min(1) },
      annotations: read,
    },
    ({ session: id, n }) =>
      guard(() => {
        const entry = hub.resolve(id).entries.find((e) => e.n === n)
        if (!entry) throw new Error(`Entry ${n} is not in the log.`)
        const { from: _from, ...rest } = shape(entry, entry.summary)
        return {
          ...rest,
          ...(entry.key !== undefined ? { key: entry.key } : {}),
          ...(entry.at ? { at: entry.at } : {}),
          detail: entry.detail ?? null,
        }
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
        'Waits until every library on the page reports that it has settled and no request is in flight, or until the timeout. With `after`, also returns the events recorded since that entry number.',
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
        const result = await settle(target, timeoutMs)
        const out = { ...result, lastEntry: lastEntry(target) }
        if (after === undefined) return out
        return {
          ...out,
          entries: target.entries.filter((e) => e.n > after).slice(0, 200).map(row),
        }
      }),
  )

  server.registerTool(
    'wait_for_update',
    {
      description:
        'Call this after editing a file. Waits for the dev server to react (a hot update, a full reload or a build error), then for the page to settle, and returns what happened: `update` says which, `files` what changed, `problems` the errors that followed, `entries` the timeline. Uses an update from the last `sinceMs` if one already arrived, so it is safe to call a moment after the edit. Follows the page across a reload. Needs a host that reports hot updates, such as the Vite plugin.',
      inputSchema: {
        session,
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Entry number noted before the edit. Without it, the last `sinceMs` are used.',
          ),
        sinceMs: z.number().int().min(0).max(120_000).optional().describe('Default 15000.'),
        timeoutMs: z.number().int().min(0).max(60_000).optional().describe('Default 10000.'),
      },
      annotations: read,
    },
    ({ session: id, after, sinceMs = 15_000, timeoutMs = 10_000 }) =>
      guard(async () => {
        const began = Date.now()
        const deadline = began + timeoutMs
        const since = began - sinceMs
        const first = hub.resolve(id)
        const fresh = (entry: LogEntry) =>
          after === undefined ? entry.t >= since : entry.n > after

        const findTrigger = () => first.entries.findLast((e) => isUpdate(e) && fresh(e))
        const reloadedInto = () =>
          [...hub.sessions.values()]
            .filter((s) => s !== first && s.connected && s.connectedAt > first.connectedAt)
            .sort((a, b) => b.connectedAt - a.connectedAt)[0]

        // A change the dev server saw but answered with nothing, for longer than this,
        // was to a file the browser does not load.
        const QUIET_AFTER_CHANGE_MS = 2000
        const unanswered = () => {
          const change = first.entries.findLast(
            (e) => e.scope === 'host' && e.type === 'change' && fresh(e),
          )
          return change !== undefined && Date.now() - change.t > QUIET_AFTER_CHANGE_MS
        }
        let trigger = findTrigger()
        while (!trigger && !reloadedInto() && !unanswered() && Date.now() < deadline) {
          await sleep(25)
          trigger = findTrigger()
        }
        // A reload closes the first page; give the next one time to connect.
        let target = first
        if (trigger?.type === 'full-reload' || (!trigger && reloadedInto())) {
          while (!reloadedInto() && Date.now() < deadline) await sleep(25)
          target = reloadedInto() ?? first
        }
        const reloaded = target !== first

        let idle: boolean | undefined
        if (target.connected && trigger?.type !== 'error') {
          const remaining = Math.max(500, deadline - Date.now())
          idle = (await settle(target, remaining).catch(() => undefined))?.idle
        }

        const before = first.entries.filter(fresh)
        const entries = reloaded ? [...before, ...target.entries] : before
        const changes = entries.filter(
          (e) => e.scope === 'host' && (e.type === 'change' || isUpdate(e)),
        )
        const update = trigger?.type ?? (reloaded ? 'full-reload' : 'none')
        return {
          update,
          ...(update === 'none'
            ? {
                note: changes.some((e) => e.type === 'change')
                  ? 'The dev server saw the file change but sent the browser no update. The file is probably not loaded by the page: server-only code, a config file, or a module nothing imports.'
                  : `The dev server reported no change to a module of the app, hot update, reload or build error in ${Date.now() - began} ms. Check that the file was saved, that something imports it, and that the dev server runs with the loopsight plugin.`,
              }
            : {}),
          files: [...new Set(changes.map((e) => e.key).filter(Boolean))],
          session: target.info.id,
          ...(reloaded ? { reloaded: true } : {}),
          ...(idle !== undefined ? { idle } : {}),
          lastEntry: lastEntry(target),
          problems: entries.filter(isProblem).slice(-20).map((entry) => ({
            ...row(entry),
            ...(entry.scope === 'host' ? { detail: entry.detail ?? null } : {}),
          })),
          entries: entries.slice(-150).map(row),
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

  // What each configured source offers. Tools that change the app are
  // registered only when actions are on.
  for (const source of sources) {
    for (const tool of source.tools ?? []) {
      if (tool.action && !actions) continue
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: { session, ...tool.input },
          annotations: tool.action ? write : read,
        },
        ({ session: id, ...args }: { session?: string } & Record<string, unknown>) =>
          guard(() => {
            const target = hub.resolve(id)
            return tool.run(args, {
              session: target,
              hub,
              actions,
              call: (method, callArgs, timeoutMs) =>
                hub.call(target, method, callArgs, timeoutMs),
            })
          }),
      )
    }
  }

  return server
}
