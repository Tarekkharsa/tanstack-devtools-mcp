/**
 * Reads OTLP/HTTP JSON, the form every OpenTelemetry exporter can send, into
 * the few fields the rest of this package uses.
 */

export type Value = string | number | boolean

export interface Span {
  traceId: string
  spanId: string
  parentId?: string
  name: string
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer'
  /** Milliseconds since the epoch. */
  start: number
  ms: number
  /** Set when the span ended in an error: the message, or what was thrown. */
  error?: string
  attrs: Record<string, Value>
}

export interface LogRecord {
  /** Milliseconds since the epoch. */
  t: number
  level: 'debug' | 'info' | 'warn' | 'error'
  body: string
  attrs: Record<string, Value>
  traceId?: string
  spanId?: string
}

const KINDS = ['internal', 'internal', 'server', 'client', 'producer', 'consumer'] as const

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…`
}

/** An OTLP `AnyValue` as something a line of text can hold. */
function plain(value: any): Value | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.stringValue === 'string') return clip(value.stringValue, 400)
  if (value.boolValue !== undefined) return Boolean(value.boolValue)
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return Number(value.doubleValue)
  if (value.arrayValue !== undefined) {
    const items = Array.isArray(value.arrayValue.values) ? value.arrayValue.values : []
    return clip(`[${items.map((item: unknown) => String(plain(item) ?? '')).join(', ')}]`, 400)
  }
  if (value.kvlistValue !== undefined) {
    return clip(JSON.stringify(attributes(value.kvlistValue.values)), 400)
  }
  return undefined
}

function attributes(list: unknown): Record<string, Value> {
  const out: Record<string, Value> = {}
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (typeof item?.key !== 'string') continue
    const value = plain(item.value)
    if (value !== undefined) out[item.key] = value
  }
  return out
}

const nanos = (value: unknown) => Number(value) / 1e6
const id = (value: unknown) => (typeof value === 'string' && value !== '' ? value.toLowerCase() : undefined)

function kindOf(value: unknown): Span['kind'] {
  if (typeof value === 'number') return KINDS[value] ?? 'internal'
  const name = String(value ?? '').replace('SPAN_KIND_', '').toLowerCase()
  return (KINDS as ReadonlyArray<string>).includes(name) ? (name as Span['kind']) : 'internal'
}

export function readTraces(body: any): Array<Span> {
  const out: Array<Span> = []
  for (const resource of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
    for (const scope of Array.isArray(resource?.scopeSpans) ? resource.scopeSpans : []) {
      for (const span of Array.isArray(scope?.spans) ? scope.spans : []) {
        const traceId = id(span?.traceId)
        const spanId = id(span?.spanId)
        if (!traceId || !spanId) continue
        const start = nanos(span.startTimeUnixNano)
        const end = nanos(span.endTimeUnixNano)
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue
        const failed = span.status?.code === 2 || span.status?.code === 'STATUS_CODE_ERROR'
        let error: string | undefined
        if (failed) {
          const thrown = (Array.isArray(span.events) ? span.events : []).find(
            (event: any) => event?.name === 'exception',
          )
          const thrownAttrs = attributes(thrown?.attributes)
          error = clip(
            String(
              span.status?.message ||
                thrownAttrs['exception.message'] ||
                thrownAttrs['exception.type'] ||
                'error',
            ),
            300,
          )
        }
        const parentId = id(span.parentSpanId)
        out.push({
          traceId,
          spanId,
          ...(parentId ? { parentId } : {}),
          name: clip(String(span.name ?? ''), 160),
          kind: kindOf(span.kind),
          start,
          ms: Math.max(0, end - start),
          ...(error !== undefined ? { error } : {}),
          attrs: attributes(span.attributes),
        })
      }
    }
  }
  return out
}

function levelOf(record: any): LogRecord['level'] {
  const number = Number(record?.severityNumber)
  if (Number.isFinite(number) && number > 0) {
    return number >= 17 ? 'error' : number >= 13 ? 'warn' : number >= 9 ? 'info' : 'debug'
  }
  const text = String(record?.severityText ?? '').toLowerCase()
  if (/fatal|err|crit/.test(text)) return 'error'
  if (/warn/.test(text)) return 'warn'
  if (/info/.test(text)) return 'info'
  return 'debug'
}

export function readLogs(body: any): Array<LogRecord> {
  const out: Array<LogRecord> = []
  for (const resource of Array.isArray(body?.resourceLogs) ? body.resourceLogs : []) {
    for (const scope of Array.isArray(resource?.scopeLogs) ? resource.scopeLogs : []) {
      for (const record of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
        const time = nanos(record?.timeUnixNano ?? record?.observedTimeUnixNano)
        const traceId = id(record?.traceId)
        const spanId = id(record?.spanId)
        out.push({
          t: Number.isFinite(time) && time > 0 ? time : Date.now(),
          level: levelOf(record),
          body: clip(String(plain(record?.body) ?? ''), 400),
          attrs: attributes(record?.attributes),
          ...(traceId ? { traceId } : {}),
          ...(spanId ? { spanId } : {}),
        })
      }
    }
  }
  return out
}
