import { otelServerSource } from './server.js'
import type { SourceDescriptor } from '@loopsight/core/server'

export { otelServerSource } from './server.js'
export { readLogs, readTraces } from './otlp.js'
export { OTEL_RULES } from './rules.js'
export { flatten, storeFor } from './store.js'
export type { LogRecord, Span } from './otlp.js'
export type { LogDetail, Node, TraceDetail } from './store.js'

/**
 * The app's server as a loopsight source. It has no page half: the server
 * tells its side itself, by exporting OpenTelemetry traces and logs as
 * OTLP/HTTP JSON to the address loopsight listens on.
 *
 * ```ts
 * loopsightVite({ sources: [tanstackQuery(), otel()] })
 * ```
 *
 * Then start the app with its exporter pointed there, for example
 * `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4777`.
 */
export function otel(): SourceDescriptor {
  return { key: 'server', server: otelServerSource }
}
