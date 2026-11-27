import type { LogEntry } from '../protocol.js'

/** Where a recommendation comes from: a docs page or a skill the library ships. */
export interface Reference {
  label: string
  /**
   * A URL, or `package: path` for a skill file the library ships inside its
   * npm package, which an agent can open in the app's node_modules.
   */
  at: string
}

export interface Finding {
  severity: 'error' | 'warning' | 'info'
  title: string
  /** Entry numbers to read with get_event, newest last. */
  entries?: Array<number>
  evidence: Array<string>
  hint?: string
  /** What the library's own documentation says to do instead. */
  fix?: string
  /** The page or skill that says so. */
  docs?: Reference
  /** The id of the rule that produced it. */
  rule?: string
}

export interface QueryFact {
  queryHash: string
  family: string
  status?: string
  fetchStatus?: string
  stale: boolean
  disabled: boolean
  hasData: boolean
  hasQueryFn: boolean
  failures: number
  /** In the cache before the page connected, as a server render leaves it. */
  preloaded: boolean
  /** Fetches started since the page connected. */
  fetches: number
  /** Pages held, for an infinite query. */
  pages?: number
  options: Record<string, unknown>
  observers: Array<Record<string, unknown>>
}

export interface RouteFact {
  routeId: string
  status?: string
  cause?: string
  preload?: boolean
  error?: string
  hasLoaderData: boolean
  loaderDepsIsSearch?: boolean
  searchError?: string
  route: Record<string, unknown> & { has: Array<string> }
}

/** What the page reports about itself: its overview, plus how it is set up. */
export interface Facts {
  url?: string
  router?: { error?: string; notFound?: string; href?: string; matches?: Array<string> } | null
  query?: { errors?: Array<{ queryHash: string; error: string }> } | null
  queryFacts?: {
    defaults: Record<string, unknown>
    queries: Array<QueryFact>
  } | null
  routerFacts?: {
    options: Record<string, unknown> & { has: Array<string> }
    contextKeys: Array<string>
    routeCount: number
    matches: Array<RouteFact>
  } | null
  /** Milliseconds between the page starting to load and it connecting. */
  connectedAfterLoad?: number
  /** Packages of interest the page has loaded, such as another router. */
  modules?: Array<string>
}

export interface RuleContext {
  entries: Array<LogEntry>
  facts: Facts | null
  /** Entries of one source, of the given types, oldest first. */
  by: (source: LogEntry['source'], ...types: Array<string>) => Array<LogEntry>
}

/**
 * One documented mistake. `check` returns a finding per occurrence it wants
 * to report; the rule's `fix` and `docs` are attached to each.
 */
export interface Rule {
  id: string
  /** The recommended way, in a sentence or two, as the source states it. */
  fix: string
  docs: Reference
  check: (context: RuleContext) => Array<Omit<Finding, 'fix' | 'docs' | 'rule'>>
}

/**
 * A warning a library prints in development. Matching its text is exact: the
 * library has already decided the app is doing something wrong.
 */
export interface KnownMessage {
  id: string
  pattern: RegExp
  title: string
  severity: Finding['severity']
  fix: string
  docs: Reference
}

export function clip(text: string, chars = 220): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

export function where(entry: LogEntry): string {
  return entry.at?.[0] ? ` — from ${entry.at[0]}` : ''
}

export const numbers = (entries: Array<LogEntry>) =>
  entries.slice(-5).map((entry) => entry.n)

export function runRules(
  rules: Array<Rule>,
  messages: Array<KnownMessage>,
  context: RuleContext,
): Array<Finding> {
  const findings: Array<Finding> = []
  for (const rule of rules) {
    let found: ReturnType<Rule['check']>
    try {
      found = rule.check(context)
    } catch {
      // A rule that trips over an unexpected shape must not hide the others.
      continue
    }
    for (const finding of found.slice(0, 3)) {
      findings.push({ ...finding, fix: rule.fix, docs: rule.docs, rule: rule.id })
    }
  }

  const said = context.entries.filter(
    (entry) => entry.source === 'console' && entry.type !== 'repeat',
  )
  for (const message of messages) {
    const matches = said.filter((entry) => message.pattern.test(entry.summary))
    if (matches.length === 0) continue
    findings.push({
      severity: message.severity,
      title: message.title,
      entries: numbers(matches),
      evidence: [clip(matches.at(-1)!.summary, 300) + where(matches.at(-1)!)],
      fix: message.fix,
      docs: message.docs,
      rule: message.id,
    })
  }
  return findings
}
