import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { readLogs, readTraces } from './otlp.js'
import { OTEL_RULES } from './rules.js'
import { storeFor } from './store.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hub, LogEntry, ServerSource, Session } from '@loopsight/core/server'
import type { LogDetail, Node, TraceDetail } from './store.js'

const MAX_BODY = 32 * 1024 * 1024
const SIGNAL = /\/v1\/(traces|logs|metrics)\/?$/

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function read(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        let raw = Buffer.concat(chunks)
        if (request.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw)
        resolve(JSON.parse(raw.toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** Takes OTLP over HTTP at the standard paths: `/v1/traces` and `/v1/logs`. */
function receive(request: IncomingMessage, response: ServerResponse, hub: Hub): boolean {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const signal = SIGNAL.exec(path)?.[1]
  if (signal === undefined) return false
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    answer(response, 405, { error: 'Method not allowed' })
    return true
  }
  if (!String(request.headers['content-type'] ?? '').includes('json')) {
    answer(response, 415, {
      error: 'Send OTLP as JSON. For an OpenTelemetry SDK: OTEL_EXPORTER_OTLP_PROTOCOL=http/json.',
    })
    return true
  }
  read(request).then(
    (body) => {
      const store = storeFor(hub)
      // Metrics are accepted and dropped, so an exporter that sends all
      // three signals does not report a failure for one of them.
      if (signal === 'traces') store.spans(readTraces(body))
      else if (signal === 'logs') store.logs(readLogs(body))
      else store.received = true
      answer(response, 200, { partialSuccess: {} })
    },
    (error: Error) => answer(response, 400, { error: error.message }),
  )
  return true
}

const line = (node: Node) =>
  `${'  '.repeat(node.depth)}${node.alongside ? '~ ' : ''}${node.name}${node.about ? ` (${node.about})` : ''} ${node.ms} ms${
    node.at > 0 ? ` +${node.at}` : ''
  }${node.call && node.call !== node.name ? ` → ${node.call}` : ''}${
    node.status !== undefined ? ` ${node.status}` : ''
  }${node.error !== undefined ? ` FAILED: ${node.error.slice(0, 160)}` : ''}${node.cut ? ' (stopped before finishing)' : ''}`

function explain(session: Session, n: number | undefined) {
  const server = session.entries.filter((entry) => entry.source === 'server')
  const of = (entry: LogEntry) => (entry.detail as TraceDetail | LogDetail).request
  let target = n
  if (target !== undefined) {
    // The number of a server entry stands for the request it belongs to.
    const named = session.entries.find((entry) => entry.n === target)
    if (!named) throw new Error(`No entry ${target} in this session. list_events shows the numbers.`)
    if (named.source === 'server') target = of(named)
  } else {
    const slowest = server
      .filter((entry) => entry.type === 'trace')
      .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))[0]
    if (!slowest) {
      throw new Error(
        'No server records are tied to this page yet. The server must export OTLP to this address, and its records arrive a few seconds after a request.',
      )
    }
    target = of(slowest)
  }
  const request = session.entries.find((entry) => entry.n === target)
  const mine = server.filter((entry) => of(entry) === target)
  return {
    request: request ? { n: request.n, summary: request.summary, ms: request.dur } : { n: target },
    traces: mine
      .filter((entry) => entry.type === 'trace')
      .map((entry) => {
        const detail = entry.detail as TraceDetail
        return {
          n: entry.n,
          ms: detail.ms,
          calls: detail.calls,
          failed: detail.failed,
          tree: [
            ...detail.spans.map(line),
            ...(detail.more ? [`… and ${detail.more} more spans`] : []),
            ...(detail.spans.some((node) => node.alongside)
              ? ['~ marks work from another trace that ran while the step above it waited: placed by its timing.']
              : []),
          ],
        }
      }),
    logs: mine
      .filter((entry) => entry.type === 'log')
      .map((entry) => ({ n: entry.n, summary: entry.summary.replace(/ \(for #\d+\)$/, ''), fields: (entry.detail as LogDetail).attrs })),
    ...(mine.length === 0
      ? { note: 'The server sent nothing for this request, or has not yet: an exporter sends in batches.' }
      : {}),
  }
}

/** The app's server, as its own OpenTelemetry traces and logs describe it. */
export const otelServerSource: ServerSource = {
  key: 'server',
  title: 'Server (OpenTelemetry)',
  about:
    'When the app\'s server exports OpenTelemetry to this address, each request the page made is followed on the server: `server` entries say what it did for that request, and `server_trace` shows the whole of it.',
  writes: {
    server:
      'what the app\'s server did for a request the page made (`trace`), and what it logged at warning level or above (`log`), from its OpenTelemetry export',
  },
  http: receive,
  // Requests are tagged once the server has shown it exports here.
  tagRequests: (hub) => storeFor(hub).received,
  rules: OTEL_RULES,
  tools: [
    {
      name: 'server_trace',
      description:
        'What the server did for one request the page made: every step with its time, each call it made out to another service, what failed, and what it logged. Call it to find out why a request was slow, or what a successful-looking answer left out. Needs the server to export OpenTelemetry (OTLP/HTTP JSON) to this address.',
      input: {
        n: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'The number of a request in the timeline (a `network` entry), or of a `server` entry. Default: the request the server took longest over.',
          ),
      },
      run: ({ n }: { n?: number }, { session }) => explain(session, n),
    },
  ],
}
