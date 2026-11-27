import { CORE_RULES, collect, ruleContext } from '@loopsight/core/server'
import { otelServerSource } from '@loopsight/otel'
import { devtoolsServerSource } from '@loopsight/tanstack-devtools'
import { queryServerSource } from '@loopsight/tanstack-query'
import { routerServerSource } from '@loopsight/tanstack-router'
import { startServerSource } from '@loopsight/tanstack-start'
import { viteServerSource } from '@loopsight/vite'
import type { LogEntry, PageFacts, ServerSource } from '@loopsight/core/server'
import type { QueryFacts } from '@loopsight/tanstack-query'
import type { RouterFacts } from '@loopsight/tanstack-router'

/**
 * What the Vite plugin hands the core with nothing configured: the server
 * half of each built-in source, in the preset's order, then Vite's own.
 */
export const SOURCES: Array<ServerSource> = [
  routerServerSource,
  queryServerSource,
  startServerSource,
  devtoolsServerSource,
  otelServerSource,
  viteServerSource,
]

export const PARTS = collect(SOURCES)
export const RULES = [...CORE_RULES, ...PARTS.rules]
export const MESSAGES = PARTS.messages

/** How the libraries are set up, as the tests state it. */
export interface Setup {
  queryFacts?: QueryFacts | null
  routerFacts?: RouterFacts | null
  /** The live overview parts, under each source's key. */
  query?: unknown
  router?: unknown
}

/** The shape a page reports: each source's facts under that source's key. */
export function live(setup: Setup | null): PageFacts | null {
  if (!setup) return null
  const { queryFacts, routerFacts, ...overview } = setup
  return {
    ...overview,
    facts: {
      ...(queryFacts ? { query: queryFacts } : {}),
      ...(routerFacts ? { router: routerFacts } : {}),
    },
  }
}

/**
 * Adds what the recorders stamp on an entry next to its text, which is what
 * rules read. Tests write the text; this keeps the two from drifting apart.
 */
export function recorded(entry: LogEntry): LogEntry {
  const detail = (entry.detail ?? {}) as Record<string, unknown>
  const add = (more: Record<string, unknown>): LogEntry => ({ ...entry, detail: { ...more, ...detail } })
  if (entry.source === 'vite') {
    const host: LogEntry = { ...entry, scope: 'host' }
    return entry.type === 'invalidate'
      ? { ...host, detail: { fastRefresh: /Could not Fast Refresh/.test(entry.summary), ...detail } }
      : host
  }
  if (entry.source === 'query' && entry.type === 'fetch' && / refetching$/.test(entry.summary)) {
    return add({ refetch: true })
  }
  if (entry.source === 'router' && entry.type === 'onResolved' && entry.summary.startsWith('(initial)')) {
    return add({ initial: true })
  }
  if (entry.source === 'network') {
    const status = / → (\d{3})$/.exec(entry.summary)?.[1]
    if (status) return add({ status: Number(status) })
  }
  return entry
}

export function check(id: string, entries: Array<LogEntry>, setup: Setup | null = null) {
  const rule = RULES.find((candidate) => candidate.id === id)
  if (!rule) throw new Error(`No rule ${id}`)
  return rule.check(ruleContext(entries, live(setup)))
}
