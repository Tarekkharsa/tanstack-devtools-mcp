import { clip, groups, numbers } from '@loopsight/core/server'
import type { LogEntry, Rule, RuleContext } from '@loopsight/core/server'
import type { LogDetail, Node, TraceDetail } from './store.js'

const trace = (entry: LogEntry) => entry.detail as TraceDetail
const log = (entry: LogEntry) => entry.detail as LogDetail

/** The page's own entry for the request a server record belongs to. */
function requestOf(context: RuleContext, n: number): LogEntry | undefined {
  return context.entries.find((entry) => entry.n === n)
}

/** A request the page took as a success, whatever happened behind it. */
const succeeded = (request: LogEntry | undefined) =>
  request !== undefined &&
  (request.type === 'ok' ||
    (request.type === 'document' &&
      ((request.detail as { status?: number } | undefined)?.status ?? 200) < 400))

/**
 * What a request was, in a few words. For the document it matters whether
 * the server work could have held up the first byte: work that outlasted it
 * was streamed in afterwards, and delayed a part of the page, not all of it.
 */
function what(request: LogEntry | undefined, serverMs?: number): string {
  if (request === undefined) return ''
  if (request.type !== 'document') return clip(request.summary.replace(/ → [^→]*$/, ''), 90)
  const wait = (request.detail as { wait?: number } | undefined)?.wait
  if (wait === undefined || serverMs === undefined) return 'the document'
  return serverMs > wait + 100
    ? `the document (streamed in after its first byte at ${wait} ms)`
    : `the document (before its first byte at ${wait} ms)`
}

const failedCall = (node: Node) =>
  node.call !== undefined && (node.error !== undefined || (node.status ?? 0) >= 400)

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The children of the node at `index`, as indexes into the same list. */
function childrenOf(nodes: ReadonlyArray<Node>, index: number): Array<number> {
  const depth = nodes[index]!.depth
  const out: Array<number> = []
  for (let next = index + 1; next < nodes.length && nodes[next]!.depth > depth; next++) {
    if (nodes[next]!.depth === depth + 1) out.push(next)
  }
  return out
}

const label = (node: Node) => `${node.alongside ? '~' : ''}${node.name}${node.about ? ` (${node.about})` : node.call && node.call !== node.name ? ` (${node.call})` : ''}`

