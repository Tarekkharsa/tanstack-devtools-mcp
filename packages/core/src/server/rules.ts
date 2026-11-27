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
  /**
   * What it is about, for a rule that reports one finding per thing: a query
   * key, a file. It pairs a finding with the plainer one it replaces (see
   * `supersedes`) and is not sent to the agent.
   */
  subject?: string
}

/**
 * What the page reports about itself: its overview, with each source's part
 * under that source's key, plus `facts`, how each library is set up.
 */
export interface PageFacts {
  url?: string
  facts?: Record<string, unknown>
  /** Milliseconds between the page starting to load and it connecting. */
  connectedAfterLoad?: number
  [sourceKey: string]: unknown
}

export interface RuleContext {
  entries: Array<LogEntry>
  /** Entries of one source, of the given types, oldest first. */
  by: (source: string, ...types: Array<string>) => Array<LogEntry>
  /** How one source's library is set up, as its page half reported it. */
  facts: <T>(sourceKey: string) => T | undefined
  /** One source's part of the live page overview. */
  overview: <T>(sourceKey: string) => T | undefined
  /** What the dev server recorded, of the given types, whichever host it is. */
  host: (...types: Array<string>) => Array<LogEntry>
  /** Hot updates and full reloads: what legitimately rebuilds the app. */
  updates: () => Array<LogEntry>
}

/**
 * One thing worth telling the agent. A rule taken from a library's
 * documentation carries `fix` and `docs`, which are attached to each finding.
 */
export interface Rule {
  id: string
  /** The recommended way, in a sentence or two, as the source states it. */
  fix?: string
  docs?: Reference
  /**
   * Rules whose findings say the same thing less well. One of theirs is
   * dropped when this rule reports a finding with the same `subject`, or
   * when either of the two has none.
   */
  supersedes?: ReadonlyArray<string>
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

/** A kind of timed entry that is worth listing when it is slow. */
export interface SlowKind {
  source: string
  types: ReadonlyArray<string>
  floorMs: number
  /** Singular and plural, as they read in a sentence: "query", "queries". */
  label: string
  plural: string
}

export function clip(text: string, chars = 220): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

export function where(entry: LogEntry): string {
  return entry.at?.[0] ? ` — from ${entry.at[0]}` : ''
}

export const numbers = (entries: Array<LogEntry>) =>
  entries.slice(-5).map((entry) => entry.n)

const UPDATES = new Set(['hmr-update', 'full-reload'])

export function ruleContext(
  entries: Array<LogEntry>,
  live: PageFacts | null,
): RuleContext {
  const host = (...types: Array<string>) =>
    entries.filter((entry) => entry.scope === 'host' && types.includes(entry.type))
  return {
    entries,
    by: (source, ...types) =>
      entries.filter((entry) => entry.source === source && types.includes(entry.type)),
    facts: <T>(key: string) => live?.facts?.[key] as T | undefined,
    overview: <T>(key: string) => (live?.[key] ?? undefined) as T | undefined,
    host,
    updates: () => entries.filter((entry) => entry.scope === 'host' && UPDATES.has(entry.type)),
  }
}

export function runRules(
  rules: ReadonlyArray<Rule>,
  messages: ReadonlyArray<KnownMessage>,
  context: RuleContext,
): Array<Finding> {
  const findings: Array<Finding> = []
  const replaced: Array<{ rule: string; subject: string | undefined }> = []
  for (const rule of rules) {
    let found: ReturnType<Rule['check']>
    try {
      found = rule.check(context)
    } catch {
      // A rule that trips over an unexpected shape must not hide the others.
      continue
    }
    for (const finding of found.slice(0, 3)) {
      // Only what is reported replaces anything: a finding cut off here must
      // not hide the plainer one about the same thing.
      for (const id of rule.supersedes ?? []) {
        replaced.push({ rule: id, subject: finding.subject })
      }
      findings.push({
        ...finding,
        ...(rule.fix !== undefined ? { fix: rule.fix } : {}),
        ...(rule.docs !== undefined ? { docs: rule.docs } : {}),
        rule: rule.id,
      })
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
    .filter(
      (finding) =>
        !replaced.some(
          (by) =>
            by.rule === finding.rule &&
            (by.subject === undefined ||
              finding.subject === undefined ||
              by.subject === finding.subject),
        ),
    )
    .map(({ subject: _subject, ...finding }) => finding)
}
