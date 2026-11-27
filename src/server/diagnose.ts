import { HYDRATION_FIX, KNOWN_MESSAGES, RULES } from './advice.js'
import { clip, numbers, runRules, where } from './rules.js'
import type { LogEntry } from '../protocol.js'
import type { Facts, Finding, KnownMessage, Rule } from './rules.js'

export type { Finding } from './rules.js'

const CONSOLE_PROBLEMS = new Set(['error', 'uncaught', 'unhandledrejection'])

/** Errors and failures, whichever source reported them. */
export function isProblem(entry: LogEntry): boolean {
  switch (entry.source) {
    case 'console':
      return CONSOLE_PROBLEMS.has(entry.type)
    case 'vite':
      return entry.type === 'error' || entry.type === 'server-error'
    case 'network':
      return entry.type === 'error' || entry.type === 'failed'
    case 'query':
    case 'mutation':
      return entry.type === 'error'
    case 'router':
      return entry.summary.includes('(error in ')
    default:
      return false
  }
}

function groups(entries: Array<LogEntry>, name: (entry: LogEntry) => string) {
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
function burst(entries: Array<LogEntry>, windowMs: number): Array<LogEntry> {
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

/**
 * Looks through a session's log, and the live page when there is one, for
 * things that are wrong or wasteful. Every rule reads recorded facts; none
 * guesses at intent.
 */
export function diagnose(
  entries: Array<LogEntry>,
  live: Facts | null,
  dropped = 0,
  rules: Array<Rule> = RULES,
  messages: Array<KnownMessage> = KNOWN_MESSAGES,
): { ok: boolean; findings: Array<Finding>; checked: number } {
  const findings: Array<Finding> = []
  const by = (source: LogEntry['source'], ...types: Array<string>) =>
    entries.filter((e) => e.source === source && types.includes(e.type))

  // The build is broken when the last thing Vite said was an error.
  const builds = by('vite', 'error', 'hmr-update', 'full-reload')
  const lastBuild = builds.at(-1)
  if (lastBuild?.type === 'error') {
    findings.push({
      severity: 'error',
      title: 'Vite reports a build error, and no update has succeeded since',
      entries: [lastBuild.n],
      evidence: [clip(lastBuild.summary, 400)],
      hint: 'The page still runs the code from before the error. Fix it, then call wait_for_update.',
    })
  }

  const hydration = by('console', 'error', 'warn', 'uncaught').filter((e) =>
    /hydrat/i.test(e.summary),
  )
  if (hydration.length > 0) {
    findings.push({
      severity: 'error',
      title: 'Hydration mismatch between the server render and the client',
      entries: numbers(hydration),
      evidence: [clip(hydration.at(-1)!.summary, 400) + where(hydration.at(-1)!)],
      fix: HYDRATION_FIX.fix,
      docs: HYDRATION_FIX.docs,
      rule: 'start/hydration-mismatch',
    })
  }

  for (const [summary, list] of groups(
    by('console', 'uncaught', 'unhandledrejection'),
    (e) => e.summary,
  ).slice(0, 5)) {
    // The browser hides everything about an error in a script from another
    // origin, and reports only this.
    const opaque = summary === 'Script error.'
    findings.push({
      severity: opaque ? 'warning' : 'error',
      title: `Uncaught error${list.length > 1 ? ` (${list.length} times)` : ''}`,
      entries: numbers(list),
      evidence: [clip(summary) + where(list.at(-1)!)],
      ...(opaque
        ? { hint: 'A script from another origin threw. The browser withholds the message and stack, so this is rarely the app.' }
        : {}),
    })
  }

  if (live?.router?.error) {
    findings.push({
      severity: 'error',
      title: 'A matched route is showing an error',
      evidence: [clip(live.router.error)],
    })
  }

  const failedQueries = live?.query?.errors ?? []
  if (failedQueries.length > 0) {
    findings.push({
      severity: 'error',
      title: `${failedQueries.length} ${failedQueries.length === 1 ? 'query is' : 'queries are'} in the error state`,
      evidence: failedQueries.slice(0, 5).map((q) => `${clip(q.queryHash, 120)}: ${clip(q.error, 160)}`),
      hint: 'get_query shows the full error and where the query is used.',
    })
  }

  const failedMutations = by('mutation', 'error')
  if (failedMutations.length > 0) {
    findings.push({
      severity: 'error',
      title: `${failedMutations.length} failed ${failedMutations.length === 1 ? 'mutation' : 'mutations'}`,
      entries: numbers(failedMutations),
      evidence: failedMutations.slice(-3).map((e) => clip(e.summary)),
    })
  }

  const failedRequests = groups(by('network', 'error', 'failed'), (e) => e.summary)
  if (failedRequests.length > 0) {
    findings.push({
      severity: 'error',
      title: `${failedRequests.reduce((sum, [, list]) => sum + list.length, 0)} failed requests`,
      entries: numbers(failedRequests.flatMap(([, list]) => list).sort((a, b) => a.n - b.n)),
      evidence: failedRequests
        .slice(0, 5)
        .map(([summary, list]) => `${list.length > 1 ? `${list.length}× ` : ''}${clip(summary)}${where(list.at(-1)!)}`),
    })
  }

  const consoleErrors = groups(
    by('console', 'error').filter((e) => !/hydrat/i.test(e.summary)),
    (e) => e.summary,
  )
  if (consoleErrors.length > 0) {
    findings.push({
      severity: 'warning',
      title: `console.error called with ${consoleErrors.length} distinct ${consoleErrors.length === 1 ? 'message' : 'messages'}`,
      entries: numbers(consoleErrors.flatMap(([, list]) => list).sort((a, b) => a.n - b.n)),
      evidence: consoleErrors
        .slice(0, 5)
        .map(([summary, list]) => `${list.length > 1 ? `${list.length}× ` : ''}${clip(summary)}${where(list.at(-1)!)}`),
    })
  }

  // Four fetches of one query inside ten seconds is a loop, not a user.
  for (const [key, list] of groups(by('query', 'fetch'), (e) => e.key ?? '')) {
    const run = burst(list, 10_000)
    if (run.length < 4) continue
    findings.push({
      severity: 'warning',
      title: `A query fetched ${run.length} times within 10 s`,
      entries: numbers(run),
      evidence: [clip(key, 160) + where(run.at(-1)!)],
      hint: 'Common causes: a query key that changes on every render, an effect that invalidates on each update, or staleTime 0 with many mounts.',
    })
    if (findings.filter((f) => f.title.startsWith('A query fetched')).length >= 3) break
  }

  // Two copies of one request in flight together were probably meant as one.
  // GET only: two POSTs to one URL can carry different bodies, which are
  // never read, so they cannot be called the same request.
  for (const [summary, list] of groups(
    by('network', 'ok', 'error').filter(
      (e) => e.dur !== undefined && /^(?:GET|HEAD) /.test(e.summary),
    ),
    (e) => e.summary.replace(/ → .*$/, ''),
  )) {
    const together = overlapping(list)
    if (together.length < 2) continue
    findings.push({
      severity: 'warning',
      title: `The same request was in flight ${together.length} times at once`,
      entries: numbers(together),
      evidence: [clip(summary) + where(together.at(-1)!)],
      hint: 'Callers that share a query key share one request.',
    })
    if (findings.filter((f) => f.title.startsWith('The same request')).length >= 3) break
  }

  const slowest = (list: Array<LogEntry>, floor: number) =>
    list
      .filter((e) => (e.dur ?? 0) >= floor)
      .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
      .slice(0, 3)
  const slow = [
    ...slowest(by('router', 'onResolved'), 1500).map((e) => ({ e, what: 'navigation' })),
    ...slowest(by('query', 'success', 'error'), 1000).map((e) => ({ e, what: 'query' })),
    ...slowest(by('network', 'ok', 'error'), 2000).map((e) => ({ e, what: 'request' })),
  ]
  if (slow.length > 0) {
    findings.push({
      severity: 'info',
      title: 'Slowest navigations, queries and requests',
      entries: slow.map(({ e }) => e.n),
      evidence: slow.map(({ e, what }) => `${e.dur} ms ${what}: ${clip(e.summary, 160)}`),
    })
  }

  // What the libraries' own docs and skills call a mistake, with their fix.
  const documented = runRules(rules, messages, { entries, facts: live, by })
  // A documented warning is also a console line; say it once, the better way.
  const explained = new Set(documented.flatMap((finding) => finding.entries ?? []))
  const documentedText = documented.flatMap((finding) => finding.evidence).join('\n')
  const kept = findings.filter((finding) => {
    if (finding.title.startsWith('A query fetched')) {
      // The same loop, already explained with its documented cause.
      const key = (finding.evidence[0] ?? '').split(' — from ')[0] ?? ''
      return !(key !== '' && documentedText.includes(key))
    }
    if (!finding.title.startsWith('console.error called')) return true
    const rest = (finding.entries ?? []).filter((n) => !explained.has(n))
    return rest.length > 0 || (finding.entries ?? []).length === 0
  })
  const order = { error: 0, warning: 1, info: 2 }
  const merged = [...kept, ...documented].sort(
    (a, b) => order[a.severity] - order[b.severity],
  )
  findings.length = 0
  findings.push(...merged)

  if (dropped > 0) {
    findings.push({
      severity: 'info',
      title: `The log dropped its ${dropped} oldest entries`,
      evidence: ['Older events are not covered. Raise `size` to keep more.'],
    })
  }

  return {
    ok: !findings.some((f) => f.severity !== 'info'),
    findings,
    checked: entries.length,
  }
}