export const OTEL_RULES: ReadonlyArray<Rule> = [
  {
    // The page cannot see this: a server that answers 200 with less than it
    // meant to send looks, from the browser, exactly like one that sent it all.
    id: 'server/failed-behind-success',
    check: (context) => {
      const hits = context
        .by('server', 'trace')
        .filter((entry) => trace(entry).failed > 0 && succeeded(requestOf(context, trace(entry).request)))
      if (hits.length === 0) return []
      const total = hits.reduce((sum, entry) => sum + trace(entry).failed, 0)
      return [
        {
          severity: 'warning',
          title: `${plural(total, 'call', 'calls')} out of the server failed behind ${plural(hits.length, 'answer', 'answers')} the page took as a success`,
          entries: numbers(hits),
          evidence: hits.slice(-5).map((entry) => {
            const failures = new Map<string, number>()
            for (const node of trace(entry).spans.filter(failedCall)) {
              const text = `${node.call}${node.about ? ` ${node.about}` : ''} → ${node.status ?? clip(node.error ?? 'failed', 80)}`
              failures.set(text, (failures.get(text) ?? 0) + 1)
            }
            return `${entry.key}: ${[...failures]
              .slice(0, 3)
              .map(([text, count]) => `${count > 1 ? `${count}× ` : ''}${clip(text, 140)}`)
              .join('; ')}`
          }),
          hint: 'Right if the server treats that answer as "nothing to show". Otherwise the page is showing less than it should and nothing in the browser says so. `server_trace` shows the whole request.',
        },
      ]
    },
  },
  {
    id: 'server/why-it-failed',
    check: (context) => {
      const findings = []
      for (const entry of context.by('server', 'trace')) {
        const request = requestOf(context, trace(entry).request)
        if (request?.type !== 'error') continue
        const failed = trace(entry).spans.filter((node) => node.error !== undefined)
        // The deepest failure is the cause; the ones above it only pass it on.
        const cause = failed.reduce<Node | undefined>(
          (deepest, node) => (!deepest || node.depth >= deepest.depth ? node : deepest),
          undefined,
        )
        if (!cause) continue
        findings.push({
          severity: 'error' as const,
          title: 'The server says where a failed request went wrong',
          entries: [request.n, entry.n],
          evidence: [
            clip(request.summary, 160),
            `${label(cause)}: ${clip(cause.error ?? '', 200)}`,
          ],
        })
      }
      return findings.slice(-3)
    },
  },
  {
    id: 'server/logged',
    check: (context) => {
      const logs = context.by('server', 'log')
      if (logs.length === 0) return []
      const errors = logs.filter((entry) => log(entry).level === 'error')
      const said = groups(logs, (entry) => `${log(entry).level.toUpperCase()} ${entry.key}`)
      return [
        {
          severity: errors.length > 0 ? ('error' as const) : ('warning' as const),
          title: `The server logged ${plural(said.length, 'distinct warning or error', 'distinct warnings and errors')} while answering this page`,
          entries: numbers(logs),
          evidence: said
            .map(([text, list]) => ({
              text,
              list,
              // A message written for every request says little about this
              // page; one written for a single request says the most.
              requests: new Set(list.map((entry) => log(entry).request)).size,
            }))
            .sort(
              (a, b) =>
                Number(b.text.startsWith('ERROR')) - Number(a.text.startsWith('ERROR')) ||
                a.requests - b.requests,
            )
            .slice(0, 8)
            .map(({ text, list, requests }) => {
              const during = log(list.at(-1)!).during
              return `${list.length > 1 ? `${list.length}× ` : ''}${clip(text, 180)}${during ? ` — in ${during}` : ''}${requests > 2 ? ` (for ${requests} requests)` : ''}`
            }),
          hint: 'A warning here is often a part of the page the server gave up on. Open an entry with get_event for its fields.',
        },
      ]
    },
  },
  {
    id: 'server/cut-short',
    check: (context) => {
      const hits = context.by('server', 'trace').filter((entry) => {
        const request = requestOf(context, trace(entry).request)
        // The page dropping the request stops the work behind it, as it should.
        return trace(entry).cut > 0 && request?.type !== 'aborted'
      })
      if (hits.length === 0) return []
      const total = hits.reduce((sum, entry) => sum + trace(entry).cut, 0)
      return [
        {
          severity: 'info',
          title: `${plural(total, 'piece', 'pieces')} of server work ${total === 1 ? 'was' : 'were'} stopped before finishing`,
          entries: numbers(hits),
          evidence: hits.slice(-5).map((entry) => {
            const cut = trace(entry).spans.filter((node) => node.cut)
            // The outermost one names the work; what is inside it went with it.
            const top = Math.min(...cut.map((node) => node.depth))
            return `${entry.key}: ${cut
              .filter((node) => node.depth === top)
              .slice(0, 3)
              .map((node) => `${label(node)} after ${node.ms} ms`)
              .join(', ')}`
          }),
          hint: 'A timeout or a time budget on the server did this. What that work was loading is missing from the answer unless something else supplied it.',
        },
      ]
    },
  },
  {
    id: 'server/one-after-another',
    check: (context) => {
      const found: Array<{ entry: LogEntry; parent: Node; run: Array<Node>; total: number; same: boolean }> = []
      for (const entry of context.by('server', 'trace').slice(-40)) {
        const nodes = trace(entry).spans
        nodes.forEach((parent, index) => {
          const steps = childrenOf(nodes, index)
            .map((child) => nodes[child]!)
            .filter((node) => node.ms >= 100 && !node.alongside)
          let run: Array<Node> = []
          const close = () => {
            const total = run.reduce((sum, node) => sum + node.ms, 0)
            // A short check before the real work is not a waterfall.
            const even = run.every((node) => node.ms >= total * 0.15)
            if (run.length >= 2 && total >= 400 && even) {
              const same = run.every((node) => label(node) === label(run[0]!)) && run.length >= 3
              found.push({ entry, parent, run, total, same })
            }
            run = []
          }
          for (const step of steps) {
            const previous = run.at(-1)
            // Started only once the one before had ended.
            if (previous && step.at < previous.at + previous.ms - 3) close()
            run.push(step)
          }
          close()
        })
      }
      if (found.length === 0) return []
      const worst = found.sort((a, b) => b.total - a.total).slice(0, 3)
      const repeated = worst.filter((item) => item.same)
      return [
        {
          severity: repeated.length > 0 ? ('warning' as const) : ('info' as const),
          title:
            repeated.length > 0
              ? `The server made the same call ${repeated[0]!.run.length} times, one after another`
              : `Server work ran one step after another, ${worst[0]!.total} ms in the longest run`,
          entries: [...new Set(worst.map((item) => item.entry.n))],
          evidence: worst.map(
            (item) =>
              `${item.entry.key} › ${item.parent.name}: ${
                item.same
                  ? `${item.run.length}× ${label(item.run[0]!)}, ${item.total} ms in all`
                  : item.run.map((node) => `${label(node)} ${node.ms} ms`).join(', then ')
              }`,
          ),
          hint: 'Right as it is if each step needs the answer of the one before. If not, running them together would take as long as the slowest alone.',
        },
      ]
    },
  },
  {
    id: 'server/where-the-time-went',
    check: (context) => {
      const slow = context
        .by('server', 'trace')
        .filter((entry) => trace(entry).ms >= 1000)
        .sort((a, b) => trace(b).ms - trace(a).ms)
        .slice(0, 3)
      if (slow.length === 0) return []
      return [
        {
          severity: 'info',
          title: `Where the server spent the time on its ${slow.length === 1 ? 'slowest answer' : `${slow.length} slowest answers`}`,
          entries: slow.flatMap((entry) => [trace(entry).request, entry.n]),
          evidence: slow.map((entry) => {
            const nodes = trace(entry).spans
            // Follow whichever child holds most of its parent's time.
            const path: Array<Node> = []
            let index = 0
            for (;;) {
              const node = nodes[index]!
              path.push(node)
              const next = childrenOf(nodes, index).sort((a, b) => nodes[b]!.ms - nodes[a]!.ms)[0]
              if (next === undefined || nodes[next]!.ms < node.ms * 0.6) break
              index = next
            }
            const end = path.at(-1)!
            const request = requestOf(context, trace(entry).request)
            const steps = path.length > 4 ? [path[0]!, path.at(-2)!, end] : path
            return `${trace(entry).ms} ms for ${what(request, trace(entry).ms) || entry.key}: ${steps
              .map((node) => `${node.alongside ? '~' : ''}${node.name}`)
              .join(' › ')}${end.call || end.about ? ` (${end.about ?? end.call})` : ''} ${end.ms} ms`
          }),
          hint: 'The last name on each line is where the time was actually spent. A name after ~ is from another trace that ran while the step before it waited. `server_trace` shows everything under a request.',
        },
      ]
    },
  },
]
