import { clip, numbers, ruleContext, runRules, where } from './rules.js'
import type { LogEntry } from '../protocol.js'
import type {
  Finding,
  KnownMessage,
  PageFacts,
  Rule,
  SlowKind,
} from './rules.js'

export type { Finding } from './rules.js'

/** What the sources bring to a diagnosis. See `collect` in `source.ts`. */
export interface DiagnoseParts {
  rules?: ReadonlyArray<Rule>
  messages?: ReadonlyArray<KnownMessage>
  slow?: ReadonlyArray<SlowKind>
}

const HOST_PROBLEMS = new Set(['error', 'server-error'])

/**
 * Errors and failures. Whoever records an entry says so with `problem`; a
 * dev server's errors count without it.
 */
export function isProblem(entry: LogEntry): boolean {
  if (entry.problem === true) return true
  return entry.scope === 'host' && HOST_PROBLEMS.has(entry.type)
}

export function groups(entries: Array<LogEntry>, name: (entry: LogEntry) => string) {
  const map = new Map<string, Array<LogEntry>>()
  for (const entry of entries) {
    const id = name(entry)
    const list = map.get(id)
    if (list) list.push(entry)
    else map.set(id, [entry])
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
}

/** The most entries of one group inside any window of `windowMs`. */
export function burst(entries: Array<LogEntry>, windowMs: number): Array<LogEntry> {
  let best: Array<LogEntry> = []
  let start = 0
  for (let end = 0; end < entries.length; end++) {
    while (entries[end]!.t - entries[start]!.t > windowMs) start += 1
    if (end - start + 1 > best.length) best = entries.slice(start, end + 1)
  }
  return best
}

/** The largest set of entries whose requests were all in flight at one moment. */
function overlapping(entries: Array<LogEntry>): Array<LogEntry> {
  const spans = entries
    .map((entry) => ({ entry, start: entry.t - (entry.dur ?? 0), end: entry.t }))
    .sort((a, b) => a.start - b.start)
  let best: Array<LogEntry> = []
  for (const span of spans) {
    const live = spans.filter((other) => other.start <= span.start && other.end > span.start)
    if (live.length > best.length) best = live.map((item) => item.entry)
  }
  return best
}

const withoutOutcome = (summary: string) => summary.replace(/ → [^→]*$/, '')

/**
 * What the core can tell by itself, from the console, the network and the
 * dev server. It knows no library; sources add their own rules.
 */
export const CORE_RULES: ReadonlyArray<Rule> = [
  {
    id: 'core/build-error',
    check: ({ host }) => {
      // The build is broken when the last thing the dev server said was an error.
      const last = host('error', 'hmr-update', 'full-reload').at(-1)
      if (last?.type !== 'error') return []
      return [
        {
          severity: 'error',
          title: 'The dev server reports a build error, and no update has succeeded since',
          entries: [last.n],
          evidence: [clip(last.summary, 400)],
          hint: 'The page still runs the code from before the error. Fix it, then call wait_for_update.',
        },
      ]
    },
  },
  {
    id: 'core/hydration-mismatch',
    check: ({ by }) => {
      const hydration = by('console', 'error', 'warn', 'uncaught').filter((e) =>
        /hydrat/i.test(e.summary),
      )
      if (hydration.length === 0) return []
      return [
        {
          severity: 'error',
          title: 'Hydration mismatch between the server render and the client',
          entries: numbers(hydration),
          evidence: [clip(hydration.at(-1)!.summary, 400) + where(hydration.at(-1)!)],
        },
      ]
    },
  },
  {
    id: 'core/uncaught',
    check: ({ by }) =>
      groups(by('console', 'uncaught', 'unhandledrejection'), (e) => e.summary)
        .slice(0, 5)
        .map(([summary, list]) => {
          // The browser hides everything about an error in a script from
          // another origin, and reports only this.
          const opaque = summary === 'Script error.'
          return {
            severity: opaque ? ('warning' as const) : ('error' as const),
            title: `Uncaught error${list.length > 1 ? ` (${list.length} times)` : ''}`,
            entries: numbers(list),
            evidence: [clip(summary) + where(list.at(-1)!)],
            ...(opaque
              ? {
                  hint: 'A script from another origin threw. The browser withholds the message and stack, so this is rarely the app.',
                }
              : {}),
          }
        }),
  },
  {
    id: 'core/failed-requests',
    check: ({ by }) => {
      const failed = groups(by('network', 'error', 'failed'), (e) => e.summary)
      if (failed.length === 0) return []
      return [
        {
          severity: 'error',
          title: `${failed.reduce((sum, [, list]) => sum + list.length, 0)} failed requests`,
          entries: numbers(failed.flatMap(([, list]) => list).sort((a, b) => a.n - b.n)),
          evidence: failed
            .slice(0, 5)
            .map(([summary, list]) => `${list.length > 1 ? `${list.length}× ` : ''}${clip(summary)}${where(list.at(-1)!)}`),
        },
      ]
    },
  },
  {
    id: 'core/duplicate-requests',
    check: ({ by }) => {
      // Two copies of one request in flight together were probably meant as
      // one. GET only: two POSTs to one URL can carry different bodies, which
      // are never read, so they cannot be called the same request.
      const findings = []
      for (const [, list] of groups(
        by('network', 'ok', 'error').filter(
          (e) => e.dur !== undefined && /^(?:GET|HEAD) /.test(e.summary),
        ),
        // The page fingerprints the whole URL; the summary shows only its start.
        (e) => (e.detail as { id?: string } | undefined)?.id ?? withoutOutcome(e.summary),
      )) {
        const together = overlapping(list)
        if (together.length < 2) continue
        findings.push({
          severity: 'warning' as const,
          title: `The same request was in flight ${together.length} times at once`,
          entries: numbers(together),
          evidence: [clip(withoutOutcome(together.at(-1)!.summary)) + where(together.at(-1)!)],
          hint: 'Callers that share a cache key share one request.',
        })
      }
      return findings
    },
  },
  {
    // The page answers these about itself when asked, so they describe it as
    // it is now and say nothing once it has closed.
    id: 'core/document-status',
    check: ({ facts }) => {
      const status = facts<DocumentState>('document')?.status
      if (status === undefined || status < 400) return []
      return [
        {
          severity: 'warning',
          title: `The server answered this page with ${status}`,
          evidence: ['What is on screen is the page the app shows for that answer.'],
          hint: 'A page that renders can still be a not-found or error page. Check the address and the route that matched.',
        },
      ]
    },
  },
  {
    id: 'core/stalled-requests',
    check: ({ overview }) => {
      const stalled = (overview<Array<{ request: string; forMs: number }>>('waitingOn') ?? []).filter(
        (item) => item.forMs >= 10_000,
      )
      if (stalled.length === 0) return []
      return [
        {
          severity: 'warning',
          title: `${stalled.length} ${stalled.length === 1 ? 'request has' : 'requests have'} been in flight for over 10 s`,
          evidence: stalled
            .slice(0, 5)
            .map((item) => `${Math.round(item.forMs / 1000)} s and counting: ${clip(item.request, 200)}`),
          hint: 'The page stops counting these as pending, so it reads as idle while something that depends on them never arrives. Right as it is for a long poll.',
        },
      ]
    },
  },
  {
    id: 'core/broken-images',
    check: ({ facts }) => {
      const page = facts<DocumentState>('document')
      if (!page || !page.brokenImageCount) return []
      return [
        {
          severity: 'warning',
          title: `${page.brokenImageCount} ${page.brokenImageCount === 1 ? 'image' : 'images'} did not load`,
          evidence: page.brokenImages.slice(0, 5).map((source) => clip(source, 200)),
        },
      ]
    },
  },
  {
    id: 'core/unnamed-controls',
    check: ({ facts }) => {
      const page = facts<DocumentState>('document')
      if (!page || !page.unnamedCount) return []
      return [
        {
          severity: 'warning',
          title: `${page.unnamedCount} ${page.unnamedCount === 1 ? 'link or control has' : 'links or controls have'} no accessible name`,
          evidence: page.unnamed.slice(0, 5).map((html) => clip(html, 260)),
          hint: 'Each is a tab stop a screen reader cannot describe. Give it visible text, an `aria-label`, or an image with `alt`. An empty link often means its content failed to render.',
        },
      ]
    },
  },
]

/** The page half's `DocumentFacts`, as much of it as the rules read. */
interface DocumentState {
  status?: number
  brokenImages: Array<string>
  brokenImageCount: number
  unnamed: Array<string>
  unnamedCount: number
}

const CORE_SLOW: ReadonlyArray<SlowKind> = [
  // The document is a request too, and the one a slow server render shows in.
  { source: 'network', types: ['ok', 'error', 'document'], floorMs: 2000, label: 'request', plural: 'requests' },
]

function sentence(words: Array<string>): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * Looks through a session's log, and the live page when there is one, for
 * things that are wrong or wasteful. Every rule reads recorded facts; none
 * guesses at intent.
 */
export function diagnose(
  entries: Array<LogEntry>,
  live: PageFacts | null,
  dropped = 0,
  parts: DiagnoseParts = {},
): { ok: boolean; findings: Array<Finding>; checked: number } {
  const context = ruleContext(entries, live)
  const found = runRules(
    [...CORE_RULES, ...(parts.rules ?? [])],
    parts.messages ?? [],
    context,
  )

  // What the app passed to console.error and no rule explains. A message
  // another finding is about is said once, the better way.
  const explained = new Set(found.flatMap((finding) => finding.entries ?? []))
  const said = groups(context.by('console', 'error'), (entry) => entry.summary).filter(
    ([, list]) => !list.some((entry) => explained.has(entry.n)),
  )
  let findings = found
  if (said.length > 0) {
    findings = [
      {
        severity: 'warning',
        title: `console.error called with ${said.length} distinct ${said.length === 1 ? 'message' : 'messages'}`,
        entries: numbers(said.flatMap(([, list]) => list).sort((a, b) => a.n - b.n)),
        evidence: said
          .slice(0, 5)
          .map(([summary, list]) => `${list.length > 1 ? `${list.length}× ` : ''}${clip(summary)}${where(list.at(-1)!)}`),
        rule: 'core/console-errors',
      },
      ...found,
    ]
  }

  const order = { error: 0, warning: 1, info: 2 }
  findings = [...findings].sort((a, b) => order[a.severity] - order[b.severity])

  const kinds = [...(parts.slow ?? []), ...CORE_SLOW]
  const slow = kinds.flatMap((kind) =>
    context
      .by(kind.source, ...kind.types)
      .filter((entry) => (entry.dur ?? 0) >= kind.floorMs)
      .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
      .slice(0, 3)
      .map((entry) => ({ entry, kind })),
  )
  if (slow.length > 0) {
    findings.push({
      severity: 'info',
      title: `Slowest ${sentence(kinds.map((kind) => kind.plural))}`,
      entries: slow.map(({ entry }) => entry.n),
      evidence: slow.map(
        ({ entry, kind }) => `${entry.dur} ms ${kind.label}: ${clip(entry.summary, 160)}`,
      ),
    })
  }

  if (dropped > 0) {
    findings.push({
      severity: 'info',
      title: `The log dropped its ${dropped} oldest entries`,
      evidence: ['Older events are not covered. Raise `size` to keep more.'],
    })
  }

  return {
    ok: !findings.some((finding) => finding.severity !== 'info'),
    findings,
    checked: entries.length,
  }
}
